import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBatchFormulaModule, loadHarvesterModules, loadPatchQueueModules, loadSelfHealingModule } from './harvester-modules.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function loadModules() {
  const modules = await loadHarvesterModules(ROOT_DIR);
  const queue = await loadPatchQueueModules(ROOT_DIR);
  const formula = await loadBatchFormulaModule(ROOT_DIR);
  const selfHealing = await loadSelfHealingModule(ROOT_DIR);
  return {
    canonicalize: modules.canonicalize,
    computePatchSignature: modules.computePatchSignature,
    createStablePatchId: modules.createStablePatchId,
    startDomHarvester: modules.startDomHarvester,
    parseV2PatchPayloadFromCode: modules.parseV2PatchPayloadFromCode,
    convertLegacyBlocksToV2Payload: modules.convertLegacyBlocksToV2Payload,
    ...selfHealing,
    ...queue,
    ...formula,
  };
}


/* ---------------------------- minimal DOM shim ---------------------------- */

const NOT_PSEUDO = ':not(';

function splitTopLevel(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of selector) {
    if (char === '[' || char === '(') depth++;
    if (char === ']' || char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function readBalanced(text, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')') {
      depth--;
      if (depth === 0) return { inner: text.slice(startIndex + 1, index), end: index };
    }
  }
  throw new Error(`unbalanced selector: ${text}`);
}

function readIdentifier(text, startIndex) {
  let index = startIndex;
  while (index < text.length && /[A-Za-z0-9_-]/.test(text[index])) index++;
  return { value: text.slice(startIndex, index), end: index };
}

function matchesAttribute(element, inner) {
  const match = inner.match(/^([A-Za-z0-9_-]+)(?:(\*=|=)"?([^"]*)"?)?$/);
  if (!match) throw new Error(`unsupported attribute selector: [${inner}]`);
  const [, name, operator, expected] = match;
  const actual = element.getAttribute(name);
  if (!operator) return actual !== null;
  if (actual === null) return false;
  return operator === '*=' ? actual.includes(expected) : actual === expected;
}

function matchesCompound(element, compound) {
  let index = 0;
  if (compound === '*') return true;
  while (index < compound.length) {
    const char = compound[index];
    if (char === '.') {
      const { value, end } = readIdentifier(compound, index + 1);
      const classes = String(element.className || '').split(/\s+/).filter(Boolean);
      if (!classes.includes(value)) return false;
      index = end;
    } else if (char === '[') {
      const close = compound.indexOf(']', index);
      if (!matchesAttribute(element, compound.slice(index + 1, close))) return false;
      index = close + 1;
    } else if (compound.startsWith(NOT_PSEUDO, index)) {
      const { inner, end } = readBalanced(compound, index + NOT_PSEUDO.length - 1);
      if (matchesCompound(element, inner)) return false;
      index = end + 1;
    } else if (/[A-Za-z]/.test(char)) {
      const { value, end } = readIdentifier(compound, index);
      if (element.tagName !== value.toUpperCase()) return false;
      index = end;
    } else {
      index++;
    }
  }
  return true;
}

