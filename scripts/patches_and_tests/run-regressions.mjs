#!/usr/bin/env node
/**
 * Consolidated local regression gate.
 *
 * Runs the four review-fix regressions plus the local CLI and webhook suites
 * sequentially as child processes. The live-endpoint smoke suite is NOT part of
 * the default gate: it needs network access to the deployed worker, so it stays
 * an explicit invocation (`--include-smoke`) instead of silently degrading the
 * local result. When included, its JSON artifact is written to a throwaway file
 * so `worker-baseline.json` is never overwritten by this runner.
 *
 * Usage:
 *   node scripts/patches_and_tests/run-regressions.mjs
 *   node scripts/patches_and_tests/run-regressions.mjs --include-smoke [--verbose]
 *   node scripts/patches_and_tests/run-regressions.mjs --skip-smoke
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts/patches_and_tests');
const SMOKE_ARTIFACT = 'scripts/patches_and_tests/.run-regressions-smoke.json';
const DEFAULT_TIMEOUT_MS = 300_000;

const LOCAL_SUITES = [
  {
    id: 'v2-prompt-contract',
    script: 'test-v2-prompt-contract.mjs',
    finding: 'V2 payload schema is executable (embedded + standalone prompts parsed by the harvester)',
  },
  {
    id: 'target-branch-concurrency',
    script: 'test-target-branch-concurrency.mjs',
    finding: 'Existing target branches patched on their snapshot with separate source/target OIDs',
  },
  {
    id: 'recent-commits-opt-in',
    script: 'test-recent-commits-opt-in.mjs',
    finding: 'Recent commits opt-in with one-time migration and persisted user choice',
  },
  {
    id: 'metadata-budget-hard-limit',
    script: 'test-metadata-budget-hard-limit.mjs',
    finding: 'Capped metadata and absolute 100k part ceiling',
  },
  {
    id: 'local-cli',
    script: 'test-local-cli.mjs',
    finding: 'Local CLI argument/preflight contracts',
  },
  {
    id: 'webhook-worker',
    script: 'test-webhook-worker.mjs',
    finding: 'Webhook HMAC validation and async bridge',
  },
];

const SMOKE_SUITE = {
  id: 'worker-smoke',
  script: 'worker-smoke.mjs',
  finding: 'Live /health probe, modularity audit, bundle identity, contract probes',
};

const HELP = `Usage: node scripts/patches_and_tests/run-regressions.mjs [options]

Runs sequentially, as child processes, in the repository root:
${LOCAL_SUITES.map((suite) => `  - scripts/patches_and_tests/${suite.script}`).join('\n')}

Options:
  --include-smoke   Also run the live-endpoint smoke suite
                    (scripts/patches_and_tests/${SMOKE_SUITE.script}). That suite
                    calls the deployed worker /health endpoint, so it is excluded
                    from the default local gate. Its JSON artifact is written to
                    ${SMOKE_ARTIFACT} and removed afterwards, so
                    worker-baseline.json stays untouched.
  --skip-smoke      Explicitly acknowledge skipping the live smoke suite
                    (the default; the run still prints that it was excluded).
  --verbose         Print full child output instead of the concise tail.
  --timeout <ms>    Per-suite timeout, default ${DEFAULT_TIMEOUT_MS}.
  --help            Show this help.
`;

function parseArgs(argv) {
  const options = {
    includeSmoke: false,
    skipSmoke: false,
    verbose: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--include-smoke' || arg === '--with-smoke') {
      options.includeSmoke = true;
    } else if (arg === '--skip-smoke' || arg === '--no-smoke') {
      options.skipSmoke = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--timeout') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--timeout expects a positive number of milliseconds');
      }
      options.timeoutMs = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function tailLines(text, count) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

function runSuite(suite, options) {
  const entry = path.join(SCRIPTS_DIR, suite.script);
  if (!fs.existsSync(entry)) {
    return {
      id: suite.id,
      script: suite.script,
      status: 'MISSING',
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: `Runner could not find ${entry}`,
    };
  }

  const startedAt = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [entry], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(suite.env || {}) },
    timeout: options.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  let status;
  if (result.error && result.error.code === 'ETIMEDOUT') {
    status = 'TIMEOUT';
  } else if (result.error) {
    status = 'ERROR';
  } else if (result.signal) {
    status = `SIGNAL:${result.signal}`;
  } else if (result.status === 0) {
    status = 'PASS';
  } else {
    status = 'FAIL';
  }

  return {
    id: suite.id,
    script: suite.script,
    status,
    exitCode: result.status,
    durationMs,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message) : ''),
  };
}

function printSuiteDetail(result, options) {
  if (options.verbose) {
    if (result.stdout.trim()) console.log(result.stdout.replace(/\s+$/, ''));
    if (result.stderr.trim()) console.log(result.stderr.replace(/\s+$/, ''));
    return;
  }

  const lines = result.status === 'PASS'
    ? tailLines(result.stdout, 1)
    : [...tailLines(result.stdout, 10), ...tailLines(result.stderr, 10)];
  for (const line of lines) {
    console.log(`      | ${line}`);
  }
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[run-regressions] ${error.message}`);
    console.error('');
    console.error(HELP);
    return 2;
  }

  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.includeSmoke && options.skipSmoke) {
    console.error('[run-regressions] --include-smoke and --skip-smoke are mutually exclusive.');
    return 2;
  }

  const suites = [...LOCAL_SUITES];
  if (options.includeSmoke) {
    suites.push({
      ...SMOKE_SUITE,
      env: {
        OUTPUT_FILE: process.env.SMOKE_OUTPUT_FILE || SMOKE_ARTIFACT,
      },
    });
  }

  console.log(`[run-regressions] root: ${ROOT}`);
  console.log(`[run-regressions] suites: ${suites.length} (sequential, one child process each)`);
  if (!options.includeSmoke) {
    const reason = options.skipSmoke ? '--skip-smoke requested' : 'default local gate';
    console.log(
      `[run-regressions] live-endpoint smoke suite EXCLUDED (${reason}); ` +
        're-run with --include-smoke to probe the deployed worker /health endpoint.'
    );
  }
  console.log('');

  const results = [];
  for (const suite of suites) {
    console.log(`[run] ${suite.id} -> ${suite.script}`);
    if (suite.finding) console.log(`      proves: ${suite.finding}`);
    const result = runSuite(suite, options);
    results.push(result);
    console.log(`      status: ${result.status} (exit ${result.exitCode}) in ${result.durationMs} ms`);
    printSuiteDetail(result, options);
    console.log('');
  }

  const smokeArtifact = path.join(ROOT, process.env.SMOKE_OUTPUT_FILE || SMOKE_ARTIFACT);
  if (options.includeSmoke && !process.env.SMOKE_OUTPUT_FILE && fs.existsSync(smokeArtifact)) {
    fs.rmSync(smokeArtifact, { force: true });
  }

  const idWidth = Math.max(...results.map((result) => result.id.length), 5);
  const statusWidth = Math.max(...results.map((result) => result.status.length), 6);

  console.log('Regression summary');
  console.log(`${pad('SUITE', idWidth)}  ${pad('STATUS', statusWidth)}  ${pad('EXIT', 4)}  TIME`);
  console.log(`${'-'.repeat(idWidth)}  ${'-'.repeat(statusWidth)}  ${'-'.repeat(4)}  ${'-'.repeat(6)}`);
  for (const result of results) {
    console.log(
      `${pad(result.id, idWidth)}  ${pad(result.status, statusWidth)}  ${pad(result.exitCode === null ? '-' : result.exitCode, 4)}  ${result.durationMs} ms`
    );
  }

  const failed = results.filter((result) => result.status !== 'PASS');
  console.log('');
  if (failed.length > 0) {
    console.log(`[run-regressions] FAIL: ${failed.length}/${results.length} suite(s) failed: ${failed.map((r) => r.id).join(', ')}`);
  } else {
    console.log(`[run-regressions] PASS: ${results.length}/${results.length} suite(s) passed`);
  }
  if (!options.includeSmoke) {
    console.log('[run-regressions] not verified by this run: live /health smoke probe (excluded by design).');
  }

  return failed.length > 0 ? 1 : 0;
}

process.exitCode = main();
