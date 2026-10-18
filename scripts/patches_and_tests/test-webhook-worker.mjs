import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const WORKER_DIST = path.join(ROOT_DIR, 'packages/edge-worker/dist/worker.mjs');

console.log('=== Stufe III: Funktionaler Test des Edge-Worker GitHub Webhooks (POST /api/webhook/github) ===\n');

let passCount = 0;
let totalCount = 0;

function assert(condition, message) {
  totalCount++;
  if (!condition) {
    console.error(`  ❌ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ [PASS] ${message}`);
  passCount++;
}

// 1. Dynamic import of bundled worker
const workerModule = await import(pathToFileURL(WORKER_DIST).href);
const worker = workerModule.default;

assert(typeof worker?.fetch === 'function', 'Worker default export has fetch handler');

const TEST_SECRET = 'gh_webhook_secret_super_secure_98765';
const TEST_ENV = {
  GITHUB_WEBHOOK_SECRET: TEST_SECRET,
  WORKER_SECRET: 'bridge-secret-12345',
  GITHUB_TOKEN: 'fake-gh-token'
};

// Helper to compute HMAC-SHA256 signature
async function computeSignature(payloadString, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadString));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

// 2. Test HMAC computation helper
const testBody = JSON.stringify({ action: 'created', comment: { body: 'Hello world' } });
const validSignature = await computeSignature(testBody, TEST_SECRET);
assert(validSignature.startsWith('sha256=') && validSignature.length === 71, 'HMAC-SHA256 signature format matches GitHub specification (71 chars)');

// 3. Test CORS Preflight OPTIONS /api/webhook/github
{
  const req = new Request('https://worker.local/api/webhook/github', {
    method: 'OPTIONS',
    headers: { 'Origin': 'https://github.com' }
  });
  const res = await worker.fetch(req, TEST_ENV);
  assert(res.status === 204, 'OPTIONS /api/webhook/github returns 204 No Content for CORS preflight');
  assert(res.headers.get('Access-Control-Allow-Origin') === '*', 'CORS Allow-Origin is *');
}

// 4. Test Invalid HTTP Method (GET instead of POST)
{
  const req = new Request('https://worker.local/api/webhook/github', { method: 'GET' });
  const res = await worker.fetch(req, TEST_ENV);
  assert(res.status === 405, 'GET /api/webhook/github returns 405 Method Not Allowed');
}

// 5. Test Missing Signature Header (Security Guardrail)
{
  const req = new Request('https://worker.local/api/webhook/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: testBody
  });
  const res = await worker.fetch(req, TEST_ENV);
  assert(res.status === 401, 'POST without x-hub-signature-256 returns 401 Unauthorized');
  const data = await res.json();
  assert(data.error?.includes('HMAC signature'), 'Error response explicitly cites HMAC signature missing');
}

// 6. Test Wrong Secret / Tampered Payload (Security Guardrail)
{
  const wrongSignature = await computeSignature(testBody, 'completely-wrong-secret');
  const req = new Request('https://worker.local/api/webhook/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': wrongSignature
    },
    body: testBody
  });
  const res = await worker.fetch(req, TEST_ENV);
  assert(res.status === 401, 'POST with mismatched HMAC signature returns 401 Unauthorized');
}

// 7. Test Tampered Body
{
  const req = new Request('https://worker.local/api/webhook/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': validSignature
    },
    body: testBody + 'tampered'
  });
  const res = await worker.fetch(req, TEST_ENV);
  assert(res.status === 401, 'POST with tampered payload content returns 401 Unauthorized');
}

// 8. Test Malformed JSON Body
{
  const malformed = '{ invalid-json-syntax';
  const malformedSig = await computeSignature(malformed, TEST_SECRET);
  const req = new Request('https://worker.local/api/webhook/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': malformedSig
    },
    body: malformed
  });
  const res = await worker.fetch(req, TEST_ENV);
  assert(res.status === 400, 'POST with malformed JSON body returns 400 Bad Request');
}

// 9. Test Valid Signature without @gemini Trigger
{
  const nonGeminiPayload = JSON.stringify({
    action: 'created',
    issue: { number: 42, comments_url: 'https://api.github.com/repos/owner/repo/issues/42/comments' },
    comment: { body: 'Just a regular developer comment without mentioning the bot' }
  });
  const sig = await computeSignature(nonGeminiPayload, TEST_SECRET);
  const req = new Request('https://worker.local/api/webhook/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': sig
    },
    body: nonGeminiPayload
  });
  const res = await worker.fetch(req, TEST_ENV);
  assert(res.status === 200, 'POST with valid HMAC but without @gemini returns 200 OK');
  const data = await res.json();
  assert(data.status === 'IGNORED', 'Response status is IGNORED');
  assert(data.message?.includes('No @gemini trigger'), 'Message specifies absence of @gemini trigger');
}

// 10. Test Valid Signature WITH @gemini Trigger (P1 Async 202 Accepted & ctx.waitUntil)
{
  const geminiPayload = JSON.stringify({
    action: 'created',
    repository: { full_name: 'sikanda/test-repo', default_branch: 'main' },
    issue: { number: 101, comments_url: 'https://api.github.com/repos/sikanda/test-repo/issues/101/comments' },
    comment: { body: '@gemini please patch authentication handler to use bcrypt' }
  });
  const sig = await computeSignature(geminiPayload, TEST_SECRET);

  let waitUntilInvoked = false;
  let scheduledPromise = null;
  const mockCtx = {
    waitUntil: (p) => {
      waitUntilInvoked = true;
      scheduledPromise = p;
    }
  };

  const req = new Request('https://worker.local/api/webhook/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': sig
    },
    body: geminiPayload
  });

  const res = await worker.fetch(req, TEST_ENV, mockCtx);
  assert(res.status === 202, 'POST with valid @gemini webhook immediately returns HTTP 202 Accepted');
  const data = await res.json();
  assert(data.status === 'ACCEPTED', 'Response status is ACCEPTED');
  assert(data.message?.includes('execution scheduled'), 'Response message confirms execution scheduled');
  assert(waitUntilInvoked === true, 'P1 Invariant: Worker calls ctx.waitUntil() to decouple background execution from 10s webhook response');
  assert(scheduledPromise instanceof Promise, 'Background workflow task is a valid Promise');
}

console.log(`\n🎉 Stufe III Test abgeschlossen: ${passCount}/${totalCount} Assertions bestanden!`);
