import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const TYPESCRIPT_CANDIDATES = [
  'packages/local-cli/node_modules/typescript/lib/typescript.js',
  'packages/edge-worker/node_modules/typescript/lib/typescript.js',
];

/** Relative imports the userscript modules are allowed to pull in (resolved to data URLs). */
const RELATIVE_MODULES = [
  {
    specifier: '../services/patchIdentity',
    source: 'packages/userscript-hud/src/services/patchIdentity.ts',
  },
  {
    specifier: './patchIdentity',
    source: 'packages/userscript-hud/src/services/patchIdentity.ts',
  },
  {
    specifier: '../../../../shared/repoPaths',
    source: 'shared/repoPaths.ts',
  },
  {
    specifier: './pathHints',
    source: 'packages/userscript-hud/src/dom/pathHints.ts',
  },
];

const HARVESTER_SOURCE = 'packages/userscript-hud/src/dom/harvester.ts';
const PATCH_QUEUE_SOURCE = 'packages/userscript-hud/src/services/patchQueue.ts';
const BATCH_FORMULA_SOURCE = 'packages/userscript-hud/src/services/batchFormula.ts';

export function loadTypeScript(rootDir) {
  const require = createRequire(import.meta.url);
  for (const candidate of TYPESCRIPT_CANDIDATES) {
    const resolved = path.join(rootDir, candidate);
    if (fs.existsSync(resolved)) return require(resolved);
  }
  throw new Error(
    `typescript is required for the harvester contract tests; install it in ${TYPESCRIPT_CANDIDATES.join(' or ')}`
  );
}

function toDataUrl(javascript) {
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
}

function transpile(ts, rootDir, relativePath) {
  return ts.transpileModule(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
}

/**
 * Transpiles one entry module and rewrites every listed relative specifier to a data URL,
 * because data: URLs cannot resolve relative imports.
 */
function buildEntryUrl(ts, rootDir, entrySource, inlined) {
  let source = transpile(ts, rootDir, entrySource);
  for (const [specifier, url] of inlined) {
    const quoted = `'${specifier}'`;
    if (source.includes(quoted)) {
      source = source.split(quoted).join(JSON.stringify(url));
    }
  }

  const leftover = [...source.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]);
  if (leftover.length > 0) {
    throw new Error(
      `${entrySource} imports unresolved relative modules: ${leftover.join(', ')} — add them to RELATIVE_MODULES`
    );
  }

  return toDataUrl(source);
}

function buildInlinedModules(ts, rootDir) {
  const inlined = new Map();
  for (const dependency of RELATIVE_MODULES) {
    let source = transpile(ts, rootDir, dependency.source);
    for (const [specifier, url] of inlined) {
      source = source.split(`'${specifier}'`).join(JSON.stringify(url));
    }

    const leftover = [...source.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]);
    if (leftover.length > 0) {
      throw new Error(
        `${dependency.source} imports unresolved relative modules: ${leftover.join(', ')} — list them before this entry in RELATIVE_MODULES`
      );
    }

    inlined.set(dependency.specifier, toDataUrl(source));
  }
  return inlined;
}

/** Loads the DOM harvester together with the identity helpers it depends on. */
export async function loadHarvesterModules(rootDir) {
  const ts = loadTypeScript(rootDir);
  const inlined = buildInlinedModules(ts, rootDir);
  const harvester = await import(buildEntryUrl(ts, rootDir, HARVESTER_SOURCE, inlined));
  return {
    ...(await import(inlined.get('../services/patchIdentity'))),
    ...harvester,
  };
}

/** Loads the HUD patch-queue helpers together with the identity helpers they depend on. */
export async function loadPatchQueueModules(rootDir) {
  const ts = loadTypeScript(rootDir);
  const inlined = buildInlinedModules(ts, rootDir);
  const patchQueue = await import(buildEntryUrl(ts, rootDir, PATCH_QUEUE_SOURCE, inlined));
  return {
    ...(await import(inlined.get('./patchIdentity'))),
    ...patchQueue,
  };
}

/** Loads the Batch Formula prompt builder (type-only imports, so no inlined modules). */
export async function loadBatchFormulaModule(rootDir) {
  const ts = loadTypeScript(rootDir);
  return import(buildEntryUrl(ts, rootDir, BATCH_FORMULA_SOURCE, new Map()));
}
