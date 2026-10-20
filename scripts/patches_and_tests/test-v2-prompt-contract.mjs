import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const ts = require(path.join(ROOT_DIR, 'packages/edge-worker/node_modules/typescript/lib/typescript.js'));

function readEmbeddedInstructions() {
  const source = fs.readFileSync(
    path.join(ROOT_DIR, 'packages/edge-worker/src/modules/mixChunker.ts'),
    'utf8'
  );
  const sourceFile = ts.createSourceFile('mixChunker.ts', source, ts.ScriptTarget.Latest, true);
  let initializer;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'DEFAULT_MIX_INSTRUCTIONS'
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  const stringArray = initializer && ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    initializer.expression.name.text === 'join' &&
    initializer.expression.expression;
  assert.ok(stringArray && ts.isArrayLiteralExpression(stringArray), 'embedded instructions are a joined string array');
  return stringArray.elements.map((element) => {
    assert.ok(ts.isStringLiteralLike(element), 'embedded instruction entries are string literals');
    return element.text;
  }).join('\n');
}

async function loadHarvesterParser() {
  const source = fs.readFileSync(
    path.join(ROOT_DIR, 'packages/userscript-hud/src/dom/harvester.ts'),
    'utf8'
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  const harvester = await import(moduleUrl);
  return {
    parseV2PatchPayloadFromCode: harvester.parseV2PatchPayloadFromCode,
    convertLegacyBlocksToV2Payload: harvester.convertLegacyBlocksToV2Payload,
  };
}

function extractJsonExamples(prompt) {
  return [...prompt.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
}

function validateCanonicalPayload(example, parseV2PatchPayloadFromCode, label) {
  const exampleObject = JSON.parse(example);
  const payload = parseV2PatchPayloadFromCode(example);
  assert.ok(payload, `${label}: harvester accepts the V2 JSON example`);
  assert.deepEqual(Object.keys(exampleObject).sort(), ['commitMessage', 'patches'], `${label}: canonical top-level fields`);
  assert.deepEqual(payload, exampleObject, `${label}: harvester parses the example without changing it`);
  assert.ok(payload.commitMessage.trim().length > 0, `${label}: commitMessage is present`);

  const actions = new Set();
  for (const patch of payload.patches) {
    assert.equal(typeof patch.path, 'string', `${label}: patch path is a string`);
    actions.add(patch.action);
    if (patch.action === 'modify') {
      assert.deepEqual(Object.keys(patch).sort(), ['action', 'blocks', 'path']);
      assert.ok(Array.isArray(patch.blocks) && patch.blocks.length > 0, `${label}: modify has blocks`);
      for (const block of patch.blocks) {
        assert.deepEqual(Object.keys(block).sort(), ['replace', 'search']);
        assert.equal(typeof block.search, 'string');
        assert.equal(typeof block.replace, 'string');
        assert.ok(block.search.length > 0, `${label}: search snippet is not empty`);
      }
    } else if (patch.action === 'create') {
      assert.deepEqual(Object.keys(patch).sort(), ['action', 'fullContent', 'path']);
      assert.equal(typeof patch.fullContent, 'string');
    } else if (patch.action === 'delete') {
      assert.deepEqual(Object.keys(patch).sort(), ['action', 'path']);
    } else {
      assert.fail(`${label}: unsupported V2 action ${patch.action}`);
    }
  }
  assert.deepEqual([...actions].sort(), ['create', 'delete', 'modify'], `${label}: all operations are represented`);
}

const harvester = await loadHarvesterParser();
const { parseV2PatchPayloadFromCode } = harvester;
const embedded = readEmbeddedInstructions();
const standalone = fs.readFileSync(path.join(ROOT_DIR, 'gemini_prompt_instructions.txt'), 'utf8');

assert.match(embedded, /^<instructions>\n[\s\S]*\n<\/instructions>$/, 'embedded text has its XML wrapper');
const embeddedBody = embedded.slice('<instructions>\n'.length, -'\n</instructions>'.length);
assert.ok(!embeddedBody.includes('<') && !embeddedBody.includes('&'), 'embedded body has no unescaped XML markup or entities');
assert.ok(!embedded.includes(']]>'), 'embedded text has no invalid CDATA terminator');

for (const [label, prompt, expectedExamples] of [
  ['embedded', embedded, 1],
  ['standalone', standalone, 2],
]) {
  const examples = extractJsonExamples(prompt);
  assert.equal(examples.length, expectedExamples, `${label}: expected V2 examples are present`);
  for (const example of examples) {
    validateCanonicalPayload(example, parseV2PatchPayloadFromCode, label);
  }
  assert.match(prompt, /V1[\s\S]{0,200}SEARCH\/REPLACE[\s\S]{0,250}(?:separate|fallback|separater|Fallback)/i, `${label}: V1 is a separate fallback`);
  assert.match(prompt, /placeholder/i, `${label}: placeholder prohibition is preserved`);
}

{
  const legacyText = [
    '// filepath: src/legacy.ts',
    '<<<<<<< SEARCH',
    'export const value = 1;',
    '=======',
    'export const value = 2;',
    '>>>>>>> REPLACE',
  ].join('\n');
  const converted = harvester.convertLegacyBlocksToV2Payload(legacyText);
  assert.ok(converted, 'V1 SEARCH/REPLACE blocks are converted instead of being rejected');
  assert.deepEqual(converted.payload.patches.map((patch) => patch.action), ['modify'], 'V1 blocks become a single modify operation');
  assert.equal(converted.payload.patches[0].path, 'src/legacy.ts', 'V1 filepath header selects the target file');
  assert.deepEqual(
    converted.payload.patches[0].blocks,
    [{ search: 'export const value = 1;', replace: 'export const value = 2;' }],
    'V1 search/replace content is preserved verbatim in the V2 payload'
  );
  assert.ok(converted.payload.commitMessage.includes('src/legacy.ts'), 'V1 path hint is retained for the commit message');
  assert.equal(converted.legacyPayload.files[0].diff, legacyText, 'V1 legacy payload still carries the raw diff');
  console.log('V1 fallback conversion executes: PASS');
}

console.log('V2 prompt contract: PASS (embedded and standalone examples accepted by the harvester parser; XML text and guardrails verified)');
