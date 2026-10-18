// packages/edge-worker/src/utils/encoding.ts
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  const CHUNK_SIZE = 32768;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// packages/edge-worker/src/utils/github.ts
var GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
function parseRepoOwner(repoInput, ownerInput) {
  if (ownerInput && repoInput && !repoInput.includes("/")) {
    return { owner: ownerInput.trim(), repo: repoInput.trim() };
  }
  const parts = repoInput.trim().replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository format "${repoInput}". Expected "owner/repo".`);
  }
  return {
    owner: parts[0],
    repo: parts.slice(1).join("/")
  };
}
async function executeGraphQL(query, variables, token) {
  const res = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent": "Cloudflare-Worker-gemini-git-bridge",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GraphQL HTTP error ${res.status} (${res.statusText}): ${text}`);
  }
  const json = await res.json();
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors.map((e) => e.message).join(" | ");
    throw new Error(`GitHub GraphQL error: ${msg}`);
  }
  return json.data;
}
async function getBranchHeadOid(owner, repo, branch, token) {
  const qualifiedBranch = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
  const query = `
    query GetBranchHead($owner: String!, $repo: String!, $branch: String!) {
      repository(owner: $owner, name: $repo) {
        ref(qualifiedName: $branch) {
          name
          target {
            oid
          }
        }
        defaultBranchRef {
          name
          target {
            oid
          }
        }
      }
    }
  `;
  const data = await executeGraphQL(query, { owner, repo, branch: qualifiedBranch }, token);
  const repository = data?.repository;
  if (!repository) {
    throw new Error(`Repository "${owner}/${repo}" was not found or is not accessible with the provided token.`);
  }
  if (repository.ref?.target?.oid) {
    return {
      headOid: repository.ref.target.oid,
      resolvedBranch: repository.ref.name
    };
  }
  if (!branch && repository.defaultBranchRef?.target?.oid) {
    return {
      headOid: repository.defaultBranchRef.target.oid,
      resolvedBranch: repository.defaultBranchRef.name
    };
  }
  throw new Error(`Branch "${branch}" (or "${qualifiedBranch}") not found in repository "${owner}/${repo}".`);
}
async function fetchFileContent(owner, repo, branch, path, token) {
  const expression = `${branch}:${path}`;
  const query = `
    query GetFileBlob($owner: String!, $repo: String!, $expression: String!) {
      repository(owner: $owner, name: $repo) {
        object(expression: $expression) {
          ... on Blob {
            text
            isTruncated
          }
        }
      }
    }
  `;
  try {
    const data = await executeGraphQL(query, { owner, repo, expression }, token);
    const blob = data?.repository?.object;
    if (blob && typeof blob.text === "string" && !blob.isTruncated) {
      return blob.text;
    }
  } catch {
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const restUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(restUrl, {
    headers: {
      "User-Agent": "Cloudflare-Worker-gemini-git-bridge",
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github.raw+json"
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch file "${path}" from "${owner}/${repo}" on branch "${branch}": HTTP ${res.status}`);
  }
  return await res.text();
}
async function fetchMultipleFilesViaGraphQL(arg1, arg2, arg3, arg4, arg5) {
  let owner;
  let repo;
  let branch;
  let paths;
  let token;
  if (typeof arg1 === "object" && arg1 !== null) {
    const parsed = parseRepoOwner(arg1.repo);
    owner = parsed.owner;
    repo = parsed.repo;
    branch = arg1.branch;
    paths = arg1.paths;
    token = arg1.token;
  } else if (Array.isArray(arg3) && typeof arg4 === "string") {
    const parsed = parseRepoOwner(arg1);
    owner = parsed.owner;
    repo = parsed.repo;
    branch = arg2;
    paths = arg3;
    token = arg4;
  } else {
    owner = arg1;
    repo = arg2;
    branch = arg3;
    paths = arg4;
    token = arg5;
  }
  const uniquePaths = Array.from(new Set(paths));
  const result = {};
  if (uniquePaths.length === 0) {
    return result;
  }
  const varDefs = ["$owner: String!", "$repo: String!"];
  const fields = [];
  const variables = { owner, repo };
  uniquePaths.forEach((p, idx) => {
    const varName = `exp_${idx}`;
    varDefs.push(`$${varName}: String!`);
    variables[varName] = `${branch}:${p}`;
    fields.push(`
      f${idx}: object(expression: $${varName}) {
        ... on Blob {
          text
          isTruncated
        }
      }
    `);
  });
  const query = `
    query BatchGetFileBlobs(${varDefs.join(", ")}) {
      repository(owner: $owner, name: $repo) {
        ${fields.join("\n")}
      }
    }
  `;
  const data = await executeGraphQL(query, variables, token);
  const repoObj = data?.repository;
  if (!repoObj) {
    throw new Error(`Repository "${owner}/${repo}" was not found or is not accessible.`);
  }
  for (let idx = 0; idx < uniquePaths.length; idx++) {
    const p = uniquePaths[idx];
    const blob = repoObj[`f${idx}`];
    if (!blob) {
      result[p] = null;
    } else if (blob.isTruncated) {
      result[p] = await fetchFileContent(owner, repo, branch, p, token);
    } else {
      result[p] = typeof blob.text === "string" ? blob.text : null;
    }
  }
  return result;
}
async function createCommitOnBranch(owner, repo, branch, expectedHeadOid, message, additions, deletions, token) {
  const mutation = `
    mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          url
          messageHeadline
        }
      }
    }
  `;
  const headline = message.split("\n")[0].trim();
  const body = message.includes("\n") ? message.split("\n").slice(1).join("\n").trim() : void 0;
  const fileChanges = {};
  if (additions.length > 0) {
    fileChanges.additions = additions;
  }
  if (deletions.length > 0) {
    fileChanges.deletions = deletions;
  }
  const cleanBranch = branch.replace(/^refs\/heads\//, "");
  const variables = {
    input: {
      branch: {
        repositoryNameWithOwner: `${owner}/${repo}`,
        branchName: cleanBranch
      },
      expectedHeadOid,
      message: {
        headline,
        body: body || null
      },
      fileChanges
    }
  };
  const data = await executeGraphQL(mutation, variables, token);
  const commit = data?.createCommitOnBranch?.commit;
  if (!commit?.oid) {
    throw new Error("createCommitOnBranch did not return commit information.");
  }
  return {
    oid: commit.oid,
    url: commit.url,
    messageHeadline: commit.messageHeadline
  };
}
async function commitSingleFileViaGraphQL(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
  if (typeof arg1 === "object" && arg1 !== null) {
    const { owner: owner2, repo: repo2 } = parseRepoOwner(arg1.repo);
    const encoded2 = utf8ToBase64(arg1.content);
    return createCommitOnBranch(
      owner2,
      repo2,
      arg1.branch,
      arg1.expectedHeadOid,
      arg1.commitMessage,
      [{ path: arg1.path, contents: encoded2 }],
      [],
      arg1.token
    );
  }
  if (typeof arg8 === "string") {
    const encoded2 = utf8ToBase64(arg6);
    return createCommitOnBranch(
      arg1,
      arg2,
      arg3,
      arg4,
      arg7,
      [{ path: arg5, contents: encoded2 }],
      [],
      arg8
    );
  }
  const { owner, repo } = parseRepoOwner(arg1);
  const encoded = utf8ToBase64(arg5);
  return createCommitOnBranch(
    owner,
    repo,
    arg2,
    arg3,
    arg6,
    [{ path: arg4, contents: encoded }],
    [],
    arg7
  );
}

// packages/edge-worker/src/modules/syntaxScanner.ts
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
      const regexPreceders = "=([{:;,?!&|+-*^~<>%return\n";
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

// packages/edge-worker/src/modules/linter.ts
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

// packages/edge-worker/src/modules/patchInMemory.ts
function checkPlaceholderErrors2(content, filePath) {
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
function runBuiltinPreflightRules2(files, preflight) {
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
      const phErrors = checkPlaceholderErrors2(op.fullContent, op.path);
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
        const phErrors = checkPlaceholderErrors2(op.fullContent, op.path);
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
          message: "Target file does not exist on branch"
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
        const phErrors = checkPlaceholderErrors2(block.replace, op.path);
        if (phErrors.length > 0) {
          errors.push(...phErrors);
          hasError = true;
        }
        try {
          currentContent = applySearchReplace(currentContent, block.search, block.replace, op.path);
        } catch (err) {
          errors.push({
            file: op.path,
            stage: "SEARCH_REPLACE",
            message: err.message,
            codeSnippet: block.search.slice(0, 200)
          });
          hasError = true;
        }
      }
      const finalPhErrors = checkPlaceholderErrors2(currentContent, op.path);
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
  const builtinErrors = runBuiltinPreflightRules2(resultingFiles, preflight);
  if (builtinErrors.length > 0) {
    errors.push(...builtinErrors);
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

// packages/edge-worker/src/modules/patcher.ts
var LLM_PLACEHOLDER_PATTERNS = [
  /\/\/\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i,
  /#\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}/i,
  /\/\*\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}\s*\*\//i,
  /<!--\s*\.{3,}\s*(?:existing|rest of|remaining|other)?\s*code\s*\.{0,3}\s*-->/i,
  /\.{3,}\s*(?:existing|rest of)\s*code\s*\.{3,}/i,
  /\/\/\s*\.{3,}\s*$/m
];
function validateNoPlaceholders(content, filePath) {
  for (const pattern of LLM_PLACEHOLDER_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(
        `Hard Guardrail Rejection: File "${filePath}" contains forbidden LLM placeholder text (e.g. "// ... existing code ..."). Commit rejected to prevent accidental code truncation.`
      );
    }
  }
}
function checkPlaceholderErrors(content, filePath) {
  return checkPlaceholderErrors2(content, filePath);
}
function runBuiltinPreflightRules(files, preflight) {
  return runBuiltinPreflightRules2(files, preflight);
}
function parseSearchReplaceBlocks(text) {
  const blocks = [];
  const regex = /<{5,9}\s*(?:SEARCH|ORIGINAL|HEAD)?\r?\n([\s\S]*?)\r?\n={5,9}\r?\n([\s\S]*?)\r?\n>{5,9}\s*(?:REPLACE|MODIFIED|UPDATED)?/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      search: match[1],
      replace: match[2]
    });
  }
  return blocks;
}
function applySearchReplace(original, search, replace, filePath = "") {
  if (original.includes(search)) {
    return original.replace(search, replace);
  }
  const normOriginal = original.replace(/\r\n/g, "\n");
  const normSearch = search.replace(/\r\n/g, "\n");
  const normReplace = replace.replace(/\r\n/g, "\n");
  if (normOriginal.includes(normSearch)) {
    const updated = normOriginal.replace(normSearch, normReplace);
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
async function applyPatchesInMemory2(patches, existingFiles, preflight, preflightHook = runPreflightLinter) {
  return applyPatchesInMemory(patches, existingFiles, preflight, preflightHook);
}
async function handlePatchRequest(req, githubToken, preflightHook = runPreflightLinter) {
  if (!req.repo || !req.branch || !req.expectedHeadOid || !req.payload?.patches) {
    return {
      status: "ERROR",
      errorMessage: 'Missing required fields: "repo", "branch", "expectedHeadOid", and "payload.patches" must be specified.'
    };
  }
  let owner = "";
  let repo = "";
  try {
    const parsed = parseRepoOwner(req.repo);
    owner = parsed.owner;
    repo = parsed.repo;
  } catch (err) {
    return {
      status: "ERROR",
      errorMessage: err.message || "Invalid repository format"
    };
  }
  const requestedBranch = req.branch.trim();
  let currentHeadOid = "";
  let resolvedBranch = requestedBranch;
  try {
    const branchInfo = await getBranchHeadOid(owner, repo, requestedBranch, githubToken);
    currentHeadOid = branchInfo.headOid;
    resolvedBranch = branchInfo.resolvedBranch;
  } catch (err) {
    return {
      status: "ERROR",
      errorMessage: `Failed to resolve branch "${requestedBranch}": ${err.message}`
    };
  }
  if (currentHeadOid !== req.expectedHeadOid) {
    return {
      status: "GIT_CONFLICT",
      newHeadOid: currentHeadOid,
      errorMessage: `Expected HEAD "${req.expectedHeadOid}" but branch "${resolvedBranch}" is at "${currentHeadOid}". Fetch the latest repo-mix.xml and retry.`
    };
  }
  const allTargetPaths = Array.from(new Set(req.payload.patches.map((p) => p.path)));
  let existingFiles = {};
  try {
    existingFiles = await fetchMultipleFilesViaGraphQL(owner, repo, resolvedBranch, allTargetPaths, githubToken);
  } catch (err) {
    return {
      status: "ERROR",
      errorMessage: `Batch fetch failed for target files: ${err.message}`
    };
  }
  const patchResult = await applyPatchesInMemory2(
    req.payload.patches,
    existingFiles,
    req.payload.preflight,
    preflightHook
  );
  if (patchResult.errors.length > 0) {
    return {
      status: "PREFLIGHT_FAILED",
      errors: patchResult.errors
    };
  }
  if (!patchResult.hasEffectiveChanges) {
    return {
      status: "NO_CHANGES_NEEDED",
      newHeadOid: currentHeadOid
    };
  }
  const encodedAdditions = patchResult.additions.map((a) => ({
    path: a.path,
    contents: utf8ToBase64(a.content)
  }));
  try {
    const commitResult = await createCommitOnBranch(
      owner,
      repo,
      resolvedBranch,
      req.expectedHeadOid,
      req.payload.commitMessage || "chore: apply patches via gemini-git-bridge",
      encodedAdditions,
      patchResult.deletions,
      githubToken
    );
    return {
      status: "COMMITTED",
      newHeadOid: commitResult.oid,
      commitUrl: commitResult.url
    };
  } catch (err) {
    const errMsg = err.message || "";
    if (errMsg.includes("expectedHeadOid") || errMsg.includes("conflict") || errMsg.includes("stale") || errMsg.includes("HEAD")) {
      const latestHead = await getBranchHeadOid(owner, repo, resolvedBranch, githubToken).catch(() => ({
        headOid: currentHeadOid
      }));
      return {
        status: "GIT_CONFLICT",
        newHeadOid: latestHead.headOid,
        errorMessage: errMsg
      };
    }
    return {
      status: "ERROR",
      errorMessage: `Commit execution failed: ${errMsg}`
    };
  }
}
async function resolveFileContent(fileInput, existingContentFetcher) {
  const patchesToApply = [];
  if (typeof fileInput.search === "string" && typeof fileInput.replace === "string") {
    patchesToApply.push({ search: fileInput.search, replace: fileInput.replace });
  }
  if (Array.isArray(fileInput.patches)) {
    for (const p of fileInput.patches) {
      if (typeof p.search === "string" && typeof p.replace === "string") {
        patchesToApply.push(p);
      }
    }
  }
  const diffToCheck = fileInput.diff || fileInput.content || "";
  if (diffToCheck.includes("<<<<<<<") || diffToCheck.includes("=====")) {
    const parsed = parseSearchReplaceBlocks(diffToCheck);
    patchesToApply.push(...parsed);
  }
  if (patchesToApply.length === 0) {
    if (typeof fileInput.content === "string") {
      validateNoPlaceholders(fileInput.content, fileInput.path);
      return fileInput.content;
    }
    throw new Error(`File change for "${fileInput.path}" must provide either "content" or search/replace patches.`);
  }
  for (const patch of patchesToApply) {
    validateNoPlaceholders(patch.replace, fileInput.path);
  }
  const existingContent = await existingContentFetcher(fileInput.path);
  let resolved = existingContent;
  for (const patch of patchesToApply) {
    resolved = applySearchReplace(resolved, patch.search, patch.replace, fileInput.path);
  }
  validateNoPlaceholders(resolved, fileInput.path);
  return resolved;
}

// packages/edge-worker/src/utils/tarUtils.ts
function concatBuffers(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
function parseAsciiString(buffer, start, length) {
  let end = start;
  const limit = start + length;
  while (end < limit && buffer[end] !== 0) {
    end++;
  }
  let str = "";
  for (let i = start; i < end; i++) {
    str += String.fromCharCode(buffer[i]);
  }
  return str.trim();
}
function parseOctal(buffer, start, length) {
  const raw = parseAsciiString(buffer, start, length);
  if (!raw) return 0;
  const parsed = parseInt(raw, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// packages/edge-worker/src/modules/mixChunker.ts
var DEFAULT_MAX_CHUNK_BYTES = 512 * 1024;
var DEFAULT_MAX_CHUNK_TOKENS = 125e3;
function buildChunkedMixXml(input) {
  const {
    owner,
    repo,
    branch,
    headOid,
    fileTreeEntries,
    files,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    splitOutput
  } = input;
  const sortedTree = [...fileTreeEntries].sort();
  const fileTreeXml = sortedTree.join("\n");
  let totalRawSize = fileTreeXml.length + 200;
  for (const f of files) {
    totalRawSize += f.path.length + f.content.length + 60;
  }
  const totalEstimatedTokens = Math.ceil(totalRawSize / 4);
  const shouldSplit = splitOutput === true || splitOutput !== false && files.length > 1 && (totalRawSize > maxChunkBytes || totalEstimatedTokens > maxChunkTokens);
  if (!shouldSplit || files.length <= 1) {
    const filesXml = files.map((f) => `  <file path="${f.path}"><![CDATA[${escapeCdata(f.content)}]]></file>`).join("\n");
    const singleXml = [
      `<repository repo="${owner}/${repo}" branch="${branch}" headOid="${headOid}">`,
      `<file_tree>`,
      fileTreeXml,
      `</file_tree>`,
      `<files>`,
      filesXml,
      `</files>`,
      `</repository>`
    ].join("\n");
    return {
      xmlContent: singleXml,
      isChunked: false,
      stats: {
        fileCount: files.length,
        estimatedTokens: Math.ceil(singleXml.length / 4)
      }
    };
  }
  const chunkBuckets = [];
  let currentBucket = [];
  let currentBucketBytes = fileTreeXml.length + 300;
  for (const f of files) {
    const fileXmlSize = f.path.length + f.content.length + 60;
    const estimatedFileTokens = Math.ceil(fileXmlSize / 4);
    if (currentBucket.length > 0 && (currentBucketBytes + fileXmlSize > maxChunkBytes || Math.ceil((currentBucketBytes + fileXmlSize) / 4) > maxChunkTokens)) {
      chunkBuckets.push(currentBucket);
      currentBucket = [];
      currentBucketBytes = fileTreeXml.length + 300;
    }
    currentBucket.push(f);
    currentBucketBytes += fileXmlSize;
  }
  if (currentBucket.length > 0) {
    chunkBuckets.push(currentBucket);
  }
  const totalParts = chunkBuckets.length;
  const parts = [];
  for (let i = 0; i < totalParts; i++) {
    const bucket = chunkBuckets[i];
    const partNum = i + 1;
    const filesXml = bucket.map((f) => `  <file path="${f.path}"><![CDATA[${escapeCdata(f.content)}]]></file>`).join("\n");
    const partXml = [
      `<repository repo="${owner}/${repo}" branch="${branch}" headOid="${headOid}" part="${partNum}" totalParts="${totalParts}">`,
      `<file_tree>`,
      fileTreeXml,
      `</file_tree>`,
      `<files>`,
      filesXml,
      `</files>`,
      `</repository>`
    ].join("\n");
    parts.push({
      partIndex: partNum,
      totalParts,
      fileName: `repo-mix.part${partNum}.xml`,
      xmlContent: partXml,
      stats: {
        fileCount: bucket.length,
        estimatedTokens: Math.ceil(partXml.length / 4)
      }
    });
  }
  return {
    xmlContent: parts[0].xmlContent,
    parts,
    isChunked: true,
    stats: {
      fileCount: files.length,
      estimatedTokens: totalEstimatedTokens
    }
  };
}

// packages/edge-worker/src/modules/mixer.ts
function escapeCdata(content) {
  return content.replace(/\]\]>/g, "]]]]><![CDATA[>");
}
function shouldSkipTarEntry(relPath, size, typeflag, includePaths) {
  if (typeflag === "5" || typeflag === "g" || typeflag === "x" || relPath.endsWith("/") || typeflag !== "0" && typeflag !== "" && typeflag !== "\0") {
    return { skip: true, reason: "DIR_OR_NON_FILE" };
  }
  const normalized = relPath.replace(/^\.?\/+/, "");
  if (!normalized) {
    return { skip: true, reason: "DIR_OR_NON_FILE" };
  }
  const segments = normalized.split("/");
  const filename = segments[segments.length - 1];
  const ignoredDirNames = /* @__PURE__ */ new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".wrangler",
    ".turbo",
    ".next",
    "coverage",
    "_v1_backup",
    "backup_unused"
  ]);
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (ignoredDirNames.has(seg) || seg.startsWith("repomix_")) {
      return { skip: true, reason: "IGNORED_PATH" };
    }
  }
  const ignoredFiles = /* @__PURE__ */ new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb"
  ]);
  if (ignoredFiles.has(filename) || filename.endsWith(".bundle") || filename.startsWith("repomix-output") || /.*-bundle.*\.txt$/i.test(filename)) {
    return { skip: true, reason: "IGNORED_PATH" };
  }
  const ignoredExtensions = /* @__PURE__ */ new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".ico",
    ".svg",
    ".mp4",
    ".webm",
    ".mov",
    ".mp3",
    ".wav",
    ".ogg",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    ".wasm",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".pyc"
  ]);
  const extMatch = filename.match(/\.[a-zA-Z0-9]+$/);
  if (extMatch && ignoredExtensions.has(extMatch[0].toLowerCase())) {
    return { skip: true, reason: "IGNORED_PATH" };
  }
  if (includePaths && includePaths.length > 0) {
    const normalizedIncludes = includePaths.map((p) => p.replace(/^\.?\/+/, ""));
    const isIncluded = normalizedIncludes.some((prefix) => normalized.startsWith(prefix));
    if (!isIncluded) {
      return { skip: true, reason: "NOT_INCLUDED" };
    }
  }
  if (size > 524288) {
    return { skip: true, reason: "OVERSIZED" };
  }
  return { skip: false };
}
function extractHeadOidFromPaxHeader(paxText) {
  const match = paxText.match(/(?:^|\n)(?:\d+\s+)?comment=([0-9a-fA-F]{40})(?:\r?\n|$)/);
  if (match) {
    return match[1].toLowerCase();
  }
  const directMatch = paxText.match(/\b([0-9a-fA-F]{40})\b/);
  if (directMatch) {
    return directMatch[1].toLowerCase();
  }
  return null;
}
async function handleMixRequest(req, githubToken) {
  let owner = "";
  let repo = "";
  try {
    const parsed = parseRepoOwner(req.repo);
    owner = parsed.owner;
    repo = parsed.repo;
  } catch (err) {
    return {
      status: "ERROR",
      headOid: "",
      xmlContent: "",
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: err.message || "Invalid repository format"
    };
  }
  const resolvedBranch = (req.branch || "main").trim();
  const tarUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(resolvedBranch)}`;
  const res = await fetch(tarUrl, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Cloudflare-Worker-gemini-git-bridge"
    }
  });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    return {
      status: "ERROR",
      headOid: "",
      xmlContent: "",
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: `GitHub tarball fetch failed with HTTP ${res.status} (${res.statusText}): ${errorBody}`
    };
  }
  if (!res.body) {
    return {
      status: "ERROR",
      headOid: "",
      xmlContent: "",
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: "GitHub tarball response body is empty"
    };
  }
  const decompressedStream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressedStream.getReader();
  let buffer = new Uint8Array(0);
  let eof = false;
  let consecutiveZeroBlocks = 0;
  let headOid = null;
  let nextPaxPath = null;
  const fileTreeEntries = [];
  const files = [];
  const textDecoder = new TextDecoder();
  async function ensureBytes(count) {
    while (buffer.length < count) {
      const { value, done } = await reader.read();
      if (done || !value) {
        eof = true;
        return false;
      }
      buffer = concatBuffers(buffer, value);
    }
    return true;
  }
  async function discardBytes(count) {
    if (buffer.length >= count) {
      buffer = buffer.subarray(count);
      return;
    }
    let remaining = count - buffer.length;
    buffer = new Uint8Array(0);
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done || !value) {
        eof = true;
        return;
      }
      if (value.length <= remaining) {
        remaining -= value.length;
      } else {
        buffer = value.subarray(remaining);
        remaining = 0;
      }
    }
  }
  try {
    while (!eof) {
      const hasHeader = await ensureBytes(512);
      if (!hasHeader && buffer.length < 512) {
        break;
      }
      const header = buffer.subarray(0, 512);
      let isZero = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) {
          isZero = false;
          break;
        }
      }
      if (isZero) {
        consecutiveZeroBlocks++;
        buffer = buffer.subarray(512);
        if (consecutiveZeroBlocks >= 2) {
          break;
        }
        continue;
      }
      consecutiveZeroBlocks = 0;
      const name = parseAsciiString(header, 0, 100);
      const size = parseOctal(header, 124, 12);
      const typeflagRaw = header[156];
      const typeflag = typeflagRaw === 0 || typeflagRaw === 32 ? "0" : String.fromCharCode(typeflagRaw);
      const prefix = parseAsciiString(header, 345, 155);
      const paddedSize = Math.ceil(size / 512) * 512;
      buffer = buffer.subarray(512);
      if (typeflag === "g") {
        await ensureBytes(paddedSize);
        const payloadBytes = buffer.subarray(0, size);
        buffer = buffer.subarray(paddedSize);
        const paxText = textDecoder.decode(payloadBytes);
        const extracted = extractHeadOidFromPaxHeader(paxText);
        if (extracted) {
          headOid = extracted;
        }
        continue;
      }
      if (typeflag === "x") {
        await ensureBytes(paddedSize);
        const payloadBytes = buffer.subarray(0, size);
        buffer = buffer.subarray(paddedSize);
        const paxText = textDecoder.decode(payloadBytes);
        const match = paxText.match(/(?:^|\n)\d+\s+path=(.+?)(?:\r?\n|$)/);
        if (match) {
          nextPaxPath = match[1].trim();
        }
        continue;
      }
      const rawEntryPath = nextPaxPath || (prefix ? `${prefix}/${name}` : name);
      nextPaxPath = null;
      const slashIndex = rawEntryPath.indexOf("/");
      if (slashIndex === -1) {
        await discardBytes(paddedSize);
        continue;
      }
      const rootPrefix = rawEntryPath.slice(0, slashIndex);
      const relPath = rawEntryPath.slice(slashIndex + 1);
      if (!headOid) {
        const rootMatch = rootPrefix.match(/-([0-9a-fA-F]{40})$/);
        if (rootMatch) {
          headOid = rootMatch[1].toLowerCase();
        }
      }
      if (!relPath || relPath.endsWith("/")) {
        await discardBytes(paddedSize);
        continue;
      }
      const filterDecision = shouldSkipTarEntry(relPath, size, typeflag, req.includePaths);
      if (filterDecision.skip) {
        if (filterDecision.reason === "OVERSIZED") {
          fileTreeEntries.push(`${relPath} [SKIPPED: >512KB]`);
        }
        await discardBytes(paddedSize);
        continue;
      }
      await ensureBytes(paddedSize);
      const fileBytes = buffer.subarray(0, size);
      buffer = buffer.subarray(paddedSize);
      const content = textDecoder.decode(fileBytes);
      if (content.includes("\0")) {
        continue;
      }
      fileTreeEntries.push(relPath);
      files.push({ path: relPath, content });
    }
  } catch (err) {
    return {
      status: "ERROR",
      headOid: headOid || "",
      xmlContent: "",
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: `Error processing tarball stream: ${err.message}`
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
  if (!headOid || !/^[0-9a-fA-F]{40}$/.test(headOid)) {
    try {
      const branchInfo = await getBranchHeadOid(owner, repo, resolvedBranch, githubToken);
      headOid = branchInfo.headOid;
    } catch (err) {
      return {
        status: "ERROR",
        headOid: "",
        xmlContent: "",
        stats: { fileCount: 0, estimatedTokens: 0 },
        errorMessage: `Failed to resolve 40-character HEAD commit OID: ${err.message}`
      };
    }
  }
  const mixResult = buildChunkedMixXml({
    owner,
    repo,
    branch: resolvedBranch,
    headOid,
    fileTreeEntries,
    files,
    maxChunkBytes: req.maxChunkBytes,
    maxChunkTokens: req.maxChunkTokens,
    splitOutput: req.splitOutput
  });
  let persistedCommitOid;
  if (req.persistToGitHub === true) {
    try {
      const commitRes = await commitSingleFileViaGraphQL({
        repo: `${owner}/${repo}`,
        branch: resolvedBranch,
        expectedHeadOid: headOid,
        path: "_context/repo-mix.xml",
        content: mixResult.xmlContent,
        commitMessage: "chore(context): update repo-mix.xml snapshot",
        token: githubToken
      });
      persistedCommitOid = commitRes.oid;
      headOid = commitRes.oid;
    } catch (err) {
      return {
        status: "ERROR",
        headOid,
        xmlContent: mixResult.xmlContent,
        parts: mixResult.parts,
        isChunked: mixResult.isChunked,
        stats: mixResult.stats,
        errorMessage: `Failed to persist repo-mix.xml snapshot to GitHub: ${err.message}`
      };
    }
  }
  return {
    status: "OK",
    headOid,
    xmlContent: mixResult.xmlContent,
    parts: mixResult.parts,
    isChunked: mixResult.isChunked,
    stats: mixResult.stats,
    ...persistedCommitOid ? { persistedCommitOid } : {}
  };
}

// packages/edge-worker/src/modules/webhookHandler.ts
async function verifyGithubWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) {
    return false;
  }
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const hex = signatureHeader.slice(7).trim();
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    return false;
  }
  const sigBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sigBytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  const enc = new TextEncoder();
  const keyData = enc.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const data = typeof rawBody === "string" ? enc.encode(rawBody) : new Uint8Array(rawBody);
  return await crypto.subtle.verify("HMAC", key, sigBytes, data);
}
async function postGithubComment(commentsUrl, body, token) {
  try {
    const res = await fetch(commentsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "gemini-git-bridge/2.0.0"
      },
      body: JSON.stringify({ body })
    });
    return res.ok;
  } catch {
    return false;
  }
}
function extractPatchPayload(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const rawJson = match && match[1] ? match[1].trim() : text.trim();
  return JSON.parse(rawJson);
}
async function executeWorkerWorkflow(payload, env) {
  const repo = payload.repository?.full_name;
  if (!repo) {
    return { mode: "worker", status: "ERROR", message: "Missing repository in payload" };
  }
  const branch = payload.pull_request?.head?.ref || payload.repository?.default_branch || "main";
  const rawComment = payload.comment?.body || payload.issue?.body || payload.pull_request?.body || "";
  const prompt = rawComment.replace(/@gemini\b/gi, "").trim();
  if (!prompt) {
    return { mode: "worker", status: "ERROR", message: "No instruction prompt found after @gemini mention" };
  }
  const githubToken = env.GITHUB_PAT || env.GITHUB_TOKEN;
  if (!githubToken) {
    return { mode: "worker", status: "ERROR", message: "GITHUB_PAT / GITHUB_TOKEN not configured in Worker environment" };
  }
  const commentsUrl = payload.issue?.comments_url || payload.pull_request?.comments_url;
  try {
    const mixResult = await handleMixRequest({ repo, branch }, githubToken);
    if (mixResult.status !== "OK") {
      const err = mixResult.errorMessage || "Failed to assemble repository context";
      if (commentsUrl) {
        await postGithubComment(commentsUrl, `\u274C **Gemini Bridge Error:** Failed to mix repository context: ${err}`, githubToken);
      }
      return { mode: "worker", status: "ERROR", message: err };
    }
    const geminiApiKey = env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      const err = "GEMINI_API_KEY not configured in Worker environment";
      if (commentsUrl) {
        await postGithubComment(commentsUrl, `\u274C **Gemini Bridge Error:** ${err}`, githubToken);
      }
      return { mode: "worker", status: "ERROR", message: err };
    }
    const systemPrompt = `You are an automated Git patch assistant.
Given a repository XML context and an issue prompt, return ONLY a valid JSON object strictly conforming to the GeminiPatchPayload schema.
Do NOT output markdown fences or additional text.`;
    const userQuery = `Task Instruction:
${prompt}

Repository Context:
${mixResult.xmlContent}`;
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${systemPrompt}

${userQuery}` }]
            }
          ]
        })
      }
    );
    if (!geminiRes.ok) {
      const statusText = await geminiRes.text();
      const err = `Gemini API call failed (${geminiRes.status}): ${statusText}`;
      if (commentsUrl) {
        await postGithubComment(commentsUrl, `\u274C **Gemini Bridge Error:** ${err}`, githubToken);
      }
      return { mode: "worker", status: "ERROR", message: err };
    }
    const geminiData = await geminiRes.json();
    const candidateText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const patchPayload = extractPatchPayload(candidateText);
    const patchResponse = await handlePatchRequest(
      {
        repo,
        branch,
        expectedHeadOid: mixResult.headOid,
        payload: patchPayload
      },
      githubToken
    );
    if (commentsUrl) {
      if (patchResponse.status === "COMMITTED") {
        const msg = `\u2705 **Gemini Bridge applied patch successfully!**

- Commit: \`${patchResponse.newHeadOid}\`
- Headline: ${patchPayload.commitMessage}`;
        await postGithubComment(commentsUrl, msg, githubToken);
      } else if (patchResponse.status === "PREFLIGHT_FAILED") {
        const errorList = (patchResponse.errors || []).map((e) => `- [${e.stage}] \`${e.file}:${e.line || 1}\` ${e.message}`).join("\n");
        const msg = `\u274C **Gemini Bridge Preflight Linter Failed:**

${errorList}`;
        await postGithubComment(commentsUrl, msg, githubToken);
      } else {
        const msg = `\u26A0\uFE0F **Gemini Bridge Patch Result:** ${patchResponse.status}
${patchResponse.errorMessage || ""}`;
        await postGithubComment(commentsUrl, msg, githubToken);
      }
    }
    return {
      mode: "worker",
      status: patchResponse.status === "COMMITTED" ? "SUCCESS" : patchResponse.status === "PREFLIGHT_FAILED" ? "PREFLIGHT_FAILED" : "ERROR",
      commitSha: patchResponse.newHeadOid,
      errors: patchResponse.errors,
      message: patchResponse.errorMessage
    };
  } catch (err) {
    if (commentsUrl) {
      await postGithubComment(commentsUrl, `\u{1F4A5} **Gemini Bridge Execution Exception:** ${err.message}`, githubToken);
    }
    return { mode: "worker", status: "ERROR", message: err.message, errors: [err] };
  }
}
async function handleGithubWebhookRequest(request, env, ctx) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const secret = env.GITHUB_WEBHOOK_SECRET || env.WORKER_SECRET || env.BRIDGE_SECRET || "";
  const isValid = await verifyGithubWebhookSignature(rawBody, signatureHeader, secret);
  if (!isValid) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized: Invalid GitHub webhook HMAC signature" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Malformed JSON payload" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const commentText = payload.comment?.body || payload.issue?.body || payload.pull_request?.body || "";
  const hasGeminiMention = /@gemini\b/i.test(commentText);
  if (!hasGeminiMention) {
    return new Response(
      JSON.stringify({ status: "IGNORED", message: "No @gemini trigger found in payload" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  const workflowPromise = executeWorkerWorkflow(payload, env).catch((err) => {
    console.error("[webhookHandler] Background workflow unhandled error:", err);
  });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(workflowPromise);
  }
  return new Response(
    JSON.stringify({
      status: "ACCEPTED",
      message: "Webhook received, signature verified, and execution scheduled."
    }),
    { status: 202, headers: { "Content-Type": "application/json" } }
  );
}

// packages/edge-worker/src/index.ts
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bridge-secret",
  "Access-Control-Max-Age": "86400"
};
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    }
  });
}
function errorResponse(message, status = 400, details) {
  return jsonResponse({
    success: false,
    error: message,
    ...details ? { details } : {}
  }, status);
}
function resolveSecret(env) {
  return env.WORKER_SECRET || env.BRIDGE_SECRET || "";
}
function resolveGithubToken(env) {
  return env.GITHUB_PAT || env.GITHUB_TOKEN || "";
}
function verifyAuth(request, env) {
  const secret = resolveSecret(env);
  if (!secret) {
    return false;
  }
  const customHeader = request.headers.get("x-bridge-secret");
  if (customHeader && customHeader === secret) {
    return true;
  }
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token === secret) {
      return true;
    }
  }
  return false;
}
var index_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return jsonResponse({
        status: "ok",
        service: "gemini-git-bridge",
        version: "2.0.0",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        hasBridgeSecret: Boolean(resolveSecret(env)),
        hasGithubToken: Boolean(resolveGithubToken(env))
      });
    }
    if (path === "/api/webhook/github") {
      return handleGithubWebhookRequest(request, env, ctx);
    }
    if (!verifyAuth(request, env)) {
      return errorResponse("Unauthorized: Invalid or missing WORKER_SECRET / BRIDGE_SECRET in Authorization or x-bridge-secret header", 401);
    }
    const githubToken = resolveGithubToken(env);
    if (!githubToken) {
      return errorResponse("Server configuration error: GITHUB_PAT / GITHUB_TOKEN secret is not set in Worker environment.", 500);
    }
    try {
      if (request.method === "POST" && (path === "/push" || path === "/commit" || path === "/api/commit" || path === "/")) {
        const body = await request.json().catch(() => {
          throw new Error("Malformed JSON payload");
        });
        let owner = "";
        let repo = "";
        try {
          const parsed = parseRepoOwner(body.repo || "", body.owner);
          owner = parsed.owner;
          repo = parsed.repo;
        } catch {
          return errorResponse('Missing required fields: Repository must be specified as "owner/repo" or separate "owner" and "repo".');
        }
        const commitMessage = body.commitMessage || body.message;
        if (!commitMessage) {
          return errorResponse('Missing required field: "commitMessage" (or "message") must be specified.');
        }
        const targetBranch = body.targetBranch || body.branch || "main";
        const fileChanges = body.changes || body.files || [];
        const deletions = body.deletions || [];
        if (fileChanges.length === 0 && deletions.length === 0) {
          return errorResponse('Commit must include at least one entry in "changes" or "files" or "deletions".');
        }
        const { headOid, resolvedBranch } = await getBranchHeadOid(owner, repo, targetBranch, githubToken);
        const additions = [];
        for (const fileInput of fileChanges) {
          if (!fileInput.path) {
            throw new Error('Every file entry must contain a "path" property.');
          }
          const contentFetcher = async (filePath) => {
            return await fetchFileContent(owner, repo, resolvedBranch, filePath, githubToken);
          };
          const resolvedText = await resolveFileContent(fileInput, contentFetcher);
          const encodedBase64 = utf8ToBase64(resolvedText);
          additions.push({
            path: fileInput.path,
            contents: encodedBase64
          });
        }
        const formattedDeletions = deletions.map((del) => {
          return typeof del === "string" ? { path: del } : { path: del.path };
        });
        const commitResult = await createCommitOnBranch(
          owner,
          repo,
          resolvedBranch,
          headOid,
          commitMessage,
          additions,
          formattedDeletions,
          githubToken
        );
        return jsonResponse({
          success: true,
          commit: commitResult,
          branch: resolvedBranch,
          repository: `${owner}/${repo}`,
          filesChanged: additions.length + formattedDeletions.length
        });
      }
      if (request.method === "POST" && path === "/api/mix") {
        const body = await request.json().catch(() => {
          throw new Error("Malformed JSON payload");
        });
        const mixResult = await handleMixRequest(body, githubToken);
        return jsonResponse(mixResult, mixResult.status === "OK" ? 200 : 400);
      }
      if (request.method === "POST" && path === "/api/patch") {
        const body = await request.json().catch(() => {
          throw new Error("Malformed JSON payload");
        });
        const patchResult = await handlePatchRequest(body, githubToken);
        return jsonResponse(patchResult, patchResult.status === "ERROR" ? 400 : 200);
      }
      if (request.method === "POST" && path === "/graphql") {
        const body = await request.json().catch(() => {
          throw new Error("Malformed JSON payload");
        });
        if (!body.query) {
          return errorResponse('Missing required field: "query" in GraphQL request.');
        }
        const result = await executeGraphQL(body.query, body.variables || {}, githubToken);
        return jsonResponse({ success: true, data: result });
      }
      return errorResponse(`Endpoint not found: ${request.method} ${path}`, 404);
    } catch (err) {
      console.error("Request processing error:", err);
      return errorResponse(err.message || "Internal server error", 500, {
        stack: err.stack
      });
    }
  }
};
export {
  index_default as default,
  errorResponse,
  jsonResponse,
  resolveGithubToken,
  resolveSecret,
  verifyAuth
};
