/**
 * Regression: the HUD must be able to detect a published userscript update.
 *
 * Tampermonkey's own `@updateURL` check runs on a ~24h schedule that the script
 * cannot influence, so a released version can stay invisible for a whole day.
 * The HUD therefore parses the published `@version` itself; a wrong comparison
 * (e.g. 0.80.1 vs 0.80.0) or a drifting update URL would silently defeat that.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const entry = path.join(ROOT, 'packages/userscript-hud/src/services/updateChecker.ts');
const build = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
const { parseUserscriptVersion, compareVersions, buildUpdateUrl, evaluateUpdateState, SCRIPT_SOURCE_URL } =
  await import(moduleUrl);

// ---------------------------------------------------------------------------
// 1. Metadata parsing
// ---------------------------------------------------------------------------
const sample = `// ==UserScript==
// @name         Gemini Git Bridge & Shadow-DOM HUD
// @version      0.80.1
// @updateURL    https://example.test/gemini-bridge.user.js
// ==/UserScript==
console.log('body');`;

assert.equal(parseUserscriptVersion(sample), '0.80.1');
assert.equal(parseUserscriptVersion(sample.replace(/\r?\n/g, '\r\n')), '0.80.1');
assert.equal(parseUserscriptVersion('// ==UserScript==\n// @name x\n// ==/UserScript=='), '');
assert.equal(parseUserscriptVersion('plain text mentioning @version 9.9.9'), '');
assert.equal(parseUserscriptVersion(''), '');

// ---------------------------------------------------------------------------
// 2. Numeric ordering (string comparison would order 0.80.0 > 0.80.1 incorrectly)
// ---------------------------------------------------------------------------
assert.equal(compareVersions('0.80.1', '0.80.0'), 1);
assert.equal(compareVersions('0.80.0', '0.80.1'), -1);
assert.equal(compareVersions('0.80.1', '0.80.1'), 0);
assert.equal(compareVersions('0.81.0', '0.80.99'), 1);
assert.equal(compareVersions('0.80', '0.80.0'), 0);
assert.equal(compareVersions('  0.80.1 ', '0.80.1'), 0);

// ---------------------------------------------------------------------------
// 2b. An unknown running version must never fake an update
// ---------------------------------------------------------------------------
assert.deepEqual(evaluateUpdateState('0.80.0', '0.80.1'), {
  currentVersion: '0.80.0',
  latestVersion: '0.80.1',
  hasUpdate: true,
});
assert.equal(evaluateUpdateState('0.80.1', '0.80.1').hasUpdate, false);
assert.equal(evaluateUpdateState('0.80.2', '0.80.1').hasUpdate, false);
assert.equal(evaluateUpdateState('', '0.80.1').hasUpdate, false, 'unknown version is not an update');
assert.deepEqual(evaluateUpdateState(' 0.80.0 ', ' 0.80.1 '), {
  currentVersion: '0.80.0',
  latestVersion: '0.80.1',
  hasUpdate: true,
});

// Legacy v2.x to v0.80.x beta transition must trigger an update
assert.deepEqual(evaluateUpdateState('2.0.26', '0.80.1'), {
  currentVersion: '2.0.26',
  latestVersion: '0.80.1',
  hasUpdate: true,
});
assert.deepEqual(evaluateUpdateState('2.0.0', '0.80.1'), {
  currentVersion: '2.0.0',
  latestVersion: '0.80.1',
  hasUpdate: true,
});

// ---------------------------------------------------------------------------
// 3. Update URL mirrors the published metadata block
// ---------------------------------------------------------------------------
const rootBundle = fs.readFileSync(path.join(ROOT, 'gemini-bridge.user.js'), 'utf8');
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'packages/userscript-hud/package.json'), 'utf8')
);
const bannerUpdateUrl = (rootBundle.match(/^\/\/ @updateURL\s+(\S+)$/m) || [])[1];

assert.equal(bannerUpdateUrl, SCRIPT_SOURCE_URL);
assert.equal(buildUpdateUrl('0.80.1'), `${SCRIPT_SOURCE_URL}?v=0.80.1`);
assert.equal(buildUpdateUrl(''), SCRIPT_SOURCE_URL);

// ---------------------------------------------------------------------------
// 4. The shipped bundle is a valid update source
// ---------------------------------------------------------------------------
assert.equal(parseUserscriptVersion(rootBundle), pkg.version);
assert.match(rootBundle, /^\/\/ @downloadURL\s+https:\/\/raw\.githubusercontent\.com\//m);
assert.match(rootBundle, /^\/\/ @connect\s+raw\.githubusercontent\.com$/m);
assert.ok(compareVersions(pkg.version, '0.80.0') > 0, 'release version must advance beyond 0.80.0');

console.log('✅ hud-update-check: metadata parsing, semver ordering and update URL are consistent.');
