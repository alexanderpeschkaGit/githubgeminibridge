import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));
const OID_SOURCE = '1111111111111111111111111111111111111111';
const OID_SOURCE_NEXT = '2222222222222222222222222222222222222222';
const OID_TARGET = '3333333333333333333333333333333333333333';
const OID_TARGET_NEXT = '4444444444444444444444444444444444444444';
const OID_TARGET_LATER = '5555555555555555555555555555555555555555';

const branches = new Map();
const calls = [];
globalThis.__patchMocks = {
  branches,
  calls,
  parseRepoOwner(value) {
    const [owner, repo] = value.split('/');
    return { owner, repo };
  },
  async getBranchHeadOid(_owner, _repo, branch) {
    const key = branch.replace(/^refs\/heads\//, '');
    if (globalThis.__patchMocks.lookupFailure && key === 'feature') {
      throw new Error('GitHub GraphQL unavailable');
    }
    const entry = branches.get(key);
    if (!entry) {
      throw new globalThis.__patchMocks.BranchNotFoundError('test', 'repo', key);
    }
    return { headOid: entry.headOid, resolvedBranch: key, repositoryId: 'repo-id' };
  },
  async createBranchRef(_owner, _repo, branch, oid) {
    calls.push({ kind: 'create', branch, oid });
    if (globalThis.__patchMocks.createRace) {
      branches.set(branch, {
        headOid: OID_TARGET,
        files: { 'src/file.txt': 'target\ncreated concurrently\n' },
      });
      delete globalThis.__patchMocks.createRace;
      throw new Error('Reference already exists');
    }
    if (branches.has(branch)) throw new Error('Reference already exists');
    const source = branches.get('main');
    branches.set(branch, { headOid: oid, files: { ...source.files } });
    return { refName: `refs/heads/${branch}`, oid };
  },
  async fetchMultipleFilesViaGraphQL(_owner, _repo, revision, paths) {
    calls.push({ kind: 'fetch', revision });
    const entry = [...branches.values()].find((candidate) => candidate.headOid === revision);
    assert.ok(entry, `file read uses resolved commit OID ${revision}`);
    const result = Object.fromEntries(paths.map((file) => [file, entry.files[file] ?? null]));
    if (globalThis.__patchMocks.afterFetch) globalThis.__patchMocks.afterFetch(revision);
    return result;
  },
  async createCommitOnBranch(_owner, _repo, branch, expectedOid, _message, additions, deletions) {
    calls.push({ kind: 'commit', branch, expectedOid });
    const entry = branches.get(branch);
    if (entry.headOid !== expectedOid) throw new Error('expectedHeadOid conflict');
    for (const addition of additions) {
      entry.files[addition.path] = Buffer.from(addition.contents, 'base64').toString('utf8');
    }
    for (const deletion of deletions) delete entry.files[deletion.path];
    entry.headOid = branch === 'main' ? OID_SOURCE_NEXT : OID_TARGET_NEXT;
    return { oid: entry.headOid, url: 'https://github.com/test/repo/commit/next' };
  },
};

const patcherEntry = path.join(ROOT, 'packages/edge-worker/src/modules/patcher.ts');
const patcherBuild = await esbuild.build({
  entryPoints: [patcherEntry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'mock-github-and-linter',
    setup(build) {
      build.onResolve({ filter: /\.\.\/utils\/github$/ }, () => ({
        path: 'github-mocks',
        namespace: 'test-mock',
      }));
      build.onLoad({ filter: /^github-mocks$/, namespace: 'test-mock' }, () => ({
        contents: `
          export class BranchNotFoundError extends Error {}
          globalThis.__patchMocks.BranchNotFoundError = BranchNotFoundError;
          export const parseRepoOwner = (...args) => globalThis.__patchMocks.parseRepoOwner(...args);
          export const getBranchHeadOid = (...args) => globalThis.__patchMocks.getBranchHeadOid(...args);
          export const createBranchRef = (...args) => globalThis.__patchMocks.createBranchRef(...args);
          export const fetchMultipleFilesViaGraphQL = (...args) => globalThis.__patchMocks.fetchMultipleFilesViaGraphQL(...args);
          export const createCommitOnBranch = (...args) => globalThis.__patchMocks.createCommitOnBranch(...args);
        `,
        loader: 'js',
      }));
      build.onResolve({ filter: /(^|\/)linter$/ }, () => ({
        path: 'linter-mock',
        namespace: 'test-mock',
      }));
      build.onLoad({ filter: /^linter-mock$/, namespace: 'test-mock' }, () => ({
        contents: 'export async function runPreflightLinter() { return []; }',
        loader: 'js',
      }));
    },
  }],
});
const patcherUrl = `data:text/javascript;base64,${Buffer.from(patcherBuild.outputFiles[0].text).toString('base64')}`;
const { handlePatchRequest } = await import(patcherUrl);

