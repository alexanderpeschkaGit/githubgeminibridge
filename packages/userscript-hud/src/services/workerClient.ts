import type {
  HudConfig,
  MixRequest,
  MixResponse,
  WorkerPatchRequest,
  WorkerPatchResponse,
  CommitRequest,
} from '../types';

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

export async function requestLegacyCommit(
  cfg: HudConfig,
  req: CommitRequest
): Promise<any> {
  // Support both /push and /commit on the worker
  const url = `${cfg.workerUrl}/push`;
  return gmRequestJson<any>(url, 'POST', cfg.workerSecret, req);
}
