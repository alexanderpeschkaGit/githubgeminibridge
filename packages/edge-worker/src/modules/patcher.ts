import type {
  FileChangeInput,
  PatchItem,
  FilePatchOperation,
  GeminiPatchPayload,
  WorkerPatchRequest,
  LinterError,
  WorkerPatchResponse
} from '../types';
import { utf8ToBase64 } from '../utils/encoding';
import { normalizeRepoPath, findRepoPathIssue } from '../../../../shared/repoPaths';
import {
  parseRepoOwner,
  BranchNotFoundError,
  getBranchHeadOid,
  createBranchRef,
  fetchMultipleFilesViaGraphQL,
  createCommitOnBranch
} from '../utils/github';
import { runPreflightLinter } from './linter';
import {
  type PreflightLinterHook as PreflightLinterHookType,
  checkPlaceholderErrors as checkPlaceholderErrorsImpl,
  runBuiltinPreflightRules as runBuiltinPreflightRulesImpl,
  applyPatchesInMemory as applyPatchesInMemoryImpl
} from './patchInMemory';
import {
  LLM_PLACEHOLDER_PATTERNS,
  validateNoPlaceholders,
  checkPlaceholderErrors,
  parseSearchReplaceBlocks,
  applySearchReplace
} from './searchReplace';

export {
  LLM_PLACEHOLDER_PATTERNS,
  validateNoPlaceholders,
  checkPlaceholderErrors,
  parseSearchReplaceBlocks,
  applySearchReplace
};

/**
 * Stage 4 Linter Hook type: enables modules/linter.ts to inject AST/syntax checks
 * into the patch preflight pipeline without modifying patcher.ts.
 */
export type PreflightLinterHook = PreflightLinterHookType;

/**
 * Pure in-memory patch processor.
 * Applies patches, validates placeholders, checks idempotency and executes preflight rules.
 */
export async function applyPatchesInMemory(
  patches: FilePatchOperation[],
  existingFiles: Record<string, string | null>,
  preflight?: GeminiPatchPayload['preflight'],
  preflightHook: PreflightLinterHook = runPreflightLinter
): Promise<{
  additions: { path: string; content: string }[];
  deletions: { path: string }[];
  errors: LinterError[];
  hasEffectiveChanges: boolean;
}> {
  return applyPatchesInMemoryImpl(patches, existingFiles, preflight, preflightHook);
}

/**
 * Handles POST /api/patch requests (Stage 2 & Stage 4).
 * Performs concurrency checks, fetches files in 1 subrequest via GraphQL,
 * applies in-memory search/replace patches, runs preflight validations,
 * and commits atomically with createCommitOnBranch.
 */
