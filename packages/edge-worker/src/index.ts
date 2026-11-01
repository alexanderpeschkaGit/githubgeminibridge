import type { WorkerEnv, HybridWorkerEnv, CommitRequest, MixRequest, WorkerPatchRequest } from './types';
import {
  handleCommitRequest,
  handlePatchRequest,
  ClientValidationError,
  UpstreamRequestError
} from './modules/patcher';
import { handleMixRequest } from './modules/mixer';
import { handleGithubWebhookRequest } from './modules/webhookHandler';
import { executeGraphQL, classifyGitHubError } from './utils/github';

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

function constantTimeEqual(provided: string, secret: string): boolean {
  const enc = new TextEncoder();
  const providedBytes = enc.encode(provided);
  const secretBytes = enc.encode(secret);
  if (secretBytes.length === 0) {
    return false;
  }
  let diff = providedBytes.length ^ secretBytes.length;
  for (let i = 0; i < secretBytes.length; i++) {
    const pByte = i < providedBytes.length ? providedBytes[i] : 0;
    diff |= pByte ^ secretBytes[i];
  }
  return diff === 0;
}

export function verifyAuth(request: Request, env: WorkerEnv): boolean {
  const secret = resolveSecret(env);
  if (!secret) {
    return false;
  }

  const customHeader = request.headers.get('x-bridge-secret');
  if (customHeader && constantTimeEqual(customHeader, secret)) {
    return true;
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token && constantTimeEqual(token, secret)) {
      return true;
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
        version: '0.80.10',
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

        const commitRes = await handleCommitRequest(body, githubToken);
        return jsonResponse(commitRes.body, commitRes.httpStatus);
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
      if (err instanceof UpstreamRequestError) {
        return errorResponse(err.message, err.httpStatus, {
          errorCode: err.errorCode,
          retryable: err.retryable
        });
      }
      const classified = classifyGitHubError(err);
      console.error('Request processing error:', err);
      return errorResponse(classified.message || 'Internal server error', 500, {
        errorCode: classified.code,
        retryable: classified.retryable
      });
    }
  }
};
