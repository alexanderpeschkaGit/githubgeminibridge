// src/localRunner.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// ../edge-worker/src/modules/searchReplace.ts
var LLM_PLACEHOLDER_PATTERNS = [
  /\/\/\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i,
  /#\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i,
  /\/\*\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}\s*\*\//i,
  /<!--\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}\s*-->/i,
  /\.{3,}\s*(?:existing|rest of)\s*code\s*\.{3,}/i,
  /\/\/\s*\.{3,}\s*$/m
];
function checkPlaceholderErrors(content, filePath) {
  const errors = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of LLM_PLACEHOLDER_PATTERNS) {
      if (pattern.test(line)) {
        errors.push({
          file: filePath,
          stage: "CUSTOM_RULE",
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
function applySearchReplace(original, search, replace, filePath = "") {
  if (original.includes(search)) {
    return original.replace(search, () => replace);
  }
  const normOriginal = original.replace(/\r\n/g, "\n");
  const normSearch = search.replace(/\r\n/g, "\n");
  const normReplace = replace.replace(/\r\n/g, "\n");
  if (normOriginal.includes(normSearch)) {
    const updated = normOriginal.replace(normSearch, () => normReplace);
    if (original.includes("\r\n")) {
      return updated.replace(/\n/g, "\r\n");
    }
    return updated;
  }
  const origLines = normOriginal.split("\n");
  const searchLines = normSearch.split("\n");
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
    const before = origLines.slice(0, matchStart).join("\n");
    const after = origLines.slice(matchStart + searchLines.length).join("\n");
    const updated = (before ? before + "\n" : "") + normReplace + (after ? "\n" + after : "");
    if (original.includes("\r\n")) {
      return updated.replace(/\n/g, "\r\n");
    }
    return updated;
  }
  const snippet = search.length > 200 ? `${search.slice(0, 200)}...` : search;
  throw new Error(`Search block could not be resolved for file "${filePath}". Target snippet:
${snippet}`);
}

// ../../shared/repoPaths.ts
function normalizeRepoPath(input) {
  return (input || "").trim().replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}
function findRepoPathIssue(input) {
  const raw = (input || "").trim();
  if (!raw) {
    return 'Patch has no file path. Add a "// filepath: <repo/relative/path>" hint above the code block.';
  }
  const normalized = normalizeRepoPath(raw);
  if (!normalized) {
    return `Patch path "${raw}" does not point to a file inside the repository.`;
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `Patch path "${raw}" must be repo-relative (absolute drive paths are not allowed).`;
  }
  if (normalized.split("/").some((segment) => segment === ".." || segment === ".")) {
    return `Patch path "${raw}" must be repo-relative and must not contain "." or ".." segments.`;
  }
  return null;
}

// ../edge-worker/src/modules/syntaxScanner.ts
var registeredOxcParser = null;
var SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
function validateJson(filePath, content, getSnippet) {
  try {
    JSON.parse(content);
    return [];
  } catch (err) {
    const msg = err.message || "Invalid JSON";
    let line = 1;
    let col = 1;
    const posMatch = msg.match(/at position (\d+)/i);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const prefixLines = content.slice(0, pos).split("\n");
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
      stage: "OXC_SYNTAX",
      line,
      column: col,
      message: `JSON SyntaxError: ${msg}`,
      codeSnippet: getSnippet(line)
    }];
  }
}
async function runOxcWasm(filePath, content, getSnippet) {
  if (!registeredOxcParser) return null;
  try {
    const res = await registeredOxcParser(filePath, content);
    if (res && Array.isArray(res.errors) && res.errors.length > 0) {
      return res.errors.map((err) => ({
        file: filePath,
        stage: "OXC_SYNTAX",
        line: err.line || 1,
        column: err.column || 1,
        message: `OXC SyntaxError: ${err.message || String(err)}`,
        codeSnippet: err.line ? getSnippet(err.line) : void 0
      }));
    }
    return [];
  } catch (oxcErr) {
    return [{
      file: filePath,
      stage: "OXC_SYNTAX",
      line: 1,
      column: 1,
      message: `OXC Parser failure: ${oxcErr.message || String(oxcErr)}`,
      codeSnippet: getSnippet(1)
    }];
  }
}
async function validateSyntaxInWorker(filePath, content) {
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return [];
  }
  const errors = [];
  const lines = content.split("\n");
  const getSnippet = (lineNum) => {
    const idx = lineNum - 1;
    return idx >= 0 && idx < lines.length ? lines[idx].trim() : "";
  };
  if (ext === ".json") {
    return validateJson(filePath, content, getSnippet);
  }
  const oxcErrors = await runOxcWasm(filePath, content, getSnippet);
  if (oxcErrors) {
    return oxcErrors;
  }
  const allowsJsx = ext === ".tsx" || ext === ".jsx" || ext === ".js" || ext === ".mjs" || ext === ".cjs";
  let currentLine = 1;
  let currentCol = 1;
  const bracketStack = [];
  let state = "CODE";
  let stringStartLine = 1;
  let stringStartCol = 1;
  let lastNonWhitespaceChar = "";
  let inRegexCharClass = false;
  const len = content.length;
  let i = 0;
  while (i < len) {
    const ch = content[i];
    const nextCh = i + 1 < len ? content[i + 1] : "";
    if (currentCol === 1 && (ch === "<" || ch === "=" || ch === ">")) {
      const restOfLine = content.slice(i, i + 10);
      if (restOfLine.startsWith("<<<<<<<") || restOfLine.startsWith("=======") || restOfLine.startsWith(">>>>>>>")) {
        const marker = restOfLine.slice(0, 7);
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: currentLine,
          column: currentCol,
          message: `Git merge conflict marker detected ("${marker}"). Resolve all conflict markers before committing.`,
          codeSnippet: getSnippet(currentLine)
        });
      }
    }
    if (state === "LINE_COMMENT") {
      if (ch === "\n") {
        state = "CODE";
        currentLine++;
        currentCol = 1;
      } else {
        currentCol++;
      }
      i++;
      continue;
    }
    if (state === "BLOCK_COMMENT") {
      if (ch === "*" && nextCh === "/") {
        state = "CODE";
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === "\n") {
        currentLine++;
        currentCol = 1;
      } else {
        currentCol++;
      }
      i++;
      continue;
    }
    if (state === "SINGLE_QUOTE" || state === "DOUBLE_QUOTE") {
      const quoteChar = state === "SINGLE_QUOTE" ? "'" : '"';
      if (ch === "\\") {
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === quoteChar) {
        state = "CODE";
        lastNonWhitespaceChar = quoteChar;
        i++;
        currentCol++;
        continue;
      }
      if (ch === "\n") {
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: stringStartLine,
          column: stringStartCol,
          message: `Unterminated ${state === "SINGLE_QUOTE" ? "single" : "double"}-quoted string literal.`,
          codeSnippet: getSnippet(stringStartLine)
        });
        state = "CODE";
        currentLine++;
        currentCol = 1;
        i++;
        continue;
      }
      currentCol++;
      i++;
      continue;
    }
    if (state === "TEMPLATE") {
      if (ch === "\\") {
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === "$" && nextCh === "{") {
        bracketStack.push({ char: "${", line: currentLine, col: currentCol });
        state = "CODE";
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === "`") {
        state = "CODE";
        lastNonWhitespaceChar = "`";
        i++;
        currentCol++;
        continue;
      }
      if (ch === "\n") {
        currentLine++;
        currentCol = 1;
      } else {
        currentCol++;
      }
      i++;
      continue;
    }
    if (state === "REGEX") {
      if (ch === "\\") {
        i += 2;
        currentCol += 2;
        continue;
      }
      if (ch === "[" && !inRegexCharClass) {
        inRegexCharClass = true;
        i++;
        currentCol++;
        continue;
      }
      if (ch === "]" && inRegexCharClass) {
        inRegexCharClass = false;
        i++;
        currentCol++;
        continue;
      }
      if (ch === "/" && !inRegexCharClass) {
        state = "CODE";
        lastNonWhitespaceChar = "/";
        i++;
        currentCol++;
        while (i < len && /[a-z]/i.test(content[i])) {
          i++;
          currentCol++;
        }
        continue;
      }
      if (ch === "\n") {
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: stringStartLine,
          column: stringStartCol,
          message: "Unterminated regular expression literal.",
          codeSnippet: getSnippet(stringStartLine)
        });
        state = "CODE";
        currentLine++;
        currentCol = 1;
        i++;
        continue;
      }
      currentCol++;
      i++;
      continue;
    }
    if (ch === "/" && nextCh === "/") {
      state = "LINE_COMMENT";
      i += 2;
      currentCol += 2;
      continue;
    }
    if (ch === "/" && nextCh === "*") {
      state = "BLOCK_COMMENT";
      stringStartLine = currentLine;
      stringStartCol = currentCol;
      i += 2;
      currentCol += 2;
      continue;
    }
    if (ch === "/") {
      if (allowsJsx && lastNonWhitespaceChar === "<") {
        lastNonWhitespaceChar = ch;
        i++;
        currentCol++;
        continue;
      }
      const regexPreceders = "=([{:;,?!&|+-*^~<>%\n";
      const isRegex = lastNonWhitespaceChar === "" || regexPreceders.includes(lastNonWhitespaceChar);
      if (isRegex) {
        state = "REGEX";
        inRegexCharClass = false;
        stringStartLine = currentLine;
        stringStartCol = currentCol;
        i++;
        currentCol++;
        continue;
      }
    }
    if (allowsJsx && (ch === "'" || ch === '"')) {
      const prevChar = i > 0 ? content[i - 1] : "";
      if (/[A-Za-z]/.test(prevChar) && /[A-Za-z]/.test(nextCh)) {
        lastNonWhitespaceChar = ch;
        i++;
        currentCol++;
        continue;
      }
    }
    if (ch === "'") {
      state = "SINGLE_QUOTE";
      stringStartLine = currentLine;
      stringStartCol = currentCol;
      i++;
      currentCol++;
      continue;
    }
    if (ch === '"') {
      state = "DOUBLE_QUOTE";
      stringStartLine = currentLine;
      stringStartCol = currentCol;
      i++;
      currentCol++;
      continue;
    }
    if (ch === "`") {
      state = "TEMPLATE";
      stringStartLine = currentLine;
      stringStartCol = currentCol;
      i++;
      currentCol++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      bracketStack.push({ char: ch, line: currentLine, col: currentCol });
      lastNonWhitespaceChar = ch;
      i++;
      currentCol++;
      continue;
    }
    if (ch === ")") {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: currentLine,
          column: currentCol,
          message: "Unexpected closing parenthesis ')' with no matching '('.",
          codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char !== "(") {
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: currentLine,
          column: currentCol,
          message: `Mismatched bracket: expected '${top.char === "{" ? "}" : top.char === "[" ? "]" : "}"}' but found ')'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch;
      i++;
      currentCol++;
      continue;
    }
    if (ch === "]") {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: currentLine,
          column: currentCol,
          message: "Unexpected closing bracket ']' with no matching '['.",
          codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char !== "[") {
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: currentLine,
          column: currentCol,
          message: `Mismatched bracket: expected '${top.char === "{" ? "}" : top.char === "(" ? ")" : "}"}' but found ']'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch;
      i++;
      currentCol++;
      continue;
    }
    if (ch === "}") {
      const top = bracketStack.pop();
      if (!top) {
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: currentLine,
          column: currentCol,
          message: "Unexpected closing brace '}' with no matching '{'.",
          codeSnippet: getSnippet(currentLine)
        });
      } else if (top.char === "${") {
        state = "TEMPLATE";
      } else if (top.char !== "{") {
        errors.push({
          file: filePath,
          stage: "OXC_SYNTAX",
          line: currentLine,
          column: currentCol,
          message: `Mismatched bracket: expected '${top.char === "(" ? ")" : "]"}' but found '}'. (Opened at line ${top.line}, col ${top.col})`,
          codeSnippet: getSnippet(currentLine)
        });
      }
      lastNonWhitespaceChar = ch;
      i++;
      currentCol++;
      continue;
    }
    if (ch === "\n") {
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
  if (state === "BLOCK_COMMENT") {
    errors.push({
      file: filePath,
      stage: "OXC_SYNTAX",
      line: stringStartLine,
      column: stringStartCol,
      message: 'Unterminated multi-line comment ("/* ... */").',
      codeSnippet: getSnippet(stringStartLine)
    });
  } else if (state === "TEMPLATE") {
    errors.push({
      file: filePath,
      stage: "OXC_SYNTAX",
      line: stringStartLine,
      column: stringStartCol,
      message: 'Unterminated template literal ("`...`").',
      codeSnippet: getSnippet(stringStartLine)
    });
  } else if (state === "SINGLE_QUOTE" || state === "DOUBLE_QUOTE") {
    errors.push({
      file: filePath,
      stage: "OXC_SYNTAX",
      line: stringStartLine,
      column: stringStartCol,
      message: `Unterminated string literal (${state === "SINGLE_QUOTE" ? "'" : '"'}).`,
      codeSnippet: getSnippet(stringStartLine)
    });
  }
  while (bracketStack.length > 0) {
    const unclosed = bracketStack.pop();
    const name = unclosed.char === "(" ? "parenthesis '('" : unclosed.char === "[" ? "bracket '['" : unclosed.char === "${" ? "template expression '${'" : "brace '{'";
    errors.push({
      file: filePath,
      stage: "OXC_SYNTAX",
      line: unclosed.line,
      column: unclosed.col,
      message: `Unclosed ${name} opened at line ${unclosed.line}, column ${unclosed.col}.`,
      codeSnippet: getSnippet(unclosed.line)
    });
  }
  return errors;
}

