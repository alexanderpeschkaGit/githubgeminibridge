/**
 * Regression: a GitHub tarball 404 must say whether the branch or the repository
 * access is wrong. GitHub returns the same status for a missing ref and for a
 * private/inaccessible repository, so the raw "404: Not Found" body alone sends
 * users into a retry loop.
 *
 * Bug history: the shipped default pair (`Portfolio_VJ_Brave_V2_0@preview`) did not
 * exist (that repository's default branch is `main`), so every "Load Repo Mix"
 * returned `GitHub tarball fetch failed with HTTP 404 (Not Found): 404: Not Found`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const OID_MAIN = 'a'.repeat(40);
const originalFetch = globalThis.fetch;

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function tarballNotFound() {
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: async () => '404: Not Found',
  };
}

const entry = path.join(ROOT, 'packages/edge-worker/src/modules/mixer.ts');
const build = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
const { handleMixRequest } = await import(moduleUrl);

try {
  // 1. Repository is accessible, configured branch is missing: name the default branch.
  const graphqlBodies = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes('/tarball/')) return tarballNotFound();
    if (target.includes('/graphql')) {
      graphqlBodies.push(JSON.parse(options.body));
      return jsonResponse({
        data: {
          repository: {
            id: 'repo-id',
            ref: null,
            defaultBranchRef: { name: 'main', target: { oid: OID_MAIN } },
          },
        },
      });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const missingBranch = await handleMixRequest(
    { repo: 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0', branch: 'preview' },
    'token'
  );
  assert.equal(missingBranch.status, 'ERROR');
  assert.match(missingBranch.errorMessage, /GitHub tarball fetch failed with HTTP 404/);
  assert.match(
    missingBranch.errorMessage,
    /alexanderpeschkaGit\/Portfolio_VJ_Brave_V2_0@preview/
  );
  assert.match(missingBranch.errorMessage, /Branch "preview" does not exist/);
  assert.match(missingBranch.errorMessage, /default branch is "main"/);
  assert.match(missingBranch.errorMessage, /Update the Branch field/);
  assert.equal(graphqlBodies.length, 2, 'branch check plus default-branch hint');
  assert.deepEqual(graphqlBodies[0].variables, {
    owner: 'alexanderpeschkaGit',
    repo: 'Portfolio_VJ_Brave_V2_0',
    branch: 'refs/heads/preview',
  });
  assert.deepEqual(graphqlBodies[1].variables, {
    owner: 'alexanderpeschkaGit',
    repo: 'Portfolio_VJ_Brave_V2_0',
    branch: 'refs/heads/',
  });

  // 2. Repository is missing or the worker token cannot see it: name access, not the branch.
  let accessCalls = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/tarball/')) return tarballNotFound();
    if (target.includes('/graphql')) {
      accessCalls += 1;
      return jsonResponse({
        errors: [
          {
            message:
              "Could not resolve to a Repository with the name 'acme/missing'.",
          },
        ],
      });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const inaccessible = await handleMixRequest({ repo: 'acme/missing', branch: 'main' }, 'token');
  assert.equal(inaccessible.status, 'ERROR');
  assert.match(inaccessible.errorMessage, /not found or is not accessible/);
  assert.match(inaccessible.errorMessage, /Check the Repo field and the active account\/worker/);
  assert.equal(accessCalls, 1, 'no fallback lookup for an inaccessible repository');

  // 3. The ref exists but GitHub still returned 404: report the unexpected tarball failure.
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/tarball/')) return tarballNotFound();
    if (target.includes('/graphql')) {
      return jsonResponse({
        data: {
          repository: {
            id: 'repo-id',
            ref: { name: 'main', target: { oid: OID_MAIN } },
            defaultBranchRef: { name: 'main', target: { oid: OID_MAIN } },
          },
        },
      });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const unexpected = await handleMixRequest({ repo: 'owner/repo', branch: 'main' }, 'token');
  assert.equal(unexpected.status, 'ERROR');
  assert.match(unexpected.errorMessage, /The branch exists \(HEAD aaaaaaa\)/);
  assert.match(unexpected.errorMessage, /failed unexpectedly/);

  // 4. A qualified or blank branch field is normalized before it reaches the tarball route.
  const tarUrls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/tarball/')) {
      tarUrls.push(target);
      return tarballNotFound();
    }
    if (target.includes('/graphql')) {
      return jsonResponse({ errors: [{ message: 'verification skipped' }] });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  await handleMixRequest({ repo: 'owner/repo', branch: ' refs/heads/main ' }, 'token');
  await handleMixRequest({ repo: 'owner/repo', branch: '   ' }, 'token');
  assert.match(tarUrls[0], /\/tarball\/main$/);
  assert.match(tarUrls[1], /\/tarball\/main$/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(
  'PASS: tarball 404 diagnoses missing branch, repo access and unexpected failures'
);
