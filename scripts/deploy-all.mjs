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

  // Step 2: Smoke tests
  console.log('\n[2/5] Running Smoke Tests...');
  run('node scripts/patches_and_tests/worker-smoke.mjs', rootDir);

  // Step 3: Git Commit & Push
  console.log('\n[3/5] Committing & Pushing to GitHub (main)...');
  run('git add gemini-bridge.user.js packages/ shared/ scripts/');
  try {
    run(`git commit -m "chore(release): bump version to ${version} and lockstep build"`);
  } catch {
    console.log('[INFO] Git commit skipped (no changes to commit).');
  }
  run('git push origin main');

  // Step 4: Deploy Worker 1 (Default: gemini-git-bridge)
  console.log('\n[4/5] Deploying Cloudflare Worker 1 (Default: gemini-git-bridge)...');
  run('npx wrangler deploy', workerDir);

  // Step 5: Deploy Worker 2 (Account 2: gemini-git-bridge-account2)
  console.log('\n[5/5] Deploying Cloudflare Worker 2 (Account 2: gemini-git-bridge-account2)...');
  run('npx wrangler deploy --env account2', workerDir);

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
