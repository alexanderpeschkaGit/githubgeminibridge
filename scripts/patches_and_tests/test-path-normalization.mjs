#!/usr/bin/env node
/**
 * Regression suite for repo-relative path canonicalization.
 *
 * GitHub resolves `object(expression: "<oid>:<path>")` strictly, so an LLM path like
 * "./src/a.ts", "/src/a.ts" or "src\a.ts" reads back as `null` and used to surface as
 * the misleading preflight error "Target file does not exist on branch".
 * A patch without any detected path was even silently routed to the harvester's
 * hardcoded placeholder "src/update.ts".
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));
const OID = '1234567890123456789012345678901234567890';

async function bundle(entry, options = {}) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    ...options,
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return import(url);
}

// ---------------------------------------------------------------------------
// 1. Real github.ts: canonical paths in the GraphQL blob lookup and the commit
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
const graphqlBodies = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  graphqlBodies.push(body);
  if (body.query.includes('createCommitOnBranch')) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: {
          createCommitOnBranch: {
            commit: { oid: OID, url: 'https://github.test/commit', messageHeadline: 'msg' },
          },
        },
      }),
    };
  }
  const repository = {};
  for (const [key, expression] of Object.entries(body.variables)) {
    if (!key.startsWith('exp_')) continue;
    repository[`f${key.slice(4)}`] = { text: `content-of:${expression}`, isTruncated: false };
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: { repository } }),
  };
};

try {
  const github = await bundle(path.join(ROOT, 'packages/edge-worker/src/utils/github.ts'));

  const fetched = await github.fetchMultipleFilesViaGraphQL(
    'owner',
    'repo',
    OID,
    ['./src/App.tsx', '/src/App.tsx', 'src\\App.tsx', 'src/App.tsx', '  src/App.tsx  '],
    'token'
  );
  const lookupBody = graphqlBodies.at(-1);
  const expressions = Object.entries(lookupBody.variables)
    .filter(([key]) => key.startsWith('exp_'))
    .map(([, value]) => value);
  assert.deepEqual(expressions, [`${OID}:src/App.tsx`], 'path variants collapse into one canonical lookup');
  assert.deepEqual(Object.keys(fetched), ['src/App.tsx'], 'batch result is keyed by the canonical path');
  assert.equal(fetched['src/App.tsx'], `content-of:${OID}:src/App.tsx`);
  console.log('PASS: ./src, /src, src\\ and padded variants resolve the same blob');

  const emptyLookup = await github.fetchMultipleFilesViaGraphQL('owner', 'repo', OID, ['./'], 'token');
  assert.deepEqual(emptyLookup, {}, 'directory-only paths are never sent to GraphQL');
  console.log('PASS: unusable paths are not sent as blob lookups');

  await github.createCommitOnBranch(
    'owner',
    'repo',
    'main',
    OID,
    'msg',
    [{ path: './src/App.tsx', contents: 'eA==' }],
    [{ path: '/src/old.ts' }],
    'token'
  );
  const commitInput = graphqlBodies.at(-1).variables.input.fileChanges;
  assert.equal(commitInput.additions[0].path, 'src/App.tsx', 'commit additions use the canonical path');
  assert.equal(commitInput.deletions[0].path, 'src/old.ts', 'commit deletions use the canonical path');
  console.log('PASS: commit mutations normalize additions and deletions');
} finally {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// 2. handlePatchRequest: normalization before fetch/commit, actionable path errors
// ---------------------------------------------------------------------------
const calls = [];
globalThis.__pathMocks = {
  calls,
  filesByRevision: new Map(),
  async getBranchHeadOid() {
    return { headOid: OID, resolvedBranch: 'main', repositoryId: 'repo-id' };
  },
  async fetchMultipleFilesViaGraphQL(_owner, _repo, _revision, paths) {
    calls.push({ kind: 'fetch', paths });
    const files = globalThis.__pathMocks.filesByRevision.get(_revision) ?? {};
    return Object.fromEntries(paths.map((file) => [file, files[file] ?? null]));
  },
  async createCommitOnBranch(_owner, _repo, branch, expectedOid, _message, additions, deletions) {
    calls.push({ kind: 'commit', branch, expectedOid, paths: additions.map((a) => a.path), deletions });
    return { oid: 'f'.repeat(40), url: 'https://github.test/commit' };
  },
};

const patcher = await bundle(path.join(ROOT, 'packages/edge-worker/src/modules/patcher.ts'), {
  plugins: [{
    name: 'mock-github-and-linter',
    setup(build) {
      build.onResolve({ filter: /\.\.\/utils\/github$/ }, () => ({ path: 'github-mock', namespace: 'test-mock' }));
      build.onLoad({ filter: /^github-mock$/, namespace: 'test-mock' }, () => ({
        contents: `
          export class BranchNotFoundError extends Error {}
          export const parseRepoOwner = (value) => { const [owner, repo] = value.split('/'); return { owner, repo }; };
          export const getBranchHeadOid = (...args) => globalThis.__pathMocks.getBranchHeadOid(...args);
          export const createBranchRef = async () => { throw new Error('not used'); };
          export const fetchMultipleFilesViaGraphQL = (...args) => globalThis.__pathMocks.fetchMultipleFilesViaGraphQL(...args);
          export const createCommitOnBranch = (...args) => globalThis.__pathMocks.createCommitOnBranch(...args);
        `,
        loader: 'js',
      }));
      build.onResolve({ filter: /(^|\/)linter$/ }, () => ({ path: 'linter-mock', namespace: 'test-mock' }));
      build.onLoad({ filter: /^linter-mock$/, namespace: 'test-mock' }, () => ({
        contents: 'export async function runPreflightLinter() { return []; }',
        loader: 'js',
      }));
    },
  }],
});

const FILE_CONTENT = 'export const APP_NAME = "sikanda";\n';
const baseRequest = (patches) => ({
  repo: 'owner/repo',
  branch: 'main',
  expectedHeadOid: OID,
  payload: { commitMessage: 'test', patches },
});
const modifyBlock = [{ search: 'sikanda', replace: 'sikanda-e2e' }];

globalThis.__pathMocks.filesByRevision.set(OID, { 'src/constants.ts': FILE_CONTENT });
calls.length = 0;
const normalized = await patcher.handlePatchRequest(
  baseRequest([{ path: './src/constants.ts', action: 'modify', blocks: modifyBlock }]),
  'token',
  async () => []
);
assert.equal(normalized.status, 'COMMITTED', JSON.stringify(normalized));
assert.deepEqual(calls.find((c) => c.kind === 'fetch').paths, ['src/constants.ts']);
assert.deepEqual(calls.find((c) => c.kind === 'commit').paths, ['src/constants.ts']);
console.log('PASS: non-canonical patch path is normalized before fetch and commit');

calls.length = 0;
const missingPath = await patcher.handlePatchRequest(
  baseRequest([{ path: '   ', action: 'modify', blocks: modifyBlock }]),
  'token',
  async () => []
);
assert.equal(missingPath.status, 'PREFLIGHT_FAILED');
assert.match(missingPath.errors[0].message, /no file path/i);
assert.equal(calls.length, 0, 'no GitHub call is made for a path-less patch');
console.log('PASS: path-less patch fails with an actionable message instead of "file does not exist"');

calls.length = 0;
const traversal = await patcher.handlePatchRequest(
  baseRequest([{ path: '../secrets/.env', action: 'modify', blocks: modifyBlock }]),
  'token',
  async () => []
);
assert.equal(traversal.status, 'PREFLIGHT_FAILED');
assert.match(traversal.errors[0].message, /must not contain/i);
assert.equal(calls.length, 0);
console.log('PASS: traversal paths are rejected before any network call');

calls.length = 0;
const unknownFile = await patcher.handlePatchRequest(
  baseRequest([{ path: 'src/update.ts', action: 'modify', blocks: modifyBlock }]),
  'token',
  async () => []
);
assert.equal(unknownFile.status, 'PREFLIGHT_FAILED');
assert.match(unknownFile.errors[0].message, /does not exist at the patch base revision/i);
assert.match(unknownFile.errors[0].message, /action "create"/);
console.log('PASS: genuinely missing files report the base revision and the "create" alternative');

// ---------------------------------------------------------------------------
// 3. Harvester: no invented target path, canonical extraction
// ---------------------------------------------------------------------------
const harvester = await bundle(path.join(ROOT, 'packages/userscript-hud/src/dom/harvester.ts'));
const SEARCH_REPLACE_TEXT = [
  '<<<<<<< SEARCH',
  'const a = 1;',
  '=======',
  'const a = 2;',
  '>>>>>>> REPLACE',
].join('\n');

const pathless = harvester.convertLegacyBlocksToV2Payload(SEARCH_REPLACE_TEXT);
assert.equal(pathless.payload.patches[0].path, '', 'no placeholder path is invented');
assert.equal(pathless.payload.commitMessage.includes('src/update.ts'), false);
assert.match(pathless.payload.commitMessage, /no path detected/);
console.log('PASS: path-less harvest stays path-less (no hardcoded src/update.ts)');

const hinted = harvester.convertLegacyBlocksToV2Payload(
  `// filepath: /src/App.tsx\n${SEARCH_REPLACE_TEXT}`
);
assert.equal(hinted.payload.patches[0].path, 'src/App.tsx');
console.log('PASS: inline "// filepath:" hint is canonicalized');

const windowsHinted = harvester.convertLegacyBlocksToV2Payload(
  `// filepath: src\\utils\\helpers.ts\n${SEARCH_REPLACE_TEXT}`
);
assert.equal(windowsHinted.payload.patches[0].path, 'src/utils/helpers.ts');
console.log('PASS: Windows separators in the hint are canonicalized');

const fromHeader = harvester.convertLegacyBlocksToV2Payload(SEARCH_REPLACE_TEXT, '.\\src\\script.tsx');
assert.equal(fromHeader.payload.patches[0].path, 'src/script.tsx');
console.log('PASS: caller-supplied default path is canonicalized');

const headerStub = (text) => ({ previousElementSibling: { textContent: text, previousElementSibling: null } });
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('**src/App.tsx**')), 'src/App.tsx');
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('`./src/utils/helpers.ts`')), 'src/utils/helpers.ts');
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('File: /src/services/r2Sync.ts')), 'src/services/r2Sync.ts');
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('**Pfad:** `src/store/theme.ts`')), 'src/store/theme.ts');
console.log('PASS: markdown-decorated and prefixed filename headers are canonicalized');

// Gemini's default heading styles above a code block (numbered list, heading, bullet, bold)
assert.equal(
  harvester.extractPathFromCode('const a = 1;', headerStub('3. `src/store/portfolioFetchActions.ts`')),
  'src/store/portfolioFetchActions.ts'
);
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('### src/components/App.tsx')), 'src/components/App.tsx');
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('- **src/hooks/useThing.ts**')), 'src/hooks/useThing.ts');
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('Datei: src/legacy/old.ts:')), 'src/legacy/old.ts');
console.log('PASS: numbered, heading, bullet and bold filename headers are canonicalized');

// Never invent a path from prose or a URL
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('Die Datei src/index.ts ist veraltet.')), '');
assert.equal(harvester.extractPathFromCode('const a = 1;', headerStub('https://example.com/main.ts')), '');
console.log('PASS: prose and URLs never yield a path');

// The header may live outside the code block wrapper (Gemini renders it as a sibling of <code-block>)
const blockSiblingStub = {
  previousElementSibling: null,
  closest: () => ({
    previousElementSibling: { textContent: '2. `src/store/actions.ts`', previousElementSibling: null },
  }),
};
assert.equal(harvester.extractPathFromCode('const a = 1;', blockSiblingStub), 'src/store/actions.ts');
console.log('PASS: headers above the enclosing code block are resolved');

// Bare path comment above the diff markers, without the "filepath:" label
const bareCommentHinted = harvester.convertLegacyBlocksToV2Payload(
  `// src/store/portfolioFetchActions.ts\n${SEARCH_REPLACE_TEXT}`
);
assert.equal(bareCommentHinted.payload.patches[0].path, 'src/store/portfolioFetchActions.ts');
console.log('PASS: bare path comment above SEARCH/REPLACE is used as the target path');

// A leading path comment inside plain code is NOT a header (no diff markers follow)
const commentOnly = harvester.convertLegacyBlocksToV2Payload('// src/legacy/note.ts\nconst a = 1;');
assert.equal(commentOnly.payload.patches[0].path, '', 'a leading path comment without markers is not a target');
console.log('PASS: path comments without patch markers stay path-less');

// ---------------------------------------------------------------------------
// 4. HUD path resolution: prompts only for missing paths
// ---------------------------------------------------------------------------
const patchPaths = await bundle(path.join(ROOT, 'packages/userscript-hud/src/services/patchPaths.ts'));
const payloadWith = (patchPath) => ({
  commitMessage: 'm',
  patches: [{ path: patchPath, action: 'modify', blocks: [{ search: 'a', replace: 'b' }] }],
});

let prompts = 0;
const answered = patchPaths.resolvePatchPaths(payloadWith(''), () => {
  prompts++;
  return '/src/App.tsx';
});
assert.equal(answered.cancelled, false);
assert.equal(answered.payload.patches[0].path, 'src/App.tsx');
assert.equal(prompts, 1);

const cancelled = patchPaths.resolvePatchPaths(payloadWith(''), () => null);
assert.equal(cancelled.cancelled, true);
assert.match(cancelled.reason, /no file path provided/i);

const untouched = patchPaths.resolvePatchPaths(payloadWith('src/App.tsx'), () => {
  throw new Error('a detected path must never prompt');
});
assert.equal(untouched.payload.patches[0].path, 'src/App.tsx');
console.log('PASS: missing paths are prompted once, detected paths never prompt');

console.log('\nAll path-normalization checks passed.');
