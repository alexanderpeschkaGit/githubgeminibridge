import type {
  HybridWorkerEnv,
  HybridTaskResult,
  GitHubWebhookPayload,
  GeminiPatchPayload
} from '../types';
import { handleMixRequest } from './mixer';
import { handlePatchRequest } from './patcher';

/**
 * Computes an HMAC-SHA256 signature in GitHub format ("sha256=<hex>").
 * Uses pure Web Crypto API (SubtleCrypto).
 */
export async function computeGithubWebhookSignature(
  rawBody: string | ArrayBuffer,
  secret: string
): Promise<string> {
  const enc = new TextEncoder();
  const keyData = enc.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = typeof rawBody === 'string' ? enc.encode(rawBody) : new Uint8Array(rawBody);
  const signature = await crypto.subtle.sign('HMAC', key, data);
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

/**
 * Verifies GitHub x-hub-signature-256 header using Web Crypto API.
 * Guarantees constant-time comparison via crypto.subtle.verify.
 */
export async function verifyGithubWebhookSignature(
  rawBody: string | ArrayBuffer,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  if (!signatureHeader || !secret) {
    return false;
  }
  if (!signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const hex = signatureHeader.slice(7).trim();
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    return false;
  }

  const sigBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sigBytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }

  const enc = new TextEncoder();
  const keyData = enc.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const data = typeof rawBody === 'string' ? enc.encode(rawBody) : new Uint8Array(rawBody);
  return await crypto.subtle.verify('HMAC', key, sigBytes, data);
}

/**
 * Helper to post feedback comments back to GitHub PR/Issue.
 */
export async function postGithubComment(
  commentsUrl: string,
  body: string,
  token: string
): Promise<boolean> {
  try {
    const res = await fetch(commentsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'gemini-git-bridge/2.0.0'
      },
      body: JSON.stringify({ body })
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Parses Gemini response text and extracts JSON patch payload.
 */
export function extractPatchPayload(text: string): GeminiPatchPayload {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const rawJson = (match && match[1]) ? match[1].trim() : text.trim();
  return JSON.parse(rawJson) as GeminiPatchPayload;
}

/**
 * Executes the full background worker workflow:
 * 1. Mixes repo context via handleMixRequest
 * 2. Asks Gemini REST API for GeminiPatchPayload
 * 3. Applies patches in-memory and commits via handlePatchRequest
 * 4. Posts result comment back to GitHub Issue or PR
 */
export async function executeWorkerWorkflow(
  payload: GitHubWebhookPayload,
  env: HybridWorkerEnv
): Promise<HybridTaskResult> {
  const repo = payload.repository?.full_name;
  if (!repo) {
    return { mode: 'worker', status: 'ERROR', message: 'Missing repository in payload' };
  }

  const branch =
    payload.pull_request?.head?.ref ||
    payload.repository?.default_branch ||
    'main';

  const rawComment =
    payload.comment?.body ||
    payload.issue?.body ||
    payload.pull_request?.body ||
    '';

  // Strip @gemini mention
  const prompt = rawComment.replace(/@gemini\b/gi, '').trim();
  if (!prompt) {
    return { mode: 'worker', status: 'ERROR', message: 'No instruction prompt found after @gemini mention' };
  }

  const githubToken = env.GITHUB_PAT || env.GITHUB_TOKEN;
  if (!githubToken) {
    return { mode: 'worker', status: 'ERROR', message: 'GITHUB_PAT / GITHUB_TOKEN not configured in Worker environment' };
  }

  const commentsUrl = payload.issue?.comments_url || payload.pull_request?.comments_url;

  try {
    // 1. Repo Mix
    const mixResult = await handleMixRequest({ repo, branch }, githubToken);
    if (mixResult.status !== 'OK') {
      const err = mixResult.errorMessage || 'Failed to assemble repository context';
      if (commentsUrl) {
        await postGithubComment(commentsUrl, `❌ **Gemini Bridge Error:** Failed to mix repository context: ${err}`, githubToken);
      }
      return { mode: 'worker', status: 'ERROR', message: err };
    }

    // 2. Query Gemini REST API
    const geminiApiKey = env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      const err = 'GEMINI_API_KEY not configured in Worker environment';
      if (commentsUrl) {
        await postGithubComment(commentsUrl, `❌ **Gemini Bridge Error:** ${err}`, githubToken);
      }
      return { mode: 'worker', status: 'ERROR', message: err };
    }

    const systemPrompt = `You are an automated Git patch assistant.
Given a repository XML context and an issue prompt, return ONLY a valid JSON object strictly conforming to the GeminiPatchPayload schema.
Do NOT output markdown fences or additional text.`;

    const userQuery = `Task Instruction:\n${prompt}\n\nRepository Context:\n${mixResult.xmlContent}`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemPrompt}\n\n${userQuery}` }]
            }
          ]
        })
      }
    );

    if (!geminiRes.ok) {
      const statusText = await geminiRes.text();
      const err = `Gemini API call failed (${geminiRes.status}): ${statusText}`;
      if (commentsUrl) {
        await postGithubComment(commentsUrl, `❌ **Gemini Bridge Error:** ${err}`, githubToken);
      }
      return { mode: 'worker', status: 'ERROR', message: err };
    }

    const geminiData: any = await geminiRes.json();
    const candidateText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const patchPayload = extractPatchPayload(candidateText);

    // 3. Apply Patch via Patcher Engine
    const patchResponse = await handlePatchRequest(
      {
        repo,
        branch,
        expectedHeadOid: mixResult.headOid,
        payload: patchPayload
      },
      githubToken
    );

    // 4. Post Feedback Comment
    if (commentsUrl) {
      if (patchResponse.status === 'COMMITTED') {
        const msg = `✅ **Gemini Bridge applied patch successfully!**\n\n- Commit: \`${patchResponse.newHeadOid}\`\n- Headline: ${patchPayload.commitMessage}`;
        await postGithubComment(commentsUrl, msg, githubToken);
      } else if (patchResponse.status === 'PREFLIGHT_FAILED') {
        const errorList = (patchResponse.errors || [])
          .map((e) => `- [${e.stage}] \`${e.file}:${e.line || 1}\` ${e.message}`)
          .join('\n');
        const msg = `❌ **Gemini Bridge Preflight Linter Failed:**\n\n${errorList}`;
        await postGithubComment(commentsUrl, msg, githubToken);
      } else {
        const msg = `⚠️ **Gemini Bridge Patch Result:** ${patchResponse.status}\n${patchResponse.errorMessage || ''}`;
        await postGithubComment(commentsUrl, msg, githubToken);
      }
    }

    return {
      mode: 'worker',
      status: patchResponse.status === 'COMMITTED' ? 'SUCCESS' : (patchResponse.status === 'PREFLIGHT_FAILED' ? 'PREFLIGHT_FAILED' : 'ERROR'),
      commitSha: patchResponse.newHeadOid,
      errors: patchResponse.errors,
      message: patchResponse.errorMessage
    };
  } catch (err: any) {
    if (commentsUrl) {
      await postGithubComment(commentsUrl, `💥 **Gemini Bridge Execution Exception:** ${err.message}`, githubToken);
    }
    return { mode: 'worker', status: 'ERROR', message: err.message, errors: [err] };
  }
}