const helperEntry = path.join(ROOT, 'packages/userscript-hud/src/services/patchOidState.ts');
const helperBuild = await esbuild.build({
  entryPoints: [helperEntry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const helperUrl = `data:text/javascript;base64,${Buffer.from(helperBuild.outputFiles[0].text).toString('base64')}`;
const { advancePatchOidState, buildWorkerPatchRequest } = await import(helperUrl);

const payload = {
  commitMessage: 'preserve target content',
  patches: [{
    path: 'src/file.txt',
    action: 'modify',
    blocks: [{ search: 'target', replace: 'patched target' }],
  }],
};
const sourceEntry = { headOid: OID_SOURCE, files: { 'src/file.txt': 'source-only\n' } };
const targetEntry = { headOid: OID_TARGET, files: { 'src/file.txt': 'target\nkeep me\n' } };
const sourceConfig = {
  repo: 'test/repo',
  branch: 'main',
  targetBranch: 'feature',
  includePaths: [],
  workerUrl: '',
  workerSecret: '',
  autoPilot: false,
  persistToGitHub: false,
  maxChunkChars: 85000,
  includeRecentCommits: false,
};

function reset(entries) {
  branches.clear();
  calls.length = 0;
  for (const [branch, entry] of Object.entries(entries)) {
    branches.set(branch, { headOid: entry.headOid, files: { ...entry.files } });
  }
  delete globalThis.__patchMocks.afterFetch;
  delete globalThis.__patchMocks.lookupFailure;
}

function request(overrides = {}) {
  return {
    repo: 'test/repo',
    branch: 'main',
    expectedHeadOid: OID_SOURCE,
    targetBranch: 'feature',
    payload,
    ...overrides,
  };
}

{
  reset({ main: sourceEntry });
  globalThis.__patchMocks.createRace = true;
  const result = await handlePatchRequest(request(), 'token', async () => []);
  assert.equal(result.status, 'COMMITTED');
  assert.equal(result.createdBranch, false);
  assert.equal(calls.find((call) => call.kind === 'fetch').revision, OID_TARGET);
  assert.equal(calls.find((call) => call.kind === 'commit').expectedOid, OID_TARGET);
  assert.equal(branches.get('feature').files['src/file.txt'], 'patched target\ncreated concurrently\n');
  console.log('PASS: concurrent target creation is re-resolved and applied against the winner branch');
}

{
  reset({ main: sourceEntry, feature: targetEntry });
  const result = await handlePatchRequest(request(), 'token', async () => []);
  assert.equal(result.status, 'COMMITTED');
  assert.equal(calls.find((call) => call.kind === 'fetch').revision, OID_TARGET);
  assert.equal(calls.find((call) => call.kind === 'commit').expectedOid, OID_TARGET);
  assert.equal(branches.get('feature').files['src/file.txt'], 'patched target\nkeep me\n');
  assert.equal(branches.get('main').files['src/file.txt'], 'source-only\n');
  console.log('PASS: existing target content is patched and committed against its own HEAD');
}

{
  reset({ main: sourceEntry, feature: targetEntry });
  const result = await handlePatchRequest(request({ expectedTargetHeadOid: OID_TARGET_NEXT }), 'token', async () => []);
  assert.equal(result.status, 'GIT_CONFLICT');
  assert.equal(calls.some((call) => call.kind === 'fetch' || call.kind === 'commit'), false);
  console.log('PASS: stale queued target OID conflicts before reading or committing');
}

{
  reset({ main: sourceEntry });
  globalThis.__patchMocks.lookupFailure = true;
  const lookupResult = await handlePatchRequest(request(), 'token', async () => []);
  assert.equal(lookupResult.status, 'ERROR');
  assert.equal(calls.some((call) => call.kind === 'create'), false);
  const invalidOidResult = await handlePatchRequest(
    request({ expectedTargetHeadOid: 'not-an-oid' }),
    'token',
    async () => []
  );
  assert.equal(invalidOidResult.status, 'ERROR');
  assert.equal(calls.some((call) => call.kind === 'create'), false);
  console.log('PASS: target lookup failures and malformed OIDs are not treated as missing branches');
}

{
  const creationSource = { headOid: OID_SOURCE, files: { 'src/file.txt': 'target\nsource base\n' } };
  reset({ main: creationSource });
  const result = await handlePatchRequest(request(), 'token', async () => []);
  assert.equal(result.status, 'COMMITTED');
  assert.deepEqual(calls.find((call) => call.kind === 'create'), {
    kind: 'create',
    branch: 'feature',
    oid: OID_SOURCE,
  });
  assert.equal(calls.find((call) => call.kind === 'commit').expectedOid, OID_SOURCE);
  assert.equal(result.createdBranch, true);
  assert.equal(branches.get('feature').files['src/file.txt'], 'patched target\nsource base\n');
  console.log("PASS: missing target is created from the source's validated expected OID");
}

{
  reset({ main: { headOid: OID_SOURCE_NEXT, files: { ...sourceEntry.files } } });
  const result = await handlePatchRequest(request(), 'token', async () => []);
  assert.equal(result.status, 'GIT_CONFLICT');
  assert.equal(calls.some((call) => call.kind === 'create'), false);
  console.log('PASS: stale source snapshot cannot create or patch a target branch');
}

{
  reset({
    main: sourceEntry,
    feature: { headOid: OID_TARGET, files: { 'src/file.txt': 'target\nkeep me\n' } },
  });
  const noOpPayload = {
    commitMessage: 'idempotent',
    patches: [{
      path: 'src/file.txt',
      action: 'modify',
      blocks: [{ search: 'target', replace: 'target' }],
    }],
  };
  const result = await handlePatchRequest(request({ payload: noOpPayload }), 'token', async () => []);
  assert.equal(result.status, 'NO_CHANGES_NEEDED');
  assert.equal(result.newHeadOid, OID_TARGET);
  assert.equal(result.targetBranch, 'feature');
  assert.equal(calls.some((call) => call.kind === 'commit'), false);
  console.log('PASS: no-op response carries the effective target OID without committing');
}

{
  reset({ main: sourceEntry, feature: targetEntry });
  globalThis.__patchMocks.afterFetch = (revision) => {
    if (revision === OID_TARGET) branches.get('feature').headOid = OID_TARGET_LATER;
  };
  const result = await handlePatchRequest(request(), 'token', async () => []);
  assert.equal(result.status, 'GIT_CONFLICT');
  assert.equal(result.newHeadOid, OID_TARGET_LATER);
  assert.equal(branches.get('feature').files['src/file.txt'], 'target\nkeep me\n');
  console.log('PASS: target race after read is rejected by the atomic commit OID gate');
}

{
  const state = {
    headOid: OID_SOURCE,
    targetHeadOid: OID_TARGET,
    targetHeadBranch: 'feature',
  };
  const first = buildWorkerPatchRequest(sourceConfig, state, payload);
  assert.equal(first.expectedHeadOid, OID_SOURCE);
  assert.equal(first.expectedTargetHeadOid, OID_TARGET);
  Object.assign(state, advancePatchOidState(sourceConfig, {
    status: 'COMMITTED',
    targetBranch: 'feature',
    newHeadOid: OID_TARGET_NEXT,
  }));
  const second = buildWorkerPatchRequest(sourceConfig, state, payload);
  assert.equal(second.expectedHeadOid, OID_SOURCE);
  assert.equal(second.expectedTargetHeadOid, OID_TARGET_NEXT);

  Object.assign(state, advancePatchOidState(sourceConfig, {
    status: 'NO_CHANGES_NEEDED',
    targetBranch: 'feature',
    newHeadOid: OID_TARGET_LATER,
  }));
  assert.equal(state.targetHeadOid, OID_TARGET_LATER);
  assert.equal(state.headOid, OID_SOURCE);

  const beforeFailure = { ...state };
  Object.assign(state, advancePatchOidState(sourceConfig, {
    status: 'NO_CHANGES_NEEDED',
    newHeadOid: OID_TARGET,
  }));
  assert.deepEqual(state, beforeFailure);
  Object.assign(state, advancePatchOidState(sourceConfig, {
    status: 'GIT_CONFLICT',
    targetBranch: 'feature',
    newHeadOid: OID_TARGET,
  }));
  assert.deepEqual(state, beforeFailure);
  Object.assign(state, advancePatchOidState(sourceConfig, {
    status: 'PREFLIGHT_FAILED',
    targetBranch: 'feature',
    newHeadOid: OID_TARGET,
  }));
  assert.deepEqual(state, beforeFailure);

  Object.assign(state, advancePatchOidState(sourceConfig, {
    status: 'COMMITTED',
    targetBranch: 'main',
    newHeadOid: OID_SOURCE_NEXT,
  }));
  assert.equal(state.headOid, OID_SOURCE_NEXT);
  assert.equal(state.targetHeadOid, OID_TARGET_LATER);
  console.log('PASS: FIFO target OIDs advance independently; no-op/failure and source-branch handling stay consistent');
}
