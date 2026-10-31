#!/usr/bin/env node
/**
 * Regression suite for the in-worker syntax lexer (Stage 4 preflight).
 *
 * The lexer treated "</tag" as the start of a regex literal and JSX text
 * contractions ("Don't") as string delimiters, so every valid .tsx/.jsx file
 * failed preflight with bogus OXC_SYNTAX errors. Real defects must still be
 * reported.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const build = await esbuild.build({
  entryPoints: [path.join(ROOT, 'packages/edge-worker/src/modules/syntaxScanner.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const url = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
const { validateSyntaxInWorker } = await import(url);

const TSX = 'src/probe.tsx';
const TS = 'src/probe.ts';

async function errors(file, content) {
  return validateSyntaxInWorker(file, content);
}

// --- Valid JSX must pass ---------------------------------------------------
const validJsx = {
  'closing tags': 'export const A = () => (\n  <main>\n    <div>\n      <span>ok</span>\n    </div>\n  </main>\n);',
  'arrow-map span': 'export const A = ({ list }) => (\n  <div>{list.map((line, i) => <span key={i}>{line}</span>)}</div>\n);',
  fragments: 'export const A = () => <><b>{1}</b></>;',
  'self closing': 'export const A = () => <img src="x" alt="y" />;',
  'jsx comment': 'export const A = () => (<div>{/* don\'t break */}</div>);',
  contractions: 'export function A() { return <p>Don\'t stop — it\'s fine</p>; }',
  'numeric contraction': 'export const A = () => <p>In the 1990\'s it\'s fine</p>;',
  'quoted text': 'export const A = () => <p>He said "hi"</p>;',
  'regex after greater-than': 'const ok = a > /x/.test(s);',
  'escaped regex slash': 'const r = /a\\/b/;',
  'ts pick union': "export type Cfg = Pick<HudConfig, 'repo' | 'branch' | 'targetBranch' | 'includePaths'>;",
};
for (const [name, code] of Object.entries(validJsx)) {
  const found = await errors(TSX, code);
  assert.deepEqual(found, [], `${name} must not report syntax errors: ${JSON.stringify(found)}`);
}
console.log(`PASS: ${Object.keys(validJsx).length} valid JSX shapes pass preflight`);

// --- Real defects must still be reported -----------------------------------
const unbalancedJsx = await errors(TSX, 'export const A = () => (<div>oops</div>;');
assert.ok(unbalancedJsx.some((e) => /Unclosed parenthesis/.test(e.message)), JSON.stringify(unbalancedJsx));

const unbalancedTs = await errors(TS, 'export function A() { return 1; ');
assert.ok(unbalancedTs.some((e) => /Unclosed brace/.test(e.message)), JSON.stringify(unbalancedTs));

const conflict = await errors(TS, 'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst c = 3;\n>>>>>>> branch\n');
assert.equal(conflict.filter((e) => /merge conflict marker/i.test(e.message)).length, 3, JSON.stringify(conflict));

const badString = await errors(TS, 'export const s = "abc\nconst x = 1;');
assert.ok(badString.some((e) => /Unterminated double-quoted string/.test(e.message)), JSON.stringify(badString));

const badRegex = await errors(TS, 'export const r = /abc\nconst x = 1;');
assert.ok(badRegex.some((e) => /Unterminated regular expression/.test(e.message)), JSON.stringify(badRegex));

const badJson = await errors('config.json', '{"a": 1,}');
assert.ok(badJson.some((e) => /JSON SyntaxError/.test(e.message)), JSON.stringify(badJson));

const brokenPickUnion = await errors(
  TS,
  "export function f(config: Pick<HudConfig, 'branch' 'includePaths' 'repo' 'targetBranch' |>) { return config; }"
);
assert.ok(
  brokenPickUnion.some((e) => /adjacent string literal/i.test(e.message)),
  `must catch adjacent string literals in broken union: ${JSON.stringify(brokenPickUnion)}`
);
assert.ok(
  brokenPickUnion.some((e) => /trailing "\|"/i.test(e.message)),
  `must catch trailing pipe before ">": ${JSON.stringify(brokenPickUnion)}`
);
console.log('PASS: unbalanced brackets, conflict markers, bad strings/regex and bad JSON are still reported');

console.log('\nAll syntax-scan checks passed.');