// ../edge-worker/src/modules/linter.ts
async function validateSyntaxInWorker2(filePath, content) {
  return validateSyntaxInWorker(filePath, content);
}
function runCustomPreflightRules(files, preflight) {
  const errors = [];
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
async function runPreflightLinter(files, preflight) {
  const errors = [];
  for (const file of files) {
    const syntaxErrors = await validateSyntaxInWorker2(file.path, file.content);
    if (syntaxErrors.length > 0) {
      errors.push(...syntaxErrors);
    }
  }
  const customErrors = runCustomPreflightRules(files, preflight);
  if (customErrors.length > 0) {
    errors.push(...customErrors);
  }
  const seen = /* @__PURE__ */ new Set();
  const deduplicated = [];
  for (const err of errors) {
    const key = `${err.file}:${err.stage}:${err.line ?? 0}:${err.column ?? 0}:${err.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(err);
    }
  }
  return deduplicated;
}

// ../edge-worker/src/modules/patchInMemory.ts
function runBuiltinPreflightRules(files, preflight) {
  const errors = [];
  if (!preflight) {
    return errors;
  }
  if (Array.isArray(preflight.forbidPatterns) && preflight.forbidPatterns.length > 0) {
    for (const pat of preflight.forbidPatterns) {
      let rx;
      try {
        rx = new RegExp(pat);
      } catch {
        continue;
      }
      for (const file of files) {
        const lines = file.content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (rx.test(line)) {
            errors.push({
              file: file.path,
              stage: "CUSTOM_RULE",
              line: i + 1,
              message: `Forbidden pattern "${pat}" detected.`,
              codeSnippet: line.trim()
            });
          }
        }
      }
    }
  }
  if (preflight.requireExports && typeof preflight.requireExports === "object") {
    for (const [requiredPath, symbols] of Object.entries(preflight.requireExports)) {
      const targetFile = files.find((f) => f.path === requiredPath);
      if (!targetFile) {
        for (const symbol of symbols) {
          errors.push({
            file: requiredPath,
            stage: "CUSTOM_RULE",
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
            stage: "CUSTOM_RULE",
            message: `Required export "${symbol}" missing in "${requiredPath}".`
          });
        }
      }
    }
  }
  return errors;
}
function isInsertStyleBlockApplied(currentContent, block) {
  return block.search.length > 0 && block.replace.length > 0 && block.replace.includes(block.search) && currentContent.includes(block.replace);
}
var MIN_ALREADY_APPLIED_REPLACE_CHARS = 8;
function isAlreadyAppliedReplacement(currentContent, replace) {
  if (replace.replace(/\s+/g, "").length < MIN_ALREADY_APPLIED_REPLACE_CHARS) {
    return false;
  }
  return currentContent.includes(replace);
}
async function applyPatchesInMemory(patches, existingFiles, preflight, preflightHook = runPreflightLinter) {
  const additions = [];
  const deletions = [];
  const errors = [];
  let hasEffectiveChanges = false;
  const resultingFiles = [];
  for (const op of patches) {
    if (op.action === "delete") {
      if (existingFiles[op.path] !== null) {
        deletions.push({ path: op.path });
        hasEffectiveChanges = true;
      }
      continue;
    }
    if (op.action === "create") {
      if (typeof op.fullContent !== "string") {
        errors.push({
          file: op.path,
          stage: "SEARCH_REPLACE",
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
    if (op.action === "modify") {
      if (typeof op.fullContent === "string" && (!op.blocks || op.blocks.length === 0)) {
        const phErrors = checkPlaceholderErrors(op.fullContent, op.path);
        if (phErrors.length > 0) {
          errors.push(...phErrors);
        }
        const existing2 = existingFiles[op.path];
        if (existing2 !== op.fullContent) {
          additions.push({ path: op.path, content: op.fullContent });
          hasEffectiveChanges = true;
        }
        resultingFiles.push({ path: op.path, content: op.fullContent });
        continue;
      }
      const existing = existingFiles[op.path];
      if (existing === null || existing === void 0) {
        errors.push({
          file: op.path,
          stage: "SEARCH_REPLACE",
          message: 'Target file does not exist at the patch base revision. Verify the path is repo-relative (no leading "/", "./" or backslashes) or use action "create" for a new file.'
        });
        continue;
      }
      if (!op.blocks || op.blocks.length === 0) {
        errors.push({
          file: op.path,
          stage: "SEARCH_REPLACE",
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
        } catch (err) {
          if (isAlreadyAppliedReplacement(currentContent, block.replace)) {
            continue;
          }
          errors.push({
            file: op.path,
            stage: "SEARCH_REPLACE",
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
  const effectiveHook = preflightHook ?? runPreflightLinter;
  if (effectiveHook) {
    try {
      const hookErrors = await effectiveHook(resultingFiles, preflight);
      if (Array.isArray(hookErrors) && hookErrors.length > 0) {
        errors.push(...hookErrors);
      }
    } catch (err) {
      errors.push({
        file: "preflightHook",
        stage: "CUSTOM_RULE",
        message: `Preflight linter hook threw an error: ${err.message}`
      });
    }
  }
  const seenErrors = /* @__PURE__ */ new Set();
  const uniqueErrors = [];
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

// src/localRunner.ts
function loadEnvFile(cwd) {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    const raw = fs.readFileSync(envPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {
  }
}
function extractJsonFromResponse(raw) {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch && jsonMatch[1]) {
    return jsonMatch[1].trim();
  }
  return trimmed;
}
async function callGeminiForPatch(prompt, contextFiles, apiKey, model = "gemini-2.0-flash") {
  const fileContextString = contextFiles.map((f) => `### File: ${f.path}
\`\`\`
${f.content}
\`\`\``).join("\n\n");
  const systemInstruction = `You are a high-precision code modification agent.
You must respond ONLY with a valid JSON matching the GeminiPatchPayload schema.
Do NOT include explanations outside of the JSON block.
Schema:
{
  "commitMessage": "string",
  "preflight": {
    "forbidPatterns": ["optional regex string"],
    "requireExports": { "path/to/file.ts": ["exportName"] }
  },
  "patches": [
    {
      "path": "string",
      "action": "modify" | "create" | "delete",
      "blocks": [
        {
          "search": "exact string to replace",
          "replace": "new replacement string (never use placeholders like // ... existing code ...)"
        }
      ],
      "fullContent": "full content for create or full replacement"
    }
  ]
}`;
  const userContent = `Task Prompt:
${prompt}

Context Files:
${fileContextString}`;
  try {
    const genaiMod = await import("@google/genai").catch(() => null);
    if (genaiMod && genaiMod.GoogleGenAI) {
      const ai = new genaiMod.GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model,
        contents: `${systemInstruction}

${userContent}`
      });
      const text = response.text || "";
      const jsonStr = extractJsonFromResponse(text);
      return JSON.parse(jsonStr);
    }
  } catch {
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemInstruction}

