import type { LinterError } from '../types';

/**
 * Optional pluggable OXC WASM parser interface.
 */
export type OxcWasmParser = (
  filename: string,
  sourceText: string
) => Promise<{ errors?: any[] } | any> | { errors?: any[] } | any;

export type OxcWasmParserFn = OxcWasmParser;

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
export const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

export interface BracketEntry {
  char: '(' | '[' | '{' | '${';
  line: number;
  col: number;
}

/**
 * Validates JSON files via JSON.parse.
 */
function validateJson(filePath: string, content: string, getSnippet: (l: number) => string): LinterError[] {
  try {
    JSON.parse(content);
    return [];
  } catch (err: any) {
    const msg = err.message || 'Invalid JSON';
    let line = 1;
    let col = 1;
    const posMatch = msg.match(/at position (\d+)/i);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const prefixLines = content.slice(0, pos).split('\n');
      line = prefixLines.length;
      col = prefixLines[prefixLines.length - 1].length + 1;
    } else {
      const lcMatch = msg.match(/line (\d+).*?column (\d+)/i);
      if (lcMatch) {
        line = parseInt(lcMatch[1], 10);
        col = parseInt(lcMatch[2], 10);
      }
    }
    return [{
      file: filePath,
      stage: 'OXC_SYNTAX',
      line,
      column: col,
      message: `JSON SyntaxError: ${msg}`,
      codeSnippet: getSnippet(line)
    }];
  }
}

/**
 * Runs optional OXC WASM parser if registered.
 */