/**
 * Route handler for POST /api/webhook/github.
 * Verifies HMAC signature, validates @gemini trigger, responds with 202 immediately,
 * and schedules background execution via ctx.waitUntil.
 */
export async function handleGithubWebhookRequest(
  request: Request,
  env: HybridWorkerEnv,
  ctx?: { waitUntil: (p: Promise<any>) => void }
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get('x-hub-signature-256');
  const secret = env.GITHUB_WEBHOOK_SECRET || env.WORKER_SECRET || env.BRIDGE_SECRET || '';

  const isValid = await verifyGithubWebhookSignature(rawBody, signatureHeader, secret);
  if (!isValid) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized: Invalid GitHub webhook HMAC signature' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubWebhookPayload;
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Malformed JSON payload' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const commentText =
    payload.comment?.body ||
    payload.issue?.body ||
    payload.pull_request?.body ||
    '';

  const hasGeminiMention = /@gemini\b/i.test(commentText);
  if (!hasGeminiMention) {
    return new Response(
      JSON.stringify({ status: 'IGNORED', message: 'No @gemini trigger found in payload' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // P1: Respond immediately with 202 Accepted to prevent GitHub 10s webhook timeout.
  // Execution runs in background via ctx.waitUntil.
  const workflowPromise = executeWorkerWorkflow(payload, env).catch((err) => {
    console.error('[webhookHandler] Background workflow unhandled error:', err);
  });

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(workflowPromise);
  }

  return new Response(
    JSON.stringify({
      status: 'ACCEPTED',
      message: 'Webhook received, signature verified, and execution scheduled.'
    }),
    { status: 202, headers: { 'Content-Type': 'application/json' } }
  );
}