${userContent}` }]
        }
      ]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!rawText) {
    throw new Error("Gemini API returned empty response");
  }
  const jsonText = extractJsonFromResponse(rawText);
  return JSON.parse(jsonText);
}
async function runLocalHybridTask(input, options = {}) {
  const cwd = options.cwd || process.cwd();
  loadEnvFile(cwd);
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      mode: "local",
      status: "ERROR",
      message: "GEMINI_API_KEY is not set in environment or options."
    };
  }
  const targetPaths = input.targetPaths || [];
  const originalFiles = [];
  for (const relPath of targetPaths) {
    const pathIssue = findRepoPathIssue(relPath);
    if (pathIssue) {
      return {
        mode: "local",
        status: "ERROR",
        message: pathIssue
      };
    }
    const normalizedRelPath = normalizeRepoPath(relPath);
    const absPath = path.resolve(cwd, normalizedRelPath);
    const resolvedCwd = path.resolve(cwd);
    if (!absPath.startsWith(resolvedCwd + path.sep) && absPath !== resolvedCwd) {
      return {
        mode: "local",
        status: "ERROR",
        message: `Path traversal detected: "${relPath}" escapes repository root.`
      };
    }
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      originalFiles.push({
        path: normalizedRelPath,
        content: fs.readFileSync(absPath, "utf-8")
      });
    }
  }
  try {
    const patchPayload = await callGeminiForPatch(
      input.prompt,
      originalFiles,
      apiKey,
      options.model
    );
    const existingRecord = {};
    for (const f of originalFiles) {
      existingRecord[f.path] = f.content;
    }
    for (const patch of patchPayload.patches) {
      const pathIssue = findRepoPathIssue(patch.path);
      if (pathIssue) {
        return {
          mode: "local",
          status: "ERROR",
          message: pathIssue
        };
      }
      const normalizedPatchPath = normalizeRepoPath(patch.path);
      const absPath = path.resolve(cwd, normalizedPatchPath);
      const resolvedCwd = path.resolve(cwd);
      if (!absPath.startsWith(resolvedCwd + path.sep) && absPath !== resolvedCwd) {
        return {
          mode: "local",
          status: "ERROR",
          message: `Path traversal detected: "${patch.path}" escapes repository root.`
        };
      }
      if (!(normalizedPatchPath in existingRecord)) {
        existingRecord[normalizedPatchPath] = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : null;
      }
      patch.path = normalizedPatchPath;
    }
    const patchResult = await applyPatchesInMemory(
      patchPayload.patches,
      existingRecord,
      patchPayload.preflight
    );
    if (patchResult.errors.length > 0) {
      return {
        mode: "local",
        status: "PREFLIGHT_FAILED",
        errors: patchResult.errors,
        message: `Preflight checks failed with ${patchResult.errors.length} error(s).`
      };
    }
    const modifiedPaths = [];
    for (const item of patchResult.deletions) {
      const pathIssue = findRepoPathIssue(item.path);
      if (pathIssue) {
        return {
          mode: "local",
          status: "ERROR",
          message: pathIssue
        };
      }
      const normalized = normalizeRepoPath(item.path);
      const absPath = path.resolve(cwd, normalized);
      const resolvedCwd = path.resolve(cwd);
      if (!absPath.startsWith(resolvedCwd + path.sep) && absPath !== resolvedCwd) {
        return {
          mode: "local",
          status: "ERROR",
          message: `Path traversal detected: "${item.path}" escapes repository root.`
        };
      }
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        modifiedPaths.push(normalized);
      }
    }
    for (const item of patchResult.additions) {
      const pathIssue = findRepoPathIssue(item.path);
      if (pathIssue) {
        return {
          mode: "local",
          status: "ERROR",
          message: pathIssue
        };
      }
      const normalized = normalizeRepoPath(item.path);
      const absPath = path.resolve(cwd, normalized);
      const resolvedCwd = path.resolve(cwd);
      if (!absPath.startsWith(resolvedCwd + path.sep) && absPath !== resolvedCwd) {
        return {
          mode: "local",
          status: "ERROR",
          message: `Path traversal detected: "${item.path}" escapes repository root.`
        };
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, item.content, "utf-8");
      modifiedPaths.push(normalized);
    }
    let commitSha;
    if (!options.skipCommit && modifiedPaths.length > 0) {
      try {
        const commitMsg = patchPayload.commitMessage || `Gemini Bridge local patch for: ${input.prompt.slice(0, 50)}`;
        execFileSync("git", ["add", "--", ...modifiedPaths], { cwd, stdio: "pipe" });
        execFileSync("git", ["commit", "-m", commitMsg], { cwd, stdio: "pipe" });
        commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" }).toString().trim();
      } catch (gitErr) {
        return {
          mode: "local",
          status: "SUCCESS",
          message: `Files written to disk, but git commit failed: ${gitErr.message}`
        };
      }
    }
    return {
      mode: "local",
      status: "SUCCESS",
      commitSha,
      message: `Successfully applied local patch (${modifiedPaths.length} file(s) modified).`
    };
  } catch (err) {
    return {
      mode: "local",
      status: "ERROR",
      message: err.message || "Unknown error occurred during local execution",
      errors: [err]
    };
  }
}

// src/cli.ts
import { fileURLToPath } from "node:url";
import * as path2 from "node:path";
function parseCliArgs(argv) {
  const args = argv.slice(2);
  let prompt = "";
  let repo = "local/repo";
  let branch = "main";
  const targetPaths = [];
  let model;
  let skipCommit = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--prompt" || arg === "-p") {
      prompt = args[++i] || "";
    } else if (arg === "--repo" || arg === "-r") {
      repo = args[++i] || "local/repo";
    } else if (arg === "--branch" || arg === "-b") {
      branch = args[++i] || "main";
    } else if (arg === "--path" || arg === "--target" || arg === "-t") {
      const val = args[++i];
      if (val) targetPaths.push(val);
    } else if (arg === "--model" || arg === "-m") {
      model = args[++i];
    } else if (arg === "--skip-commit") {
      skipCommit = true;
    } else if (!arg.startsWith("-") && !prompt) {
      prompt = arg;
    }
  }
  return {
    input: {
      prompt,
      repo,
      branch,
      targetPaths: targetPaths.length > 0 ? targetPaths : void 0
    },
    model,
    skipCommit,
    help
  };
}
function printHelp() {
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
async function runCli(argv = process.argv) {
  const { input, model, skipCommit, help } = parseCliArgs(argv);
  if (help || !input.prompt) {
    printHelp();
    return help ? 0 : 1;
  }
  console.log(`[gemini-local] Starting local task: "${input.prompt}"`);
  if (input.targetPaths && input.targetPaths.length > 0) {
    console.log(`[gemini-local] Target files: ${input.targetPaths.join(", ")}`);
  }
  const result = await runLocalHybridTask(input, { model, skipCommit });
  if (result.status === "SUCCESS") {
    console.log(`[gemini-local] Status: SUCCESS`);
    if (result.commitSha) {
      console.log(`[gemini-local] Commit SHA: ${result.commitSha}`);
    }
    if (result.message) {
      console.log(`[gemini-local] ${result.message}`);
    }
    return 0;
  } else if (result.status === "PREFLIGHT_FAILED") {
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
try {
  const currentFilePath = fileURLToPath(import.meta.url);
  const entryArg = process.argv[1] ? path2.resolve(process.argv[1]) : "";
  const isDirectRun = entryArg === currentFilePath || entryArg && entryArg.endsWith("gemini-local");
  if (isDirectRun) {
    runCli().then((code) => {
      if (code !== 0) process.exit(code);
    });
  }
} catch {
}
export {
  applyPatchesInMemory,
  extractJsonFromResponse,
  parseCliArgs,
  printHelp,
  runCli,
  runLocalHybridTask
};
