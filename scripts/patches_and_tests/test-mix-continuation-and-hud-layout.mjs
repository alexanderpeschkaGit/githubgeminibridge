#!/usr/bin/env node
/**
 * Regression Suite: Multi-Turn Mix Continuation & Compact 4-Row HUD Layout
 *
 * Asserts:
 * 1. RepoMix continuation parts (mixChunker.ts + mixContinuation.ts):
 *    - Default (enableContinuation omitted/false) preserves continuationParts === undefined on >10-part input.
 *    - enableContinuation: true on a 24-part fixture emits parts (1..10) + continuationParts (11..24),
 *      every single part <= HARD_GEMINI_CHAR_LIMIT (100_000), disjoint file sets covering 100% of valid files,
 *      and <truncation_notice> mentions pre-packed continuation parts.
 *    - enableContinuation: true on a 35-part fixture caps continuationParts at MAX_CONTINUATION_PARTS = 20 (Parts 11..30)
 *      and reports unrecoverableFilesCount > 0.
 *    - file_over_hard_limit (>100k single file) is never placed in continuationParts.
 * 2. Compact HUD DOM & Dropdown (hudDomTree.ts + hudRepoHistoryDropdown.ts + hudRender.ts):
 *    - Single-row containers .hud-repo-owner-grid, .hud-account-worker-grid, and .hud-toggles-row exist;
 *      standalone <select> is absent.
 *    - repoHistoryBtn opens/closes repoHistoryMenu; selecting an item updates repo/owner/branch/targetBranch
 *      and resets OID state; Escape keydown closes the menu.
 *    - continueMixBtn stays hidden when continuationQueue is empty, renders '⏭️ Parts 11–20' when 14 parts
 *      are queued, and advances to '⏭️ Parts 21–24' after slicing 10 parts.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const HEAD_OID = 'abcdef0123456789abcdef0123456789abcdef01';

async function bundleModule(entryRelativePath) {
  const build = await esbuild.build({
    entryPoints: [path.join(ROOT, entryRelativePath)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
}

// ============================================================================
// PART 1: Edge-Worker RepoMix Continuation (mixChunker.ts)
// ============================================================================

const chunkerUrl = await bundleModule('packages/edge-worker/src/modules/mixChunker.ts');
const { buildChunkedMixXml, HARD_GEMINI_CHAR_LIMIT, MAX_GEMINI_PARTS } = await import(chunkerUrl);

const continuationUrl = await bundleModule('packages/edge-worker/src/modules/mixContinuation.ts');
const { MAX_CONTINUATION_PARTS } = await import(continuationUrl);

function makeUniformFiles(count, size = 70_000, prefix = 'src/file') {
  return Array.from({ length: count }, (_, i) => ({
    path: `${prefix}${String(i).padStart(2, '0')}.ts`,
    content: `// file ${i}\n` + 'A'.repeat(size),
  }));
}

function makeChunkInput(files, options = {}) {
  return {
    owner: 'acme',
    repo: 'project',
    branch: 'main',
    headOid: HEAD_OID,
    fileTreeEntries: files.map((f) => f.path),
    files,
    ...options,
  };
}

function extractFilePathsFromPartXml(xml) {
  const paths = [];
  const regex = /<file path="([^"]+)">/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

// 1.1: Default (omitted / false) preserves continuationParts === undefined on >10-part input
{
  const files15 = makeUniformFiles(15, 70_000);

  const resOmitted = buildChunkedMixXml(makeChunkInput(files15));
  assert.equal(resOmitted.isChunked, true);
  assert.equal(resOmitted.parts.length, MAX_GEMINI_PARTS);
  assert.equal(resOmitted.continuationParts, undefined, 'continuationParts must be undefined when omitted');
  assert.equal(resOmitted.truncation?.reason, 'part_limit_exceeded');

  const resFalse = buildChunkedMixXml(makeChunkInput(files15, { enableContinuation: false }));
  assert.equal(resFalse.continuationParts, undefined, 'continuationParts must be undefined when false');
  console.log('PASS: default (enableContinuation omitted/false) leaves continuationParts undefined');
}

// 1.2: enableContinuation: true on a 24-part fixture emits parts (1..10) + continuationParts (11..24)
{
  const files24 = makeUniformFiles(24, 70_000);
  const res24 = buildChunkedMixXml(makeChunkInput(files24, { enableContinuation: true }));

  assert.equal(res24.parts.length, 10, 'base parts must equal MAX_GEMINI_PARTS (10)');
  assert.ok(Array.isArray(res24.continuationParts), 'continuationParts must be an array');
  assert.equal(res24.continuationParts.length, 14, 'continuationParts must contain 14 parts (total 24)');

  for (let i = 0; i < res24.parts.length; i++) {
    assert.equal(res24.parts[i].partIndex, i + 1, `base part index should be ${i + 1}`);
  }
  for (let i = 0; i < res24.continuationParts.length; i++) {
    assert.equal(res24.continuationParts[i].partIndex, 11 + i, `continuation part index should be ${11 + i}`);
  }

  const allParts = [...res24.parts, ...res24.continuationParts];
  for (const part of allParts) {
    assert.ok(
      part.xmlContent.length <= HARD_GEMINI_CHAR_LIMIT,
      `${part.fileName} exceeds hard ceiling: ${part.xmlContent.length} > ${HARD_GEMINI_CHAR_LIMIT}`
    );
    assert.equal(part.stats.charCount, part.xmlContent.length, 'stats.charCount matches xmlContent length');
  }

  const basePaths = res24.parts.flatMap((p) => extractFilePathsFromPartXml(p.xmlContent));
  const contPaths = res24.continuationParts.flatMap((p) => extractFilePathsFromPartXml(p.xmlContent));
  const baseSet = new Set(basePaths);
  const contSet = new Set(contPaths);

  assert.equal(baseSet.size, 10, 'base parts cover 10 files');
  assert.equal(contSet.size, 14, 'continuation parts cover 14 files');

  for (const path of baseSet) {
    assert.ok(!contSet.has(path), `disjoint violation: ${path} appears in both base and continuation parts`);
  }

  const unionSet = new Set([...baseSet, ...contSet]);
  assert.equal(unionSet.size, 24, 'union covers exactly 24 files');
  for (const file of files24) {
    assert.ok(unionSet.has(file.path), `missing file from union: ${file.path}`);
  }

  const part1Xml = res24.parts[0].xmlContent;
  assert.ok(part1Xml.includes('<truncation_notice>'), 'Part 1 must include <truncation_notice>');
  assert.ok(
    part1Xml.includes('14 omitted file(s) are pre-packed into 14 continuation part(s) (Parts 11-24)'),
    'truncation_notice must describe pre-packed continuation parts'
  );
  console.log('PASS: 24-part fixture emits conforming, disjoint, 100%-covered continuation parts (11..24)');
}

// 1.3: enableContinuation: true on a 35-part fixture caps continuationParts at MAX_CONTINUATION_PARTS = 20
{
  const files35 = makeUniformFiles(35, 70_000);
  const res35 = buildChunkedMixXml(makeChunkInput(files35, { enableContinuation: true }));

  assert.equal(res35.parts.length, 10, 'base parts capped at 10');
  assert.equal(res35.continuationParts.length, MAX_CONTINUATION_PARTS, 'continuationParts capped at 20');
  assert.equal(res35.continuationParts[0].partIndex, 11);
  assert.equal(res35.continuationParts[19].partIndex, 30);

  assert.ok(res35.truncation, 'truncation summary must be present');
  assert.equal(res35.truncation.continuationPartsCount, 20);
  assert.equal(res35.truncation.continuationFilesCount, 20);
  assert.ok(res35.truncation.unrecoverableFilesCount > 0, 'unrecoverableFilesCount > 0 when repository > 30 parts');
  assert.equal(res35.truncation.unrecoverableFilesCount, 5, '35 files - 10 base - 20 continuation = 5 unrecoverable');
  console.log('PASS: 35-part fixture caps continuationParts at 20 (Parts 11..30) and reports unrecoverableFilesCount > 0');
}

// 1.4: file_over_hard_limit (>100k single file) is never placed in continuationParts
{
  const normalFiles = makeUniformFiles(15, 70_000);
  const oversizedFile = { path: 'src/huge-file.ts', content: 'Z'.repeat(120_000) };
  const resMixed = buildChunkedMixXml(makeChunkInput([...normalFiles, oversizedFile], { enableContinuation: true }));

  assert.equal(resMixed.parts.length, 10);
  assert.equal(resMixed.continuationParts.length, 5);

  for (const part of resMixed.continuationParts) {
    assert.ok(!part.xmlContent.includes('src/huge-file.ts'), `oversized file in continuation part ${part.fileName}`);
  }
  for (const part of resMixed.parts) {
    assert.ok(!part.xmlContent.includes('<file path="src/huge-file.ts">'), `oversized file body emitted in part ${part.fileName}`);
  }

  const omittedOversized = resMixed.truncation?.omittedFiles.find((f) => f.path === 'src/huge-file.ts');
  assert.ok(omittedOversized, 'huge file must be recorded in omittedFiles');
  assert.equal(omittedOversized.reason, 'file_over_hard_limit');
  assert.ok((resMixed.truncation?.unrecoverableFilesCount ?? 0) > 0, 'unrecoverableFilesCount accounts for oversized file');
  console.log('PASS: file_over_hard_limit (>100k) is never placed in continuationParts');
}

// 1.5: Priority ranking and file line-budget enforcement
{
  const selectionUrl = await bundleModule('packages/edge-worker/src/modules/mixSelection.ts');
  const { rankFilesForOmission } = await import(selectionUrl);

  const sampleFiles = [
    { path: 'cf-gemini-git-bridge/src/index.ts', content: 'legacy', fileXml: '<file>legacy</file>' },
    { path: 'plans/00_MASTER_ROADMAP.md', content: 'plan', fileXml: '<file>plan</file>' },
    { path: 'scripts/worker-smoke.mjs', content: 'smoke', fileXml: '<file>smoke</file>' },
    { path: '.agents/rules/test.md', content: 'rule', fileXml: '<file>rule</file>' },
    { path: 'packages/edge-worker/src/index.ts', content: 'entry', fileXml: '<file>entry</file>' },
    { path: 'package.json', content: 'config', fileXml: '<file>config</file>' },
  ];

  const ranked = rankFilesForOmission(sampleFiles);
  const paths = ranked.map((f) => f.path);

  const ruleIdx = paths.indexOf('.agents/rules/test.md');
  const scriptIdx = paths.indexOf('scripts/worker-smoke.mjs');
  const planIdx = paths.indexOf('plans/00_MASTER_ROADMAP.md');
  const legacyIdx = paths.indexOf('cf-gemini-git-bridge/src/index.ts');

  assert.ok(ruleIdx !== -1 && scriptIdx !== -1 && planIdx !== -1 && legacyIdx !== -1, 'all test files found');
  assert.ok(ruleIdx < planIdx, '.agents/rules/* must rank ahead of plans/*');
  assert.ok(ruleIdx < legacyIdx, '.agents/rules/* must rank ahead of cf-gemini-git-bridge/*');
  assert.ok(scriptIdx < planIdx, 'scripts/* must rank ahead of plans/*');
  assert.ok(scriptIdx < legacyIdx, 'scripts/* must rank ahead of cf-gemini-git-bridge/*');

  // Line count assertions (< 465 lines)
  const fs = await import('node:fs');
  const mixChunkerLines = fs.readFileSync(path.join(ROOT, 'packages/edge-worker/src/modules/mixChunker.ts'), 'utf8').split('\n').length;
  const hudStylesLines = fs.readFileSync(path.join(ROOT, 'packages/userscript-hud/src/ui/hudStylesAndDom.ts'), 'utf8').split('\n').length;

  assert.ok(mixChunkerLines < 465, `mixChunker.ts has ${mixChunkerLines} lines, expected < 465`);
  assert.ok(hudStylesLines < 465, `hudStylesAndDom.ts has ${hudStylesLines} lines, expected < 465`);
  console.log(`PASS: priority tiers rank rules/scripts ahead of plans/legacy; mixChunker.ts (${mixChunkerLines} lines) and hudStylesAndDom.ts (${hudStylesLines} lines) stay < 465`);
}

// ============================================================================
// PART 2: Compact 4-Row HUD DOM, History Popover & Continuation Button
// ============================================================================

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.style = {};
    this.className = '';
    this._text = '';
    this.id = '';
    this.title = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.shadowRoot = null;
    this.onclick = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); if (v === '') this.children = []; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(t, f) { const a = this.listeners.get(t) || []; a.push(f); this.listeners.set(t, a); }
  removeEventListener(t, f) { const a = this.listeners.get(t) || []; this.listeners.set(t, a.filter((x) => x !== f)); }
  dispatchEvent(e) {
    if (!e.target) e.target = this;
    if (e.type === 'click' && typeof this.onclick === 'function') this.onclick(e);
    for (const f of this.listeners.get(e.type) || []) f(e);
    if (this.parentNode && e.bubbles && !e._stopped) this.parentNode.dispatchEvent(e);
  }
  contains(n) { let c = n; while (c) { if (c === this) return true; c = c.parentNode; } return false; }
  remove() {
    if (this.parentNode && Array.isArray(this.parentNode.children)) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }
  attachShadow() {
    this.shadowRoot = new FakeElement('shadow-root');
    this.shadowRoot.parentNode = this;
    return this.shadowRoot;
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.target = null;
    this._stopped = false;
    this._composedPath = init.composedPath || null;
  }
  stopPropagation() { this._stopped = true; }
  composedPath() { return typeof this._composedPath === 'function' ? this._composedPath() : (this._composedPath || (this.target ? [this.target] : [])); }
}

class FakeKeyboardEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key || '';
  }
}

const docListeners = new Map();
globalThis.document = {
  body: new FakeElement('body'),
  createElement(tag) { return new FakeElement(tag); },
  getElementById(id) {
    return findDescendants(this.body, (n) => n.id === id)[0] || null;
  },
  addEventListener(t, f) { const a = docListeners.get(t) || []; a.push(f); docListeners.set(t, a); },
  removeEventListener(t, f) { const a = docListeners.get(t) || []; docListeners.set(t, a.filter((x) => x !== f)); },
  dispatchEvent(e) { if (!e.target) e.target = this; for (const f of docListeners.get(e.type) || []) f(e); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
};
globalThis.Event = FakeEvent;
globalThis.KeyboardEvent = FakeKeyboardEvent;

const gmStore = new Map();
globalThis.GM_getValue = (key, def) => (gmStore.has(key) ? gmStore.get(key) : def);
globalThis.GM_setValue = (key, val) => gmStore.set(key, val);

const hudTreeUrl = await bundleModule('packages/userscript-hud/src/ui/hudDomTree.ts');
const { buildHudDomTree: createHudDom } = await import(hudTreeUrl);

const hudDropdownUrl = await bundleModule('packages/userscript-hud/src/ui/hudRepoHistoryDropdown.ts');
const { bindRepoHistoryDropdown } = await import(hudDropdownUrl);

const hudRenderUrl = await bundleModule('packages/userscript-hud/src/ui/hudRender.ts');
const { renderHudState } = await import(hudRenderUrl);

const hudBindingsUrl = await bundleModule('packages/userscript-hud/src/ui/hudConfigBindings.ts');
const { bindHudConfigInputs } = await import(hudBindingsUrl);

function findDescendants(root, predicate) {
  const matches = [];
  function walk(node) {
    if (!node) return;
    if (predicate(node)) matches.push(node);
    if (node.shadowRoot) walk(node.shadowRoot);
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }
  walk(root);
  return matches;
}

function findByClass(root, className) {
  return findDescendants(root, (node) => (node.className || '').split(/\s+/).includes(className));
}

function findByTag(root, tag) {
  return findDescendants(root, (node) => node.tagName === tag.toUpperCase());
}

// 2.1: Single-row containers exist and standalone <select> is absent
{
  const config = {
    owner: 'testowner',
    repo: 'testrepo',
    branch: 'main',
    targetBranch: '',
    workerUrl: 'https://edge.example.com',
    workerSecret: 'secret123',
    includePaths: ['src/'],
    maxChunkChars: 85000,
    autoPilot: true,
    includeRecentCommits: false,
  };
  const state = {
    status: 'IDLE',
    statusMessage: 'Ready',
    headOid: '',
    retryCount: 0,
    harvestedPatches: [],
    continuationQueue: [],
  };

  const dom = createHudDom(config, state);

  const repoOwnerGrids = findByClass(dom.host, 'hud-repo-owner-grid');
  assert.equal(repoOwnerGrids.length, 1, 'single-row container .hud-repo-owner-grid must exist');

  const accountWorkerGrids = findByClass(dom.host, 'hud-account-worker-grid');
  assert.equal(accountWorkerGrids.length, 1, 'single-row container .hud-account-worker-grid must exist');

  const togglesRows = findByClass(dom.host, 'hud-toggles-row');
  assert.equal(togglesRows.length, 1, 'single-row container .hud-toggles-row must exist');

  const selects = findByTag(dom.host, 'select');
  assert.equal(selects.length, 0, 'standalone <select> must be completely absent from HUD DOM');
  console.log('PASS: 4-row compact HUD containers exist and standalone <select> is absent');
}

// 2.2: repoHistoryBtn opens/closes repoHistoryMenu, item selection updates state, Escape closes menu
{
  const historyEntries = [
    { owner: 'histowner', repo: 'histrepo', branch: 'feat/test', targetBranch: 'target-main' },
  ];
  gmStore.set('repo_history_v1_account1', JSON.stringify(historyEntries));
  gmStore.set('repo_history_v1', JSON.stringify(historyEntries));
  gmStore.set('active_profile', 'account1');

  const config = {
    owner: 'currentowner',
    repo: 'currentrepo',
    branch: 'main',
    targetBranch: '',
    workerUrl: 'https://edge.example.com',
    workerSecret: 'secret',
    includePaths: [],
    maxChunkChars: 85000,
    autoPilot: true,
    includeRecentCommits: false,
  };
  const state = {
    status: 'IDLE',
    statusMessage: 'Ready',
    headOid: HEAD_OID,
    retryCount: 0,
    harvestedPatches: [],
    continuationQueue: [],
  };

  const dom = createHudDom(config, state);

  let resetOidCalled = false;
  let resetOidReason = '';
  const resetPatchOidState = (reason) => {
    resetOidCalled = true;
    resetOidReason = reason;
    state.headOid = '';
  };
  const clearTargetOidState = () => {};
  const refreshAccountHint = () => {};
  const renderState = () => {};

  bindRepoHistoryDropdown({
    dom,
    config,
    state,
    resetPatchOidState,
    clearTargetOidState,
    refreshAccountHint,
    renderState,
  });

  // Initially closed
  assert.equal(dom.repoHistoryMenu.style.display, 'none');

  // Toggle open
  dom.repoHistoryBtn.onclick(new FakeEvent('click', { bubbles: true }));
  assert.equal(dom.repoHistoryMenu.style.display, 'flex', 'menu opens on button click');
  assert.equal(dom.repoHistoryBtn.getAttribute('aria-expanded'), 'true');

  // Toggle close
  dom.repoHistoryBtn.onclick(new FakeEvent('click', { bubbles: true }));
  assert.equal(dom.repoHistoryMenu.style.display, 'none', 'menu closes on second button click');
  assert.equal(dom.repoHistoryBtn.getAttribute('aria-expanded'), 'false');

  // Open again, then close via Escape
  dom.repoHistoryBtn.onclick(new FakeEvent('click', { bubbles: true }));
  assert.equal(dom.repoHistoryMenu.style.display, 'flex');
  globalThis.document.dispatchEvent(new FakeKeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(dom.repoHistoryMenu.style.display, 'none', 'Escape key closes open repo history menu');

  // Open again, verify container click does not dismiss but outside click does
  dom.repoHistoryBtn.onclick(new FakeEvent('click', { bubbles: true }));
  assert.equal(dom.repoHistoryMenu.style.display, 'flex');

  const menuContainerClick = new FakeEvent('click', {
    bubbles: true,
    composedPath: [dom.repoHistoryMenu, dom.shadowRoot, dom.host],
  });
  menuContainerClick.target = dom.repoHistoryMenu;
  globalThis.document.dispatchEvent(menuContainerClick);
  assert.equal(dom.repoHistoryMenu.style.display, 'flex', 'container click inside repoHistoryMenu must not dismiss menu');

  const outsideClick = new FakeEvent('click', {
    bubbles: true,
    composedPath: [globalThis.document.body],
  });
  outsideClick.target = globalThis.document.body;
  globalThis.document.dispatchEvent(outsideClick);
  assert.equal(dom.repoHistoryMenu.style.display, 'none', 'outside click closes repo history menu');

  // Open again, select item from menu
  dom.repoHistoryBtn.onclick(new FakeEvent('click', { bubbles: true }));
  assert.equal(dom.repoHistoryMenu.style.display, 'flex');
  assert.equal(dom.repoHistoryMenu.children.length, 1, 'history menu has 1 item button');

  const itemBtn = dom.repoHistoryMenu.children[0];
  itemBtn.onclick(new FakeEvent('click', { bubbles: true }));

  assert.equal(config.owner, 'histowner', 'selecting item updates config.owner');
  assert.equal(config.repo, 'histrepo', 'selecting item updates config.repo');
  assert.equal(config.branch, 'feat/test', 'selecting item updates config.branch');
  assert.equal(config.targetBranch, 'target-main', 'selecting item updates config.targetBranch');

  assert.equal(dom.ownerInput.value, 'histowner', 'dom.ownerInput reflects selected item');
  assert.equal(dom.repoInput.value, 'histrepo', 'dom.repoInput reflects selected item');
  assert.equal(dom.branchInput.value, 'feat/test', 'dom.branchInput reflects selected item');
  assert.equal(dom.targetBranchInput.value, 'target-main', 'dom.targetBranchInput reflects selected item');

  assert.equal(resetOidCalled, true, 'resetPatchOidState must be triggered on repo switch');
  assert.ok(resetOidReason.includes('histrepo'), 'reset reason names selected repo');
  assert.equal(dom.repoHistoryMenu.style.display, 'none', 'menu closes after selecting item');
  console.log('PASS: repoHistory popover toggle, Escape dismissal, and selection updates state and resets OID');
}

// 2.3: continueMixBtn dynamic visibility and label advancement
{
  const config = {
    owner: 'acme',
    repo: 'project',
    branch: 'main',
    targetBranch: '',
    workerUrl: 'https://edge.example.com',
    workerSecret: 'secret',
    includePaths: [],
    maxChunkChars: 85000,
    autoPilot: true,
    includeRecentCommits: false,
  };
  const state = {
    status: 'IDLE',
    statusMessage: 'Ready',
    headOid: HEAD_OID,
    retryCount: 0,
    harvestedPatches: [],
    continuationQueue: [],
  };

  const dom = createHudDom(config, state);

  // Hidden when queue is empty
  renderHudState({ dom, state, config, updateState: () => {}, onApplyPatch: () => {} });
  assert.equal(dom.continueMixBtn.style.display, 'none', 'continueMixBtn stays hidden when continuationQueue is empty');

  // Queue 14 parts (indexed 11..24)
  state.continuationQueue = Array.from({ length: 14 }, (_, i) => ({
    partIndex: 11 + i,
    totalParts: 24,
    fileName: `repo-mix.part${11 + i}.txt`,
    xmlContent: `<test part="${11 + i}"/>`,
    stats: { fileCount: 1, estimatedTokens: 10, charCount: 40 },
  }));

  renderHudState({ dom, state, config, updateState: () => {}, onApplyPatch: () => {} });
  assert.equal(dom.continueMixBtn.style.display, 'inline-flex', 'continueMixBtn visible when continuationQueue has parts');
  assert.equal(dom.continueMixBtn.textContent, '⏭️ Parts 11–20', 'label reflects first batch of 10 (11..20)');

  // Advance by slicing 10 parts (leaving 4 parts indexed 21..24)
  state.continuationQueue = state.continuationQueue.slice(10);
  assert.equal(state.continuationQueue.length, 4);

  renderHudState({ dom, state, config, updateState: () => {}, onApplyPatch: () => {} });
  assert.equal(dom.continueMixBtn.style.display, 'inline-flex', 'continueMixBtn remains visible for remaining parts');
  assert.equal(dom.continueMixBtn.textContent, '⏭️ Parts 21–24', 'label advances to Parts 21–24');

  // Slice remaining parts
  state.continuationQueue = state.continuationQueue.slice(4);
  assert.equal(state.continuationQueue.length, 0);

  renderHudState({ dom, state, config, updateState: () => {}, onApplyPatch: () => {} });
  assert.equal(dom.continueMixBtn.style.display, 'none', 'continueMixBtn hidden when continuationQueue becomes empty');
  console.log('PASS: continueMixBtn displays ⏭️ Parts 11–20, advances to ⏭️ Parts 21–24, and hides when empty');
}

// 2.4: dom.repoInput.onchange writes sanitized owner/repo back to dom.repoInput.value
{
  const config = {
    owner: 'acme',
    repo: 'project',
    branch: 'main',
    targetBranch: '',
    workerUrl: 'https://edge.example.com',
    workerSecret: 'secret',
    includePaths: [],
    maxChunkChars: 85000,
    autoPilot: true,
    includeRecentCommits: false,
  };
  const state = { headOid: HEAD_OID, targetHeadOid: null, targetHeadBranch: null };
  const dom = createHudDom(config, {
    status: 'IDLE',
    statusMessage: 'Ready',
    headOid: HEAD_OID,
    retryCount: 0,
    harvestedPatches: [],
    continuationQueue: [],
  });

  bindHudConfigInputs({
    dom,
    config,
    state,
    resetPatchOidState: () => {},
    clearTargetOidState: () => {},
    renderState: () => {},
  });

  dom.repoInput.value = ' https://github.com/my-org/my-new-repo ';
  dom.repoInput.onchange();
  assert.equal(dom.repoInput.value, 'my-org/my-new-repo', 'dom.repoInput.value must be updated with sanitized owner/repo');
  assert.equal(config.repo, 'my-org/my-new-repo', 'config.repo must be updated with sanitized owner/repo');
  console.log('PASS: dom.repoInput.onchange writes sanitized owner/repo back to dom.repoInput.value');
}

// 2.5: repoHistory deduplicates by canonical repoSlug across branch changes and empty owner edge cases
{
  const repoHistoryUrl = await bundleModule('packages/userscript-hud/src/services/repoHistory.ts');
  const { repoSlug, loadRepoHistory, pushRepoHistory } = await import(repoHistoryUrl);

  gmStore.clear();
  gmStore.set('active_profile', 'account1');

  assert.equal(repoSlug({ owner: '', repo: 'myrepo', branch: 'main' }), 'myrepo', 'empty owner falls back to repo without leading slash');
  assert.equal(repoSlug({ owner: '', repo: '/myrepo/', branch: 'main' }), 'myrepo', 'leading/trailing slashes stripped');
  assert.equal(
    repoSlug({ owner: 'AlexanderPeschkaGit', repo: 'TestRepo', branch: 'main' }),
    'alexanderpeschkagit/testrepo',
    'owner + repo canonicalized to lowercase owner/repo'
  );

  pushRepoHistory({ owner: 'alexanderpeschkaGit', repo: 'alexanderpeschkaGit/testrepo', branch: 'main' });
  pushRepoHistory({ owner: 'alexanderpeschkaGit', repo: 'alexanderpeschkaGit/testrepo', branch: 'preview', targetBranch: 'feat-1' });
  pushRepoHistory({ owner: 'alexanderpeschkaGit', repo: 'testrepo', branch: 'feature-x', targetBranch: 'feat-2' });

  const loaded = loadRepoHistory();
  assert.equal(loaded.length, 1, '3 branch changes on the same repo must leave exactly 1 entry');
  assert.equal(loaded[0].branch, 'feature-x', 'latest branch is upserted at position 0');
  assert.equal(loaded[0].targetBranch, 'feat-2', 'latest targetBranch is preserved');
  console.log('PASS: repoHistory deduplicates by canonical repoSlug and handles empty owner without leading slash');
}

// 2.6: HUD lifecycle (initGeminiEdgeHud / destroyGeminiEdgeHud / resetGeminiEdgeHud) & busy guard
{
  globalThis.window = globalThis;
  globalThis.window.top = globalThis.window;
  globalThis.window.self = globalThis.window;
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  };

  const indexUrl = await bundleModule('packages/userscript-hud/src/index.ts');
  const { initGeminiEdgeHud, destroyGeminiEdgeHud, resetGeminiEdgeHud } = await import(indexUrl);

  const ctrl1 = initGeminiEdgeHud();
  assert.ok(ctrl1, 'initGeminiEdgeHud returns controller');
  assert.ok(globalThis.document.getElementById('gemini-edge-hud-root'), '#gemini-edge-hud-root is mounted in DOM');

  // Concurrency guard: reset is blocked while MIXING or PATCHING
  ctrl1.updateState({ status: 'MIXING' });
  const guardedCtrl = resetGeminiEdgeHud();
  assert.equal(guardedCtrl, ctrl1, 'resetGeminiEdgeHud is blocked while status === MIXING');
  assert.ok(globalThis.document.getElementById('gemini-edge-hud-root'), 'host remains mounted during MIXING guard');

  ctrl1.updateState({ status: 'IDLE' });
  destroyGeminiEdgeHud();
  assert.equal(globalThis.document.getElementById('gemini-edge-hud-root'), null, 'destroyGeminiEdgeHud removes #gemini-edge-hud-root');

  const ctrl2 = resetGeminiEdgeHud();
  assert.ok(ctrl2 && ctrl2 !== ctrl1, 'resetGeminiEdgeHud mounts a fresh controller instance');
  assert.ok(globalThis.document.getElementById('gemini-edge-hud-root'), '#gemini-edge-hud-root is re-mounted after reset');
  destroyGeminiEdgeHud();
  console.log('PASS: HUD lifecycle init/destroy/reset and MIXING/PATCHING concurrency guard work as expected');
}

console.log('Multi-turn mix continuation & compact HUD layout suite: PASS');
