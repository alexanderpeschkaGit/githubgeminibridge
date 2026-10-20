/**
 * Regression: persisted HUD patch OIDs must be scoped to the configured repo+branch.
 *
 * Bug history: `head_oid` was stored repo-agnostically. After switching the repo field
 * (e.g. `sikanda_projectinart_11` -> `sikanda_projectinart_11-on-main`) the HUD sent the
 * OID of the *other* repo as `expectedHeadOid`, so the worker correctly answered
 * GIT_CONFLICT even though nothing in the target branch had been touched by the user.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const OID_REPO_A = '639fb9e522800b24e9693bbc17558b7c4db2ec50';
const OID_REPO_B = '715102671660f74ad289e27a1e30a154490d902b';
const OID_TARGET = '3333333333333333333333333333333333333333';

const entry = path.join(ROOT, 'packages/userscript-hud/src/services/patchOidState.ts');
const build = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
const {
  buildOidScope,
  resolvePatchOidState,
  buildWorkerPatchRequest,
  isPatchSnapshotReady,
  patchSnapshotRequiredMessage,
  resolveConflictOidReset,
} = await import(moduleUrl);

const configA = {
  repo: 'alexanderpeschkaGit/sikanda_projectinart_11',
  branch: 'main',
  targetBranch: '',
  includePaths: [],
  workerUrl: '',
  workerSecret: '',
  autoPilot: false,
  persistToGitHub: false,
  maxChunkChars: 85000,
  includeRecentCommits: false,
};
const configB = { ...configA, repo: 'alexanderpeschkaGit/sikanda_projectinart_11-on-main' };

assert.equal(buildOidScope(configA), 'alexanderpeschkagit/sikanda_projectinart_11#main');
assert.notEqual(buildOidScope(configA), buildOidScope(configB));
assert.equal(buildOidScope({ repo: ' A/B ', branch: 'refs/heads/Main' }), 'a/b#main');

const stored = {
  headOidScope: buildOidScope(configA),
  headOid: OID_REPO_A,
  targetHeadOid: '',
  targetHeadBranch: '',
};

// 1. Same repo+branch: the stored snapshot OID is reused.
assert.deepEqual(resolvePatchOidState(configA, stored), {
  headOid: OID_REPO_A,
  targetHeadOid: '',
  targetHeadBranch: '',
});
assert.equal(buildWorkerPatchRequest(configA, resolvePatchOidState(configA, stored), { patches: [] }).expectedHeadOid, OID_REPO_A);

// 2. Repo switched: the foreign OID must never be sent as expectedHeadOid.
const restoredB = resolvePatchOidState(configB, stored);
assert.deepEqual(restoredB, { headOid: '', targetHeadOid: '', targetHeadBranch: '' });
assert.equal(buildWorkerPatchRequest(configB, restoredB, { patches: [] }).expectedHeadOid, '');

// 3. Branch switched within the same repo: also invalid.
assert.deepEqual(
  resolvePatchOidState({ ...configA, branch: 'preview' }, stored),
  { headOid: '', targetHeadOid: '', targetHeadBranch: '' }
);

// 4. Legacy entries without a scope marker (pre-2.0.3 storage) are discarded.
assert.deepEqual(
  resolvePatchOidState(configA, { ...stored, headOidScope: '' }),
  { headOid: '', targetHeadOid: '', targetHeadBranch: '' }
);

// 5. Malformed/stale OIDs are dropped even when the scope matches.
assert.deepEqual(
  resolvePatchOidState(configA, { ...stored, headOid: 'not-an-oid' }),
  { headOid: '', targetHeadOid: '', targetHeadBranch: '' }
);

// 6. Target OIDs survive only for the configured distinct target branch of that scope.
const distinctTarget = { ...configA, targetBranch: 'feature' };
const targetStored = {
  headOidScope: buildOidScope(distinctTarget),
  headOid: OID_REPO_A,
  targetHeadOid: OID_TARGET,
  targetHeadBranch: 'feature',
};
assert.deepEqual(resolvePatchOidState(distinctTarget, targetStored), {
  headOid: OID_REPO_A,
  targetHeadOid: OID_TARGET,
  targetHeadBranch: 'feature',
});
assert.deepEqual(
  resolvePatchOidState({ ...distinctTarget, targetBranch: 'other' }, targetStored),
  { headOid: OID_REPO_A, targetHeadOid: '', targetHeadBranch: '' }
);
assert.deepEqual(
  resolvePatchOidState({ ...distinctTarget, repo: 'other/repo' }, targetStored),
  { headOid: '', targetHeadOid: '', targetHeadBranch: '' }
);

// 7. A patch is never committed without a validated snapshot OID (no V1 /push fallback).
assert.equal(isPatchSnapshotReady({ headOid: '' }), false);
assert.equal(isPatchSnapshotReady({ headOid: 'not-an-oid' }), false);
assert.equal(isPatchSnapshotReady({ headOid: OID_REPO_A }), true);
const refusal = patchSnapshotRequiredMessage(configA, 'feat: x');
assert.match(refusal, /No repo mix snapshot for alexanderpeschkaGit\/sikanda_projectinart_11@main/);
assert.match(refusal, /Load Repo Mix/);

// 8. A GIT_CONFLICT must invalidate the token that lost the check, so a stale OID
//    can never be replayed on the next retry (source conflict) and a target race
//    never throws away a still-valid mix snapshot.
assert.equal(resolveConflictOidReset({ status: 'GIT_CONFLICT', newHeadOid: OID_REPO_B }), 'source');
assert.equal(
  resolveConflictOidReset({ status: 'GIT_CONFLICT', newHeadOid: OID_TARGET, targetBranch: 'bridge' }),
  'target'
);
assert.equal(resolveConflictOidReset({ status: 'COMMITTED', newHeadOid: OID_TARGET }), 'none');
assert.equal(resolveConflictOidReset({ status: 'NO_CHANGES_NEEDED', newHeadOid: OID_TARGET }), 'none');
assert.equal(resolveConflictOidReset({ status: 'PREFLIGHT_FAILED' }), 'none');
assert.equal(resolveConflictOidReset({ status: 'ERROR', errorMessage: 'boom' }), 'none');

console.log('PASS: persisted patch OIDs are repo+branch scoped and foreign snapshots are never replayed');
