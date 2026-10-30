import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const HEAD_OID = 'abcdef0123456789abcdef0123456789abcdef01';

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(text, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function tarHeader({ name, size, typeflag }) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTarGz() {
  const blocks = [];
  const pax = Buffer.from(`52 comment=${HEAD_OID}\n`, 'utf8');
  blocks.push(tarHeader({ name: 'pax_global_header', size: pax.length, typeflag: 'g' }));
  blocks.push(pax, Buffer.alloc((512 - (pax.length % 512)) % 512, 0));

  const content = Buffer.from('export const value = 1;\n', 'utf8');
  blocks.push(tarHeader({ name: `owner-repo-${HEAD_OID}/src/a.ts`, size: content.length, typeflag: '0' }));
  blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512, 0));
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const recentCommitCalls = [];
const tarballGz = buildTarGz();

globalThis.__mixMocks = {
  recentCommitCalls,
  parseRepoOwner(value) {
    const [owner, repo] = value.split('/');
    return { owner, repo };
  },
  async getBranchHeadOid() {
    return { headOid: HEAD_OID, resolvedBranch: 'main', repositoryId: 'repo-id' };
  },
  async commitSingleFileViaGraphQL() {
    return { oid: HEAD_OID, url: 'https://github.com/test/repo/commit/next' };
  },
  async fetchRecentCommitsAndVolatileFiles(_owner, _repo, _branch, _token, count) {
    recentCommitCalls.push({ count });
    return {
      commits: [{ hash: HEAD_OID, date: '2026-10-20', author: 'Dev', title: 'feat: x', files: [] }],
      volatileFiles: [{ path: 'src/a.ts', touchCount: 2, latestStatus: 'modified' }],
      xmlContent: '<recent_commits><commit hash="x" /></recent_commits>',
    };
  },
};

const mixerBuild = await esbuild.build({
  entryPoints: [path.join(ROOT, 'packages/edge-worker/src/modules/mixer.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'mock-github-and-recent-commits',
    setup(build) {
      build.onResolve({ filter: /\.\.\/utils\/github$/ }, () => ({ path: 'github-mocks', namespace: 'test-mock' }));
      build.onLoad({ filter: /^github-mocks$/, namespace: 'test-mock' }, () => ({
        contents: `
          export const parseRepoOwner = (...args) => globalThis.__mixMocks.parseRepoOwner(...args);
          export const getBranchHeadOid = (...args) => globalThis.__mixMocks.getBranchHeadOid(...args);
          export const commitSingleFileViaGraphQL = (...args) => globalThis.__mixMocks.commitSingleFileViaGraphQL(...args);
          export class BranchNotFoundError extends Error { constructor(o, r, b, d) { super(); this.defaultBranch = d; } }
        `,
        loader: 'js',
      }));
      build.onResolve({ filter: /(^|\/)recentCommits$/ }, () => ({ path: 'recent-commits-mock', namespace: 'test-mock' }));
      build.onLoad({ filter: /^recent-commits-mock$/, namespace: 'test-mock' }, () => ({
        contents: `
          export const fetchRecentCommitsAndVolatileFiles = (...args) =>
            globalThis.__mixMocks.fetchRecentCommitsAndVolatileFiles(...args);
        `,
        loader: 'js',
      }));
    },
  }],
});

const mixerUrl = `data:text/javascript;base64,${Buffer.from(mixerBuild.outputFiles[0].text).toString('base64')}`;
const { handleMixRequest } = await import(mixerUrl);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.match(String(url), /\/tarball\//, 'only the tarball endpoint is fetched');
  return new Response(tarballGz, { status: 200, headers: { 'content-type': 'application/gzip' } });
};

async function runMix(overrides) {
  recentCommitCalls.length = 0;
  const result = await handleMixRequest({ repo: 'test/repo', branch: 'main', ...overrides }, 'token');
  assert.equal(result.status, 'OK', `mix succeeds: ${result.errorMessage || ''}`);
  assert.equal(result.headOid, HEAD_OID);
  return result;
}

{
  const result = await runMix({});
  assert.equal(recentCommitCalls.length, 0, 'omitted includeRecentCommits performs zero recent-commit fetches');
  assert.equal(result.stats.recentCommitsCount, undefined, 'omitted includeRecentCommits reports no commit stats');
  assert.equal(result.xmlContent.includes('<recent_commits>'), false, 'omitted includeRecentCommits omits metadata XML');
  console.log('PASS: omitted includeRecentCommits is opt-out');
}

