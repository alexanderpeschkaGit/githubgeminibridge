import type {
  FilePatchOperation,
  GeminiPatchPayload,
  LinterError
} from '../types';
import {
  LLM_PLACEHOLDER_PATTERNS,
  applySearchReplace
} from './patcher';
import { runPreflightLinter } from './linter';

/**
 * Stage 4 Linter Hook type: enables modules/linter.ts to inject AST/syntax checks
 * into the patch preflight pipeline without modifying patcher.ts.
 */
export type PreflightLinterHook = (
  files: { path: string; content: string }[],
  preflight?: GeminiPatchPayload['preflight']
) => Promise<LinterError[]> | LinterError[];

/**
 * Non-throwing helper that checks LLM_PLACEHOLDER_PATTERNS and returns
 * aggregated LinterError items for Stage 2 & 4 non-fail-fast error reporting.
 */
export function checkPlaceholderErrors(content: string, filePath: string): LinterError[] {
  const errors: LinterError[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of LLM_PLACEHOLDER_PATTERNS) {
      if (pattern.test(line)) {
        errors.push({
          file: filePath,
          stage: 'CUSTOM_RULE',
          line: i + 1,
          message: `Forbidden LLM placeholder pattern detected: "${line.trim()}"`,
          codeSnippet: line.trim()
        });
        break;
      }
    }
  }
  return errors;
}

/**
 * Evaluates custom preflight rules without failing fast.
 * Verifies forbidPatterns and requireExports across all resulting files.
 */
