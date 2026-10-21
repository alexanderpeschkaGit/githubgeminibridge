/**
 * Regression: the update banner must not outlive the action it asks for.
 *
 * The running userscript instance keeps executing after Tampermonkey installs a
 * new version (no reload), so a banner that stays up after the install click
 * keeps claiming a pending update that is already applied. A manual "up to date"
 * result must not stick in the panel either.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const entry = path.join(ROOT, 'packages/userscript-hud/src/ui/updateBanner.ts');
const build = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
const { initHudUpdateBanner } = await import(moduleUrl);

// --- deterministic fake environment (no DOM, no real timers) ---------------
function makeElement() {
  const handlers = new Map();
  return {
    style: {},
    className: '',
    textContent: '',
    title: '',
    disabled: false,
    addEventListener(type, handler) {
      handlers.set(type, [...(handlers.get(type) || []), handler]);
    },
    fire(type) {
      for (const handler of handlers.get(type) || []) handler();
    },
  };
}

const UPDATE_URL =
  'https://raw.githubusercontent.com/alexanderpeschkaGit/githubgeminibridge/main/gemini-bridge.user.js';

let timers = [];
globalThis.setTimeout = (fn) => {
  timers.push(fn);
  return timers.length;
};
globalThis.clearTimeout = (id) => {
  if (id > 0) timers[id - 1] = null;
};
const opened = [];
globalThis.window = { open: (...args) => opened.push(args) };

const flush = () => new Promise((resolve) => setImmediate(resolve));

function runTimers() {
  const pending = timers;
  timers = [];
  for (const timer of pending) if (timer) timer();
}

async function mount(checkResult) {
  const dom = {
    updateCheckBtn: makeElement(),
    updateBanner: makeElement(),
    updateBannerText: makeElement(),
    updateBannerBtn: makeElement(),
  };
  const calls = [];
  initHudUpdateBanner(dom, {
    check: async (options) => {
      calls.push(options);
      return checkResult;
    },
  });
  await flush();
  return { dom, calls };
}

// ---------------------------------------------------------------------------
// 1. A published update is persistent, but the install click retires it
// ---------------------------------------------------------------------------
{
  const { dom } = await mount({ currentVersion: '2.0.14', latestVersion: '2.0.15', hasUpdate: true });

  assert.equal(dom.updateBanner.style.display, 'flex');
  assert.match(dom.updateBanner.className, /\bupdate\b/);
  assert.match(dom.updateBannerText.textContent, /2\.0\.15/);
  assert.match(dom.updateBannerBtn.textContent, /Install v2\.0\.15/);
  assert.equal(timers.filter(Boolean).length, 0, 'update banner must stay until the user acts');

  dom.updateBannerBtn.fire('click');

  assert.deepEqual(opened.at(-1), [`${UPDATE_URL}?v=2.0.15`, '_blank', 'noopener']);
  assert.match(dom.updateBannerText.textContent, /Reload this page after installing v2\.0\.15/);
  assert.match(dom.updateBanner.className, /\bok\b/);
  assert.equal(dom.updateBanner.style.display, 'flex');

  runTimers();
  assert.equal(dom.updateBanner.style.display, 'none', 'reload hint auto-hides');
}

// ---------------------------------------------------------------------------
// 2. "up to date" is a toast, never a sticky panel
// ---------------------------------------------------------------------------
{
  const { dom, calls } = await mount({
    currentVersion: '2.0.15',
    latestVersion: '2.0.15',
    hasUpdate: false,
  });

  assert.equal(dom.updateBanner.style.display, 'none', 'background check stays silent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].force, false);

  dom.updateCheckBtn.fire('click');
  await flush();

  assert.equal(calls.at(-1).force, true);
  assert.match(dom.updateBannerText.textContent, /up to date \(v2\.0\.15\)/);
  assert.match(dom.updateBanner.className, /\bok\b/);
  assert.equal(dom.updateBanner.style.display, 'flex');
  assert.equal(dom.updateCheckBtn.disabled, false);

  runTimers();
  assert.equal(dom.updateBanner.style.display, 'none', 'manual up-to-date result must not stick');
}

// ---------------------------------------------------------------------------
// 3. An unknown running version is reported (persistent) instead of silence
// ---------------------------------------------------------------------------
{
  const { dom } = await mount({ currentVersion: '', latestVersion: '2.0.15', hasUpdate: false });

  dom.updateCheckBtn.fire('click');
  await flush();

  assert.match(dom.updateBannerText.textContent, /Running version unknown/);
  assert.match(dom.updateBanner.className, /\berror\b/);
  assert.equal(dom.updateBanner.style.display, 'flex');
  assert.equal(timers.filter(Boolean).length, 0, 'the diagnostic stays until dismissed');
}

// ---------------------------------------------------------------------------
// 4. A throttled check never leaves the button stuck or shows a banner
// ---------------------------------------------------------------------------
{
  const { dom } = await mount(null);

  assert.equal(dom.updateBanner.style.display, 'none');

  dom.updateCheckBtn.fire('click');
  await flush();

  assert.equal(dom.updateBanner.style.display, 'none');
  assert.equal(dom.updateCheckBtn.disabled, false);
}

console.log('✅ hud-update-banner: install click retires the banner, manual results never stick.');
