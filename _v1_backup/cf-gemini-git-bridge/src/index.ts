import type { Env, CommitRequest } from './types';
import { utf8ToBase64 } from './encoding';
import { resolveFileContent } from './patch';
import { getBranchHeadOid, fetchFileContent, createCommitOnBranch, executeGraphQL } from './github';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-bridge-secret',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}

function errorResponse(message: string, status = 400, details?: any): Response {
  return jsonResponse({
    success: false,
    error: message,
    ...(details ? { details } : {})
  }, status);
}

function verifyAuth(request: Request, env: Env): boolean {
  if (!env.BRIDGE_SECRET) {
    return false;
  }

  const customHeader = request.headers.get('x-bridge-secret');
  if (customHeader && customHeader === env.BRIDGE_SECRET) {
    return true;
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token === env.BRIDGE_SECRET) {
      return true;
    }
  }

  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        hasBridgeSecret: Boolean(env.BRIDGE_SECRET),
        hasGithubToken: Boolean(env.GITHUB_TOKEN)
      });
    }

    // 3. Authenticate all protected endpoints
    if (!verifyAuth(request, env)) {
      return errorResponse('Unauthorized: Invalid or missing BRIDGE_SECRET in Authorization or x-bridge-secret header', 401);
    }

    if (!env.GITHUB_TOKEN) {
      return errorResponse('Server configuration error: GITHUB_TOKEN secret is not set in Worker environment.', 500);
    }

    try {
      // 4. Commit / Push Relay Endpoint (Supports POST /push, /commit, /api/commit)
      if (request.method === 'POST' && (path === '/push' || path === '/commit' || path === '/api/commit' || path === '/')) {
        const body = (await request.json().catch(() => {
          throw new Error('Malformed JSON payload');
        })) as CommitRequest;

        // Parse owner and repo
        let owner = body.owner || '';
        let repo = body.repo || '';

        if (!owner && repo.includes('/')) {
          const parts = repo.split('/');
          owner = parts[0];
          repo = parts.slice(1).join('/');
        }

        if (!owner || !repo) {
          return errorResponse('Missing required fields: Repository must be specified as "owner/repo" or separate "owner" and "repo".');
        }

        const commitMessage = body.commitMessage || body.message;
        if (!commitMessage) {
          return errorResponse('Missing required field: "commitMessage" (or "message") must be specified.');
        }

        const targetBranch = body.targetBranch || body.branch || 'main';
        const fileChanges = body.changes || body.files || [];
        const deletions = body.deletions || [];

        if (fileChanges.length === 0 && deletions.length === 0) {
          return errorResponse('Commit must include at least one entry in "changes" or "files" or "deletions".');
        }

        // 4a. Resolve HEAD Commit OID for target branch to prevent race conditions
        const { headOid, resolvedBranch } = await getBranchHeadOid(owner, repo, targetBranch, env.GITHUB_TOKEN);

        // 4b. Resolve File Changes (Apply Search/Replace, Hard Guardrail, & encode to Base64)
        const additions: { path: string; contents: string }[] = [];

        for (const fileInput of fileChanges) {
          if (!fileInput.path) {
            throw new Error('Every file entry must contain a "path" property.');
          }

          const contentFetcher = async (filePath: string) => {
            return await fetchFileContent(owner, repo, resolvedBranch, filePath, env.GITHUB_TOKEN);
          };

          const resolvedText = await resolveFileContent(fileInput, contentFetcher);
          const encodedBase64 = utf8ToBase64(resolvedText);

          additions.push({
            path: fileInput.path,
            contents: encodedBase64
          });
        }

        // 4c. Format Deletions
        const formattedDeletions: { path: string }[] = deletions.map((del) => {
          return typeof del === 'string' ? { path: del } : { path: del.path };
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
          env.GITHUB_TOKEN
        );

        return jsonResponse({
          success: true,
          commit: commitResult,
          branch: resolvedBranch,
          repository: `${owner}/${repo}`,
          filesChanged: additions.length + formattedDeletions.length
        });
      }

      // 5. Raw GraphQL Proxy Endpoint
      if (request.method === 'POST' && path === '/graphql') {
        const body: any = await request.json().catch(() => {
          throw new Error('Malformed JSON payload');
        });

        if (!body.query) {
          return errorResponse('Missing required field: "query" in GraphQL request.');
        }

        const result = await executeGraphQL(body.query, body.variables || {}, env.GITHUB_TOKEN);
        return jsonResponse({ success: true, data: result });
      }

      return errorResponse(`Endpoint not found: ${request.method} ${path}`, 404);
    } catch (err: any) {
      console.error('Request processing error:', err);
      return errorResponse(err.message || 'Internal server error', 500, {
        stack: err.stack
      });
    }
  }
};
