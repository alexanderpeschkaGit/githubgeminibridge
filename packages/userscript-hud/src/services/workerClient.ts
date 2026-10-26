import type {
  HudConfig,
  MixRequest,
  MixResponse,
  WorkerPatchRequest,
  WorkerPatchResponse,
  CommitRequest,
} from '../types';

export type { SkippedFile } from '../types';

/**
 * V2 responses carry a machine-readable payload even on failure (status/errors/
 * errorMessage). They must reach the caller instead of collapsing into a generic
 * Error; transport-level failures (401/403/404/500) still reject.
 */
export function isV2ErrorPayload(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const payload = data as Record<string, unknown>;
  return (
    typeof payload.status === 'string' ||
    typeof payload.errorMessage === 'string' ||
    Array.isArray(payload.errors)
  );
}

function shouldResolveV2Error(status: number, data: unknown): boolean {
  return (status === 400 || status === 409) && isV2ErrorPayload(data);
}

/**
 * CSP-Bypass Invariant (P1 Komponente 5):
 * All requests to the Cloudflare Worker MUST use GM_xmlhttpRequest (or GM.xmlHttpRequest)
 * to bypass the host site's strict connect-src Content Security Policy.
 */
export async function gmRequestJson<T>(
  url: string,
  method: 'GET' | 'POST',
  secret: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${secret}`,
    'x-bridge-secret': secret,
  };

  let payloadString: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payloadString = typeof body === 'string' ? body : JSON.stringify(body);
  }

  // 1. Preferred Tampermonkey / Greasemonkey API
  if (typeof GM_xmlhttpRequest === 'function') {
    return new Promise<T>((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: payloadString,
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText);
            if (res.status >= 200 && res.status < 300) {
              resolve(data as T);
            } else if (shouldResolveV2Error(res.status, data)) {
              resolve(data as T);
            } else {
              const errMsg =
                data?.error || data?.errorMessage || `HTTP ${res.status}: ${res.responseText}`;
              reject(new Error(errMsg));
            }
          } catch (err) {
            if (res.status >= 200 && res.status < 300) {
              resolve(res.responseText as unknown as T);
            } else {
              reject(new Error(`HTTP ${res.status}: ${res.responseText}`));
            }
          }
        },
        onerror: (err) => {
          reject(new Error(`Network error calling Cloudflare Worker: ${err?.statusText || err || 'Unknown error'}`));
        },
        ontimeout: () => {
          reject(new Error('Request to Cloudflare Worker timed out'));
        },
      });
    });
  }

  // 2. Async GM.xmlHttpRequest API
  if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') {
    const res = await GM.xmlHttpRequest({
      method,
      url,
      headers,
      data: payloadString,
    });
    try {
      const data = JSON.parse(res.responseText);
      if (res.status >= 200 && res.status < 300) {
        return data as T;
      }
      if (shouldResolveV2Error(res.status, data)) {
        return data as T;
      }
      throw new Error(data?.error || data?.errorMessage || `HTTP ${res.status}: ${res.responseText}`);
    } catch (e: any) {
      if (res.status >= 200 && res.status < 300) {
        return res.responseText as unknown as T;
      }
      throw e;
    }
  }

  // 3. Fallback to standard fetch (e.g. node / dev harness)
  if (typeof fetch === 'function') {
    const res = await fetch(url, {
      method,
      headers,
      body: payloadString,
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (res.ok) {
      return data as T;
    }
    if (shouldResolveV2Error(res.status, data)) {
      return data as T;
    }
    throw new Error(data?.error || data?.errorMessage || `HTTP ${res.status}: ${text}`);
  }

  throw new Error('No supported HTTP client found (GM_xmlhttpRequest, GM.xmlHttpRequest, or fetch)');
}

export async function checkWorkerHealth(
  cfg: HudConfig
): Promise<{ status: string; version?: string; hasBridgeSecret?: boolean; hasGithubToken?: boolean }> {
  const url = `${cfg.workerUrl}/health`;
  return gmRequestJson(url, 'GET', cfg.workerSecret);
}

export async function requestRepoMix(
  cfg: HudConfig,
  req?: Partial<MixRequest>
): Promise<MixResponse> {
  const url = `${cfg.workerUrl}/api/mix`;
  const payload: MixRequest = {
    repo: req?.repo || cfg.repo,
    branch: req?.branch || cfg.branch,
    includePaths: req?.includePaths || (cfg.includePaths.length > 0 ? cfg.includePaths : undefined),
    persistToGitHub: req?.persistToGitHub ?? cfg.persistToGitHub,
    maxChunkChars: req?.maxChunkChars ?? cfg.maxChunkChars,
    maxChunkBytes: req?.maxChunkBytes,
    maxChunkTokens: req?.maxChunkTokens,
    splitOutput: req?.splitOutput,
    includeRecentCommits: req?.includeRecentCommits ?? cfg.includeRecentCommits,
  };
  return gmRequestJson<MixResponse>(url, 'POST', cfg.workerSecret, payload);
}

export async function requestWorkerPatch(
  cfg: HudConfig,
  req: WorkerPatchRequest
): Promise<WorkerPatchResponse> {
  const url = `${cfg.workerUrl}/api/patch`;
  return gmRequestJson<WorkerPatchResponse>(url, 'POST', cfg.workerSecret, req);
}

const OID_REGEX = /^[0-9a-f]{40}$/i;

/** Accepts `owner/name`, a GitHub URL or `git@github.com:owner/name`. */
export function parseRepoSlug(repo: string): { owner: string; name: string } {
  const cleaned = (repo || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`Invalid repository "${repo}": expected "owner/name".`);
  }
  return { owner: parts[0], name: parts[1] };
}

/** Pure request builder so the wire contract stays unit-testable without network access. */
export function buildBranchHeadRequestBody(
  repo: string,
  branch: string
): { query: string; variables: { owner: string; repo: string; branch: string } } {
  const { owner, name } = parseRepoSlug(repo);
  const branchName = (branch || '').trim().replace(/^refs\/heads\//, '');
  if (!branchName) {
    throw new Error('Cannot resolve a HEAD OID without a branch name.');
  }
  return {
    query:
      'query BranchHead($owner: String!, $repo: String!, $branch: String!) { repository(owner: $owner, name: $repo) { ref(qualifiedName: $branch) { target { oid } } } }',
    variables: { owner, repo: name, branch: `refs/heads/${branchName}` },
  };
}

/** Extracts `repository.ref.target.oid` from the `/graphql` proxy envelope. */
export function extractBranchHeadOid(payload: unknown): string {
  const oid = (payload as any)?.data?.repository?.ref?.target?.oid;
  return OID_REGEX.test(String(oid || '')) ? String(oid) : '';
}

/**
 * Resolves the current HEAD of `repo@branch` through the authenticated V1 `/graphql`
 * proxy (1 GraphQL call, no tarball). Used when the HUD has no mix snapshot: the
 * resulting OID is a real concurrency token, so a patch is still never committed
 * against an unvalidated revision.
 */
export async function requestBranchHead(
  cfg: HudConfig,
  repo: string,
  branch: string
): Promise<string> {
  const body = buildBranchHeadRequestBody(repo, branch);
  const payload = await gmRequestJson<unknown>(
    `${cfg.workerUrl}/graphql`,
    'POST',
    cfg.workerSecret,
    body
  );
  const oid = extractBranchHeadOid(payload);
  if (!oid) {
    throw new Error(`Branch "${body.variables.branch}" was not found in ${body.variables.owner}/${body.variables.repo}.`);
  }
  return oid;
}

export async function requestLegacyCommit(
  cfg: HudConfig,
  req: CommitRequest
): Promise<any> {
  // Support both /push and /commit on the worker
  const url = `${cfg.workerUrl}/push`;
  return gmRequestJson<any>(url, 'POST', cfg.workerSecret, req);
}
