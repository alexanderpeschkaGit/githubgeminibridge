import type {
  FilePatchOperation,
  GeminiPatchPayload,
  LinterError,
  PatchBlock
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
 * Detects an already-applied insert-style block ("add lines around an anchor"):
 * when `replace` contains `search`, the anchor still matches after the commit,
 * so applySearchReplace would re-insert the added lines and duplicate them.
 * Presence of the full replacement is therefore the applied-state marker.
 */
export function isInsertStyleBlockApplied(
  currentContent: string,
  block: PatchBlock
): boolean {
  return (
    block.search.length > 0 &&
    block.replace.length > 0 &&
    block.replace.includes(block.search) &&
    currentContent.includes(block.replace)
  );
}

/**
 * Minimum number of non-whitespace characters a replace-style replacement needs
 * before it counts as proof of an earlier application. Without this floor a generic
 * fragment ("x", "}", "return") that happens to exist anywhere in the file silently
 * turned a failed search into `NO_CHANGES_NEEDED`; a specific replacement keeps the
 * legitimate replay idempotent.
 */
export const MIN_ALREADY_APPLIED_REPLACE_CHARS = 8;

/**
 * Guards the replace-style idempotency shortcut used when a search block no longer
 * resolves: only a specific replacement text proves the block was committed before.
 */
export function isAlreadyAppliedReplacement(
  currentContent: string,
  replace: string
): boolean {
  if (replace.replace(/\s+/g, '').length < MIN_ALREADY_APPLIED_REPLACE_CHARS) {
    return false;
  }
  return currentContent.includes(replace);
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
          message: 'Target file does not exist at the patch base revision. Verify the path is repo-relative (no leading "/", "./" or backslashes) or use action "create" for a new file.'
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

        if (isInsertStyleBlockApplied(currentContent, block)) {
          continue;
        }

        try {
          currentContent = applySearchReplace(currentContent, block.search, block.replace, op.path);
        } catch (err: any) {
          // Idempotency: a replacement that is already present means this block was
          // applied by an earlier commit, so re-applying yields NO_CHANGES_NEEDED
          // instead of a SEARCH_REPLACE failure. Only a specific replacement counts
          // as proof (see isAlreadyAppliedReplacement).
          if (isAlreadyAppliedReplacement(currentContent, block.replace)) {
            continue;
          }
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
