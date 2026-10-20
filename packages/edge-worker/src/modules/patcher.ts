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

/**
 * Hard Guardrail: Patterns indicating AI placeholder text that would truncate code.
 */
export const LLM_PLACEHOLDER_PATTERNS = [
  /\/\/\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i,
  /#\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i,
  /\/\*\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}\s*\*\//i,
  /<!--\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}\s*-->/i,
  /\.{3,}\s*(?:existing|rest of)\s*code\s*\.{3,}/i,
  /\/\/\s*\.{3,}\s*$/m,
];

/**
 * Stage 4 Linter Hook type: enables modules/linter.ts to inject AST/syntax checks
 * into the patch preflight pipeline without modifying patcher.ts.
 */
export type PreflightLinterHook = PreflightLinterHookType;

/**
 * Validates that file content does NOT contain LLM placeholder comments.
 * Throws an error immediately if detected (used by V1 Legacy endpoints).
 */
export function validateNoPlaceholders(content: string, filePath: string): void {
  for (const pattern of LLM_PLACEHOLDER_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(
        `Hard Guardrail Rejection: File "${filePath}" contains forbidden LLM placeholder text (e.g. "// ... existing code ..."). Commit rejected to prevent accidental code truncation.`
      );
    }
  }
}

/**
 * Non-throwing helper that checks LLM_PLACEHOLDER_PATTERNS and returns
 * aggregated LinterError items for Stage 2 & 4 non-fail-fast error reporting.
 */
export function checkPlaceholderErrors(content: string, filePath: string): LinterError[] {
  return checkPlaceholderErrorsImpl(content, filePath);
}

/**
 * Evaluates custom preflight rules without failing fast.
 * Verifies forbidPatterns and requireExports across all resulting files.
 */
export function runBuiltinPreflightRules(
  files: { path: string; content: string }[],
  preflight?: GeminiPatchPayload['preflight']
): LinterError[] {
  return runBuiltinPreflightRulesImpl(files, preflight);
}

/**
 * Extracts <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE blocks from text.
 */
export function parseSearchReplaceBlocks(text: string): PatchItem[] {
  const blocks: PatchItem[] = [];
  const regex = /<{5,9}\s*(?:SEARCH|ORIGINAL|HEAD)?\r?\n([\s\S]*?)\r?\n={5,9}\r?\n([\s\S]*?)\r?\n>{5,9}\s*(?:REPLACE|MODIFIED|UPDATED)?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      search: match[1],
      replace: match[2]
    });
  }

  return blocks;
}

/**
 * Applies a single search & replace transformation to a file content string.
 * Handles exact matches, CRLF vs LF differences, and trimmed line matches.
 */
export function applySearchReplace(original: string, search: string, replace: string, filePath: string = ''): string {
  // 1. Direct match
  if (original.includes(search)) {
    return original.replace(search, replace);
  }

  // 2. Normalized newline match (CRLF -> LF)
  const normOriginal = original.replace(/\r\n/g, '\n');
  const normSearch = search.replace(/\r\n/g, '\n');
  const normReplace = replace.replace(/\r\n/g, '\n');

  if (normOriginal.includes(normSearch)) {
    const updated = normOriginal.replace(normSearch, normReplace);
    if (original.includes('\r\n')) {
      return updated.replace(/\n/g, '\r\n');
    }
    return updated;
  }

  // 3. Relaxed line-by-line trimmed match
  const origLines = normOriginal.split('\n');
  const searchLines = normSearch.split('\n');

  let matchStart = -1;
  for (let i = 0; i <= origLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (origLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchStart = i;
      break;
    }
  }

  if (matchStart !== -1) {
    const before = origLines.slice(0, matchStart).join('\n');
    const after = origLines.slice(matchStart + searchLines.length).join('\n');
    const updated = (before ? before + '\n' : '') + normReplace + (after ? '\n' + after : '');
    if (original.includes('\r\n')) {
      return updated.replace(/\n/g, '\r\n');
    }
    return updated;
  }

  const snippet = search.length > 200 ? `${search.slice(0, 200)}...` : search;
  throw new Error(`Search block could not be resolved for file "${filePath}". Target snippet:\n${snippet}`);
}

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

  // Verify the source snapshot even when the patch will be committed elsewhere.
  let sourceInfo;
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
      if (req.expectedTargetHeadOid) {
        return {
          status: 'GIT_CONFLICT',
          errorMessage: `Target branch "${effectiveTargetBranch}" no longer exists at expected HEAD "${req.expectedTargetHeadOid}".`
        };
      }
      if (req.createBranchIfNeeded === false) {
        return {
          status: 'ERROR',
          errorMessage: `Target branch "${effectiveTargetBranch}" does not exist and createBranchIfNeeded is false.`
        };
      }

      try {
        await createBranchRef(owner, repo, effectiveTargetBranch, req.expectedHeadOid, githubToken, sourceInfo.repositoryId);
        createdBranch = true;
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
      if (createdBranch) {
        try {
          targetInfo = await getBranchHeadOid(owner, repo, effectiveTargetBranch, githubToken);
        } catch (resolveErr: any) {
          return {
            status: 'ERROR',
            errorMessage: `Target branch "${effectiveTargetBranch}" was created but could not be resolved: ${resolveErr.message}`
          };
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
  const allTargetPaths = Array.from(new Set(req.payload.patches.map((p) => p.path)));
  let existingFiles: Record<string, string | null> = {};
  try {
    existingFiles = await fetchMultipleFilesViaGraphQL(owner, repo, commitExpectedHeadOid, allTargetPaths, githubToken);
  } catch (err: any) {
    return { status: 'ERROR', errorMessage: `Batch fetch failed for target files: ${err.message}` };
  }

  const patchResult = await applyPatchesInMemory(
    req.payload.patches,
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
      createdBranch
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
