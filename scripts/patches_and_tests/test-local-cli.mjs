import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(ROOT_DIR, 'packages/local-cli/dist/cli.mjs');

console.log('=== Stufe II: Funktionaler Test des Local CLI (packages/local-cli) ===\n');

let passCount = 0;
let totalCount = 0;

function assert(condition, message) {
  totalCount++;
  if (!condition) {
    console.error(`  ❌ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ [PASS] ${message}`);
  passCount++;
}

// 1. Test CLI Help output
try {
  const helpOut = execSync(`node "${CLI_PATH}" --help`, { encoding: 'utf-8' });
  assert(helpOut.includes('Gemini Bridge Local CLI'), 'CLI --help displays banner');
  assert(helpOut.includes('--prompt'), 'CLI --help displays --prompt option');
  assert(helpOut.includes('--skip-commit'), 'CLI --help displays --skip-commit option');
} catch (e) {
  assert(false, `CLI --help failed: ${e.message}`);
}

// 2. Test CLI without arguments (exits 1 and prints usage)
try {
  execSync(`node "${CLI_PATH}"`, { encoding: 'utf-8', stdio: 'pipe' });
  assert(false, 'CLI without arguments should exit with code 1');
} catch (e) {
  assert(e.status === 1, 'CLI without arguments correctly exits with status code 1');
  assert(e.stdout.includes('Usage:'), 'CLI without arguments displays usage');
}

// 3. Test CLI with prompt but without GEMINI_API_KEY (exits 1 with clear error)
try {
  execSync(`node "${CLI_PATH}" -p "Test prompt"`, {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, GEMINI_API_KEY: '' }
  });
  assert(false, 'CLI without GEMINI_API_KEY should exit with code 1');
} catch (e) {
  assert(e.status === 1, 'CLI without API key exits with code 1');
  const errOutput = e.stderr || e.stdout;
  assert(errOutput.includes('GEMINI_API_KEY is not set'), 'Error message clearly indicates missing GEMINI_API_KEY');
}

// 4. Test programmatic helper functions: parseCliArgs, extractJsonFromResponse & applyPatchesInMemory
const { parseCliArgs, extractJsonFromResponse, applyPatchesInMemory } = await import(pathToFileURL(CLI_PATH).href);

const parsed = parseCliArgs([
  'node',
  'cli.mjs',
  '--prompt',
  'Fix bug in auth',
  '--path',
  'src/auth.ts',
  '--path',
  'src/utils.ts',
  '--repo',
  'sikanda/bridge',
  '--branch',
  'feature/auth',
  '--model',
  'gemini-2.5-pro',
  '--skip-commit'
]);

assert(parsed.input.prompt === 'Fix bug in auth', 'parseCliArgs correctly parses --prompt');
assert(parsed.input.targetPaths?.length === 2, 'parseCliArgs collects multiple --path flags');
assert(parsed.input.repo === 'sikanda/bridge', 'parseCliArgs parses --repo');
assert(parsed.input.branch === 'feature/auth', 'parseCliArgs parses --branch');
assert(parsed.model === 'gemini-2.5-pro', 'parseCliArgs parses --model');
assert(parsed.skipCommit === true, 'parseCliArgs parses --skip-commit');

// 5. Test extractJsonFromResponse markdown stripping
const jsonRaw = '{"commitMessage":"test"}';
assert(extractJsonFromResponse(jsonRaw) === jsonRaw, 'extractJsonFromResponse passes plain JSON unchanged');

const jsonInFences = '```json\n{"commitMessage":"test in markdown"}\n```';
assert(extractJsonFromResponse(jsonInFences) === '{"commitMessage":"test in markdown"}', 'extractJsonFromResponse strips ```json markdown fences');

const jsonInGenericFences = '```\n{"commitMessage":"generic markdown"}\n```';
assert(extractJsonFromResponse(jsonInGenericFences) === '{"commitMessage":"generic markdown"}', 'extractJsonFromResponse strips generic ``` markdown fences');

// 6. Test In-Memory Preflight Integration in local runner (via applyPatchesInMemory)


// 6a. Hard Guardrail: Reject LLM Placeholders (// ... existing code ...)
const placeholderPatch = [
  {
    path: 'test.ts',
    action: 'modify',
    blocks: [
      {
        search: 'const a = 1;',
        replace: 'const a = 1;\n// ... existing code ...\nconst b = 2;'
      }
    ]
  }
];
const placeholderResult = await applyPatchesInMemory(placeholderPatch, { 'test.ts': 'const a = 1;' });
assert(placeholderResult.errors.length > 0, 'In-Memory Preflight catches placeholder patterns');
assert(placeholderResult.errors[0].message.includes('LLM placeholder'), 'Error specifically identifies LLM placeholder');

// 6b. Syntax Error Guardrail: Reject unmatched curly brackets
const syntaxErrorPatch = [
  {
    path: 'test.ts',
    action: 'modify',
    blocks: [
      {
        search: 'function test() {}',
        replace: 'function test() { const invalid = 123;'
      }
    ]
  }
];
const syntaxResult = await applyPatchesInMemory(syntaxErrorPatch, { 'test.ts': 'function test() {}' });
assert(syntaxResult.errors.length > 0, 'In-Memory Preflight catches unclosed syntax brackets');
assert(syntaxResult.errors[0].stage === 'OXC_SYNTAX', 'Error stage is correctly tagged as OXC_SYNTAX');

// 6c. Clean Patch Application: Valid Search/Replace with 0 errors
const validPatch = [
  {
    path: 'test.ts',
    action: 'modify',
    blocks: [
      {
        search: 'export const version = "1.0.0";',
        replace: 'export const version = "2.0.0";'
      }
    ]
  }
];
const validResult = await applyPatchesInMemory(validPatch, { 'test.ts': 'export const version = "1.0.0";' });
assert(validResult.errors.length === 0, 'Clean patch produces 0 preflight errors');
assert(validResult.additions[0].content === 'export const version = "2.0.0";', 'Addition contains correctly patched content');

// 6d. Idempotency: re-applying an already-committed patch is a no-op, not a SEARCH_REPLACE failure
const alreadyAppliedPatch = [
  {
    path: 'test.ts',
    action: 'modify',
    blocks: [
      {
        search: 'export const version = "1.0.0";',
        replace: 'export const version = "2.0.0";'
      }
    ]
  }
];
const alreadyAppliedResult = await applyPatchesInMemory(alreadyAppliedPatch, {
  'test.ts': 'export const version = "2.0.0";'
});
assert(
  alreadyAppliedResult.errors.length === 0,
  'Re-applying an already-committed patch produces 0 errors (idempotent)'
);
assert(
  alreadyAppliedResult.hasEffectiveChanges === false,
  'Re-applying an already-committed patch has no effective changes'
);

console.log(`\n🎉 Stufe II Test abgeschlossen: ${passCount}/${totalCount} Assertions bestanden!`);
