/**
 * Regression: account profiles, one-time migration, owner detection & typed-wins switch.
 *
 * Bundles `services/storage.ts` + `services/accountProfiles.ts` with a GM storage shim
 * and verifies the profile-scoped contract:
 *  - legacy flat keys seed account1 exactly once (marker `account_profiles_migration_v1`)
 *  - `saveHudConfig` mirrors profile keys while keeping the legacy flat mirror
 *  - account2 never inherits account1 values (empty profile stays empty)
 *  - full account1 -> account2 -> account1 round-trip keeps both profiles intact
 *  - repo-owner classification (active / account2 / foreign / empty)
 *  - typed_wins: the typed repo is adopted into the target profile on hint switch
 *  - PAT-shaped worker secrets keep throwing (sanitizeNoGithubPat hard guardrail)
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

async function bundleModule(entry) {
  const build = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
}

const storageUrl = await bundleModule('packages/userscript-hud/src/services/storage.ts');
const profilesUrl = await bundleModule('packages/userscript-hud/src/services/accountProfiles.ts');

const {
  loadHudConfig,
  saveHudConfig,
  sanitizeNoGithubPat,
  setStoredValue,
  getActiveProfileId,
} = await import(storageUrl);
const {
  classifyRepoOwner,
  ownerOfRepo,
  switchAccountProfile,
  switchAccountProfileWithRepo,
} = await import(profilesUrl);

function installStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  globalThis.GM_getValue = (key) => store.get(key);
  globalThis.GM_setValue = (key, value) => store.set(key, value);
  return store;
}

// 1. Fresh store with legacy flat keys: migration seeds account1, defaults account2 owner.
{
  const store = installStorage({
    worker_url: 'https://legacy-acc1.workers.dev',
    worker_secret: 'legacy-secret-1',
    owner_repo: 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0',
    branch: 'preview',
  });
  const cfg = loadHudConfig();
  assert.equal(getActiveProfileId(), 'account1', 'default profile is account1');
  assert.equal(store.get('account1_worker_url'), 'https://legacy-acc1.workers.dev', 'legacy worker_url seeded into account1');
  assert.equal(store.get('account1_owner'), 'alexanderpeschkaGit', 'owner seeded from legacy repo owner');
  assert.equal(store.get('account2_owner'), 'vijaysikanda', 'account2 owner defaulted');
  assert.equal(store.get('account_profiles_migration_v1'), 'true', 'migration marker written');
  assert.equal(cfg.owner, 'alexanderpeschkaGit');
  assert.equal(cfg.workerUrl, 'https://legacy-acc1.workers.dev');
  console.log('PASS: one-time migration seeds profiles from legacy flat keys');
}

// 2. saveHudConfig mirrors the active profile while keeping the flat legacy mirror.
{
  const store = installStorage();
  loadHudConfig();
  saveHudConfig({ workerSecret: 's1' });
  assert.equal(store.get('worker_secret'), 's1', 'flat mirror still written');
  assert.equal(store.get('account1_worker_secret'), 's1', 'profile key written for active account1');
  console.log('PASS: saveHudConfig mirrors active profile');
}

// 3. Account 2 must never inherit account 1 values.
{
  const store = installStorage({
    worker_url: 'https://legacy-acc1.workers.dev',
    worker_secret: 'legacy-secret-1',
    owner_repo: 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0',
  });
  loadHudConfig();
  setStoredValue('active_profile', 'account2');
  const cfg2 = loadHudConfig();
  assert.equal(cfg2.repo, '', 'no account1 repo leak into account2');
  assert.equal(cfg2.workerSecret, '', 'no account1 secret leak into account2');
  assert.equal(cfg2.workerUrl, '', 'no account1 worker URL leak into account2');
  console.log('PASS: account2 profile starts empty (no account1 fallback)');
}

// 4. Round-trip: configure account2, switch back and forth, both profiles intact.
{
  const store = installStorage({
    worker_url: 'https://acc1.workers.dev',
    worker_secret: 's1',
    owner_repo: 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0',
    branch: 'preview',
  });
  loadHudConfig();
  setStoredValue('active_profile', 'account2');
  saveHudConfig({
    workerUrl: 'https://acc2.workers.dev',
    workerSecret: 's2',
    owner: 'vijaysikanda',
    repo: 'vijaysikanda/xyz',
  });

  switchAccountProfile('account1');
  const c1 = loadHudConfig();
  assert.equal(c1.workerUrl, 'https://acc1.workers.dev');
  assert.equal(c1.workerSecret, 's1');
  assert.equal(c1.repo, 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0');

  switchAccountProfile('account2');
  const c2 = loadHudConfig();
  assert.equal(c2.workerSecret, 's2', 'account2 secret intact');
  assert.equal(c2.repo, 'vijaysikanda/xyz', 'account2 repo intact');
  assert.equal(c2.owner, 'vijaysikanda');
  console.log('PASS: account1 <-> account2 round-trip keeps both profiles');
}

// 5. Repo-owner classification.
{
  const store = installStorage({ owner_repo: 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0' });
  const cfg = loadHudConfig();
  assert.equal(classifyRepoOwner({ ...cfg, repo: 'alexanderpeschkaGit/x' }), 'active');
  assert.equal(classifyRepoOwner({ ...cfg, repo: 'vijaysikanda/x' }), 'account2');
  assert.equal(classifyRepoOwner({ ...cfg, repo: 'fremd/x' }), 'foreign');
  assert.equal(classifyRepoOwner({ ...cfg, repo: '' }), 'empty');
  assert.equal(ownerOfRepo('https://github.com/ALEXANDERPESCHKAGIT/repo'), 'alexanderpeschkagit');
  assert.equal(ownerOfRepo('git@github.com:vijaysikanda/repo'), 'vijaysikanda');
  console.log('PASS: owner classification (active / account2 / foreign / empty)');
}

// 6. typed_wins: the typed repo is adopted into the target profile on hint switch.
{
  const store = installStorage();
  loadHudConfig();
  switchAccountProfileWithRepo('account2', 'vijaysikanda/neuesRepo');
  const cfg = loadHudConfig();
  assert.equal(getActiveProfileId(), 'account2');
  assert.equal(cfg.repo, 'vijaysikanda/neuesRepo', 'typed repo wins into target profile');
  console.log('PASS: typed-wins switch carries the repo into the target profile');
}

// 7. PAT guardrail still rejects PAT-shaped secrets.
{
  const store = installStorage();
  assert.throws(
    () => saveHudConfig({ workerSecret: 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }),
    /Security Guardrail/,
    'PAT-shaped worker secret must throw'
  );
  assert.throws(
    () => sanitizeNoGithubPat('ghp_abcdefghijklmnopqrstuvwxyz012345', 'workerSecret'),
    /Security Guardrail/,
    'fine-grained PAT shape must throw'
  );
  console.log('PASS: PAT guardrail rejects PAT-shaped secrets');
}

console.log('Account profiles & owner detection contract: PASS');
process.exit(0);
