#!/usr/bin/env node
/**
 * Live end-to-end probe of the V2 patch pipeline against a real repository.
 *
 * The suite bundles `packages/edge-worker/src/index.ts` and drives the worker's
 * `fetch` handler directly, so auth, path canonicalization, the GraphQL blob batch,
 * the in-memory search/replace and the preflight aggregation are all exercised
 * against the real GitHub API (no mocking, no deploy needed).
 *
 * Read-only by default. Writing a commit requires `--commit`, which only ever
 * targets a throwaway `gemini-bridge-e2e-<timestamp>` branch that is deleted again.
 *
 * Usage:
 *   node scripts/patches_and_tests/test-live-patch-e2e.mjs
 *   node scripts/patches_and_tests/test-live-patch-e2e.mjs --repo owner/name --branch main
 *   node scripts/patches_and_tests/test-live-patch-e2e.mjs --file src/constants.ts --commit
 *
 * Token: GITHUB_TOKEN / GH_TOKEN in the environment, otherwise `gh auth token`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const REPO = argValue('--repo') || 'alexanderpeschkaGit/sikanda_projectinart_11';
const BRANCH = argValue('--branch') || 'main';
const COMMIT = args.includes('--commit');
const REVISION_MARKER = `bridge-e2e-${Date.now()}`;
const SECRET = 'e2e-worker-secret';

function resolveToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

const token = resolveToken();
assert.ok(token, 'a GitHub token is required (GITHUB_TOKEN or `gh auth token`)');

const build = await esbuild.build({
  entryPoints: [path.join(ROOT, 'packages/edge-worker/src/index.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const workerUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
const worker = (await import(workerUrl)).default;
const env = { GITHUB_PAT: token, WORKER_SECRET: SECRET };

async function callWorker(pathname, body) {
  const request = new Request(`https://worker.local${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, env);
  return { httpStatus: response.status, body: await response.json() };
}

async function githubRest(apiPath, init = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gemini-git-bridge-e2e',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GitHub REST ${init.method || 'GET'} ${apiPath} failed: ${response.status} ${text}`);
  }
  return json;
}

const [owner, repoName] = REPO.split('/');
const scratchBranch = `gemini-bridge-e2e-${REVISION_MARKER}`;
const IMPOSSIBLE_SEARCH = '__GEMINI_BRIDGE_E2E_NONEXISTENT_ANCHOR__';
const IMPOSSIBLE_REPLACE = '__GEMINI_BRIDGE_E2E_NONEXISTENT_REPLACEMENT__';
const hasErrorMatching = (result, pattern) =>
  Array.isArray(result.body?.errors) && result.body.errors.some((error) => pattern.test(error.message));

console.log(`[live-e2e] repo=${REPO} branch=${BRANCH} mode=${COMMIT ? 'commit' : 'read-only'}`);

let passed = 0;
function pass(label) {
  passed++;
  console.log(`PASS: ${label}`);
}

async function blobText(expression) {
  const res = await callWorker('/graphql', {
    query:
      'query Blob($owner: String!, $repo: String!, $expr: String!) { repository(owner: $owner, name: $repo) { object(expression: $expr) { ... on Blob { text } } } }',
    variables: { owner, repo: repoName, expr: expression },
  });
  assert.equal(res.httpStatus, 200, JSON.stringify(res.body));
  return res.body?.data?.repository?.object?.text ?? null;
}

try {
  // 1. Health + HEAD resolution through the real proxy
  const health = await callWorker('/health');
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.hasGithubToken, true);
  pass('/health reports a configured token');

  const head = await callWorker('/graphql', {
    query:
      'query Head($owner: String!, $repo: String!, $branch: String!) { repository(owner: $owner, name: $repo) { ref(qualifiedName: $branch) { target { oid } } } }',
    variables: { owner, repo: repoName, branch: `refs/heads/${BRANCH}` },
  });
  const headOid = head.body?.data?.repository?.ref?.target?.oid;
  assert.match(String(headOid), /^[0-9a-f]{40}$/, `HEAD of ${BRANCH} must resolve: ${JSON.stringify(head.body)}`);
  console.log(`[live-e2e] ${BRANCH} HEAD ${headOid}`);

  // 2. Pick a real file that exists on the branch
  let targetFile = argValue('--file');
  if (!targetFile) {
    const entries = await githubRest(`/repos/${owner}/${repoName}/contents/src?ref=${encodeURIComponent(headOid)}`);
    const candidate = entries.find(
      (entry) => entry.type === 'file' && /\.(ts|tsx|js|jsx|md|json)$/.test(entry.name)
    );
    assert.ok(candidate, 'no suitable file found under src/');
    targetFile = candidate.path;
  }
  const targetContent = await blobText(`${headOid}:${targetFile}`);
  assert.ok(targetContent && targetContent.length > 0, `${targetFile} must be readable at ${headOid}`);
  console.log(`[live-e2e] probe file ${targetFile} (${targetContent.length} chars)`);

  const missingFile = argValue('--missing') || 'src/update.ts';
  assert.equal(await blobText(`${headOid}:${missingFile}`), null, `${missingFile} is expected to be absent`);
  pass(`${missingFile} is genuinely absent on ${BRANCH}`);

  const patchRequest = (patch) => ({
    repo: REPO,
    branch: BRANCH,
    expectedHeadOid: headOid,
    payload: { commitMessage: 'bridge e2e probe', patches: [patch] },
  });

  // 3. Canonical path reaches the file (the search resolves to a preflight error,
  //    which proves the blob was read instead of reported as missing).
  const canonical = await callWorker(
    '/api/patch',
    patchRequest({
      path: targetFile,
      action: 'modify',
      blocks: [{ search: IMPOSSIBLE_SEARCH, replace: IMPOSSIBLE_REPLACE }],
    })
  );
  assert.equal(canonical.body.status, 'PREFLIGHT_FAILED', JSON.stringify(canonical.body));
  assert.ok(hasErrorMatching(canonical, /could not be resolved/i), JSON.stringify(canonical.body));
  assert.equal(
    hasErrorMatching(canonical, /OXC_SYNTAX/),
    false,
    `no bogus syntax errors for a valid file: ${JSON.stringify(canonical.body)}`
  );
  pass(`canonical path "${targetFile}" reads the real blob`);

  // 4. Non-canonical path variants address the same blob (the reported bug shape)
  for (const variant of [`/./${targetFile}`, `./${targetFile}`, targetFile.replace(/\//g, '\\')]) {
    const res = await callWorker(
      '/api/patch',
      patchRequest({
        path: variant,
        action: 'modify',
        blocks: [{ search: IMPOSSIBLE_SEARCH, replace: IMPOSSIBLE_REPLACE }],
      })
    );
    assert.equal(res.body.status, 'PREFLIGHT_FAILED', JSON.stringify(res.body));
    assert.ok(
      hasErrorMatching(res, /could not be resolved/i),
      `path variant "${variant}" must resolve: ${JSON.stringify(res.body)}`
    );
    assert.equal(hasErrorMatching(res, /does not exist/i), false, JSON.stringify(res.body));
  }
  pass('"./", "/./" and backslash variants resolve the same blob');

  // 5. The old bogus default path now fails with an accurate, actionable message
  const bogus = await callWorker(
    '/api/patch',
    patchRequest({
      path: missingFile,
      action: 'modify',
      blocks: [{ search: IMPOSSIBLE_SEARCH, replace: IMPOSSIBLE_REPLACE }],
    })
  );
  assert.equal(bogus.body.status, 'PREFLIGHT_FAILED', JSON.stringify(bogus.body));
  assert.ok(hasErrorMatching(bogus, /does not exist at the patch base revision/i), JSON.stringify(bogus.body));
  assert.ok(hasErrorMatching(bogus, /action "create"/i), JSON.stringify(bogus.body));
  pass(`"${missingFile}" reports an accurate base-revision error`);

  // 6. A path-less patch never reaches GitHub
  const pathless = await callWorker(
    '/api/patch',
    patchRequest({ path: '', action: 'modify', blocks: [{ search: 'x', replace: 'y' }] })
  );
  assert.equal(pathless.body.status, 'PREFLIGHT_FAILED', JSON.stringify(pathless.body));
  assert.ok(hasErrorMatching(pathless, /no file path/i), JSON.stringify(pathless.body));
  pass('path-less patch is rejected before any GitHub call');

  // 7. Optional write path: full commit on a throwaway branch
  if (COMMIT) {
    const anchor = targetContent
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line.length < 120);
    assert.ok(anchor, `no usable search anchor in ${targetFile}`);

    const committed = await callWorker(
      '/api/patch',
      {
        repo: REPO,
        branch: BRANCH,
        expectedHeadOid: headOid,
        targetBranch: scratchBranch,
        payload: {
          commitMessage: `chore(e2e): verify patch pipeline ${REVISION_MARKER}`,
          patches: [{
            path: `./${targetFile}`,
            action: 'modify',
            blocks: [{
              search: anchor,
              replace: `${anchor}\n// ${REVISION_MARKER}`,
            }],
          }],
        },
      }
    );
    assert.equal(committed.body.status, 'COMMITTED', JSON.stringify(committed.body));
    assert.equal(committed.body.targetBranch, scratchBranch);
    assert.equal(committed.body.createdBranch, true);
    assert.match(String(committed.body.newHeadOid), /^[0-9a-f]{40}$/);
    pass(`search/replace committed to throwaway branch ${scratchBranch}`);

    const committedText = await blobText(`${committed.body.newHeadOid}:${targetFile}`);
    assert.ok(committedText.includes(REVISION_MARKER), 'committed blob must contain the marker');
    pass('committed blob on the throwaway branch contains the replacement');

    const sourceText = await blobText(`${headOid}:${targetFile}`);
    assert.equal(sourceText, targetContent, `source branch ${BRANCH} must stay untouched`);
    pass(`${BRANCH} is unchanged by the throwaway-branch commit`);
  } else {
    console.log('[live-e2e] write path skipped (pass --commit to run it)');
  }
} finally {
  if (COMMIT) {
    try {
      await githubRest(`/repos/${owner}/${repoName}/git/refs/heads/${scratchBranch}`, { method: 'DELETE' });
      console.log(`[live-e2e] deleted throwaway branch ${scratchBranch}`);
    } catch (error) {
      console.error(`[live-e2e] cleanup failed for ${scratchBranch}: ${error.message}`);
    }
  }
}

console.log(`\n[live-e2e] ${passed} checks passed against ${REPO}@${BRANCH}`);
