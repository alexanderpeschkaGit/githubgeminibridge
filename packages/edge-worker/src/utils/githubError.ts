import type { GitHubErrorCode } from '../types';

export interface NormalizedGitHubError {
  code: GitHubErrorCode;
  httpStatus: number;
  patchStatus: 'GIT_CONFLICT' | 'ERROR';
  message: string;
  actualHeadOid?: string;
  retryable: boolean;
}

export class GitHubApiError extends Error {
  readonly code: GitHubErrorCode;
  readonly httpStatus: number;
  readonly graphqlTypes: string[];
  readonly actualHeadOid?: string;
  readonly retryable: boolean;

  constructor(params: {
    message: string;
    code: GitHubErrorCode;
    httpStatus: number;
    graphqlTypes?: string[];
    actualHeadOid?: string;
    retryable: boolean;
  }) {
    super(params.message);
    this.name = 'GitHubApiError';
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.graphqlTypes = params.graphqlTypes || [];
    this.actualHeadOid = params.actualHeadOid;
    this.retryable = params.retryable;
  }
}

/**
 * Extracts a 40-character commit OID when GitHub reports the actual branch tip
 * inside a stale-ref error message (e.g. 'Expected branch to point to "..." but it points to "<oid>"').
 */
export function extractConflictingHeadOid(message: string): string | undefined {
  if (!message) return undefined;
  const match =
    message.match(/but it points to ["']?([0-9a-fA-F]{40})["']?/i) ||
    message.match(/branch [^\n]*? is at ["']?([0-9a-fA-F]{40})["']?/i) ||
    message.match(/was at ["']?([0-9a-fA-F]{40})["']? but expected/i);
  return match ? match[1].toLowerCase() : undefined;
}

const BRANCH_PROTECTION_PATTERN =
  /protected branch|repository rule violations|Changes must be made through a pull request|Required status check|GH006|GH013|push declined due to repository rule|ruleset/i;

const GIT_CONFLICT_PATTERN =
  /expectedHeadOid|Expected branch to point to|but it points to|fast[- ]forward|Head sha|reference update failed|cannot lock ref|was at [0-9a-f]{7,40} but expected|stale (?:ref|head|branch|commit)|merge conflict/i;

const RATE_LIMIT_PATTERN =
  /rate limit|secondary rate limit|abuse detection|HTTP error 429/i;

const AUTH_FORBIDDEN_PATTERN =
  /Bad credentials|Resource not accessible by personal access token|INSUFFICIENT_SCOPES|requires one of the following scopes|must have push access|write access to repository not granted|HTTP error 401|HTTP error 403/i;

const REPO_NOT_FOUND_PATTERN =
  /Could not resolve to a Repository|Repository .* was not found|not accessible with the provided token/i;

const BRANCH_NOT_FOUND_PATTERN =
  /Branch .* was not found|Reference does not exist|ref .* not found/i;

/**
 * Classifies any GitHub GraphQL, REST, or internal error into an actionable status and code.
 */
export function classifyGitHubError(
  err: unknown,
  context?: { repo?: string; branch?: string; operation?: string }
): NormalizedGitHubError {
  const rawMessage = err instanceof Error ? err.message : String(err || 'Unknown GitHub error');
  const errName = err instanceof Error ? err.name : '';
  const graphqlTypes =
    err instanceof GitHubApiError
      ? err.graphqlTypes.map((t) => t.toUpperCase())
      : [];
  const actualHeadOid =
    (err instanceof GitHubApiError ? err.actualHeadOid : undefined) ||
    extractConflictingHeadOid(rawMessage);

  // 1. Branch protection / Repository rulesets (must precede generic conflict/forbidden checks)
  if (BRANCH_PROTECTION_PATTERN.test(rawMessage)) {
    const branchLabel = context?.branch ? `"${context.branch}"` : 'the target branch';
    const hint = ` [Actionable Fix: Branch ${branchLabel} is protected by GitHub branch protection or rulesets. Set a separate "Target Branch" (e.g. "feature/patch") in the HUD to commit to a new branch and open a Pull Request.]`;
    return {
      code: 'BRANCH_PROTECTED',
      httpStatus: 403,
      patchStatus: 'ERROR',
      message: rawMessage.includes('Actionable Fix:') ? rawMessage : `${rawMessage}${hint}`,
      retryable: false,
    };
  }

  // 2. Branch Not Found
  if (errName === 'BranchNotFoundError' || BRANCH_NOT_FOUND_PATTERN.test(rawMessage)) {
    return {
      code: 'BRANCH_NOT_FOUND',
      httpStatus: 404,
      patchStatus: 'ERROR',
      message: rawMessage,
      retryable: false,
    };
  }

  // 3. Optimistic Concurrency / Stale HEAD / Non-Fast-Forward Conflict
  if (
    (err instanceof GitHubApiError && err.code === 'GIT_CONFLICT') ||
    GIT_CONFLICT_PATTERN.test(rawMessage)
  ) {
    return {
      code: 'GIT_CONFLICT',
      httpStatus: 409,
      patchStatus: 'GIT_CONFLICT',
      message: rawMessage,
      actualHeadOid,
      retryable: true,
    };
  }

  // 4. Rate Limits
  if (graphqlTypes.includes('RATE_LIMITED') || RATE_LIMIT_PATTERN.test(rawMessage)) {
    const hint = ' [Actionable Fix: GitHub API rate limit reached. Wait 30-60 seconds and retry.]';
    return {
      code: 'RATE_LIMITED',
      httpStatus: 429,
      patchStatus: 'ERROR',
      message: rawMessage.includes('Actionable Fix:') ? rawMessage : `${rawMessage}${hint}`,
      retryable: true,
    };
  }

  // 5. Repository Not Found or Token Cannot See Private Repo
  if (graphqlTypes.includes('NOT_FOUND') || REPO_NOT_FOUND_PATTERN.test(rawMessage)) {
    return {
      code: 'REPO_NOT_FOUND',
      httpStatus: 404,
      patchStatus: 'ERROR',
      message: rawMessage,
      retryable: false,
    };
  }

  // 6. Authentication / Fine-Grained PAT Permission Scope
  if (
    graphqlTypes.includes('INSUFFICIENT_SCOPES') ||
    graphqlTypes.includes('FORBIDDEN') ||
    AUTH_FORBIDDEN_PATTERN.test(rawMessage)
  ) {
    const repoLabel = context?.repo ? ` for "${context.repo}"` : '';
    const hint = ` [Actionable Fix: Verify that the Worker's GITHUB_PAT / GITHUB_TOKEN has "Contents: Read and write" permission${repoLabel} and that the active HUD Account matches the repository owner.]`;
    return {
      code: 'AUTH_FORBIDDEN',
      httpStatus: /HTTP error 401|Bad credentials/i.test(rawMessage) ? 401 : 403,
      patchStatus: 'ERROR',
      message: rawMessage.includes('Actionable Fix:') ? rawMessage : `${rawMessage}${hint}`,
      retryable: false,
    };
  }

  // 7. Validation / Unprocessable Entity
  if (graphqlTypes.includes('UNPROCESSABLE') || /HTTP error 422|UNPROCESSABLE/i.test(rawMessage)) {
    return {
      code: 'VALIDATION_FAILED',
      httpStatus: 422,
      patchStatus: 'ERROR',
      message: rawMessage,
      retryable: false,
    };
  }

  return {
    code: 'UPSTREAM_ERROR',
    httpStatus: err instanceof GitHubApiError ? err.httpStatus : 502,
    patchStatus: 'ERROR',
    message: rawMessage,
    retryable: true,
  };
}

export function createGitHubHttpError(status: number, statusText: string, bodyText: string): GitHubApiError {
  const message = `GitHub GraphQL HTTP error ${status} (${statusText}): ${bodyText}`;
  const classified = classifyGitHubError(new Error(message));
  return new GitHubApiError({
    message,
    code: classified.code,
    httpStatus: status >= 400 ? status : classified.httpStatus,
    actualHeadOid: classified.actualHeadOid,
    retryable: status === 429 || status >= 500 || classified.retryable,
  });
}

export function createGitHubGraphQLError(errors: Array<{ message?: string; type?: string }>): GitHubApiError {
  const msg = errors.map((e) => e?.message || 'Unknown GraphQL error').join(' | ');
  const graphqlTypes = errors
    .map((e) => (typeof e?.type === 'string' ? e.type.trim() : ''))
    .filter(Boolean);
  const message = `GitHub GraphQL error: ${msg}`;
  const probe = new GitHubApiError({
    message,
    code: 'UPSTREAM_ERROR',
    httpStatus: 502,
    graphqlTypes,
    actualHeadOid: extractConflictingHeadOid(msg),
    retryable: false,
  });
  const classified = classifyGitHubError(probe);
  return new GitHubApiError({
    message,
    code: classified.code,
    httpStatus: classified.httpStatus,
    graphqlTypes,
    actualHeadOid: classified.actualHeadOid,
    retryable: classified.retryable,
  });
}
