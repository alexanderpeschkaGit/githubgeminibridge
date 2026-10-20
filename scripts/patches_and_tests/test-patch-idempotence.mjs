import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const build = await esbuild.build({
  entryPoints: [path.join(ROOT, 'packages/edge-worker/src/modules/patchInMemory.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'mock-github-and-linter',
    setup(b) {
      b.onResolve({ filter: /\.\.\/utils\/github$/ }, () => ({
        path: 'github-mocks',
        namespace: 'test-mock',
      }));
      b.onLoad({ filter: /^github-mocks$/, namespace: 'test-mock' }, () => ({
        contents: `
          export class BranchNotFoundError extends Error {}
          const unused = () => { throw new Error('github mock not expected in this suite'); };
          export const parseRepoOwner = unused;
          export const getBranchHeadOid = unused;
          export const createBranchRef = unused;
          export const fetchMultipleFilesViaGraphQL = unused;
          export const createCommitOnBranch = unused;
        `,
        loader: 'js',
      }));
      b.onResolve({ filter: /(^|\/)linter$/ }, () => ({
        path: 'linter-mock',
        namespace: 'test-mock',
      }));
      b.onLoad({ filter: /^linter-mock$/, namespace: 'test-mock' }, () => ({
        contents: 'export async function runPreflightLinter() { return []; }',
        loader: 'js',
      }));
    },
  }],
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
const { applyPatchesInMemory, isInsertStyleBlockApplied } = await import(moduleUrl);

const FILE = 'src/store/example.ts';
const noLint = () => [];

async function apply(content, blocks) {
  return applyPatchesInMemory(
    [{ path: FILE, action: 'modify', blocks }],
    { [FILE]: content },
    undefined,
    noLint
  );
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

const ANCHOR = [
  '    if (data.theme) {',
  '      baseSettings = data.theme;',
  '    }',
].join('\n');
const SOCIAL_LINE = '      set({ socialLinks: data.socialLinks });';
const INSERT_STYLE = {
  search: ANCHOR,
  replace: [
    ANCHOR,
    '    if (data.socialLinks && data.socialLinks.length > 0) {',
    SOCIAL_LINE,
    '    }',
  ].join('\n'),
};
const BASE = ['function run(data) {', ANCHOR, '}', ''].join('\n');

// 1. Insert-style block: applying it twice must not duplicate the inserted lines.
assert.equal(
  isInsertStyleBlockApplied(BASE, INSERT_STYLE),
  false,
  'fresh content must not be treated as already patched'
);

const first = await apply(BASE, [INSERT_STYLE]);
assert.equal(first.errors.length, 0, 'first application must not report errors');
assert.equal(first.hasEffectiveChanges, true, 'first application must change the file');
const patched = first.additions[0].content;
assert.equal(count(patched, SOCIAL_LINE), 1, 'first application inserts the block exactly once');

const second = await apply(patched, [INSERT_STYLE]);
assert.equal(second.errors.length, 0, 're-application must not report errors');
assert.equal(
  second.hasEffectiveChanges,
  false,
  're-applying an insert-style patch must be a no-op (NO_CHANGES_NEEDED)'
);
assert.equal(second.additions.length, 0, 're-application must not produce an addition');
assert.equal(count(patched, SOCIAL_LINE), 1, 'committed content stays deduplicated');

// 2. Replace-style blocks keep their previous idempotency behaviour.
const REPLACE_STYLE = {
  search: ANCHOR,
  replace: ANCHOR.replace('= data.theme;', '= { ...data.theme };'),
};
const replaceFirst = await apply(BASE, [REPLACE_STYLE]);
assert.equal(replaceFirst.hasEffectiveChanges, true, 'replace-style applies on fresh content');
const replaceSecond = await apply(replaceFirst.additions[0].content, [REPLACE_STYLE]);
assert.equal(replaceSecond.errors.length, 0, 'replace-style re-application stays error-free');
assert.equal(replaceSecond.hasEffectiveChanges, false, 'replace-style re-application is a no-op');

// 3. A replace-style block whose replacement text already exists elsewhere in the
//    file must still be applied (no false-positive skip).
const coincidence = ['const a = 1;', '// const a = 2;', ''].join('\n');
const coincidencePatch = { search: 'const a = 1;', replace: 'const a = 2;' };
const coincidenceRun = await apply(coincidence, [coincidencePatch]);
assert.equal(
  coincidenceRun.hasEffectiveChanges,
  true,
  'replace-style blocks are not skipped because of an unrelated identical string'
);
assert.ok(
  coincidenceRun.additions[0].content.startsWith('const a = 2;'),
  'replace-style block is applied at its anchor'
);

// 4. Mixed queue: an already applied block plus a new one applies only the new one.
const SECOND_BLOCK = {
  search: '    }',
  replace: ['    }', '    runSideEffect(data);'].join('\n'),
};
const mixed = await apply(patched, [INSERT_STYLE, SECOND_BLOCK]);
assert.equal(mixed.errors.length, 0, 'mixed queue stays error-free');
assert.equal(mixed.hasEffectiveChanges, true, 'mixed queue still applies the pending block');
const mixedContent = mixed.additions[0].content;
assert.equal(count(mixedContent, SOCIAL_LINE), 1, 'already applied block is not duplicated');
assert.equal(count(mixedContent, 'runSideEffect(data);'), 1, 'pending block is applied once');

console.log('PASS: insert-style patches are idempotent and replace-style idempotency is preserved');
