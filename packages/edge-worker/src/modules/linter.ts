import type { LinterError, GeminiPatchPayload } from '../types';
import {
  checkPlaceholderErrors,
  runBuiltinPreflightRules,
  type PreflightLinterHook
} from './patcher';
import {
  type OxcWasmParser,
  type OxcWasmParserFn,
  registerOxcWasmParser,
  validateSyntaxInWorker as scanSyntaxInWorker
} from './syntaxScanner';

export type { OxcWasmParser, OxcWasmParserFn };
export { registerOxcWasmParser };

/**
 * Structural syntax validation running in < 5 ms in Cloudflare Workers and Node.js.
 * Non-Fail-Fast: accumulates all detected syntax errors across the file.
 */
export async function validateSyntaxInWorker(filePath: string, content: string): Promise<LinterError[]> {
  return scanSyntaxInWorker(filePath, content);
}

/**
 * Runs all custom preflight rules without failing fast:
 * checks placeholder patterns (validateNoPlaceholders guardrail),
 * preflight.forbidPatterns, and preflight.requireExports.
 */
export function runCustomPreflightRules(
  files: { path: string; content: string }[],
  preflight?: GeminiPatchPayload['preflight']
): LinterError[] {
  const errors: LinterError[] = [];

  for (const file of files) {
    const phErrors = checkPlaceholderErrors(file.content, file.path);
    if (phErrors.length > 0) {
      errors.push(...phErrors);
    }
  }

  const builtinErrors = runBuiltinPreflightRules(files, preflight);
  if (builtinErrors.length > 0) {
    errors.push(...builtinErrors);
  }

  return errors;
}

/**
 * Full Stage 4 Pre-Flight Linter Hook implementation.
 * Iterates over all files to validate syntax and custom rules without failing fast,
 * deduplicating any identical error entries.
 */
export async function runPreflightLinter(
  files: { path: string; content: string }[],
  preflight?: GeminiPatchPayload['preflight']
): Promise<LinterError[]> {
  const errors: LinterError[] = [];

  // 1. Syntax check on all modified/created files
  for (const file of files) {
    const syntaxErrors = await validateSyntaxInWorker(file.path, file.content);
    if (syntaxErrors.length > 0) {
      errors.push(...syntaxErrors);
    }
  }

  // 2. Custom preflight rules (placeholders, forbidPatterns, requireExports)
  const customErrors = runCustomPreflightRules(files, preflight);
  if (customErrors.length > 0) {
    errors.push(...customErrors);
  }

  // Deduplicate errors by file:stage:line:col:message
  const seen = new Set<string>();
  const deduplicated: LinterError[] = [];

  for (const err of errors) {
    const key = `${err.file}:${err.stage}:${err.line ?? 0}:${err.column ?? 0}:${err.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(err);
    }
  }

  return deduplicated;
}