function matchesSelector(element, selector) {
  return splitTopLevel(selector).some((compound) => matchesCompound(element, compound));
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.style = { cssText: '', position: '', top: '', right: '' };
    this.className = '';
    this.onclick = null;
    this._text = '';
    this.shadowRoot = null;
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    child.parentElement = this;
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (element) => {
      for (const child of element.children) {
        if (matchesSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  attachShadow() {
    this.shadowRoot = new FakeElement('shadow-root', this.ownerDocument);
    return this.shadowRoot;
  }

  addEventListener() {}
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
    this.documentElement = new FakeElement('html', this);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  addEventListener() {}
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {}

  disconnect() {}
}

function mountHarvester(startDomHarvester) {
  const document = new FakeDocument();
  globalThis.document = document;
  globalThis.MutationObserver = FakeMutationObserver;
  const harvested = [];
  const inlineApplied = [];
  const observer = startDomHarvester(
    (patch) => harvested.push(patch),
    (patch) => inlineApplied.push(patch)
  );
  return { document, harvested, inlineApplied, observer };
}

function addCodeBlock(document, codeText, options = {}) {
  const codeBlock = document.createElement('code-block');
  const header = document.createElement('div');
  header.className = options.headerClass || 'code-header';
  if (options.clonedButton) {
    const cloned = document.createElement('button');
    cloned.className = 'ggb-inline-btn';
    cloned.textContent = '⚡ Push Patch (/api/patch)';
    header.appendChild(cloned);
  }
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = codeText;
  pre.appendChild(code);
  codeBlock.appendChild(header);
  codeBlock.appendChild(pre);
  document.body.appendChild(codeBlock);
  return { codeBlock, header, pre };
}

function payloadJson({ commitMessage = 'feat(types): add SocialLink.label', pathName = 'src/types.ts', search = 'a', replace = 'b' } = {}) {
  return JSON.stringify({
    commitMessage,
    patches: [
      {
        path: pathName,
        action: 'modify',
        blocks: [{ search, replace }],
      },
    ],
  });
}

/* --------------------------------- tests --------------------------------- */

const {
  canonicalize,
  computePatchSignature,
  createStablePatchId,
  startDomHarvester,
  enqueueHarvestedPatch,
  isDuplicatePatch,
  removeHarvestedPatch,
  fifoQueue,
  runPatchQueue,
  coalescePatchesIntoBatch,
  buildBatchFormulaPrompt,
  MAX_QUEUED_PATCHES,
  partitionQueueForHolisticCheck,
  parseV2PatchPayloadFromCode,
  convertLegacyBlocksToV2Payload,
  buildSelfHealingPrompt,
} = await loadModules();

{
  const payload = {
    commitMessage: 'feat(types): add SocialLink.label',
    patches: [{ path: 'src/types.ts', action: 'modify', blocks: [{ search: 'a', replace: 'b' }] }],
  };
  const reordered = {
    patches: [
      {
        blocks: [{ replace: 'b', search: 'a' }],
        action: 'modify',
        path: 'src/types.ts',
      },
    ],
    commitMessage: 'feat(types): add SocialLink.label',
  };

  assert.deepEqual(canonicalize(reordered), canonicalize(payload), 'canonicalize ignores JSON key order');
  assert.equal(
    computePatchSignature('v2_json', reordered),
    computePatchSignature('v2_json', payload),
    'signature is key-order independent'
  );

  const baseId = createStablePatchId('v2_json', payload);
  assert.match(baseId, /^patch-[0-9a-z]+$/, 'stable id has the patch-<hash> shape');
  assert.equal(createStablePatchId('v2_json', reordered), baseId, 'identical payloads share one id');
  assert.equal(createStablePatchId('v2_json', payload), createStablePatchId('v2_json', payload), 'ids are deterministic');

  const variants = {
    commitMessage: { ...payload, commitMessage: 'feat(types): other message' },
    path: { ...payload, patches: [{ ...payload.patches[0], path: 'src/other.ts' }] },
    search: {
      ...payload,
      patches: [{ ...payload.patches[0], blocks: [{ search: 'a2', replace: 'b' }] }],
    },
    replace: {
      ...payload,
      patches: [{ ...payload.patches[0], blocks: [{ search: 'a', replace: 'b2' }] }],
    },
    patchOrder: {
      ...payload,
      patches: [
        payload.patches[0],
        { path: 'src/second.ts', action: 'create', fullContent: 'export const x = 1;' },
      ],
    },
  };

  const seen = new Set([baseId]);
  for (const [label, variant] of Object.entries(variants)) {
    const variantId = createStablePatchId('v2_json', variant);
    assert.notEqual(variantId, baseId, `${label} changes the id`);
    assert.ok(!seen.has(variantId), `${label} is a distinct identity`);
    seen.add(variantId);
  }
  assert.notEqual(
    createStablePatchId('v1_search_replace', payload),
    baseId,
    'mode participates in the identity'
  );
}

{
  const identical = payloadJson();
  const { document, harvested, inlineApplied, observer } = mountHarvester(startDomHarvester);

  addCodeBlock(document, identical);
  observer.callback();
  assert.equal(harvested.length, 1, 'initial scan harvests exactly one patch');
  assert.equal(document.querySelectorAll('.ggb-inline-btn').length, 1, 'exactly one inline button is attached');
  assert.equal(harvested[0].id, createStablePatchId('v2_json', JSON.parse(identical)), 'queue id is content-derived');

  observer.callback();
  assert.equal(harvested.length, 1, 'a repeated scan does not re-harvest the same block');
  assert.equal(document.querySelectorAll('.ggb-inline-btn').length, 1, 'a repeated scan adds no second button');

  const inlineButton = document.querySelector('.ggb-inline-btn');
  inlineButton.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(inlineApplied.length, 1, 'the inline button applies the harvested patch once');
  assert.equal(inlineApplied[0].id, harvested[0].id, 'inline apply uses the same stable patch');

  addCodeBlock(document, identical, { clonedButton: true });
  observer.callback();
  assert.equal(harvested.length, 1, 'a re-rendered block with an inline button is not queued again');
  assert.equal(
    document.querySelectorAll('.ggb-inline-btn').length,
    2,
    'the re-rendered block keeps only its cloned button'
  );

  addCodeBlock(document, payloadJson({ commitMessage: 'fix(types): different payload', pathName: 'src/other.ts' }));
  observer.callback();
  assert.equal(harvested.length, 2, 'a genuinely different payload is still harvested');
  assert.notEqual(harvested[1].id, harvested[0].id, 'the second patch has its own identity');
  assert.equal(document.querySelectorAll('.ggb-inline-btn').length, 3, 'the third block receives its own button');
}

{
  const patchText = [
    '<<<<<<< SEARCH',
    'if (data.theme) {',
    '  baseThemeSettings = data.theme;',
    '}',
    '=======',
    'if (data.theme) {',
    '  baseThemeSettings = data.theme;',
    '}',
    '>>>>>>> REPLACE',
  ].join('\n');

  const first = mountHarvester(startDomHarvester);
  const { codeBlock } = addCodeBlock(first.document, patchText);
  first.observer.callback();
  assert.equal(first.harvested.length, 1, 'a path-less block is harvested');
  assert.equal(first.harvested[0].payload.patches[0].path, '', 'the path is still missing at harvest');

  // Gemini streams the filename heading only after the fenced block exists.
  const heading = first.document.createElement('p');
  heading.textContent = 'file :`src/store/portfolioFetchActions.ts`';
  first.document.body.insertBefore(heading, codeBlock);

  first.observer.callback();
  assert.equal(
    first.harvested[0].payload.patches[0].path,
    'src/store/portfolioFetchActions.ts',
    'a heading rendered after the harvest fills the queued patch'
  );

  const second = mountHarvester(startDomHarvester);
  const secondBlock = addCodeBlock(second.document, patchText);
  second.observer.callback();
  assert.equal(second.harvested[0].payload.patches[0].path, '', 'second harvest starts path-less');

  const lateHeading = second.document.createElement('p');
  lateHeading.textContent = 'file :`src/store/portfolioFetchActions.ts`';
  second.document.body.insertBefore(lateHeading, secondBlock.codeBlock);
  // No extra scan: the click itself must re-read the DOM.
  const button = secondBlock.codeBlock.querySelector('.ggb-inline-btn');
  button.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(
    second.inlineApplied[0].payload.patches[0].path,
    'src/store/portfolioFetchActions.ts',
    'the inline apply refreshes a missing path from the live DOM'
  );
}

{
  const legacy = [
    '// filepath: src/legacy.ts',
    '<<<<<<< SEARCH',
    'export const value = 1;',
    '=======',
    'export const value = 2;',
    '>>>>>>> REPLACE',
  ].join('\n');
  const first = mountHarvester(startDomHarvester);
  addCodeBlock(first.document, legacy);
  first.observer.callback();
  assert.equal(first.harvested.length, 1, 'legacy SEARCH/REPLACE blocks are harvested once');
  assert.equal(first.harvested[0].mode, 'v1_search_replace', 'legacy blocks keep their V1 mode');
  assert.match(first.harvested[0].id, /^patch-[0-9a-z]+$/, 'legacy ids are content-derived too');
  first.observer.callback();
  assert.equal(first.harvested.length, 1, 'a second scan of a legacy block stays at one harvest');

  const second = mountHarvester(startDomHarvester);
  addCodeBlock(second.document, legacy);
  second.observer.callback();
  assert.equal(
    second.harvested[0].id,
    first.harvested[0].id,
    'legacy ids are stable across re-harvests'
  );
}

{
  const makePatch = (id, payload) => ({
    id,
    mode: 'v2_json',
    commitMessage: payload.commitMessage,
    payload,
    timestamp: '',
  });

  const first = makePatch('patch-a', JSON.parse(payloadJson()));
  const duplicateById = { ...first };
  const duplicateByContent = makePatch('patch-other-id', JSON.parse(payloadJson()));
  const other = makePatch('patch-b', JSON.parse(payloadJson({ commitMessage: 'fix: other patch' })));

  let queue = [];
  queue = enqueueHarvestedPatch(queue, first);
  assert.equal(queue.length, 1, 'the first patch is queued');
  assert.equal(enqueueHarvestedPatch(queue, duplicateById), queue, 'a repeated id is ignored');
  assert.equal(
    enqueueHarvestedPatch(queue, duplicateByContent),
    queue,
    'an identical payload with a different id is ignored'
  );
  assert.ok(isDuplicatePatch(queue, duplicateByContent), 'content duplicates are detected');

  queue = enqueueHarvestedPatch(queue, other);
  assert.equal(queue.length, 2, 'a distinct payload is queued');
  assert.deepEqual(
    fifoQueue(queue).map((entry) => entry.id),
    ['patch-a', 'patch-b'],
    'FIFO applies the oldest harvest first'
  );
  assert.deepEqual(
    removeHarvestedPatch(queue, 'patch-a').map((entry) => entry.id),
    ['patch-b'],
    'committed patches leave the queue'
  );

  let capped = [];
  for (let index = 0; index < MAX_QUEUED_PATCHES + 5; index++) {
    capped = enqueueHarvestedPatch(
      capped,
      makePatch('cap-' + index, JSON.parse(payloadJson({ commitMessage: 'cap ' + index })))
    );
  }
  assert.equal(capped.length, MAX_QUEUED_PATCHES, 'the queue keeps its size cap');
  assert.equal(capped[0].id, 'cap-' + (MAX_QUEUED_PATCHES + 4), 'the newest patch stays on top');

  const attempts = [];
  const progress = [];
  const run = await runPatchQueue(
    queue,
    async (patch) => {
      attempts.push(patch.id);
      return patch.id !== 'patch-b';
    },
    (_patch, index, total) => progress.push(`${index + 1}/${total}`)
  );

  assert.deepEqual(attempts, ['patch-a', 'patch-b'], 'the queue runs in FIFO order');
  assert.deepEqual(progress, ['1/2', '2/2'], 'progress reports index and total');
  assert.equal(run.applied, 1, 'fail-fast counts only applied patches');
  assert.equal(run.total, 2, 'total reflects the queue length at start');
}

{
  const makeBatchPatch = (id, pathName, commitMessage, preflight) => ({
    id,
    mode: 'v2_json',
    commitMessage,
    payload: {
      commitMessage,
      patches: [{ path: pathName, action: 'modify', blocks: [{ search: 'a', replace: 'b' }] }],
      ...(preflight ? { preflight } : {}),
    },
    timestamp: '',
  });

  const first = makeBatchPatch('batch-a', 'src/a.ts', 'feat: a', {
    forbidPatterns: ['console\\.log', ': any'],
    requireExports: { 'src/a.ts': ['useAuth'] },
  });
  const second = makeBatchPatch('batch-b', 'src/b.ts', 'feat: b', {
    forbidPatterns: [': any', 'debugger'],
    requireExports: { 'src/a.ts': ['useAuth', 'init'], 'src/b.ts': ['helper'] },
  });

  let batchQueue = [];
  batchQueue = enqueueHarvestedPatch(batchQueue, first);
  batchQueue = enqueueHarvestedPatch(batchQueue, second);

  const batch = coalescePatchesIntoBatch(batchQueue);
  assert.ok(batch, 'a two-entry queue coalesces into one atomic batch');
  assert.deepEqual(
    batch.payload.patches.map((operation) => operation.path),
    ['src/a.ts', 'src/b.ts'],
    'the coalesced batch keeps FIFO order'
  );
  assert.equal(batch.payload.patches.length, 2, 'the batch carries one operation per queued patch');
  assert.deepEqual(
    batch.payload.preflight.forbidPatterns,
    ['console\\.log', ': any', 'debugger'],
    'forbidPatterns merge without duplicates'
  );
  assert.deepEqual(
    batch.payload.preflight.requireExports,
    { 'src/a.ts': ['useAuth', 'init'], 'src/b.ts': ['helper'] },
    'requireExports merge per file'
  );
  assert.equal(
    batch.commitMessage,
    'batch: feat: a | feat: b',
    'the consolidated commit message keeps FIFO messages'
  );
  assert.equal(
    batch.id,
    createStablePatchId('v2_json', batch.payload),
    'the batch id stays content-derived'
  );

  assert.equal(coalescePatchesIntoBatch([first]), null, 'a single patch is not coalesced');
  const unresolved = makeBatchPatch('batch-c', '', 'feat: c');
  assert.equal(
    coalescePatchesIntoBatch([unresolved, second]),
    null,
    'an unresolved path disables atomic coalescing'
  );

  const formula = buildBatchFormulaPrompt(
    {
      repo: 'owner/repo',
      branch: 'main',
      targetBranch: 'preview',
      includePaths: ['src/', 'packages/edge-worker/'],
    },
    { headOid: '1234567890abcdef1234567890abcdef12345678' }
  );
  assert.match(formula, /owner\/repo@preview/, 'the formula names the active repo and target branch');
  assert.ok(formula.includes('base headOid: 1234567'), 'the formula grounds the model in the snapshot head');
  assert.ok(formula.includes('src/, packages/edge-worker/'), 'the formula carries the active path scope');
  assert.ok(formula.includes('SINGLE atomic V2 GeminiPatchPayload'), 'the formula demands one atomic payload');
  assert.ok(formula.includes('exactly ONE ```json block'), 'the formula caps output to one JSON block');
  assert.ok(formula.includes('at most ONCE'), 'the formula forbids duplicate file entries');
  assert.ok(formula.includes('NEVER use placeholders'), 'the formula repeats the placeholder ban');
  assert.ok(
    formula.includes('without reordering union types'),
    'the formula protects unchanged function and union type signatures'
  );


  // 1. Holistic queue partition with mixed valid and invalid snippets
  const p1 = makeBatchPatch('q-1', 'src/a.ts', 'feat: a');
  const p2 = {
    id: 'q-2',
    mode: 'v2_json',
    commitMessage: 'broken path snippet',
    payload: {
      commitMessage: 'broken',
      patches: [{ path: '', action: 'modify', blocks: [{ search: 'old', replace: 'new' }] }]
    },
    timestamp: new Date().toISOString()
  };
  const p3 = makeBatchPatch('q-3', 'src/a.ts', 'feat: a part 2');
  const p4 = makeBatchPatch('q-4', 'src/b.ts', 'feat: b');

  const partition = partitionQueueForHolisticCheck([p4, p3, p2, p1]);
  assert.equal(partition.totalSnippets, 4, 'inspects all 4 snippets');
  assert.equal(partition.localErrors.length, 1, 'aggregates missing path error');
  assert.match(partition.localErrors[0].file, /snippet #2/, 'identifies snippet #2 as having missing path');
  assert.equal(partition.localErrors[0].stage, 'SEARCH_REPLACE');
  assert.ok(partition.validBatch, 'extracts valid batch even when other snippets have local errors');
  assert.deepEqual(partition.targetFiles, ['src/a.ts', 'src/b.ts'], 'lists all unique valid target files');
  assert.equal(partition.validBatch.payload.patches.length, 2, 'merges snippets targeting the same file');
  assert.equal(partition.validBatch.payload.patches[0].blocks.length, 2, 'concatenates modify blocks on same file');

  // 2. parseV2PatchPayloadFromCode with markdown wrappers
  const wrappedMd = '```md\nHere is your fix:\n```json\n{\n  "commitMessage": "test fix",\n  "patches": [\n    {\n      "path": "src/index.ts",\n      "action": "modify",\n      "blocks": [{ "search": "old", "replace": "new" }]\n    }\n  ]\n}\n```\nHope this helps!\n```';
  const parsedMd = parseV2PatchPayloadFromCode(wrappedMd);
  assert.ok(parsedMd, 'extracts inner JSON payload from markdown block');
  assert.equal(parsedMd.commitMessage, 'test fix');
  assert.equal(parsedMd.patches[0].path, 'src/index.ts');

  // 3. convertLegacyBlocksToV2Payload with multi-file diff sections
  const blockA = ['<' + '<<<<<< SEARCH', 'export const A = 1;', '='.repeat(7), 'export const A = 2;', '>'.repeat(7) + ' REPLACE'].join('\n');
  const blockB = ['<' + '<<<<<< SEARCH', 'export const B = 1;', '='.repeat(7), 'export const B = 2;', '>'.repeat(7) + ' REPLACE'].join('\n');
  const multiFileDiff = `// filepath: src/header.ts\n${blockA}\n\n### src/footer.ts\n${blockB}`;
  const legacyParsed = convertLegacyBlocksToV2Payload(multiFileDiff);
  assert.ok(legacyParsed, 'parses multi-file diff block');
  assert.equal(legacyParsed.payload.patches.length, 2, 'produces 2 FilePatchOperations');
  assert.equal(legacyParsed.payload.patches[0].path, 'src/header.ts');
  assert.equal(legacyParsed.payload.patches[1].path, 'src/footer.ts');

  // 4. buildSelfHealingPrompt with targetFiles & importable instructions
  const prompt = buildSelfHealingPrompt(
    partition.localErrors,
    'owner/repo',
    'main',
    '1234567890abcdef1234567890abcdef12345678',
    1,
    { targetFiles: ['src/a.ts', 'src/b.ts'], targetBranch: 'preview' }
  );
  assert.ok(prompt.includes('Target Files in Scope: src/a.ts, src/b.ts'), 'includes target files');
  assert.ok(prompt.includes('branch "preview"'), 'includes target branch');
  assert.ok(prompt.includes('Anchor Context: Provide 2–4 lines of verbatim surrounding context'), 'includes anchor context rule');
  assert.ok(prompt.includes('directly importable Markdown/JSON patch block'), 'demands importable code block');

  // 5. Same-file create followed by modify is preserved in sequence in partitionQueueForHolisticCheck
  const createPatch = {
    id: 'q-create',
    mode: 'v2_json',
    commitMessage: 'feat: create c.ts',
    payload: {
      commitMessage: 'feat: create c.ts',
      patches: [{ path: './src/c.ts', action: 'create', fullContent: 'export const c = 1;\n' }],
      preflight: { requireExports: { './src/c.ts': ['c'] } },
    },
    timestamp: '',
  };
  const modifyCreatedPatch = makeBatchPatch('q-mod-c', 'src/c.ts', 'feat: update c.ts');
  const createThenModPartition = partitionQueueForHolisticCheck([modifyCreatedPatch, createPatch]);
  assert.equal(
    createThenModPartition.validBatch.payload.patches.length,
    2,
    'create followed by modify on the same file stays a 2-step sequence'
  );
  assert.equal(createThenModPartition.validBatch.payload.patches[0].action, 'create');
  assert.equal(createThenModPartition.validBatch.payload.patches[1].action, 'modify');
  assert.deepEqual(
    createThenModPartition.validBatch.payload.preflight.requireExports,
    { 'src/c.ts': ['c'] },
    'requireExports keys are canonicalized via normalizeRepoPath'
  );

  // 6. parseV2PatchPayloadFromCode preserves JSON strings containing inner backtick fences and surrounding prose braces
  const fenceInsideString = '```md\nFix for `function demo() {}`:\n```json\n' + JSON.stringify({
    commitMessage: 'docs: example fence',
    patches: [{
      path: 'src/prompt.ts',
      action: 'modify',
      blocks: [{ search: 'old', replace: 'Example:\n```json\n{ "a": 1 }\n```' }],
    }],
  }) + '\n```\nNotes: `{ done: true }`\n```';
  const parsedWithInnerFence = parseV2PatchPayloadFromCode(fenceInsideString);
  assert.ok(parsedWithInnerFence, 'parses JSON payload even when replace string contains backtick fences and prose has braces');
  assert.equal(parsedWithInnerFence.patches[0].path, 'src/prompt.ts');

  // 7. Streaming guardrails: incomplete diff or incomplete V2 JSON with a path hint must return null
  const incompleteDiff = '// filepath: src/streaming.ts\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;';
  assert.equal(
    convertLegacyBlocksToV2Payload(incompleteDiff, 'src/streaming.ts'),
    null,
    'incomplete streaming SEARCH/REPLACE block must not fall through to full-file create'
  );
  const incompleteJson = '{\n  "commitMessage": "feat: streaming",\n  "patches": [\n    { "path": "src/a.ts"';
  assert.equal(
    convertLegacyBlocksToV2Payload(incompleteJson, 'src/a.ts'),
    null,
    'incomplete streaming V2 JSON must not fall through to full-file create'
  );

  // 8. Bare path comments between multi-file diff sections are resolved
  const bareMultiFileDiff = `// src/first.ts\n${blockA}\n\n// src/second.ts\n${blockB}`;
  const bareMultiParsed = convertLegacyBlocksToV2Payload(bareMultiFileDiff);
  assert.ok(bareMultiParsed, 'parses multi-file diff with bare path comments');
  assert.deepEqual(
    bareMultiParsed.payload.patches.map((p) => p.path),
    ['src/first.ts', 'src/second.ts'],
    'resolves bare path comment for second diff section'
  );

  // 9. Multiple sibling <pre> blocks in a shared parent container (no <code-block> wrapper) are all harvested
  const siblingEnv = mountHarvester(startDomHarvester);
  const sharedContainer = siblingEnv.document.createElement('div');
  siblingEnv.document.body.appendChild(sharedContainer);
  for (const file of ['src/one.ts', 'src/two.ts']) {
    const pre = siblingEnv.document.createElement('pre');
    const code = siblingEnv.document.createElement('code');
    code.textContent = payloadJson({ commitMessage: `feat: ${file}`, pathName: file });
    pre.appendChild(code);
    sharedContainer.appendChild(pre);
  }
  siblingEnv.observer.callback();
  assert.equal(siblingEnv.harvested.length, 2, 'both sibling <pre> blocks in a shared container are harvested');

  // 10. Streaming multi-block diff growth updates the harvested patch in-place without duplicate emission
  const streamEnv = mountHarvester(startDomHarvester);
  const streamPre = streamEnv.document.createElement('pre');
  const streamCode = streamEnv.document.createElement('code');
  streamCode.textContent = `// filepath: src/stream.ts\n${blockA}`;
  streamPre.appendChild(streamCode);
  streamEnv.document.body.appendChild(streamPre);
  streamEnv.observer.callback();
  assert.equal(streamEnv.harvested.length, 1, 'initial completed diff block is harvested once');
  assert.equal(streamEnv.harvested[0].payload.patches[0].blocks.length, 1, 'starts with 1 diff block');

  // Mid-stream second block (partial marker) is ignored until balanced
  streamCode.textContent = `// filepath: src/stream.ts\n${blockA}\n<<<<`;
  assert.equal(
    convertLegacyBlocksToV2Payload(streamCode.textContent, 'src/stream.ts'),
    null,
    'trailing partial diff marker returns null while second block is streaming'
  );
  assert.equal(
    convertLegacyBlocksToV2Payload('// filepath: src/stream.ts', 'src/stream.ts'),
    null,
    'header-only comment without body lines returns null during streaming'
  );

  // Second diff block finishes streaming into the same <pre>
  streamCode.textContent = `// filepath: src/stream.ts\n${blockA}\n\n${blockB}`;
  streamEnv.observer.callback();
  assert.equal(streamEnv.harvested.length, 1, 'streaming growth does not emit a duplicate queue entry');
  assert.equal(
    streamEnv.harvested[0].payload.patches[0].blocks.length,
    2,
    'existing harvested patch is updated in-place with the second diff block'
  );
}

console.log(
  'Harvest dedupe: PASS (stable content ids, one emission per code block, re-renders and repeated scans produce no duplicate queue entries, FIFO queue dedupes by id and payload, atomic batch coalescing, holistic queue partitioning, and importable self-healing prompt stay in contract)'
);
