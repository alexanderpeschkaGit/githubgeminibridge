#!/usr/bin/env node
import { runLocalHybridTask } from './localRunner';
import type { HybridTaskInput } from '../../../shared/types';

export function parseCliArgs(argv: string[]): {
  input: HybridTaskInput;
  model?: string;
  skipCommit?: boolean;
  help?: boolean;
} {
  const args = argv.slice(2);
  let prompt = '';
  let repo = 'local/repo';
  let branch = 'main';
  const targetPaths: string[] = [];
  let model: string | undefined;
  let skipCommit = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--prompt' || arg === '-p') {
      prompt = args[++i] || '';
    } else if (arg === '--repo' || arg === '-r') {
      repo = args[++i] || 'local/repo';
    } else if (arg === '--branch' || arg === '-b') {
      branch = args[++i] || 'main';
    } else if (arg === '--path' || arg === '--target' || arg === '-t') {
      const val = args[++i];
      if (val) targetPaths.push(val);
    } else if (arg === '--model' || arg === '-m') {
      model = args[++i];
    } else if (arg === '--skip-commit') {
      skipCommit = true;
    } else if (!arg.startsWith('-') && !prompt) {
      prompt = arg;
    }
  }

  return {
    input: {
      prompt,
      repo,
      branch,
      targetPaths: targetPaths.length > 0 ? targetPaths : undefined
    },
    model,
    skipCommit,
    help
  };
}

export function printHelp(): void {
  console.log(`
Gemini Bridge Local CLI (Stage 5 Hybrid Routing)
Usage:
  gemini-local [options] [prompt]

Options:
  -p, --prompt <prompt>      Task instruction for Gemini
  -t, --path <filepath>      Target file(s) to include in context (repeatable)
  -r, --repo <owner/repo>    Repository name identifier (default: local/repo)
  -b, --branch <branch>      Branch name (default: main)
  -m, --model <model>        Gemini model (default: gemini-2.0-flash)
      --skip-commit          Apply changes to disk without creating a Git commit
  -h, --help                 Display this help message

Environment:
  GEMINI_API_KEY             Google Gemini API Key (or set in .env)
`);
}

export async function runCli(argv = process.argv): Promise<number> {
  const { input, model, skipCommit, help } = parseCliArgs(argv);

  if (help || !input.prompt) {
    printHelp();
    return help ? 0 : 1;
  }

  console.log(`[gemini-local] Starting local task: "${input.prompt}"`);
  if (input.targetPaths && input.targetPaths.length > 0) {
    console.log(`[gemini-local] Target files: ${input.targetPaths.join(', ')}`);
  }

  const result = await runLocalHybridTask(input, { model, skipCommit });

  if (result.status === 'SUCCESS') {
    console.log(`[gemini-local] Status: SUCCESS`);
    if (result.commitSha) {
      console.log(`[gemini-local] Commit SHA: ${result.commitSha}`);
    }
    if (result.message) {
      console.log(`[gemini-local] ${result.message}`);
    }
    return 0;
  } else if (result.status === 'PREFLIGHT_FAILED') {
    console.error(`[gemini-local] Preflight validation failed!`);
    if (result.errors) {
      for (const err of result.errors) {
        console.error(`  - [${err.stage}] ${err.file}:${err.line || 1} - ${err.message}`);
      }
    }
    return 2;
  } else {
    console.error(`[gemini-local] Error: ${result.message}`);
    return 1;
  }
}

// Only auto-run if directly executed
if (process.argv[1] && process.argv[1].endsWith('cli.ts')) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