export async function handlePatchRequest(
  req: WorkerPatchRequest,
  githubToken: string,
  preflightHook: PreflightLinterHook = runPreflightLinter
): Promise<WorkerPatchResponse> {
  if (!req.repo || !req.branch || !req.expectedHeadOid || !req.payload?.patches) {
    return {
      status: 'ERROR',
      errorMessage: 'Missing required fields: "repo", "branch", "expectedHeadOid", and "payload.patches" must be specified.'
    };
  }

  let owner = '';
  let repo = '';
  try {
    const parsed = parseRepoOwner(req.repo);
    owner = parsed.owner;
    repo = parsed.repo;
  } catch (err: any) {
    return {
      status: 'ERROR',
      errorMessage: err.message || 'Invalid repository format'
    };
  }

  const baseBranch = req.branch.trim();
  const effectiveTargetBranch = (req.targetBranch || req.branch).trim();
  const normalizeBranch = (branch: string) => branch.replace(/^refs\/heads\//, '');
  const isDistinctTarget = normalizeBranch(effectiveTargetBranch) !== normalizeBranch(baseBranch);
  if (
    req.expectedTargetHeadOid !== undefined &&
    (typeof req.expectedTargetHeadOid !== 'string' || !/^[0-9a-f]{40}$/i.test(req.expectedTargetHeadOid))
  ) {
    return { status: 'ERROR', errorMessage: 'expectedTargetHeadOid must be a 40-character Git commit OID.' };
  }

  // LLM-supplied paths routinely carry "./", a leading "/" or Windows separators.
  // GitHub resolves `<oid>:<path>` strictly, so every non-canonical variant reads as
  // "file does not exist". Normalize once here so blob lookup, in-memory patch and
  // commit mutation all address the exact same repo-relative path. Validation runs
  // before any branch is created, so an invalid payload never leaves a new branch.
  const patches: FilePatchOperation[] = [];
  const pathErrors: LinterError[] = [];
  for (const patch of req.payload.patches) {
    const issue = findRepoPathIssue(patch.path);
    if (issue) {
      pathErrors.push({
        file: patch.path || '(missing path)',
        stage: 'SEARCH_REPLACE',
        message: issue
      });
      continue;
    }
    patches.push({ ...patch, path: normalizeRepoPath(patch.path) });
  }
  if (pathErrors.length > 0) {
    return { status: 'PREFLIGHT_FAILED', errors: pathErrors };
  }

  const allTargetPaths = Array.from(new Set(patches.map((p) => p.path)));

  // Same-branch patches need no separate target resolution, so the source HEAD
  // check and the blob read are dispatched together. The HEAD result still gates
  // every mutation: a stale OID returns before applyPatchesInMemory runs.
  let sourceInfo: Awaited<ReturnType<typeof getBranchHeadOid>>;
  let prefetchedFiles: Record<string, string | null> | undefined;
  if (!isDistinctTarget) {
    const headPromise = getBranchHeadOid(owner, repo, baseBranch, githubToken);
    const filesPromise = fetchMultipleFilesViaGraphQL(
      owner,
      repo,
      req.expectedHeadOid,
      allTargetPaths,
      githubToken
    );
    // A stale source OID aborts before the blob read is awaited; keep a rejection
    // from surfacing as an unhandled promise rejection.
    filesPromise.catch(() => undefined);
    try {
      sourceInfo = await headPromise;
    } catch (err: any) {
      return { status: 'ERROR', errorMessage: `Failed to resolve branch "${baseBranch}": ${err.message}` };
    }
    if (sourceInfo.headOid !== req.expectedHeadOid) {
      return {
        status: 'GIT_CONFLICT',
        newHeadOid: sourceInfo.headOid,
        errorMessage: `Expected HEAD "${req.expectedHeadOid}" but branch "${sourceInfo.resolvedBranch}" is at "${sourceInfo.headOid}". Fetch the latest repo mix and retry.`
      };
    }
    try {
      prefetchedFiles = await filesPromise;
    } catch (err: any) {
      return { status: 'ERROR', errorMessage: `Batch fetch failed for target files: ${err.message}` };
    }
  } else {
    // Verify the source snapshot even when the patch will be committed elsewhere.
    try {
      sourceInfo = await getBranchHeadOid(owner, repo, baseBranch, githubToken);
    } catch (err: any) {
      return { status: 'ERROR', errorMessage: `Failed to resolve branch "${baseBranch}": ${err.message}` };
    }
    if (sourceInfo.headOid !== req.expectedHeadOid) {
      return {
        status: 'GIT_CONFLICT',
        newHeadOid: sourceInfo.headOid,
        errorMessage: `Expected HEAD "${req.expectedHeadOid}" but branch "${sourceInfo.resolvedBranch}" is at "${sourceInfo.headOid}". Fetch the latest repo mix and retry.`
      };
    }
  }

  // Resolve/create the actual commit branch before reading any files.
  let targetInfo = sourceInfo;
  let createdBranch = false;
  if (isDistinctTarget) {
    try {
      targetInfo = await getBranchHeadOid(owner, repo, effectiveTargetBranch, githubToken);
    } catch (err: any) {
      if (!(err instanceof BranchNotFoundError)) {
        return { status: 'ERROR', errorMessage: `Failed to resolve target branch "${effectiveTargetBranch}": ${err.message}` };
      }
      if (req.dryRun) {
        targetInfo = {
          headOid: req.expectedHeadOid,
          resolvedBranch: normalizeBranch(effectiveTargetBranch),
          repositoryId: sourceInfo.repositoryId
        };
      } else if (req.expectedTargetHeadOid) {
        return {
          status: 'GIT_CONFLICT',
          errorMessage: `Target branch "${effectiveTargetBranch}" no longer exists at expected HEAD "${req.expectedTargetHeadOid}".`
        };
      } else if (req.createBranchIfNeeded === false) {
        return {
          status: 'ERROR',
          errorMessage: `Target branch "${effectiveTargetBranch}" does not exist and createBranchIfNeeded is false.`
        };
      } else {
        try {
          const createdRef = await createBranchRef(owner, repo, effectiveTargetBranch, req.expectedHeadOid, githubToken, sourceInfo.repositoryId);
          createdBranch = true;
          // The new ref points at the validated source OID, so its initial tree
          // is exactly that commit — no second resolution roundtrip is needed.
          targetInfo = {
            headOid: createdRef.oid || req.expectedHeadOid,
            resolvedBranch: normalizeBranch(effectiveTargetBranch),
            repositoryId: sourceInfo.repositoryId
          };
        } catch (createErr: any) {
          // A concurrent creator may win after the initial not-found lookup. Only
          // continue if a fresh lookup confirms that the branch now exists.
          try {
            targetInfo = await getBranchHeadOid(owner, repo, effectiveTargetBranch, githubToken);
          } catch (resolveErr: any) {
            return {
              status: 'ERROR',
              errorMessage: `Failed to create target branch "${effectiveTargetBranch}": ${createErr.message}; verification failed: ${resolveErr.message}`
            };
          }
        }
      }
    }

    if (req.expectedTargetHeadOid && targetInfo.headOid !== req.expectedTargetHeadOid) {
      return {
        status: 'GIT_CONFLICT',
        newHeadOid: targetInfo.headOid,
        targetBranch: targetInfo.resolvedBranch,
        errorMessage: `Expected target HEAD "${req.expectedTargetHeadOid}" but branch "${targetInfo.resolvedBranch}" is at "${targetInfo.headOid}".`
      };
    }
  }

  const commitBranch = targetInfo.resolvedBranch;
  const commitExpectedHeadOid = targetInfo.headOid;

  // Apply patches to the exact branch snapshot that will receive the commit.
  let existingFiles: Record<string, string | null>;
  if (prefetchedFiles !== undefined) {
    existingFiles = prefetchedFiles;
  } else {
    try {
      existingFiles = await fetchMultipleFilesViaGraphQL(
        owner,
        repo,
        commitExpectedHeadOid,
        allTargetPaths,
        githubToken
      );
    } catch (err: any) {
      return { status: 'ERROR', errorMessage: `Batch fetch failed for target files: ${err.message}` };
    }
  }

  const patchResult = await applyPatchesInMemory(
    patches,
    existingFiles,
    req.payload.preflight,
    preflightHook
  );
  if (patchResult.errors.length > 0) {
    return { status: 'PREFLIGHT_FAILED', errors: patchResult.errors };
  }
  if (!patchResult.hasEffectiveChanges) {
    return {
      status: 'NO_CHANGES_NEEDED',
      newHeadOid: commitExpectedHeadOid,
      targetBranch: commitBranch,
      createdBranch: req.dryRun ? false : createdBranch
    };
  }

  if (req.dryRun) {
    return {
      status: 'VALIDATED',
      newHeadOid: commitExpectedHeadOid,
      targetBranch: commitBranch,
      createdBranch: false
    };
  }

  const encodedAdditions = patchResult.additions.map((a) => ({
    path: a.path,
    contents: utf8ToBase64(a.content)
  }));

  try {
    const commitResult = await createCommitOnBranch(
      owner,
      repo,
      commitBranch,
      commitExpectedHeadOid,
      req.payload.commitMessage || 'chore: apply patches via gemini-git-bridge',
      encodedAdditions,
      patchResult.deletions,
      githubToken
    );
    const compareUrl = `https://github.com/${owner}/${repo}/compare/${sourceInfo.resolvedBranch}...${commitBranch}?expand=1`;
    return {
      status: 'COMMITTED',
      newHeadOid: commitResult.oid,
      commitUrl: commitResult.url,
      targetBranch: commitBranch,
      createdBranch,
      pullRequestUrl: isDistinctTarget ? compareUrl : undefined
    };
  } catch (err: any) {
    const errMsg = err.message || '';
    if (/expectedHeadOid|conflict|stale|HEAD/i.test(errMsg)) {
      const latestHead = await getBranchHeadOid(owner, repo, commitBranch, githubToken).catch(() => ({
        headOid: commitExpectedHeadOid
      }));
      return {
        status: 'GIT_CONFLICT',
        newHeadOid: latestHead.headOid,
        targetBranch: commitBranch,
        errorMessage: errMsg
      };
    }
    return { status: 'ERROR', errorMessage: `Commit execution failed: ${errMsg}` };
  }
}

/**
 * Resolves a FileChangeInput into full updated file content.
 * Kept for 100% backward compatibility with V1 routes (/push, /commit).
 */
export async function resolveFileContent(
  fileInput: FileChangeInput,
  existingContentFetcher: (path: string) => Promise<string>
): Promise<string> {
  const patchesToApply: PatchItem[] = [];

  // Check explicit single search/replace
  if (typeof fileInput.search === 'string' && typeof fileInput.replace === 'string') {
    patchesToApply.push({ search: fileInput.search, replace: fileInput.replace });
  }

  // Check array of patches
  if (Array.isArray(fileInput.patches)) {
    for (const p of fileInput.patches) {
      if (typeof p.search === 'string' && typeof p.replace === 'string') {
        patchesToApply.push(p);
      }
    }
  }

  // Check diff or content for <<<<<<< SEARCH blocks
  const diffToCheck = fileInput.diff || fileInput.content || '';
  if (diffToCheck.includes('<<<<<<<') || diffToCheck.includes('=====')) {
    const parsed = parseSearchReplaceBlocks(diffToCheck);
    patchesToApply.push(...parsed);
  }

  // If no search/replace patches found, treat as full file content replacement/creation
  if (patchesToApply.length === 0) {
    if (typeof fileInput.content === 'string') {
      validateNoPlaceholders(fileInput.content, fileInput.path);
      return fileInput.content;
    }
    throw new Error(`File change for "${fileInput.path}" must provide either "content" or search/replace patches.`);
  }

  // Validate that replace blocks do not contain placeholders
  for (const patch of patchesToApply) {
    validateNoPlaceholders(patch.replace, fileInput.path);
  }

  // Fetch existing content
  const existingContent = await existingContentFetcher(fileInput.path);
  let resolved = existingContent;

  for (const patch of patchesToApply) {
    resolved = applySearchReplace(resolved, patch.search, patch.replace, fileInput.path);
  }

  // Validate the final resolved file
  validateNoPlaceholders(resolved, fileInput.path);

  return resolved;
}