export function runBuiltinPreflightRules(
  files: { path: string; content: string }[],
  preflight?: GeminiPatchPayload['preflight']
): LinterError[] {
  const errors: LinterError[] = [];
  if (!preflight) {
    return errors;
  }

  // 1. forbidPatterns
  if (Array.isArray(preflight.forbidPatterns) && preflight.forbidPatterns.length > 0) {
    for (const pat of preflight.forbidPatterns) {
      let rx: RegExp;
      try {
        rx = new RegExp(pat);
      } catch {
        continue;
      }
      for (const file of files) {
        const lines = file.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (rx.test(line)) {
            errors.push({
              file: file.path,
              stage: 'CUSTOM_RULE',
              line: i + 1,
              message: `Forbidden pattern "${pat}" detected.`,
              codeSnippet: line.trim()
            });
          }
        }
      }
    }
  }

  // 2. requireExports
  if (preflight.requireExports && typeof preflight.requireExports === 'object') {
    for (const [requiredPath, symbols] of Object.entries(preflight.requireExports)) {
      const targetFile = files.find((f) => f.path === requiredPath);
      if (!targetFile) {
        for (const symbol of symbols) {
          errors.push({
            file: requiredPath,
            stage: 'CUSTOM_RULE',
            message: `Required export "${symbol}" missing because file "${requiredPath}" was not found among modified files.`
          });
        }
        continue;
      }

      for (const symbol of symbols) {
        const exportRegex = new RegExp(
          `(?:export\\s+(?:(?:default\\s+)?(?:const|let|var|function|class|interface|type|enum|async\\s+function)\\s+${symbol}\\b|export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}|export\\s*\\*\\s*as\\s+${symbol}\\b)`
        );
        if (!exportRegex.test(targetFile.content)) {
          errors.push({
            file: requiredPath,
            stage: 'CUSTOM_RULE',
            message: `Required export "${symbol}" missing in "${requiredPath}".`
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Pure in-memory patch processor.
 * Applies patches, validates placeholders, checks idempotency and executes preflight rules.
 */
export async function applyPatchesInMemory(
  patches: FilePatchOperation[],
  existingFiles: Record<string, string | null>,
  preflight?: GeminiPatchPayload['preflight'],
  preflightHook: PreflightLinterHook = runPreflightLinter
): Promise<{
  additions: { path: string; content: string }[];
  deletions: { path: string }[];
  errors: LinterError[];
  hasEffectiveChanges: boolean;
}> {
  const additions: { path: string; content: string }[] = [];
  const deletions: { path: string }[] = [];
  const errors: LinterError[] = [];
  let hasEffectiveChanges = false;
  const resultingFiles: { path: string; content: string }[] = [];

  for (const op of patches) {
    if (op.action === 'delete') {
      if (existingFiles[op.path] !== null) {
        deletions.push({ path: op.path });
        hasEffectiveChanges = true;
      }
      continue;
    }

    if (op.action === 'create') {
      if (typeof op.fullContent !== 'string') {
        errors.push({
          file: op.path,
          stage: 'SEARCH_REPLACE',
          message: 'Operation "create" requires "fullContent" string.'
        });
        continue;
      }

      const phErrors = checkPlaceholderErrors(op.fullContent, op.path);
      if (phErrors.length > 0) {
        errors.push(...phErrors);
      }

      const existing = existingFiles[op.path];
      if (existing !== op.fullContent) {
        additions.push({ path: op.path, content: op.fullContent });
        hasEffectiveChanges = true;
      }
      resultingFiles.push({ path: op.path, content: op.fullContent });
      continue;
    }

    if (op.action === 'modify') {
      // Full content overwrite without search/replace blocks
      if (typeof op.fullContent === 'string' && (!op.blocks || op.blocks.length === 0)) {
        const phErrors = checkPlaceholderErrors(op.fullContent, op.path);
        if (phErrors.length > 0) {
          errors.push(...phErrors);
        }

        const existing = existingFiles[op.path];
        if (existing !== op.fullContent) {
          additions.push({ path: op.path, content: op.fullContent });
          hasEffectiveChanges = true;
        }
        resultingFiles.push({ path: op.path, content: op.fullContent });
        continue;
      }

      // Search/replace blocks modification
      const existing = existingFiles[op.path];
      if (existing === null || existing === undefined) {
        errors.push({
          file: op.path,
          stage: 'SEARCH_REPLACE',
          message: 'Target file does not exist on branch'
        });
        continue;
      }

      if (!op.blocks || op.blocks.length === 0) {
        errors.push({
          file: op.path,
          stage: 'SEARCH_REPLACE',
          message: 'Operation "modify" requires non-empty "blocks" or "fullContent".'
        });
        continue;
      }

      let currentContent = existing;
      let hasError = false;

      for (const block of op.blocks) {
        const phErrors = checkPlaceholderErrors(block.replace, op.path);
        if (phErrors.length > 0) {
          errors.push(...phErrors);
          hasError = true;
        }

        try {
          currentContent = applySearchReplace(currentContent, block.search, block.replace, op.path);
        } catch (err: any) {
          errors.push({
            file: op.path,
            stage: 'SEARCH_REPLACE',
            message: err.message,
            codeSnippet: block.search.slice(0, 200)
          });
          hasError = true;
        }
      }

      const finalPhErrors = checkPlaceholderErrors(currentContent, op.path);
      if (finalPhErrors.length > 0) {
        errors.push(...finalPhErrors);
        hasError = true;
      }

      if (!hasError) {
        if (currentContent !== existing) {
          additions.push({ path: op.path, content: currentContent });
          hasEffectiveChanges = true;
        }
        resultingFiles.push({ path: op.path, content: currentContent });
      }
    }
  }

  // Preflight custom rules (builtin)
  const builtinErrors = runBuiltinPreflightRules(resultingFiles, preflight);
  if (builtinErrors.length > 0) {
    errors.push(...builtinErrors);
  }

  // Stage 4 preflight linter hook (oxc-parser / AST syntax checks + custom rules)
  const effectiveHook = preflightHook ?? runPreflightLinter;
  if (effectiveHook) {
    try {
      const hookErrors = await effectiveHook(resultingFiles, preflight);
      if (Array.isArray(hookErrors) && hookErrors.length > 0) {
        errors.push(...hookErrors);
      }
    } catch (err: any) {
      errors.push({
        file: 'preflightHook',
        stage: 'CUSTOM_RULE',
        message: `Preflight linter hook threw an error: ${err.message}`
      });
    }
  }

  // Deduplicate errors across stages and rules
  const seenErrors = new Set<string>();
  const uniqueErrors: LinterError[] = [];
  for (const err of errors) {
    const key = `${err.file}:${err.stage}:${err.line ?? 0}:${err.column ?? 0}:${err.message}`;
    if (!seenErrors.has(key)) {
      seenErrors.add(key);
      uniqueErrors.push(err);
    }
  }

  return {
    additions,
    deletions,
    errors: uniqueErrors,
    hasEffectiveChanges
  };
}
