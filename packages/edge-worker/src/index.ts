import type { WorkerEnv, HybridWorkerEnv, CommitRequest, MixRequest, WorkerPatchRequest } from './types';
import { utf8ToBase64 } from './utils/encoding';
import { resolveFileContent, handlePatchRequest } from './modules/patcher';
import { handleMixRequest } from './modules/mixer';
import { handleGithubWebhookRequest } from './modules/webhookHandler';
import { getBranchHeadOid, fetchFileContent, createCommitOnBranch, executeGraphQL, parseRepoOwner } from './utils/github';
import { normalizeRepoPath, findRepoPathIssue } from '../../../shared/repoPaths';

class ClientValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientValidationError';
  }
}

class UpstreamRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamRequestError';
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-bridge-secret',
  'Access-Control-Max-Age': '86400',
};

export function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}

export function errorResponse(message: string, status = 400, details?: any): Response {
  return jsonResponse({
    success: false,
    error: message,
    ...(details ? { details } : {})
  }, status);
}

export function resolveSecret(env: WorkerEnv): string {
  return env.WORKER_SECRET || env.BRIDGE_SECRET || '';
}

export function resolveGithubToken(env: WorkerEnv): string {
  return env.GITHUB_PAT || env.GITHUB_TOKEN || '';
}

