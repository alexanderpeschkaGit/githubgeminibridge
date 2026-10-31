import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');
const hudDir = path.resolve(__dirname, '..');

// Resolve esbuild via packages/edge-worker/node_modules if needed
const req = createRequire(path.join(rootDir, 'packages/edge-worker/package.json'));
let esbuild;
try {
  esbuild = req('esbuild');
} catch (e) {
  esbuild = await import('esbuild');
}

const USERSCRIPT_BANNER = (version) => `// ==UserScript==
// @name         Gemini Git Bridge & Shadow-DOM HUD
// @namespace    https://gemini-git-bridge.sikanda.workers.dev/
// @version      ${version}
// @description  Commit code & search/replace patches directly from Google Gemini & AI Studio to GitHub via Cloudflare Worker (Shadow-DOM HUD)
// @author       Antigravity
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @noframes
// @connect      gemini-git-bridge.sikanda.workers.dev
// @connect      *.workers.dev
// @connect      raw.githubusercontent.com
// @downloadURL  https://raw.githubusercontent.com/alexanderpeschkaGit/githubgeminibridge/main/gemini-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/alexanderpeschkaGit/githubgeminibridge/main/gemini-bridge.user.js
// @run-at       document-idle
// ==/UserScript==

// --- Trusted Types (TrustedHTML) compatibility for Google Gemini & AI Studio ---
if (typeof window !== 'undefined' && window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
  try {
    window.trustedTypes.createPolicy('default', {
      createHTML: (string) => string,
      createScript: (string) => string,
      createScriptURL: (string) => string,
    });
  } catch (e) {
    try {
      window.trustedTypes.createPolicy('geminiBridgePolicy', {
        createHTML: (string) => string,
      });
    } catch (e2) {
      // Ignored if policy already exists
    }
  }
}
`;

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const BUMP_KINDS = ['major', 'minor', 'patch'];

function readCliOption(name) {
  const option = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return option ? option.slice(name.length + 3).trim() : '';
}

function bumpSemver(version, kind) {
  const match = version.match(SEMVER_PATTERN);
  if (!match) throw new Error(`Unsupported version "${version}" (expected x.y.z)`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Synchronizes edge-worker package.json and index.ts so versions never drift.
 */
function syncEdgeWorkerVersion(version) {
  const edgePkgPath = path.join(rootDir, 'packages/edge-worker/package.json');
  if (fs.existsSync(edgePkgPath)) {
    const edgePkg = fs.readFileSync(edgePkgPath, 'utf8');
    const updated = edgePkg.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${version}$3`);
    if (updated !== edgePkg) {
      fs.writeFileSync(edgePkgPath, updated, 'utf8');
      console.log(`[Build Userscript] Synced packages/edge-worker/package.json -> v${version}`);
    }
  }

  const edgeIndexPath = path.join(rootDir, 'packages/edge-worker/src/index.ts');
  if (fs.existsSync(edgeIndexPath)) {
    const edgeIndex = fs.readFileSync(edgeIndexPath, 'utf8');
    const updated = edgeIndex.replace(/(version:\s*')([^']+)(',)/, `$1${version}$3`);
    if (updated !== edgeIndex) {
      fs.writeFileSync(edgeIndexPath, updated, 'utf8');
      console.log(`[Build Userscript] Synced packages/edge-worker/src/index.ts -> v${version}`);
    }
  }
}

/**
 * package.json is the single source of truth for the userscript version.
 * Tampermonkey only re-downloads when @version increases, so releases pass
 * --bump=patch|minor|major (or --version=x.y.z); a plain build never bumps.
 */
function resolveVersion(pkgPath) {
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const current = (raw.match(/"version"\s*:\s*"([^"]+)"/) || [])[1];
  if (!current) throw new Error(`No "version" field in ${pkgPath}`);

  const bumpKind = readCliOption('bump').toLowerCase();
  const pinned = readCliOption('version');
  if (bumpKind && !BUMP_KINDS.includes(bumpKind)) {
    throw new Error(`--bump must be one of: ${BUMP_KINDS.join(', ')}`);
  }
  if (pinned && !SEMVER_PATTERN.test(pinned)) {
    throw new Error(`--version must match x.y.z, got "${pinned}"`);
  }

  const next = pinned || (bumpKind ? bumpSemver(current, bumpKind) : current);
  if (next !== current) {
    fs.writeFileSync(pkgPath, raw.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${next}$3`), 'utf8');
    console.log(`[Build Userscript] Version ${current} -> ${next}`);
  }

  // Always keep edge-worker in lockstep with userscript-hud
  syncEdgeWorkerVersion(next);

  return next;
}

async function build() {
  const pkgPath = path.join(hudDir, 'package.json');
  const version = resolveVersion(pkgPath);
  console.log(`[Build Userscript] Bundling packages/userscript-hud/src/index.ts... (v${version})`);
  const entryPoint = path.join(hudDir, 'src/index.ts');
  const distDir = path.join(hudDir, 'dist');
  const distTarget = path.join(distDir, 'gemini-bridge.user.js');
  const rootTarget = path.join(rootDir, 'gemini-bridge.user.js');

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    minify: false,
    banner: {
      js: USERSCRIPT_BANNER(version),
    },
  });

  if (result.errors.length > 0) {
    console.error('[Build Userscript] Build failed with errors:', result.errors);
    process.exit(1);
  }

  const bundledCode = result.outputFiles[0].text;

  fs.writeFileSync(distTarget, bundledCode, 'utf8');
  console.log(`[Build Userscript] Wrote: ${distTarget} (${(bundledCode.length / 1024).toFixed(1)} KB)`);

  fs.writeFileSync(rootTarget, bundledCode, 'utf8');
  console.log(`[Build Userscript] Synced to root: ${rootTarget}`);
  console.log('✅ [Build Userscript] Userscript successfully built.');
}

build().catch((err) => {
  console.error('[Build Userscript] Fatal error:', err);
  process.exit(1);
});