async function runOxcWasm(filePath: string, content: string, getSnippet: (l: number) => string): Promise<LinterError[] | null> {
  if (!registeredOxcParser) return null;
  try {
    const res = await registeredOxcParser(filePath, content);
    if (res && Array.isArray(res.errors) && res.errors.length > 0) {
      return res.errors.map((err: any) => ({
        file: filePath,
        stage: 'OXC_SYNTAX',
        line: err.line || 1,
        column: err.column || 1,
        message: `OXC SyntaxError: ${err.message || String(err)}`,
        codeSnippet: err.line ? getSnippet(err.line) : undefined
      }));
    }
    return [];
  } catch (oxcErr: any) {
    return [{
      file: filePath,
      stage: 'OXC_SYNTAX',
      line: 1,
      column: 1,
      message: `OXC Parser failure: ${oxcErr.message || String(oxcErr)}`,
      codeSnippet: getSnippet(1)
    }];
  }
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
    return validateJson(filePath, content, getSnippet);
  }

  // 2. Optional registered OXC WASM Parser Hook
  const oxcErrors = await runOxcWasm(filePath, content, getSnippet);
  if (oxcErrors) {
    return oxcErrors;
  }

  // 3. Fast In-Worker Lexer and Bracket/Conflict-Marker Verifier
  const allowsJsx = ext === '.tsx' || ext === '.jsx' || ext === '.js' || ext === '.mjs' || ext === '.cjs';
  let currentLine = 1;
  let currentCol = 1;
  const bracketStack: BracketEntry[] = [];
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
      if (restOfLine.startsWith('<<<<<<<') || restOfLine.startsWith('=======') || restOfLine.startsWith('>>>>>>>')) {
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
      if (ch === '\n') { state = 'CODE'; currentLine++; currentCol = 1; } else { currentCol++; }
      i++;
      continue;
    }

    if (state === 'BLOCK_COMMENT') {
      if (ch === '*' && nextCh === '/') { state = 'CODE'; i += 2; currentCol += 2; continue; }
      if (ch === '\n') { currentLine++; currentCol = 1; } else { currentCol++; }
      i++;
      continue;
    }

    if (state === 'SINGLE_QUOTE' || state === 'DOUBLE_QUOTE') {
      const quoteChar = state === 'SINGLE_QUOTE' ? "'" : '"';
      if (ch === '\\') { i += 2; currentCol += 2; continue; }
      if (ch === quoteChar) { state = 'CODE'; lastNonWhitespaceChar = quoteChar; i++; currentCol++; continue; }
      if (ch === '\n') {
        errors.push({
          file: filePath, stage: 'OXC_SYNTAX', line: stringStartLine, column: stringStartCol,
          message: `Unterminated ${state === 'SINGLE_QUOTE' ? 'single' : 'double'}-quoted string literal.`,
          codeSnippet: getSnippet(stringStartLine)
        });
        state = 'CODE'; currentLine++; currentCol = 1; i++; continue;
      }
      currentCol++; i++;
      continue;
    }

    if (state === 'TEMPLATE') {
      if (ch === '\\') { i += 2; currentCol += 2; continue; }
      if (ch === '$' && nextCh === '{') {
        bracketStack.push({ char: '${', line: currentLine, col: currentCol });
        state = 'CODE'; i += 2; currentCol += 2; continue;
      }
      if (ch === '`') { state = 'CODE'; lastNonWhitespaceChar = '`'; i++; currentCol++; continue; }
      if (ch === '\n') { currentLine++; currentCol = 1; } else { currentCol++; }
      i++;
      continue;
    }

    if (state === 'REGEX') {
      if (ch === '\\') { i += 2; currentCol += 2; continue; }
      if (ch === '[' && !inRegexCharClass) { inRegexCharClass = true; i++; currentCol++; continue; }
      if (ch === ']' && inRegexCharClass) { inRegexCharClass = false; i++; currentCol++; continue; }
      if (ch === '/' && !inRegexCharClass) {
        state = 'CODE'; lastNonWhitespaceChar = '/'; i++; currentCol++;
        while (i < len && /[a-z]/i.test(content[i])) { i++; currentCol++; }
        continue;
      }
      if (ch === '\n') {
        errors.push({
          file: filePath, stage: 'OXC_SYNTAX', line: stringStartLine, column: stringStartCol,
          message: 'Unterminated regular expression literal.', codeSnippet: getSnippet(stringStartLine)
        });
        state = 'CODE'; currentLine++; currentCol = 1; i++; continue;
      }
      currentCol++; i++;
      continue;
    }

    // STATE: 'CODE'
    if (ch === '/' && nextCh === '/') { state = 'LINE_COMMENT'; i += 2; currentCol += 2; continue; }
    if (ch === '/' && nextCh === '*') {
      state = 'BLOCK_COMMENT'; stringStartLine = currentLine; stringStartCol = currentCol;
      i += 2; currentCol += 2; continue;
    }

    if (ch === '/') {
      // In JSX the sequence "</tag" closes an element; treating that slash as a
      // regex start made every .tsx/.jsx file report "Unterminated regular expression".
      if (allowsJsx && lastNonWhitespaceChar === '<') {
        lastNonWhitespaceChar = ch; i++; currentCol++; continue;
      }
      const regexPreceders = '=([{:;,?!&|+-*^~<%';
      const isRegex = lastNonWhitespaceChar === '' || regexPreceders.includes(lastNonWhitespaceChar);
      if (isRegex) {
        state = 'REGEX'; inRegexCharClass = false; stringStartLine = currentLine; stringStartCol = currentCol;
        i++; currentCol++; continue;
      }
    }

    // JSX text may contain contractions ("Don't", "it's") that are not string
    // delimiters; only the letter-quote-letter shape is treated as literal text.
    if (allowsJsx && (ch === "'" || ch === '"')) {
      const prevChar = i > 0 ? content[i - 1] : '';
      if (/[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(nextCh)) {
        lastNonWhitespaceChar = ch; i++; currentCol++; continue;
      }
    }

    if (ch === "'") { state = 'SINGLE_QUOTE'; stringStartLine = currentLine; stringStartCol = currentCol; i++; currentCol++; continue; }
    if (ch === '"') { state = 'DOUBLE_QUOTE'; stringStartLine = currentLine; stringStartCol = currentCol; i++; currentCol++; continue; }
    if (ch === '`') { state = 'TEMPLATE'; stringStartLine = currentLine; stringStartCol = currentCol; i++; currentCol++; continue; }

    if (ch === '(' || ch === '[' || ch === '{') {
      bracketStack.push({ char: ch, line: currentLine, col: currentCol });
      lastNonWhitespaceChar = ch;
      i++; currentCol++;
      continue;
    }

    if (ch === ')') {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath, stage: 'OXC_SYNTAX', line: currentLine, column: currentCol,
          message: "Unexpected closing parenthesis ')' with no matching '('.", codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char !== '(') {
        errors.push({
          file: filePath, stage: 'OXC_SYNTAX', line: currentLine, column: currentCol,
          message: `Mismatched bracket: expected '${top.char === '{' ? '}' : top.char === '[' ? ']' : '}'}' but found ')'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch; i++; currentCol++; continue;
    }

    if (ch === ']') {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath, stage: 'OXC_SYNTAX', line: currentLine, column: currentCol,
          message: "Unexpected closing bracket ']' with no matching '['.", codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char !== '[') {
        errors.push({
          file: filePath, stage: 'OXC_SYNTAX', line: currentLine, column: currentCol,
          message: `Mismatched bracket: expected '${top.char === '{' ? '}' : top.char === '(' ? ')' : '}'}' but found ']'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch; i++; currentCol++; continue;
    }

    if (ch === '}') {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath, stage: 'OXC_SYNTAX', line: currentLine, column: currentCol,
          message: "Unexpected closing brace '}' with no matching '{'.", codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char === '${') {
        state = 'TEMPLATE';
      } else if (top.char !== '{') {
        errors.push({
          file: filePath, stage: 'OXC_SYNTAX', line: currentLine, column: currentCol,
          message: `Mismatched bracket: expected '${top.char === '(' ? ')' : ']'}' but found '}'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch; i++; currentCol++; continue;
    }

    if (ch === '\n') { currentLine++; currentCol = 1; i++; continue; }
    if (!/\s/.test(ch)) { lastNonWhitespaceChar = ch; }
    currentCol++; i++;
  }

  // End of file diagnostics
  if (state === 'BLOCK_COMMENT') {
    errors.push({
      file: filePath, stage: 'OXC_SYNTAX', line: stringStartLine, column: stringStartCol,
      message: 'Unterminated multi-line comment ("/* ... */").', codeSnippet: getSnippet(stringStartLine)
    });
  } else if (state === 'TEMPLATE') {
    errors.push({
      file: filePath, stage: 'OXC_SYNTAX', line: stringStartLine, column: stringStartCol,
      message: 'Unterminated template literal ("`...`").', codeSnippet: getSnippet(stringStartLine)
    });
  } else if (state === 'SINGLE_QUOTE' || state === 'DOUBLE_QUOTE') {
    errors.push({
      file: filePath, stage: 'OXC_SYNTAX', line: stringStartLine, column: stringStartCol,
      message: `Unterminated string literal (${state === 'SINGLE_QUOTE' ? "'" : '"'}).`, codeSnippet: getSnippet(stringStartLine)
    });
  }

  // Check remaining open brackets
  while (bracketStack.length > 0) {
    const unclosed = bracketStack.pop()!;
    const name = unclosed.char === '(' ? "parenthesis '('" : unclosed.char === '[' ? "bracket '['" : unclosed.char === '${' ? "template expression '${'" : "brace '{'";
    errors.push({
      file: filePath, stage: 'OXC_SYNTAX', line: unclosed.line, column: unclosed.col,
      message: `Unclosed ${name} opened at line ${unclosed.line}, column ${unclosed.col}.`, codeSnippet: getSnippet(unclosed.line)
    });
  }

  return errors;
}
