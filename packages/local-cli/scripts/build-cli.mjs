import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');
const cliDir = path.resolve(__dirname, '..');

const req = createRequire(path.join(rootDir, 'cf-gemini-git-bridge/package.json'));
let esbuild;
try {
  esbuild = req('esbuild');
} catch (e) {
  esbuild = await import('esbuild');
}

async function build() {
  console.log('[Build CLI] Bundling packages/local-cli/src/cli.ts...');
  const entryPoint = path.join(cliDir, 'src/cli.ts');
  const distDir = path.join(cliDir, 'dist');
  const distTarget = path.join(distDir, 'cli.mjs');

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: true,
    outfile: distTarget,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    packages: 'external'
  });

  console.log(`[Build CLI] Wrote: ${distTarget}`);
  console.log('✅ [Build CLI] Local CLI successfully built.');
}

build().catch((err) => {
  console.error('[Build CLI] Build failed:', err);
  process.exit(1);
});
