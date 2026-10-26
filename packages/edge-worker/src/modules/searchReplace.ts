import type { LinterError, PatchItem } from '../types';

/**
 * Hard Guardrail: Patterns indicating AI placeholder text that would truncate code.
 */
export const LLM_PLACEHOLDER_PATTERNS = [
  /\/\/\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i,
  /#\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i,
  /\/\*\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}\s*\*\//i,
  /<!--\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}\s*-->/i,
  /\.{3,}\s*(?:existing|rest of)\s*code\s*\.{3,}/i,
  /\/\/\s*\.{3,}\s*$/m,
];

/**
 * Validates that file content does NOT contain LLM placeholder comments.
 * Throws an error immediately if detected (used by V1 Legacy endpoints).
 */
export function validateNoPlaceholders(content: string, filePath: string): void {
  for (const pattern of LLM_PLACEHOLDER_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(
        `Hard Guardrail Rejection: File "${filePath}" contains forbidden LLM placeholder text (e.g. "// ... existing code ..."). Commit rejected to prevent accidental code truncation.`
      );
    }
  }
}

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
 * Extracts <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE blocks from text.
 */
export function parseSearchReplaceBlocks(text: string): PatchItem[] {
  const blocks: PatchItem[] = [];
  const regex = /<{5,9}\s*(?:SEARCH|ORIGINAL|HEAD)?\r?\n([\s\S]*?)\r?\n={5,9}\r?\n([\s\S]*?)\r?\n>{5,9}\s*(?:REPLACE|MODIFIED|UPDATED)?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      search: match[1],
      replace: match[2]
    });
  }

  return blocks;
}

/**
 * Applies a single search & replace transformation to a file content string.
 * Handles exact matches, CRLF vs LF differences, and trimmed line matches.
 */
export function applySearchReplace(original: string, search: string, replace: string, filePath: string = ''): string {
  // 1. Direct match
  if (original.includes(search)) {
    return original.replace(search, () => replace);
  }

  // 2. Normalized newline match (CRLF -> LF)
  const normOriginal = original.replace(/\r\n/g, '\n');
  const normSearch = search.replace(/\r\n/g, '\n');
  const normReplace = replace.replace(/\r\n/g, '\n');

  if (normOriginal.includes(normSearch)) {
    const updated = normOriginal.replace(normSearch, () => normReplace);
    if (original.includes('\r\n')) {
      return updated.replace(/\n/g, '\r\n');
    }
    return updated;
  }

  // 3. Relaxed line-by-line trimmed match
  const origLines = normOriginal.split('\n');
  const searchLines = normSearch.split('\n');

  let matchStart = -1;
  for (let i = 0; i <= origLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (origLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchStart = i;
      break;
    }
  }

  if (matchStart !== -1) {
    const before = origLines.slice(0, matchStart).join('\n');
    const after = origLines.slice(matchStart + searchLines.length).join('\n');
    const updated = (before ? before + '\n' : '') + normReplace + (after ? '\n' + after : '');
    if (original.includes('\r\n')) {
      return updated.replace(/\n/g, '\r\n');
    }
    return updated;
  }

  const snippet = search.length > 200 ? `${search.slice(0, 200)}...` : search;
  throw new Error(`Search block could not be resolved for file "${filePath}". Target snippet:\n${snippet}`);
}
