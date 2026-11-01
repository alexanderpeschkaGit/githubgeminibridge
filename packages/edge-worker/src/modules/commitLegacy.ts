import type { CommitRequest, FileChangeInput, GitHubErrorCode } from '../types';
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
import { classifyGitHubError } from '../utils/githubError';
import { resolveOrCreateTarget } from './branchResolver';
import { validateNoPlaceholders, parseSearchReplaceBlocks, applySearchReplace } from './searchReplace';

export class ClientValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientValidationError';
  }
}

export class UpstreamRequestError extends Error {
  readonly httpStatus: number;
  readonly errorCode: GitHubErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    httpStatus = 502,
    errorCode: GitHubErrorCode = 'UPSTREAM_ERROR',
    retryable = false
  ) {
    super(message);
    this.name = 'UpstreamRequestError';
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

export interface LegacyCommitHttpResult {
  httpStatus: number;
  body: Record<string, any>;
}

function fileChangeNeedsExistingContent(fileInput: FileChangeInput): boolean {
  if (typeof fileInput.search === 'string' && typeof fileInput.replace === 'string') return true;
  if (Array.isArray(fileInput.patches) && fileInput.patches.length > 0) return true;
  const diffToCheck = fileInput.diff || fileInput.content || '';
  return diffToCheck.includes('<<<<<<<') || diffToCheck.includes('=====');
}

/**
 * Resolves a FileChangeInput into full updated file content.
 * Kept for 100% backward compatibility with V1 routes (/push, /commit).
 */
export async function resolveFileContent(
  fileInput: FileChangeInput,
  existingContentFetcher: (path: string) => Promise<string>
): Promise<string> {
  const patchesToApply: { search: string; replace: string }[] = [];

  if (typeof fileInput.search === 'string' && typeof fileInput.replace === 'string') {
    patchesToApply.push({ search: fileInput.search, replace: fileInput.replace });
  }

  if (Array.isArray(fileInput.patches)) {
    for (const p of fileInput.patches) {
      if (typeof p.search === 'string' && typeof p.replace === 'string') {
        patchesToApply.push(p);
      }
    }
  }

  const diffToCheck = fileInput.diff || fileInput.content || '';
  if (diffToCheck.includes('<<<<<<<') || diffToCheck.includes('=====')) {
    const parsed = parseSearchReplaceBlocks(diffToCheck);
    patchesToApply.push(...parsed);
  }

  if (patchesToApply.length === 0) {
    if (typeof fileInput.content === 'string') {
      validateNoPlaceholders(fileInput.content, fileInput.path);
      return fileInput.content;
    }
    throw new Error(`File change for "${fileInput.path}" must provide either "content" or search/replace patches.`);
  }

  for (const patch of patchesToApply) {
    validateNoPlaceholders(patch.replace, fileInput.path);
  }

  const existingContent = await existingContentFetcher(fileInput.path);
  let resolved = existingContent;

  for (const patch of patchesToApply) {
    resolved = applySearchReplace(resolved, patch.search, patch.replace, fileInput.path);
  }

  validateNoPlaceholders(resolved, fileInput.path);
  return resolved;
}

/**
 * Unified V1 commit handler (/push, /commit, /api/commit, /).
 * Shares the V2 1-subrequest GraphQL batch read at the pinned commit OID,
 * sequential workingFiles chaining, target-branch concurrency, and normalized GraphQL errors.
 */
export async function handleCommitRequest(
  body: CommitRequest,
  githubToken: string
): Promise<LegacyCommitHttpResult> {
  let owner = '';
  let repo = '';
  try {
    const parsed = parseRepoOwner(body.repo || '', body.owner);
    owner = parsed.owner;
    repo = parsed.repo;
  } catch {
    throw new ClientValidationError(
      'Missing required fields: Repository must be specified as "owner/repo" or separate "owner" and "repo".'
    );
  }

  const commitMessage = (body.commitMessage || body.message || '').trim();
  if (!commitMessage) {
    throw new ClientValidationError('Missing required field: "commitMessage" (or "message") must be specified.');
  }

  const fileChanges = body.changes || body.files || [];
  const deletions = body.deletions || [];
  if (fileChanges.length === 0 && deletions.length === 0) {
    throw new ClientValidationError('Commit must include at least one entry in "changes" or "files" or "deletions".');
  }

  if (
    body.expectedTargetHeadOid !== undefined &&
    (typeof body.expectedTargetHeadOid !== 'string' || !/^[0-9a-f]{40}$/i.test(body.expectedTargetHeadOid))
  ) {
    throw new ClientValidationError('expectedTargetHeadOid must be a 40-character Git commit OID.');
  }

  const normalizedChanges: FileChangeInput[] = fileChanges.map((fileInput) => {
    const pathIssue = findRepoPathIssue(fileInput.path);
    if (pathIssue) throw new ClientValidationError(pathIssue);
    return { ...fileInput, path: normalizeRepoPath(fileInput.path) };
  });

  const formattedDeletions: { path: string }[] = deletions.map((del) => {
    const rawPath = typeof del === 'string' ? del : del.path;
    const pathIssue = findRepoPathIssue(rawPath);
    if (pathIssue) throw new ClientValidationError(pathIssue);
    return { path: normalizeRepoPath(rawPath) };
  });

  const normalizeBranch = (branch: string) => branch.replace(/^refs\/heads\//, '');
  const effectiveTargetBranch = (body.targetBranch || body.branch || 'main').trim();
  const baseBranch = (body.baseBranch || body.branch || effectiveTargetBranch).trim();
  const isDistinctTarget = normalizeBranch(effectiveTargetBranch) !== normalizeBranch(baseBranch);

  let sourceInfo: Awaited<ReturnType<typeof getBranchHeadOid>>;
  try {
    sourceInfo = await getBranchHeadOid(owner, repo, baseBranch, githubToken);
  } catch (err: any) {
    const classified = classifyGitHubError(err, { repo: `${owner}/${repo}`, branch: baseBranch });
    throw new UpstreamRequestError(classified.message, classified.httpStatus, classified.code, classified.retryable);
  }

  if (body.expectedHeadOid && sourceInfo.headOid !== body.expectedHeadOid) {
    const errorMessage = `Expected HEAD "${body.expectedHeadOid}" but branch "${sourceInfo.resolvedBranch}" is at "${sourceInfo.headOid}". Fetch the latest repo mix and retry.`;
    return {
      httpStatus: 409,
      body: {
        success: false,
        error: errorMessage,
        status: 'GIT_CONFLICT',
        errorCode: 'GIT_CONFLICT',
        retryable: true,
        newHeadOid: sourceInfo.headOid,
        errorMessage
      }
    };
  }

  let targetInfo = sourceInfo;
  let createdBranch = false;
  if (isDistinctTarget) {
    try {
      const resolved = await resolveOrCreateTarget({
        owner,
        repo,
        baseBranch,
        effectiveTargetBranch,
        sourceInfo,
        expectedTargetHeadOid: body.expectedTargetHeadOid,
        createBranchIfNeeded: body.createBranchIfNeeded,
        dryRun: false,
        githubToken,
        baseOidForCreate: body.expectedHeadOid || sourceInfo.headOid
      });
      targetInfo = resolved.targetInfo;
      createdBranch = resolved.createdBranch;
    } catch (err: any) {
      if (!(err instanceof BranchNotFoundError)) {
        const classified = classifyGitHubError(err, { repo: `${owner}/${repo}`, branch: effectiveTargetBranch });
        throw new UpstreamRequestError(classified.message, classified.httpStatus, classified.code, classified.retryable);
      }
      if (body.expectedTargetHeadOid) {
        const errorMessage = `Target branch "${effectiveTargetBranch}" no longer exists at expected HEAD "${body.expectedTargetHeadOid}".`;
        return {
          httpStatus: 409,
          body: {
            success: false,
            error: errorMessage,
            status: 'GIT_CONFLICT',
            errorCode: 'GIT_CONFLICT',
            retryable: true,
            targetBranch: normalizeBranch(effectiveTargetBranch),
            errorMessage
          }
        };
      }
      if (body.createBranchIfNeeded === false) {
        throw new ClientValidationError(
          `Target branch "${effectiveTargetBranch}" does not exist and createBranchIfNeeded is false.`
        );
      }
      const baseOidForCreate = body.expectedHeadOid || sourceInfo.headOid;
      try {
        const createdRef = await createBranchRef(
          owner,
          repo,
          effectiveTargetBranch,
          baseOidForCreate,
          githubToken,
          sourceInfo.repositoryId
        );
        createdBranch = true;
        targetInfo = {
          headOid: createdRef.oid || baseOidForCreate,
          resolvedBranch: normalizeBranch(effectiveTargetBranch),
          repositoryId: sourceInfo.repositoryId
        };
      } catch (createErr: any) {
        try {
          targetInfo = await getBranchHeadOid(owner, repo, effectiveTargetBranch, githubToken);
        } catch {
          const classified = classifyGitHubError(createErr, { repo: `${owner}/${repo}`, branch: effectiveTargetBranch });
          throw new UpstreamRequestError(classified.message, classified.httpStatus, classified.code, classified.retryable);
        }
      }
    }

    if (body.expectedTargetHeadOid && targetInfo.headOid !== body.expectedTargetHeadOid) {
      const errorMessage = `Expected target HEAD "${body.expectedTargetHeadOid}" but branch "${targetInfo.resolvedBranch}" is at "${targetInfo.headOid}".`;
      return {
        httpStatus: 409,
        body: {
          success: false,
          error: errorMessage,
          status: 'GIT_CONFLICT',
          errorCode: 'GIT_CONFLICT',
          retryable: true,
          newHeadOid: targetInfo.headOid,
          targetBranch: targetInfo.resolvedBranch,
          errorMessage
        }
      };
    }
  }

  const commitBranch = targetInfo.resolvedBranch;
  const commitExpectedHeadOid = targetInfo.headOid;

  const pathsNeedingFetch = Array.from(
    new Set(normalizedChanges.filter(fileChangeNeedsExistingContent).map((c) => c.path))
  );

  let existingFiles: Record<string, string | null> = {};
  if (pathsNeedingFetch.length > 0) {
    try {
      existingFiles = await fetchMultipleFilesViaGraphQL(
        owner,
        repo,
        commitExpectedHeadOid,
        pathsNeedingFetch,
        githubToken
      );
    } catch (err: any) {
      const classified = classifyGitHubError(err, { repo: `${owner}/${repo}`, branch: commitBranch });
      throw new UpstreamRequestError(classified.message, classified.httpStatus, classified.code, classified.retryable);
    }
  }

  const workingFiles: Record<string, string | null> = { ...existingFiles };
  const additionsMap = new Map<string, string>();

  for (const fileInput of normalizedChanges) {
    const contentFetcher = async (requestedPath: string): Promise<string> => {
      const norm = normalizeRepoPath(requestedPath);
      const current = workingFiles[norm];
      if (typeof current === 'string') return current;
      throw new ClientValidationError(
        `Target file "${norm}" does not exist on branch "${commitBranch}" at revision ${commitExpectedHeadOid.slice(0, 7)}.`
      );
    };

    let resolvedText: string;
    try {
      resolvedText = await resolveFileContent(fileInput, contentFetcher);
    } catch (err: any) {
      if (err instanceof ClientValidationError || err instanceof UpstreamRequestError) throw err;
      throw new ClientValidationError(err?.message || 'Invalid file change payload');
    }
    workingFiles[fileInput.path] = resolvedText;
    additionsMap.set(fileInput.path, utf8ToBase64(resolvedText));
  }

  for (const del of formattedDeletions) {
    additionsMap.delete(del.path);
  }

  const additions = Array.from(additionsMap, ([path, contents]) => ({ path, contents }));

  try {
    const commitResult = await createCommitOnBranch(
      owner,
      repo,
      commitBranch,
      commitExpectedHeadOid,
      commitMessage,
      additions,
      formattedDeletions,
      githubToken
    );
    const compareUrl = `https://github.com/${owner}/${repo}/compare/${sourceInfo.resolvedBranch}...${commitBranch}?expand=1`;
    return {
      httpStatus: 200,
      body: {
        success: true,
        status: 'COMMITTED',
        commit: commitResult,
        newHeadOid: commitResult.oid,
        commitUrl: commitResult.url,
        branch: commitBranch,
        targetBranch: commitBranch,
        createdBranch,
        ...(isDistinctTarget ? { pullRequestUrl: compareUrl } : {}),
        repository: `${owner}/${repo}`,
        filesChanged: additions.length + formattedDeletions.length
      }
    };
  } catch (err: any) {
    const classified = classifyGitHubError(err, { repo: `${owner}/${repo}`, branch: commitBranch, operation: 'commit' });
    if (classified.code === 'GIT_CONFLICT') {
      const latestHead = classified.actualHeadOid
        ? { headOid: classified.actualHeadOid }
        : await getBranchHeadOid(owner, repo, commitBranch, githubToken).catch(() => ({
            headOid: commitExpectedHeadOid
          }));
      return {
        httpStatus: 409,
        body: {
          success: false,
          error: classified.message,
          status: 'GIT_CONFLICT',
          errorCode: 'GIT_CONFLICT',
          retryable: true,
          newHeadOid: latestHead.headOid,
          ...(isDistinctTarget ? { targetBranch: commitBranch } : {}),
          errorMessage: classified.message
        }
      };
    }
    throw new UpstreamRequestError(
      `Commit execution failed: ${classified.message}`,
      classified.httpStatus,
      classified.code,
      classified.retryable
    );
  }
}
