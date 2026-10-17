import type { LinterError, GeminiPatchPayload } from '../types';
import {
  checkPlaceholderErrors,
  runBuiltinPreflightRules,
  type PreflightLinterHook
} from './patcher';

/**
 * Optional pluggable OXC WASM parser interface.
 */
export type OxcWasmParser = (
  filename: string,
  sourceText: string
) => Promise<{ errors?: any[] } | any> | { errors?: any[] } | any;

let registeredOxcParser: OxcWasmParser | null = null;

/**
 * Registers an optional WASM-based oxc-parser hook for high-fidelity AST checks.
 */
export function registerOxcWasmParser(parser: OxcWasmParser | null): void {
  registeredOxcParser = parser;
}

/**
 * Supported file extensions for syntax validation.
 */
const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

interface BracketEntry {
  char: '(' | '[' | '{' | '${';
  line: number;
  col: number;
}

/**
 * Lexical and structural syntax validation running in < 5 ms in Cloudflare Workers and Node.js.
 * Non-Fail-Fast: accumulates all detected syntax errors across the file.
 */
export async function validateSyntaxInWorker(filePath: string, content: string): Promise<LinterError[]> {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : '';
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return [];
  }

  const errors: LinterError[] = [];
  const lines = content.split('\n');
  const getSnippet = (lineNum: number) => {
    const idx = lineNum - 1;
    return idx >= 0 && idx < lines.length ? lines[idx].trim() : '';
  };

  // 1. JSON file validation via JSON.parse
  if (ext === '.json') {
    try {
      JSON.parse(content);
      return [];
    } catch (err: any) {
      const msg = err.message || 'Invalid JSON';
      let line = 1;
      let col = 1;

      // Extract character position from V8 error message if present (e.g. "at position 42")
      const posMatch = msg.match(/at position (\d+)/i);
      if (posMatch) {
        const pos = parseInt(posMatch[1], 10);
        const prefix = content.slice(0, pos);
        const prefixLines = prefix.split('\n');
        line = prefixLines.length;
        col = prefixLines[prefixLines.length - 1].length + 1;
      } else {
        // Fallback: extract line/column directly
        const lcMatch = msg.match(/line (\d+).*?column (\d+)/i);
        if (lcMatch) {
          line = parseInt(lcMatch[1], 10);
          col = parseInt(lcMatch[2], 10);
        }
      }

      return [
        {
          file: filePath,
          stage: 'OXC_SYNTAX',
          line,
          column: col,
          message: `JSON SyntaxError: ${msg}`,
          codeSnippet: getSnippet(line)
        }
      ];
    }
  }

  // 2. Optional registered OXC WASM Parser Hook
  if (registeredOxcParser) {
    try {
      const res = await registeredOxcParser(filePath, content);
      if (res && Array.isArray(res.errors) && res.errors.length > 0) {
        for (const err of res.errors) {
          errors.push({
            file: filePath,
            stage: 'OXC_SYNTAX',
            line: err.line || 1,
            column: err.column || 1,
            message: `OXC SyntaxError: ${err.message || String(err)}`,
            codeSnippet: err.line ? getSnippet(err.line) : undefined
          });
        }
        return errors;
      }
    } catch (oxcErr: any) {
      errors.push({
        file: filePath,
        stage: 'OXC_SYNTAX',
        line: 1,
        column: 1,
        message: `OXC Parser failure: ${oxcErr.message || String(oxcErr)}`,
        codeSnippet: getSnippet(1)
      });
      return errors;
    }
  }

  // 3. Fast In-Worker Lexer and Bracket/Conflict-Marker Verifier
  // Checks merge conflicts, unbalanced brackets/parentheses, and unterminated strings/templates/comments.
  let currentLine = 1;
  let currentCol = 1;
  const bracketStack: BracketEntry[] = [];

  // State tracker: 'CODE' | 'SINGLE_QUOTE' | 'DOUBLE_QUOTE' | 'TEMPLATE' | 'BLOCK_COMMENT' | 'LINE_COMMENT' | 'REGEX'
  let state: 'CODE' | 'SINGLE_QUOTE' | 'DOUBLE_QUOTE' | 'TEMPLATE' | 'BLOCK_COMMENT' | 'LINE_COMMENT' | 'REGEX' = 'CODE';
  let stringStartLine = 1;
  let stringStartCol = 1;
  let lastNonWhitespaceChar = '';
  let inRegexCharClass = false;

  const len = content.length;
  let i = 0;

  while (i < len) {
    const ch = content[i];
    const nextCh = i + 1 < len ? content[i + 1] : '';

    // Check merge conflict markers at the start of a line
    if (currentCol === 1 && (ch === '<' || ch === '=' || ch === '>')) {
      const restOfLine = content.slice(i, i + 10);
      if (
        restOfLine.startsWith('<<<<<<<') ||
        restOfLine.startsWith('=======') ||
        restOfLine.startsWith('>>>>>>>')
      ) {
        const marker = restOfLine.slice(0, 7);
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: currentLine,
          column: currentCol,
          message: `Git merge conflict marker detected ("${marker}"). Resolve all conflict markers before committing.`,
          codeSnippet: getSnippet(currentLine)
        });
      }
    }

    if (state === 'LINE_COMMENT') {
      if (ch === '\n') {
        state = 'CODE';
        currentLine++;
        currentCol = 1;
      } else {
        currentCol++;
      }
      i++;
      continue;
    }

    if (state === 'BLOCK_COMMENT') {
      if (ch === '*' && nextCh === '/') {
        state = 'CODE';
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === '\n') {
        currentLine++;
        currentCol = 1;
      } else {
        currentCol++;
      }
      i++;
      continue;
    }

    if (state === 'SINGLE_QUOTE') {
      if (ch === '\\') {
        // Escaped character in single quote
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === "'") {
        state = 'CODE';
        lastNonWhitespaceChar = "'";
        i++;
        currentCol++;
        continue;
      }
      if (ch === '\n') {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: stringStartLine,
          column: stringStartCol,
          message: 'Unterminated single-quoted string literal.',
          codeSnippet: getSnippet(stringStartLine)
        });
        state = 'CODE';
        currentLine++;
        currentCol = 1;
        i++;
        continue;
      }
      currentCol++;
      i++;
      continue;
    }

    if (state === 'DOUBLE_QUOTE') {
      if (ch === '\\') {
        // Escaped character in double quote
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === '"') {
        state = 'CODE';
        lastNonWhitespaceChar = '"';
        i++;
        currentCol++;
        continue;
      }
      if (ch === '\n') {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: stringStartLine,
          column: stringStartCol,
          message: 'Unterminated double-quoted string literal.',
          codeSnippet: getSnippet(stringStartLine)
        });
        state = 'CODE';
        currentLine++;
        currentCol = 1;
        i++;
        continue;
      }
      currentCol++;
      i++;
      continue;
    }

    if (state === 'TEMPLATE') {
      if (ch === '\\') {
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === '$' && nextCh === '{') {
        bracketStack.push({ char: '${', line: currentLine, col: currentCol });
        state = 'CODE';
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === '`') {
        state = 'CODE';
        lastNonWhitespaceChar = '`';
        i++;
        currentCol++;
        continue;
      }
      if (ch === '\n') {
        currentLine++;
        currentCol = 1;
      } else {
        currentCol++;
      }
      i++;
      continue;
    }

    if (state === 'REGEX') {
      if (ch === '\\') {
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === '[' && !inRegexCharClass) {
        inRegexCharClass = true;
        i++;
        currentCol++;
        continue;
      }
      if (ch === ']' && inRegexCharClass) {
        inRegexCharClass = false;
        i++;
        currentCol++;
        continue;
      }
      if (ch === '/' && !inRegexCharClass) {
        state = 'CODE';
        lastNonWhitespaceChar = '/';
        i++;
        currentCol++;
        // consume any regex flags (g, i, m, s, u, y, d, v)
        while (i < len && /[a-z]/i.test(content[i])) {
          i++;
          currentCol++;
        }
        continue;
      }
      if (ch === '\n') {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: stringStartLine,
          column: stringStartCol,
          message: 'Unterminated regular expression literal.',
          codeSnippet: getSnippet(stringStartLine)
        });
        state = 'CODE';
        currentLine++;
        currentCol = 1;
        i++;
        continue;
      }
      currentCol++;
      i++;
      continue;
    }

    // STATE: 'CODE'
    if (ch === '/' && nextCh === '/') {
      state = 'LINE_COMMENT';
      i += 2;
      currentCol += 2;
      continue;
    }

    if (ch === '/' && nextCh === '*') {
      state = 'BLOCK_COMMENT';
      stringStartLine = currentLine;
      stringStartCol = currentCol;
      i += 2;
      currentCol += 2;
      continue;
    }

    // Check regex literal vs division:
    // A slash is regex literal if preceding token was an operator, punctuation or start of expression
    if (ch === '/') {
      const regexPreceders = '=([{:;,?!&|+-*^~<>%return\n';
      const isRegex =
        lastNonWhitespaceChar === '' ||
        regexPreceders.includes(lastNonWhitespaceChar);

      if (isRegex) {
        state = 'REGEX';
        inRegexCharClass = false;
        stringStartLine = currentLine;
        stringStartCol = currentCol;
        i++;
        currentCol++;
        continue;
      }
    }

    if (ch === "'") {
      state = 'SINGLE_QUOTE';
      stringStartLine = currentLine;
      stringStartCol = currentCol;
      i++;
      currentCol++;
      continue;
    }

    if (ch === '"') {
      state = 'DOUBLE_QUOTE';
      stringStartLine = currentLine;
      stringStartCol = currentCol;
      i++;
      currentCol++;
      continue;
    }

    if (ch === '`') {
      state = 'TEMPLATE';
      stringStartLine = currentLine;
      stringStartCol = currentCol;
      i++;
      currentCol++;
      continue;
    }

    // Bracket Stack Handlers
    if (ch === '(' || ch === '[' || ch === '{') {
      bracketStack.push({ char: ch, line: currentLine, col: currentCol });
      lastNonWhitespaceChar = ch;
      i++;
      currentCol++;
      continue;
    }

    if (ch === ')') {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: currentLine,
          column: currentCol,
          message: "Unexpected closing parenthesis ')' with no matching '('.",
          codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char !== '(') {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: currentLine,
          column: currentCol,
          message: `Mismatched bracket: expected '${top.char === '{' ? '}' : top.char === '[' ? ']' : '}'}' but found ')'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch;
      i++;
      currentCol++;
      continue;
    }

    if (ch === ']') {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: currentLine,
          column: currentCol,
          message: "Unexpected closing bracket ']' with no matching '['.",
          codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char !== '[') {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: currentLine,
          column: currentCol,
          message: `Mismatched bracket: expected '${top.char === '{' ? '}' : top.char === '(' ? ')' : '}'}' but found ']'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch;
      i++;
      currentCol++;
      continue;
    }

    if (ch === '}') {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: currentLine,
          column: currentCol,
          message: "Unexpected closing brace '}' with no matching '{'.",
          codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char === '${') {
        // Closed template expression -> switch back to TEMPLATE mode
        state = 'TEMPLATE';
      } else if (top.char !== '{') {
        errors.push({
          file: filePath,
          stage: 'OXC_SYNTAX',
          line: currentLine,
          column: currentCol,
          message: `Mismatched bracket: expected '${top.char === '(' ? ')' : ']'}' but found '}'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch;
      i++;
      currentCol++;
      continue;
    }

    if (ch === '\n') {
      currentLine++;
      currentCol = 1;
      i++;
      continue;
    }

    if (!/\s/.test(ch)) {
      lastNonWhitespaceChar = ch;
    }

    currentCol++;
    i++;
  }

  // End of file diagnostics
  if (state === 'BLOCK_COMMENT') {
    errors.push({
      file: filePath,
      stage: 'OXC_SYNTAX',
      line: stringStartLine,
      column: stringStartCol,
      message: 'Unterminated multi-line comment ("/* ... */").',
      codeSnippet: getSnippet(stringStartLine)
    });
  } else if (state === 'TEMPLATE') {
    errors.push({
      file: filePath,
      stage: 'OXC_SYNTAX',
      line: stringStartLine,
      column: stringStartCol,
      message: 'Unterminated template literal ("`...`").',
      codeSnippet: getSnippet(stringStartLine)
    });
  } else if (state === 'SINGLE_QUOTE' || state === 'DOUBLE_QUOTE') {
    errors.push({
      file: filePath,
      stage: 'OXC_SYNTAX',
      line: stringStartLine,
      column: stringStartCol,
      message: `Unterminated string literal (${state === 'SINGLE_QUOTE' ? "'" : '"'}).`,
      codeSnippet: getSnippet(stringStartLine)
    });
  }

  // Check remaining open brackets
  while (bracketStack.length > 0) {
    const unclosed = bracketStack.pop()!;
    const name =
      unclosed.char === '('
        ? "parenthesis '('"
        : unclosed.char === '['
        ? "bracket '['"
        : unclosed.char === '${'
        ? "template expression '${'"
        : "brace '{'";

    errors.push({
      file: filePath,
      stage: 'OXC_SYNTAX',
      line: unclosed.line,
      column: unclosed.col,
      message: `Unclosed ${name} opened at line ${unclosed.line}, column ${unclosed.col}.`,
      codeSnippet: getSnippet(unclosed.line)
    });
  }

  return errors;
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
