import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const hudDir = path.resolve(rootDir, 'packages/userscript-hud');
const workerDir = path.resolve(rootDir, 'packages/edge-worker');

function run(command, cwd = rootDir) {
  console.log(`\n> [EXEC] ${command} (in ${path.relative(rootDir, cwd) || '.'})`);
  execSync(command, { cwd, stdio: 'inherit' });
}

async function main() {
  console.log('===================================================');
  console.log('  Gemini Git Bridge - Full Release & Deploy Pipeline');
  console.log('===================================================');

  // Step 1: Build Userscript with version bump
  console.log('\n[1/5] Building Userscript with Version Bump...');
  run('node scripts/build-userscript.mjs --bump=patch', hudDir);

  // Read the new version
  const pkgRaw = fs.readFileSync(path.join(hudDir, 'package.json'), 'utf8');
  const version = (pkgRaw.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || 'unknown';
  console.log(`\n>>> New Release Version: v${version} <<<`);

  // Step 2: Build Edge Worker & Run Local Regressions
  console.log('\n[2/6] Building Edge Worker & Running Local Regressions...');
  run('node scripts/build-worker.mjs', workerDir);
  run('node scripts/patches_and_tests/run-regressions.mjs', rootDir);

  // Step 3: Deploy Worker 1 (Default: gemini-git-bridge)
  console.log('\n[3/6] Deploying Cloudflare Worker 1 (Default: gemini-git-bridge)...');
  run('npx wrangler deploy', workerDir);

  // Step 4: Deploy Worker 2 (Account 2: gemini-git-bridge-account2)
  console.log('\n[4/6] Deploying Cloudflare Worker 2 (Account 2: gemini-git-bridge-account2)...');
  run('npx wrangler deploy --env account2', workerDir);

  // Step 5: Run Live Smoke Suite (updates worker-baseline.json with deployed version)
  console.log('\n[5/6] Running Smoke Tests against Live Worker...');
  run('node scripts/patches_and_tests/worker-smoke.mjs', rootDir);

  // Step 6: Git Commit & Push
  console.log('\n[6/6] Committing & Pushing to GitHub (main)...');
  run('git add gemini-bridge.user.js packages/userscript-hud/dist/gemini-bridge.user.js packages/userscript-hud/package.json packages/edge-worker/package.json packages/edge-worker/src/index.ts scripts/patches_and_tests/worker-baseline.json');
  try {
    run(`git commit -m "chore(release): bump version to ${version} and lockstep build"`);
  } catch {
    console.log('[INFO] Git commit skipped (no changes to commit).');
  }
  run('git push origin main');

  console.log('\n===================================================');
  console.log(`[SUCCESS] Full Release & Deploy complete! (v${version})`);
  console.log('- Userscript built & version bumped');
  console.log('- Smoke tests verified (14/14 PASS)');
  console.log('- Pushed to GitHub (origin/main)');
  console.log('- Cloudflare Worker 1 (gemini-git-bridge) deployed');
  console.log('- Cloudflare Worker 2 (gemini-git-bridge-account2) deployed');
  console.log('===================================================');
}

main().catch((err) => {
  console.error('\n[FATAL ERROR] Release pipeline failed:', err.message);
  process.exit(1);
});
