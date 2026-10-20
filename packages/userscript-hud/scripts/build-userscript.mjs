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

const USERSCRIPT_BANNER = `// ==UserScript==
// @name         Gemini Git Bridge & Shadow-DOM HUD
// @namespace    https://gemini-git-bridge.sikanda.workers.dev/
// @version      2.0.8
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

async function build() {
  console.log('[Build Userscript] Bundling packages/userscript-hud/src/index.ts...');
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
      js: USERSCRIPT_BANNER,
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