{
  const result = await runMix({ includeRecentCommits: false });
  assert.equal(recentCommitCalls.length, 0, 'false includeRecentCommits performs zero recent-commit fetches');
  assert.equal(result.stats.recentCommitsCount, undefined, 'false includeRecentCommits reports no commit stats');
  console.log('PASS: includeRecentCommits=false is opt-out');
}

{
  const result = await runMix({ includeRecentCommits: true, recentCommitsCount: 4 });
  assert.equal(recentCommitCalls.length, 1, 'true includeRecentCommits performs exactly one metadata fetch');
  assert.equal(recentCommitCalls[0].count, 4, 'requested commit count is forwarded');
  assert.equal(result.stats.recentCommitsCount, 1, 'commit stats are reported on opt-in');
  assert.equal(result.stats.volatileFilesCount, 1, 'volatile file stats are reported on opt-in');
  assert.ok(result.xmlContent.includes('<recent_commits>'), 'metadata XML is embedded on opt-in');
  console.log('PASS: includeRecentCommits=true enables metadata fetch');
}

globalThis.fetch = realFetch;

const storageBuild = await esbuild.build({
  entryPoints: [path.join(ROOT, 'packages/userscript-hud/src/services/storage.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const storageUrl = `data:text/javascript;base64,${Buffer.from(storageBuild.outputFiles[0].text).toString('base64')}`;
const { loadHudConfig, saveHudConfig, DEFAULT_HUD_CONFIG } = await import(storageUrl);

function installStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  globalThis.GM_getValue = (key) => store.get(key);
  globalThis.GM_setValue = (key, value) => store.set(key, value);
  return store;
}

{
  const store = installStorage();
  assert.equal(DEFAULT_HUD_CONFIG.includeRecentCommits, false, 'HUD default is off');
  assert.equal(loadHudConfig().includeRecentCommits, false, 'new installation loads unchecked');
  assert.equal(store.get('recent_commits_opt_in_migration_v1'), 'true', 'migration marker is written');
  console.log('PASS: new HUD configuration defaults to off');
}

{
  const store = installStorage({ include_recent_commits: 'true' });
  assert.equal(loadHudConfig().includeRecentCommits, false, 'legacy stored true is migrated to false');
  assert.equal(store.get('include_recent_commits'), 'false', 'legacy value is persisted as false');
  assert.equal(store.get('recent_commits_opt_in_migration_v1'), 'true', 'migration is marked complete');
  console.log('PASS: legacy stored true is migrated once');
}

{
  const store = installStorage({ include_recent_commits: 'true' });
  loadHudConfig();
  saveHudConfig({ includeRecentCommits: true });
  assert.equal(store.get('include_recent_commits'), 'true', 'explicit opt-in is persisted');
  assert.equal(loadHudConfig().includeRecentCommits, true, 'explicit opt-in survives later loads');
  assert.equal(loadHudConfig().includeRecentCommits, true, 'migration does not re-run after opt-in');
  console.log('PASS: explicit opt-in persists after the one-time migration');
}

{
  const store = installStorage({ include_recent_commits: 'false' });
  assert.equal(loadHudConfig().includeRecentCommits, false, 'stored false stays false');
  saveHudConfig({ includeRecentCommits: false });
  assert.equal(store.get('include_recent_commits'), 'false', 'unchecked state stores false');
  console.log('PASS: unchecked state persists false');
}

{
  const domSource = fs.readFileSync(
    path.join(ROOT, 'packages/userscript-hud/src/ui/hudDomTree.ts'),
    'utf8'
  );
  assert.ok(
    domSource.includes('recentCommitsCheck.checked = config.includeRecentCommits === true'),
    'HUD checkbox renders checked only on explicit opt-in'
  );
  const hudSource = fs.readFileSync(
    path.join(ROOT, 'packages/userscript-hud/src/ui/hudConfigBindings.ts'),
    'utf8'
  );
  assert.ok(
    hudSource.includes('saveHudConfig({ includeRecentCommits: config.includeRecentCommits })'),
    'HUD checkbox change handler persists the value'
  );
  console.log('PASS: HUD checkbox wiring is preserved');
}

console.log('Recent-commits opt-in contract: PASS');
