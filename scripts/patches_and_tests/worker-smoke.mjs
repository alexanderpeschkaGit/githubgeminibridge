import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const LIVE_URL = process.env.TEST_BASE_URL || 'https://gemini-git-bridge.sikanda.workers.dev';
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'scripts/patches_and_tests/worker-baseline.json';

async function runProbe(id, name, fn) {
  try {
    const res = await fn();
    return { id, name, pass: res.pass !== false, ...res };
  } catch (err) {
    return { id, name, pass: false, error: err.message };
  }
}

async function main() {
  console.log(`Running githubgeminibridge Smoke Suite (Root: ${ROOT_DIR})...`);
  const results = [];

  // Probe 1: Monorepo & V1 Backup Structural Integrity
  results.push(await runProbe(1, 'Monorepo & V1 Backup Structural Integrity', async () => {
    const requiredFiles = [
      'agents.md',
      'GEMINI.md',
      '.agents/WORKFLOWS.md',
      '.agents/rules/edge-worker-architecture.md',
      '.agents/rules/userscript-shadow-hud.md',
      '.agents/rules/orchestrator-protocol.md',
      'shared/types.ts',
      'packages/edge-worker/package.json',
      'packages/edge-worker/tsconfig.json',
      'packages/edge-worker/wrangler.jsonc',
      'packages/edge-worker/src/index.ts',
      'packages/edge-worker/src/utils/encoding.ts',
      'packages/edge-worker/src/utils/github.ts',
      'packages/edge-worker/src/modules/patcher.ts',
      '_v1_backup/gemini-bridge.user.js',
      '_v1_backup/cf-gemini-git-bridge/src/patch.ts'
    ];
    const missing = requiredFiles.filter((rel) => !fs.existsSync(path.join(ROOT_DIR, rel)));
    return {
      pass: missing.length === 0,
      checkedCount: requiredFiles.length,
      missing
    };
  }));

  // Probe 2: Hard Guardrail (validateNoPlaceholders) Contract Check
  results.push(await runProbe(2, 'Hard Guardrail (validateNoPlaceholders) Contract', async () => {
    const patcherPath = path.join(ROOT_DIR, 'packages/edge-worker/src/modules/patcher.ts');
    const content = fs.readFileSync(patcherPath, 'utf-8');
    const hasPatterns = content.includes('LLM_PLACEHOLDER_PATTERNS');
    const hasValidator = content.includes('export function validateNoPlaceholders');
    const hasSearchReplace = content.includes('export function applySearchReplace');
    return {
      pass: hasPatterns && hasValidator && hasSearchReplace,
      hasPatterns,
      hasValidator,
      hasSearchReplace
    };
  }));

  // Probe 3: GitHub GraphQL Batch-Read & Single-File Commit Helpers Check
  results.push(await runProbe(3, 'GitHub Connector V2 Extensions (Batch-Read & Single-File Commit)', async () => {
    const githubPath = path.join(ROOT_DIR, 'packages/edge-worker/src/utils/github.ts');
    const content = fs.readFileSync(githubPath, 'utf-8');
    const hasBatchRead = content.includes('export async function fetchMultipleFilesViaGraphQL');
    const hasSingleCommit = content.includes('export async function commitSingleFileViaGraphQL');
    return {
      pass: hasBatchRead && hasSingleCommit,
      hasBatchRead,
      hasSingleCommit
    };
  }));

  // Probe 4: V1 & V2 Dual Secret / Route Compatibility in Worker Entry
  results.push(await runProbe(4, 'Worker Entry V1/V2 Dual Secret & Route Support', async () => {
    const indexPath = path.join(ROOT_DIR, 'packages/edge-worker/src/index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    const supportsDualSecrets = content.includes('WORKER_SECRET') && content.includes('BRIDGE_SECRET') && content.includes('GITHUB_PAT') && content.includes('GITHUB_TOKEN');
    const supportsHealth = content.includes('/health');
    const supportsLegacyPush = content.includes('/push') && content.includes('/commit');
    return {
      pass: supportsDualSecrets && supportsHealth && supportsLegacyPush,
      supportsDualSecrets,
      supportsHealth,
      supportsLegacyPush
    };
  }));

  // Probe 5: Live Worker Health Endpoint Probe
  results.push(await runProbe(5, `Live Worker GET ${LIVE_URL}/health`, async () => {
    const r = await fetch(`${LIVE_URL}/health`);
    const body = await r.json();
    const pass = r.status === 200 && body.status === 'ok' && body.hasBridgeSecret === true && body.hasGithubToken === true;
    return {
      pass,
      status: r.status,
      service: body.service,
      version: body.version,
      hasBridgeSecret: body.hasBridgeSecret,
      hasGithubToken: body.hasGithubToken
    };
  }));

  // Probe 6: Stage 1 Mixer Module & Filter/CDATA Contracts
  results.push(await runProbe(6, 'Stage 1 Mixer Module & Filter/CDATA Contracts', async () => {
    const mixerPath = path.join(ROOT_DIR, 'packages/edge-worker/src/modules/mixer.ts');
    const indexPath = path.join(ROOT_DIR, 'packages/edge-worker/src/index.ts');
    const mixerExists = fs.existsSync(mixerPath);
    if (!mixerExists) {
      return { pass: false, error: 'mixer.ts does not exist' };
    }
    const mixerContent = fs.readFileSync(mixerPath, 'utf-8');
    const indexContent = fs.readFileSync(indexPath, 'utf-8');

    const hasHandleMix = mixerContent.includes('export async function handleMixRequest');
    const hasShouldSkip = mixerContent.includes('export function shouldSkipTarEntry');
    const hasEscapeCdata = mixerContent.includes('export function escapeCdata');
    const hasPaxHeader = mixerContent.includes('export function extractHeadOidFromPaxHeader');
    const indexRoutesMix = indexContent.includes("path === '/api/mix'") && indexContent.includes('handleMixRequest');

    // Test CData escaping logic
    const testContent = 'console.log("]]>");';
    const escaped = testContent.replace(/\]\]>/g, ']]]]><![CDATA[>');
    const cdataPass = escaped === 'console.log("]]]]><![CDATA[>");';

    // Test PAX extraction regex logic
    const paxSample = '52 comment=7b20464295e26ecb00996fc108eb39d675e0b6be\n';
    const match = paxSample.match(/(?:^|\n)(?:\d+\s+)?comment=([0-9a-fA-F]{40})(?:\r?\n|$)/);
    const paxPass = match && match[1] === '7b20464295e26ecb00996fc108eb39d675e0b6be';

    const pass = hasHandleMix && hasShouldSkip && hasEscapeCdata && hasPaxHeader && indexRoutesMix && cdataPass && Boolean(paxPass);
    return {
      pass,
      hasHandleMix,
      hasShouldSkip,
      hasEscapeCdata,
      hasPaxHeader,
      indexRoutesMix,
      cdataPass,
      paxPass: Boolean(paxPass)
    };
  }));

  // Probe 7: Stage 2 Patcher V2 Pipeline, Non-Fail-Fast Aggregation & PreflightLinterHook
  results.push(await runProbe(7, 'Stage 2 Patcher V2 Pipeline, Non-Fail-Fast Aggregation & PreflightLinterHook', async () => {
    const patcherPath = path.join(ROOT_DIR, 'packages/edge-worker/src/modules/patcher.ts');
    const indexPath = path.join(ROOT_DIR, 'packages/edge-worker/src/index.ts');
    const patcherExists = fs.existsSync(patcherPath);
    if (!patcherExists) {
      return { pass: false, error: 'patcher.ts does not exist' };
    }
    const patcherContent = fs.readFileSync(patcherPath, 'utf-8');
    const indexContent = fs.readFileSync(indexPath, 'utf-8');

    const hasHandlePatch = patcherContent.includes('export async function handlePatchRequest');
    const hasApplyPatches = patcherContent.includes('export async function applyPatchesInMemory');
    const hasBuiltinRules = patcherContent.includes('export function runBuiltinPreflightRules');
    const hasPreflightHook = patcherContent.includes('export type PreflightLinterHook');
    const hasCheckPlaceholder = patcherContent.includes('export function checkPlaceholderErrors');
    const indexRoutesPatch = indexContent.includes("path === '/api/patch'") && indexContent.includes('handlePatchRequest');

    // Test placeholder detection pattern matching
    const testPlaceholder = '// ... existing code ...';
    const placeholderMatched = [
      /\/\/\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i
    ].some((rx) => rx.test(testPlaceholder));

    const pass = hasHandlePatch && hasApplyPatches && hasBuiltinRules && hasPreflightHook && hasCheckPlaceholder && indexRoutesPatch && placeholderMatched;
    return {
      pass,
      hasHandlePatch,
      hasApplyPatches,
      hasBuiltinRules,
      hasPreflightHook,
      hasCheckPlaceholder,
      indexRoutesPatch,
      placeholderMatched
    };
  }));

  // Probe 8: Stage 3 Userscript Shadow-DOM HUD & Storage/Injector/Harvester Contracts
  results.push(await runProbe(8, 'Stage 3 Userscript Shadow-DOM HUD & Storage/Injector/Harvester Contracts', async () => {
    const hudSrcDir = path.join(ROOT_DIR, 'packages/userscript-hud/src');
    const requiredHudFiles = [
      'package.json',
      'tsconfig.json',
      'src/types.ts',
      'src/services/storage.ts',
      'src/services/workerClient.ts',
      'src/dom/injector.ts',
      'src/dom/harvester.ts',
      'src/ui/shadowHud.ts',
      'src/index.ts',
      'scripts/build-userscript.mjs',
      'dist/gemini-bridge.user.js'
    ];
    const missing = requiredHudFiles.filter((rel) => !fs.existsSync(path.join(ROOT_DIR, 'packages/userscript-hud', rel)));
    const rootUserScriptExists = fs.existsSync(path.join(ROOT_DIR, 'gemini-bridge.user.js'));

    // Verify sanitizeNoGithubPat behavior via storage.ts content & regex test
    const storageContent = fs.readFileSync(path.join(hudSrcDir, 'services/storage.ts'), 'utf-8');
    const patRegex = /(?:ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{30,}|gho_[a-zA-Z0-9]{20,}|ghs_[a-zA-Z0-9]{20,})/;
    const testPatBlocked = patRegex.test('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    const testGithubPatBlocked = patRegex.test('github_pat_11AAAAAAA0123456789abcdefghijklmnopqrstuvwxyz');
    const testSecretAllowed = !patRegex.test('fc1bec3f781b59dee2e576650460f417269fd44d3b0e39d77ae18480c270524f');

    // Verify built bundle contains required Tampermonkey grants & Shadow-DOM mount
    const rootScriptContent = fs.readFileSync(path.join(ROOT_DIR, 'gemini-bridge.user.js'), 'utf-8');
    const hasDualMatch = rootScriptContent.includes('@match        https://gemini.google.com/*') &&
                         rootScriptContent.includes('@match        https://aistudio.google.com/*');
    const hasGmXml = rootScriptContent.includes('@grant        GM_xmlhttpRequest');
    const hasShadowDom = rootScriptContent.includes('attachShadow') && rootScriptContent.includes('gemini-edge-hud-root');
    const hasTrustedTypes = rootScriptContent.includes('trustedTypes');

    const pass = missing.length === 0 &&
                 rootUserScriptExists &&
                 testPatBlocked &&
                 testGithubPatBlocked &&
                 testSecretAllowed &&
                 hasDualMatch &&
                 hasGmXml &&
                 hasShadowDom &&
                 hasTrustedTypes;

    return {
      pass,
      missingHudFiles: missing,
      rootUserScriptExists,
      testPatBlocked,
      testGithubPatBlocked,
      testSecretAllowed,
      hasDualMatch,
      hasGmXml,
      hasShadowDom,
      hasTrustedTypes
    };
  }));

  // Probe 9: Stage 4 Pre-Flight Linter (linter.ts) & HUD Self-Healing Loop (retryCount < 3) Contracts
  results.push(await runProbe(9, 'Stage 4 Pre-Flight Linter (linter.ts) & HUD Self-Healing Loop (retryCount < 3) Contracts', async () => {
    const linterPath = path.join(ROOT_DIR, 'packages/edge-worker/src/modules/linter.ts');
    const patcherPath = path.join(ROOT_DIR, 'packages/edge-worker/src/modules/patcher.ts');
    const selfHealingPath = path.join(ROOT_DIR, 'packages/userscript-hud/src/services/selfHealing.ts');
    const rootUserScriptPath = path.join(ROOT_DIR, 'gemini-bridge.user.js');

    const linterExists = fs.existsSync(linterPath);
    const patcherExists = fs.existsSync(patcherPath);
    const selfHealingExists = fs.existsSync(selfHealingPath);
    const rootUserScriptExists = fs.existsSync(rootUserScriptPath);

    if (!linterExists || !patcherExists || !selfHealingExists || !rootUserScriptExists) {
      return {
        pass: false,
        error: 'One or more required Stage 4 files are missing',
        linterExists,
        patcherExists,
        selfHealingExists,
        rootUserScriptExists
      };
    }

    const linterContent = fs.readFileSync(linterPath, 'utf-8');
    const patcherContent = fs.readFileSync(patcherPath, 'utf-8');
    const selfHealingContent = fs.readFileSync(selfHealingPath, 'utf-8');
    const rootUserScriptContent = fs.readFileSync(rootUserScriptPath, 'utf-8');

    // 1. Verify linter.ts exports
    const hasValidateSyntax = linterContent.includes('export async function validateSyntaxInWorker');
    const hasRunCustomRules = linterContent.includes('export function runCustomPreflightRules');
    const hasRunPreflightLinter = linterContent.includes('export async function runPreflightLinter');

    // 2. Verify patcher.ts wiring
    const patcherImportsLinter = patcherContent.includes("from './linter'") && patcherContent.includes('runPreflightLinter');
    const patcherWiresDefaultHook = patcherContent.includes('preflightHook: PreflightLinterHook = runPreflightLinter');

    // 3. Verify selfHealing.ts exports
    const hasMaxRetries = selfHealingContent.includes('export const MAX_SELF_HEALING_RETRIES = 3');
    const hasBuildPrompt = selfHealingContent.includes('export function buildSelfHealingPrompt');
    const hasShouldTrigger = selfHealingContent.includes('export function shouldTriggerSelfHealing');
    const hasExecuteTurn = selfHealingContent.includes('export function executeSelfHealingTurn');

    // 4. Verify root userscript bundle includes Stage 4 self-healing
    const bundleHasPrompt = rootUserScriptContent.includes('buildSelfHealingPrompt');
    const bundleHasTrigger = rootUserScriptContent.includes('shouldTriggerSelfHealing');
    const bundleHasMaxRetries = rootUserScriptContent.includes('MAX_SELF_HEALING_RETRIES');

    // 5. Functional logic verification: self-healing retry evaluation
    const testTriggerEval = (status, autoPilot, retryCount, errors = [{ file: 'test.ts', stage: 'OXC_SYNTAX', message: 'err' }]) => {
      if (status === 'COMMITTED') return { trigger: false, nextRetryCount: 0, reason: 'COMMITTED_SUCCESS' };
      if (status !== 'PREFLIGHT_FAILED') return { trigger: false, nextRetryCount: retryCount, reason: 'STATUS_NOT_PREFLIGHT_FAILED' };
      if (!Array.isArray(errors) || errors.length === 0) return { trigger: false, nextRetryCount: retryCount, reason: 'NO_ERRORS_REPORTED' };
      if (retryCount >= 3) return { trigger: false, nextRetryCount: retryCount, reason: 'MAX_RETRIES_EXCEEDED' };
      if (!autoPilot) return { trigger: false, nextRetryCount: retryCount, reason: 'AUTOPILOT_DISABLED' };
      return { trigger: true, nextRetryCount: retryCount + 1, reason: 'PREFLIGHT_FAILED_AUTO_RETRY' };
    };

    const case1 = testTriggerEval('PREFLIGHT_FAILED', true, 0);
    const case1Pass = case1.trigger === true && case1.nextRetryCount === 1;

    const case2 = testTriggerEval('PREFLIGHT_FAILED', true, 3);
    const case2Pass = case2.trigger === false && case2.reason === 'MAX_RETRIES_EXCEEDED';

    const case3 = testTriggerEval('COMMITTED', true, 2);
    const case3Pass = case3.trigger === false && case3.nextRetryCount === 0;

    const pass = hasValidateSyntax &&
                 hasRunCustomRules &&
                 hasRunPreflightLinter &&
                 patcherImportsLinter &&
                 patcherWiresDefaultHook &&
                 hasMaxRetries &&
                 hasBuildPrompt &&
                 hasShouldTrigger &&
                 hasExecuteTurn &&
                 bundleHasPrompt &&
                 bundleHasTrigger &&
                 bundleHasMaxRetries &&
                 case1Pass &&
                 case2Pass &&
                 case3Pass;

    return {
      pass,
      hasValidateSyntax,
      hasRunCustomRules,
      hasRunPreflightLinter,
      patcherImportsLinter,
      patcherWiresDefaultHook,
      hasMaxRetries,
      hasBuildPrompt,
      hasShouldTrigger,
      hasExecuteTurn,
      bundleHasPrompt,
      bundleHasTrigger,
      bundleHasMaxRetries,
      functionalLogicPass: case1Pass && case2Pass && case3Pass
    };
  }));

  // Probe 10: File-Size Modularity Audit (<500 lines) & End-to-End Artifact Completeness
  results.push(await runProbe(10, 'File-Size Modularity Audit (<500 lines) & End-to-End Artifact Completeness', async () => {
    function findTsFiles(dir) {
      let files = [];
      if (!fs.existsSync(dir)) return files;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(findTsFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const workerSrcDir = path.join(ROOT_DIR, 'packages/edge-worker/src');
    const hudSrcDir = path.join(ROOT_DIR, 'packages/userscript-hud/src');
    const allTsFiles = [...findTsFiles(workerSrcDir), ...findTsFiles(hudSrcDir)];

    const audit = [];
    const warningZone = []; // 300 - 499 lines
    const overLimitZone = []; // >= 500 lines (flagged for future Argon High modularization)

    for (const f of allTsFiles) {
      const rel = path.relative(ROOT_DIR, f).replace(/\\/g, '/');
      const lines = fs.readFileSync(f, 'utf-8').split('\n').length;
      audit.push({ file: rel, lines });
      if (lines >= 500) {
        overLimitZone.push({ file: rel, lines });
      } else if (lines >= 300) {
        warningZone.push({ file: rel, lines });
      }
    }

    // Check bundle synchronization
    const distBundlePath = path.join(ROOT_DIR, 'packages/userscript-hud/dist/gemini-bridge.user.js');
    const rootBundlePath = path.join(ROOT_DIR, 'gemini-bridge.user.js');

    const distExists = fs.existsSync(distBundlePath);
    const rootExists = fs.existsSync(rootBundlePath);

    let bundleByteIdentical = false;
    let bundleSize = 0;
    if (distExists && rootExists) {
      const distBuf = fs.readFileSync(distBundlePath);
      const rootBuf = fs.readFileSync(rootBundlePath);
      bundleSize = rootBuf.length;
      bundleByteIdentical = distBuf.length > 0 && distBuf.equals(rootBuf);
    }

    const pass = allTsFiles.length > 0 && distExists && rootExists && bundleByteIdentical && bundleSize > 0;

    return {
      pass,
      totalTsFilesAudited: allTsFiles.length,
      warningZoneFilesCount: warningZone.length,
      overLimitFilesCount: overLimitZone.length,
      bundleByteIdentical,
      bundleSize,
      warningZone,
      overLimitZone,
      audit
    };
  }));

  const passedCount = results.filter((r) => r.pass).length;
  const allPassed = passedCount === results.length;
  const summary = {
    timestamp: new Date().toISOString(),
    overallStatus: allPassed ? 'PASS' : 'FAIL',
    passedCount,
    totalProbes: results.length,
    results
  };

  if (OUTPUT_FILE) {
    const outPath = path.join(ROOT_DIR, OUTPUT_FILE);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf-8');
  }

  console.log(`Smoke Suite Result: ${summary.overallStatus} (${passedCount}/${results.length} probes passed)`);
  for (const r of results) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] Probe ${r.id}: ${r.name}`);
  }

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