export function verifyAuth(request: Request, env: WorkerEnv): boolean {
  const secret = resolveSecret(env);
  if (!secret) {
    return false;
  }

  const enc = new TextEncoder();
  const secretBytes = enc.encode(secret);

  const customHeader = request.headers.get('x-bridge-secret');
  if (customHeader) {
    const headerBytes = enc.encode(customHeader);
    if (headerBytes.length === secretBytes.length) {
      let result = 0;
      for (let i = 0; i < headerBytes.length; i++) {
        result |= headerBytes[i] ^ secretBytes[i];
      }
      if (result === 0) {
        return true;
      }
    }
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const tokenBytes = enc.encode(token);
    if (tokenBytes.length === secretBytes.length) {
      let result = 0;
      for (let i = 0; i < tokenBytes.length; i++) {
        result |= tokenBytes[i] ^ secretBytes[i];
      }
      if (result === 0) {
        return true;
      }
    }
  }

  return false;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: any): Promise<Response> {
    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // 2. Health check endpoint (public)
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      return jsonResponse({
        status: 'ok',
        service: 'gemini-git-bridge',
        version: '2.0.7',
        timestamp: new Date().toISOString(),
        hasBridgeSecret: Boolean(resolveSecret(env)),
        hasGithubToken: Boolean(resolveGithubToken(env))
      });
    }

    // 2b. GitHub Webhook endpoint (authenticated via HMAC-SHA256 signature, not Bearer token)
    if (path === '/api/webhook/github') {
      return handleGithubWebhookRequest(request, env as HybridWorkerEnv, ctx);
    }

    // 3. Authenticate all protected endpoints
    if (!verifyAuth(request, env)) {
      return errorResponse('Unauthorized: Invalid or missing WORKER_SECRET / BRIDGE_SECRET in Authorization or x-bridge-secret header', 401);
    }

    const githubToken = resolveGithubToken(env);
    if (!githubToken) {
      return errorResponse('Server configuration error: GITHUB_PAT / GITHUB_TOKEN secret is not set in Worker environment.', 500);
    }

    try {
      // 4. V1 Commit / Push Relay Endpoint (Supports POST /push, /commit, /api/commit)
      if (request.method === 'POST' && (path === '/push' || path === '/commit' || path === '/api/commit' || path === '/')) {
        const body = (await request.json().catch(() => {
          throw new ClientValidationError('Malformed JSON payload');
        })) as CommitRequest;

        let owner = '';
        let repo = '';
        try {
          const parsed = parseRepoOwner(body.repo || '', body.owner);
          owner = parsed.owner;
          repo = parsed.repo;
        } catch {
          throw new ClientValidationError('Missing required fields: Repository must be specified as "owner/repo" or separate "owner" and "repo".');
        }

        const commitMessage = body.commitMessage || body.message;
        if (!commitMessage) {
          throw new ClientValidationError('Missing required field: "commitMessage" (or "message") must be specified.');
        }

        const targetBranch = body.targetBranch || body.branch || 'main';
        const fileChanges = body.changes || body.files || [];
        const deletions = body.deletions || [];

        if (fileChanges.length === 0 && deletions.length === 0) {
          throw new ClientValidationError('Commit must include at least one entry in "changes" or "files" or "deletions".');
        }

        // 4a. Resolve HEAD Commit OID for target branch to prevent race conditions
        const { headOid, resolvedBranch } = await getBranchHeadOid(owner, repo, targetBranch, githubToken);
        if (body.expectedHeadOid && body.expectedHeadOid !== headOid) {
          return jsonResponse(
            {
              status: 'GIT_CONFLICT',
              newHeadOid: headOid,
              errorMessage: `Expected HEAD "${body.expectedHeadOid}" but branch "${resolvedBranch}" is at "${headOid}". Fetch the latest repo mix and retry.`
            },
            409
          );
        }

        // 4b. Resolve File Changes (Apply Search/Replace, Hard Guardrail, & encode to Base64)
        const additions: { path: string; contents: string }[] = [];

        for (const fileInput of fileChanges) {
          const pathIssue = findRepoPathIssue(fileInput.path);
          if (pathIssue) {
            throw new ClientValidationError(pathIssue);
          }
          const filePath = normalizeRepoPath(fileInput.path);

          const contentFetcher = async (requestedPath: string) => {
            try {
              return await fetchFileContent(owner, repo, resolvedBranch, requestedPath, githubToken);
            } catch (err: any) {
              throw new UpstreamRequestError(err?.message || 'Failed to fetch existing file from GitHub');
            }
          };

          let resolvedText: string;
          try {
            resolvedText = await resolveFileContent({ ...fileInput, path: filePath }, contentFetcher);
          } catch (err: any) {
            if (err instanceof UpstreamRequestError) {
              throw err;
            }
            throw new ClientValidationError(err?.message || 'Invalid file change payload');
          }
          const encodedBase64 = utf8ToBase64(resolvedText);

          additions.push({
            path: filePath,
            contents: encodedBase64
          });
        }

        // 4c. Format Deletions
        const formattedDeletions: { path: string }[] = deletions.map((del) => {
          const rawPath = typeof del === 'string' ? del : del.path;
          const pathIssue = findRepoPathIssue(rawPath);
          if (pathIssue) {
            throw new ClientValidationError(pathIssue);
          }
          return { path: normalizeRepoPath(rawPath) };
        });

        // 4d. Execute createCommitOnBranch via GitHub GraphQL
        const commitResult = await createCommitOnBranch(
          owner,
          repo,
          resolvedBranch,
          headOid,
          commitMessage,
          additions,
          formattedDeletions,
          githubToken
        );

        return jsonResponse({
          success: true,
          commit: commitResult,
          branch: resolvedBranch,
          repository: `${owner}/${repo}`,
          filesChanged: additions.length + formattedDeletions.length
        });
      }

      // 5. V2 Mix Engine Endpoint (Stage 1)
      if (request.method === 'POST' && path === '/api/mix') {
        const body = (await request.json().catch(() => {
          throw new Error('Malformed JSON payload');
        })) as MixRequest;

        const mixResult = await handleMixRequest(body, githubToken);
        return jsonResponse(mixResult, mixResult.status === 'OK' ? 200 : 400);
      }

      // 6. V2 In-Memory Patcher Endpoint (Stage 2 & Stage 4)
      if (request.method === 'POST' && path === '/api/patch') {
        const body = (await request.json().catch(() => {
          throw new Error('Malformed JSON payload');
        })) as WorkerPatchRequest;

        const patchResult = await handlePatchRequest(body, githubToken);
        return jsonResponse(patchResult, patchResult.status === 'ERROR' ? 400 : 200);
      }

      // 7. Raw GraphQL Proxy Endpoint
      if (request.method === 'POST' && path === '/graphql') {
        const body: any = await request.json().catch(() => {
          throw new Error('Malformed JSON payload');
        });

        if (!body.query) {
          return errorResponse('Missing required field: "query" in GraphQL request.');
        }

        const result = await executeGraphQL(body.query, body.variables || {}, githubToken);
        return jsonResponse({ success: true, data: result });
      }

      return errorResponse(`Endpoint not found: ${request.method} ${path}`, 404);
    } catch (err: any) {
      if (err instanceof ClientValidationError) {
        return errorResponse(err.message, 400);
      }
      console.error('Request processing error:', err);
      return errorResponse(err.message || 'Internal server error', 500);
    }
  }
};
