import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');
const workerDir = path.resolve(__dirname, '..');

const req = createRequire(path.join(rootDir, 'cf-gemini-git-bridge/package.json'));
let esbuild;
try {
  esbuild = req('esbuild');
} catch (e) {
  esbuild = await import('esbuild');
}

async function build() {
  console.log('[Build Worker] Bundling packages/edge-worker/src/index.ts...');
  const entryPoint = path.join(workerDir, 'src/index.ts');
  const distDir = path.join(workerDir, 'dist');
  const distTarget = path.join(distDir, 'worker.mjs');

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: true,
    outfile: distTarget,
    format: 'esm',
    target: 'es2022'
  });

  console.log(`[Build Worker] Wrote: ${distTarget}`);
  console.log('✅ [Build Worker] Edge Worker successfully built.');
}

build().catch((err) => {
  console.error('[Build Worker] Build failed:', err);
  process.exit(1);
});
