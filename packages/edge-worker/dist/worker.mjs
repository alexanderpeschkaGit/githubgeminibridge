// src/utils/encoding.ts
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

// src/utils/githubRepo.ts
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

// src/utils/githubGraphQL.ts
var GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
var BranchNotFoundError = class extends Error {
  constructor(owner, repo, branch) {
    super(`Branch "${branch}" was not found in repository "${owner}/${repo}".`);
    this.name = "BranchNotFoundError";
  }
};
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
        id
        ref(qualifiedName: $branch) { name target { oid } }
        defaultBranchRef { name target { oid } }
      }
    }
  `;
  const data = await executeGraphQL(query, { owner, repo, branch: qualifiedBranch }, token);
  const repository = data?.repository;
  if (!repository) {
    throw new Error(`Repository "${owner}/${repo}" was not found or is not accessible with the provided token.`);
  }
  if (repository.ref?.target?.oid) {
    return { headOid: repository.ref.target.oid, resolvedBranch: repository.ref.name, repositoryId: repository.id };
  }
  if (!branch && repository.defaultBranchRef?.target?.oid) {
    return { headOid: repository.defaultBranchRef.target.oid, resolvedBranch: repository.defaultBranchRef.name, repositoryId: repository.id };
  }
  throw new BranchNotFoundError(owner, repo, branch || qualifiedBranch);
}
async function createBranchRef(owner, repo, branchName, oid, token, repositoryId) {
  const cleanBranch = branchName.replace(/^refs\/heads\//, "");
  const qualifiedName = `refs/heads/${cleanBranch}`;
  if (repositoryId) {
    const mutation = `
      mutation CreateRef($input: CreateRefInput!) {
        createRef(input: $input) { ref { name target { oid } } }
      }
    `;
    try {
      const data = await executeGraphQL(mutation, { input: { repositoryId, name: qualifiedName, oid } }, token);
      const ref = data?.createRef?.ref;
      if (ref?.name) return { refName: ref.name, oid: ref.target?.oid || oid };
    } catch {
    }
  }
  const restUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`;
  const res = await fetch(restUrl, {
    method: "POST",
    headers: {
      "User-Agent": "Cloudflare-Worker-gemini-git-bridge",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ref: qualifiedName, sha: oid })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to create branch "${cleanBranch}" on "${owner}/${repo}": HTTP ${res.status} - ${errText}`);
  }
  const json = await res.json();
  return { refName: json.ref, oid: json.object?.sha || oid };
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

// src/utils/githubBatchRead.ts
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
  const uniquePaths = Array.from(new Set(paths.map((p) => normalizeRepoPath(p)))).filter(Boolean);
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
  const MAX_TRUNCATED_FETCH_CONCURRENCY = 6;
  const truncatedPaths = [];
  for (let idx = 0; idx < uniquePaths.length; idx++) {
    const p = uniquePaths[idx];
    const blob = repoObj[`f${idx}`];
    if (!blob) {
      result[p] = null;
    } else if (blob.isTruncated) {
      truncatedPaths.push(p);
    } else {
      result[p] = typeof blob.text === "string" ? blob.text : null;
    }
  }
  let nextTruncatedIndex = 0;
  const workerCount = Math.min(MAX_TRUNCATED_FETCH_CONCURRENCY, truncatedPaths.length);
  const fallbackWorkers = Array.from({ length: workerCount }, async () => {
    while (nextTruncatedIndex < truncatedPaths.length) {
      const path = truncatedPaths[nextTruncatedIndex++];
      result[path] = await fetchFileContent(owner, repo, branch, path, token);
    }
  });
  await Promise.all(fallbackWorkers);
  return result;
}

// src/utils/githubCommit.ts
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
    fileChanges.additions = additions.map((addition) => ({
      ...addition,
      path: normalizeRepoPath(addition.path)
    }));
  }
  if (deletions.length > 0) {
    fileChanges.deletions = deletions.map((deletion) => ({
      path: normalizeRepoPath(deletion.path)
    }));
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

// src/modules/searchReplace.ts
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

// src/modules/patchInMemory.ts
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
  const workingFiles = { ...existingFiles };
  const resultingFiles = /* @__PURE__ */ new Map();
  for (const op of patches) {
    if (op.action === "delete") {
      const current = Object.prototype.hasOwnProperty.call(workingFiles, op.path) ? workingFiles[op.path] : null;
      if (current !== null) {
        workingFiles[op.path] = null;
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
      workingFiles[op.path] = op.fullContent;
      resultingFiles.set(op.path, op.fullContent);
      continue;
    }
    if (op.action === "modify") {
      if (typeof op.fullContent === "string" && (!op.blocks || op.blocks.length === 0)) {
        const phErrors = checkPlaceholderErrors(op.fullContent, op.path);
        if (phErrors.length > 0) {
          errors.push(...phErrors);
        }
        workingFiles[op.path] = op.fullContent;
        resultingFiles.set(op.path, op.fullContent);
        continue;
      }
      const existing = Object.prototype.hasOwnProperty.call(workingFiles, op.path) ? workingFiles[op.path] : null;
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
        if (typeof block.search !== "string" || block.search.trim().length === 0) {
          errors.push({
            file: op.path,
            stage: "SEARCH_REPLACE",
            message: 'Patch block "search" must be a non-empty string.'
          });
          hasError = true;
          continue;
        }
        if (typeof block.replace !== "string") {
          errors.push({
            file: op.path,
            stage: "SEARCH_REPLACE",
            message: 'Patch block "replace" must be a string.'
          });
          hasError = true;
          continue;
        }
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
        workingFiles[op.path] = currentContent;
        resultingFiles.set(op.path, currentContent);
      }
    }
  }
  for (const [path, content] of Object.entries(workingFiles)) {
    const baseContent = Object.prototype.hasOwnProperty.call(existingFiles, path) ? existingFiles[path] : null;
    if (content === null) {
      if (baseContent !== null) {
        deletions.push({ path });
      }
    } else if (content !== baseContent) {
      additions.push({ path, content });
    }
  }
  const hasEffectiveChanges = additions.length > 0 || deletions.length > 0;
  const resultingFileList = Array.from(resultingFiles, ([path, content]) => ({ path, content }));
  const effectiveHook = preflightHook ?? runPreflightLinter;
  if (effectiveHook) {
    try {
      const hookErrors = await effectiveHook(resultingFileList, preflight);
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

// src/modules/syntaxScanner.ts
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
      const regexPreceders = "=([{:;,?!&|+-*^~<%";
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
      if (/[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(nextCh)) {
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

// src/modules/linter.ts
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

// src/modules/patcher.ts
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
  const baseBranch = req.branch.trim();
  const effectiveTargetBranch = (req.targetBranch || req.branch).trim();
  const normalizeBranch = (branch) => branch.replace(/^refs\/heads\//, "");
  const isDistinctTarget = normalizeBranch(effectiveTargetBranch) !== normalizeBranch(baseBranch);
  if (req.expectedTargetHeadOid !== void 0 && (typeof req.expectedTargetHeadOid !== "string" || !/^[0-9a-f]{40}$/i.test(req.expectedTargetHeadOid))) {
    return { status: "ERROR", errorMessage: "expectedTargetHeadOid must be a 40-character Git commit OID." };
  }
  const patches = [];
  const pathErrors = [];
  for (const patch of req.payload.patches) {
    const issue = findRepoPathIssue(patch.path);
    if (issue) {
      pathErrors.push({
        file: patch.path || "(missing path)",
        stage: "SEARCH_REPLACE",
        message: issue
      });
      continue;
    }
    patches.push({ ...patch, path: normalizeRepoPath(patch.path) });
  }
  if (pathErrors.length > 0) {
    return { status: "PREFLIGHT_FAILED", errors: pathErrors };
  }
  const allTargetPaths = Array.from(new Set(patches.map((p) => p.path)));
  let sourceInfo;
  let prefetchedFiles;
  if (!isDistinctTarget) {
    const headPromise = getBranchHeadOid(owner, repo, baseBranch, githubToken);
    const filesPromise = fetchMultipleFilesViaGraphQL(
      owner,
      repo,
      req.expectedHeadOid,
      allTargetPaths,
      githubToken
    );
    filesPromise.catch(() => void 0);
    try {
      sourceInfo = await headPromise;
    } catch (err) {
      return { status: "ERROR", errorMessage: `Failed to resolve branch "${baseBranch}": ${err.message}` };
    }
    if (sourceInfo.headOid !== req.expectedHeadOid) {
      return {
        status: "GIT_CONFLICT",
        newHeadOid: sourceInfo.headOid,
        errorMessage: `Expected HEAD "${req.expectedHeadOid}" but branch "${sourceInfo.resolvedBranch}" is at "${sourceInfo.headOid}". Fetch the latest repo mix and retry.`
      };
    }
    try {
      prefetchedFiles = await filesPromise;
    } catch (err) {
      return { status: "ERROR", errorMessage: `Batch fetch failed for target files: ${err.message}` };
    }
  } else {
    try {
      sourceInfo = await getBranchHeadOid(owner, repo, baseBranch, githubToken);
    } catch (err) {
      return { status: "ERROR", errorMessage: `Failed to resolve branch "${baseBranch}": ${err.message}` };
    }
    if (sourceInfo.headOid !== req.expectedHeadOid) {
      return {
        status: "GIT_CONFLICT",
        newHeadOid: sourceInfo.headOid,
        errorMessage: `Expected HEAD "${req.expectedHeadOid}" but branch "${sourceInfo.resolvedBranch}" is at "${sourceInfo.headOid}". Fetch the latest repo mix and retry.`
      };
    }
  }
  let targetInfo = sourceInfo;
  let createdBranch = false;
  if (isDistinctTarget) {
    try {
      targetInfo = await getBranchHeadOid(owner, repo, effectiveTargetBranch, githubToken);
    } catch (err) {
      if (!(err instanceof BranchNotFoundError)) {
        return { status: "ERROR", errorMessage: `Failed to resolve target branch "${effectiveTargetBranch}": ${err.message}` };
      }
      if (req.expectedTargetHeadOid) {
        return {
          status: "GIT_CONFLICT",
          errorMessage: `Target branch "${effectiveTargetBranch}" no longer exists at expected HEAD "${req.expectedTargetHeadOid}".`
        };
      }
      if (req.createBranchIfNeeded === false) {
        return {
          status: "ERROR",
          errorMessage: `Target branch "${effectiveTargetBranch}" does not exist and createBranchIfNeeded is false.`
        };
      }
      try {
        const createdRef = await createBranchRef(owner, repo, effectiveTargetBranch, req.expectedHeadOid, githubToken, sourceInfo.repositoryId);
        createdBranch = true;
        targetInfo = {
          headOid: createdRef.oid || req.expectedHeadOid,
          resolvedBranch: normalizeBranch(effectiveTargetBranch),
          repositoryId: sourceInfo.repositoryId
        };
      } catch (createErr) {
        try {
          targetInfo = await getBranchHeadOid(owner, repo, effectiveTargetBranch, githubToken);
        } catch (resolveErr) {
          return {
            status: "ERROR",
            errorMessage: `Failed to create target branch "${effectiveTargetBranch}": ${createErr.message}; verification failed: ${resolveErr.message}`
          };
        }
      }
    }
    if (req.expectedTargetHeadOid && targetInfo.headOid !== req.expectedTargetHeadOid) {
      return {
        status: "GIT_CONFLICT",
        newHeadOid: targetInfo.headOid,
        targetBranch: targetInfo.resolvedBranch,
        errorMessage: `Expected target HEAD "${req.expectedTargetHeadOid}" but branch "${targetInfo.resolvedBranch}" is at "${targetInfo.headOid}".`
      };
    }
  }
  const commitBranch = targetInfo.resolvedBranch;
  const commitExpectedHeadOid = targetInfo.headOid;
  let existingFiles;
  if (prefetchedFiles !== void 0) {
    existingFiles = prefetchedFiles;
  } else {
    try {
      existingFiles = await fetchMultipleFilesViaGraphQL(
        owner,
        repo,
        commitExpectedHeadOid,
        allTargetPaths,
        githubToken
      );
    } catch (err) {
      return { status: "ERROR", errorMessage: `Batch fetch failed for target files: ${err.message}` };
    }
  }
  const patchResult = await applyPatchesInMemory2(
    patches,
    existingFiles,
    req.payload.preflight,
    preflightHook
  );
  if (patchResult.errors.length > 0) {
    return { status: "PREFLIGHT_FAILED", errors: patchResult.errors };
  }
  if (!patchResult.hasEffectiveChanges) {
    return {
      status: "NO_CHANGES_NEEDED",
      newHeadOid: commitExpectedHeadOid,
      targetBranch: commitBranch,
      createdBranch
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
      commitBranch,
      commitExpectedHeadOid,
      req.payload.commitMessage || "chore: apply patches via gemini-git-bridge",
      encodedAdditions,
      patchResult.deletions,
      githubToken
    );
    const compareUrl = `https://github.com/${owner}/${repo}/compare/${sourceInfo.resolvedBranch}...${commitBranch}?expand=1`;
    return {
      status: "COMMITTED",
      newHeadOid: commitResult.oid,
      commitUrl: commitResult.url,
      targetBranch: commitBranch,
      createdBranch,
      pullRequestUrl: isDistinctTarget ? compareUrl : void 0
    };
  } catch (err) {
    const errMsg = err.message || "";
    if (/expectedHeadOid|conflict|stale|HEAD/i.test(errMsg)) {
      const latestHead = await getBranchHeadOid(owner, repo, commitBranch, githubToken).catch(() => ({
        headOid: commitExpectedHeadOid
      }));
      return {
        status: "GIT_CONFLICT",
        newHeadOid: latestHead.headOid,
        targetBranch: commitBranch,
        errorMessage: errMsg
      };
    }
    return { status: "ERROR", errorMessage: `Commit execution failed: ${errMsg}` };
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

// src/modules/mixSelection.ts
var ROOT_CONFIG_FILES = /* @__PURE__ */ new Set([
  "package.json",
  "tsconfig.json",
  "wrangler.toml",
  "wrangler.jsonc",
  "pnpm-workspace.yaml",
  "turbo.json"
]);
var ENTRYPOINT_PATTERN = /^(index|main|worker|app)\.(ts|tsx|js|jsx|mjs)$/;
function capFileTree(entries, maxChars) {
  let tree = [...entries].sort().join("\n");
  if (tree.length > maxChars) {
    const truncated = tree.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf("\n");
    tree = (lastNewline !== -1 ? truncated.slice(0, lastNewline) : truncated) + "\n... [file_tree truncated to preserve character budget]";
  }
  return tree;
}
function priorityTier(filePath) {
  const segments = filePath.split("/");
  const baseName = segments[segments.length - 1] ?? "";
  if (segments.length === 1 && ROOT_CONFIG_FILES.has(baseName)) return 0;
  if (ENTRYPOINT_PATTERN.test(baseName)) return 1;
  if (filePath.startsWith("src/") || filePath.startsWith("shared/") || filePath.startsWith("packages/")) {
    return 2;
  }
  return 3;
}
function rankFilesForOmission(files) {
  return [...files].sort(
    (a, b) => priorityTier(a.path) - priorityTier(b.path) || a.fileXml.length - b.fileXml.length || a.path.localeCompare(b.path)
  );
}
function selectFilesWithinPartLimit(files, countParts, maxParts) {
  const requiredParts = countParts(files);
  if (requiredParts <= maxParts) {
    return { kept: [...files], omitted: [], requiredParts };
  }
  const kept = rankFilesForOmission(files);
  const omitted = [];
  const dropLowest = (count) => {
    const dropped = kept.splice(Math.max(0, kept.length - count));
    for (const file of dropped) {
      omitted.push({
        path: file.path,
        reason: "part_limit_exceeded",
        chars: file.content.length
      });
    }
  };
  if (kept.length <= 500) {
    while (kept.length > 0 && countParts(kept) > maxParts) {
      dropLowest(1);
    }
  } else {
    let batch = Math.max(1, Math.ceil(kept.length * 0.1));
    while (kept.length > 0 && countParts(kept) > maxParts) {
      dropLowest(Math.min(batch, kept.length));
      batch = Math.min(batch * 2, Math.max(1, Math.ceil(files.length / 2)));
    }
  }
  return { kept, omitted, requiredParts };
}
function buildOmittedManifest(omitted, maxChars = 8e3) {
  if (omitted.length === 0) return "";
  const sorted = [...omitted].sort((a, b) => a.path.localeCompare(b.path));
  const header = `<omitted_files count="${sorted.length}">`;
  const footer = "</omitted_files>";
  const marker = "... [omitted file list truncated to preserve character budget]";
  let body = "";
  for (const entry of sorted) {
    const line = `${entry.path}
`;
    const projected = header.length + 1 + body.length + line.length + footer.length + 1;
    if (projected + marker.length + 2 > maxChars) {
      body += `${marker}
`;
      break;
    }
    body += line;
  }
  return `${header}
${body}${footer}`;
}
function buildTruncationNotice(summary) {
  const sample = summary.omittedFiles.slice(0, 5).map((entry) => entry.path).join(", ");
  const suffix = summary.omittedFiles.length > 5 ? " ..." : "";
  const reasons = [...new Set(summary.omittedFiles.map((entry) => entry.reason))].join(", ");
  return [
    "<truncation_notice>",
    `RepoMix is TRUNCATED to fit Gemini's ${summary.availableParts}-file attachment limit.`,
    `Included: ${summary.includedFiles} of ${summary.totalFiles} files. Omitted: ${summary.omittedFiles.length} file(s) (${reasons}).`,
    `The complete file set would need at least ${summary.requiredParts} parts; available: ${summary.availableParts}.`,
    sample ? `Sample omitted paths: ${sample}${suffix}` : "",
    "Do not emit patches for omitted paths. Ask the user to narrow includePaths or update .repomixignore.cf.",
    "</truncation_notice>"
  ].filter((line) => line.length > 0).join("\n");
}

// src/utils/tarUtils.ts
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
function parseIgnoreLines(content) {
  if (!content) return [];
  return content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
}
function matchesIgnorePattern(relPath, patterns) {
  if (!relPath || !patterns || patterns.length === 0) return false;
  const normalized = relPath.replace(/^\/+/, "");
  const segments = normalized.split("/");
  const fileName = segments[segments.length - 1];
  for (const rawPattern of patterns) {
    let pat = rawPattern.trim();
    if (!pat || pat.startsWith("#")) continue;
    const isDirOnly = pat.endsWith("/");
    if (isDirOnly) {
      pat = pat.slice(0, -1);
    }
    const isAnchored = pat.startsWith("/");
    if (isAnchored) {
      pat = pat.slice(1);
    }
    if (pat.includes("*") || pat.includes("?")) {
      const regexStr = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      const regex = new RegExp(isAnchored ? `^${regexStr}$` : `(^|/)${regexStr}$`);
      if (regex.test(normalized) || !pat.includes("/") && regex.test(fileName)) {
        return true;
      }
      continue;
    }
    if (isDirOnly) {
      if (isAnchored) {
        if (normalized === pat || normalized.startsWith(pat + "/")) return true;
      } else {
        if (segments.includes(pat) || normalized.startsWith(pat + "/") || normalized.includes("/" + pat + "/")) {
          return true;
        }
      }
      continue;
    }
    if (isAnchored) {
      if (normalized === pat || normalized.startsWith(pat + "/")) return true;
    } else {
      if (fileName === pat || normalized === pat || normalized.startsWith(pat + "/") || segments.includes(pat)) {
        return true;
      }
    }
  }
  return false;
}
var DEFAULT_IGNORED_DIR_NAMES = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".wrangler",
  ".turbo",
  ".next",
  "coverage",
  "_v1_backup",
  "backup_unused",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".ipynb_checkpoints"
]);
var DEFAULT_IGNORED_FILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb"
]);
var DEFAULT_IGNORED_EXTENSIONS = /* @__PURE__ */ new Set([
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

// src/modules/mixerTarScan.ts
var TarScanError = class extends Error {
  headOid;
  constructor(message, headOid) {
    super(message);
    this.name = "TarScanError";
    this.headOid = headOid;
  }
};
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
  if (filename === "gemini-bridge.user.js") {
    console.log(`[RepoMix] Skipping generated bundle: ${normalized} (path: ${normalized}, filename: ${filename})`);
    return { skip: true, reason: "GENERATED_BUNDLE" };
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (DEFAULT_IGNORED_DIR_NAMES.has(seg) || seg.startsWith("repomix_")) {
      return { skip: true, reason: "IGNORED_PATH" };
    }
  }
  if (DEFAULT_IGNORED_FILES.has(filename) || filename.endsWith(".bundle") || filename.startsWith("repomix-output") || /.*-bundle.*\.txt$/i.test(filename)) {
    return { skip: true, reason: "IGNORED_PATH" };
  }
  const extMatch = filename.match(/\.[a-zA-Z0-9]+$/);
  if (extMatch && DEFAULT_IGNORED_EXTENSIONS.has(extMatch[0].toLowerCase())) {
    return { skip: true, reason: "IGNORED_PATH" };
  }
  if (includePaths && includePaths.length > 0) {
    if (normalized !== ".repomixignore.cf" && normalized !== ".repomixignore") {
      const normalizedIncludes = includePaths.map((p) => p.replace(/^\.?\/+/, ""));
      const isIncluded = normalizedIncludes.some((prefix) => normalized.startsWith(prefix));
      if (!isIncluded) {
        return { skip: true, reason: "NOT_INCLUDED" };
      }
    }
  }
  if (size > 524288) {
    return { skip: true, reason: "OVERSIZED" };
  }
  return { skip: false };
}
function extractHeadOidFromPaxHeader(paxText) {
  const match = paxText.match(/(?:^|\n)(?:\d+\s+)?comment=([0-9a-fA-F]{40})(?:\r?\n|$)/) || paxText.match(/\b([0-9a-fA-F]{40})\b/);
  return match ? match[1].toLowerCase() : null;
}
async function scanTarGzipStream(stream, includePaths) {
  const decompressedStream = stream.pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressedStream.getReader();
  let buffer = new Uint8Array(0);
  let eof = false;
  let consecutiveZeroBlocks = 0;
  let headOid = null;
  let nextPaxPath = null;
  const fileTreeEntries = [];
  const files = [];
  const dynamicIgnorePatterns = [];
  const textDecoder = new TextDecoder();
  const skippedFiles = [];
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
      if (dynamicIgnorePatterns.length > 0 && relPath !== ".repomixignore.cf" && relPath !== ".repomixignore" && matchesIgnorePattern(relPath, dynamicIgnorePatterns)) {
        await discardBytes(paddedSize);
        continue;
      }
      const filterDecision = shouldSkipTarEntry(relPath, size, typeflag, includePaths);
      if (filterDecision.skip) {
        if (filterDecision.reason === "OVERSIZED") {
          fileTreeEntries.push(`${relPath} [SKIPPED: >512KB]`);
          skippedFiles.push({ path: relPath, reason: "too_large", bytes: size });
        } else if (filterDecision.reason === "GENERATED_BUNDLE") {
          console.log(`[RepoMix] Skipped file: path=${relPath}, filename=gemini-bridge.user.js`);
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
      if (relPath === ".repomixignore.cf" || relPath === ".repomixignore") {
        const newPatterns = parseIgnoreLines(content);
        if (newPatterns.length > 0) {
          dynamicIgnorePatterns.push(...newPatterns);
          for (let i = files.length - 1; i >= 0; i--) {
            if (matchesIgnorePattern(files[i].path, dynamicIgnorePatterns)) {
              files.splice(i, 1);
            }
          }
          for (let i = fileTreeEntries.length - 1; i >= 0; i--) {
            const entryPath = fileTreeEntries[i].replace(/\s+\[SKIPPED:.*\]$/, "");
            if (matchesIgnorePattern(entryPath, dynamicIgnorePatterns)) {
              fileTreeEntries.splice(i, 1);
            }
          }
        }
      }
      if (dynamicIgnorePatterns.length > 0 && matchesIgnorePattern(relPath, dynamicIgnorePatterns)) {
        continue;
      }
      fileTreeEntries.push(relPath);
      files.push({ path: relPath, content });
    }
  } catch (err) {
    throw new TarScanError(`Error processing tarball stream: ${err.message}`, headOid);
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
  return { headOid, fileTreeEntries, files, skippedFiles: skippedFiles.length > 0 ? skippedFiles : void 0 };
}

// src/modules/mixSerializer.ts
function formatFileXml(file) {
  return `  <file path="${file.path}"><![CDATA[${escapeCdata(file.content)}]]></file>`;
}
function buildPartXml(params) {
  const repoAttr = params.partNum !== void 0 && params.totalParts !== void 0 ? `<repository repo="${params.owner}/${params.repo}" branch="${params.branch}" headOid="${params.headOid}" part="${params.partNum}" totalParts="${params.totalParts}">` : `<repository repo="${params.owner}/${params.repo}" branch="${params.branch}" headOid="${params.headOid}">`;
  const sections = [repoAttr];
  if (params.instructionsText) {
    sections.push(params.instructionsText);
  }
  if (params.truncationNoticeText) {
    sections.push(params.truncationNoticeText);
  }
  if (params.recentCommitsText) {
    sections.push(params.recentCommitsText);
  }
  sections.push("<file_tree>", params.treeText, "</file_tree>");
  if (params.omittedManifestText) {
    sections.push(params.omittedManifestText);
  }
  sections.push("<files>", ...params.fileXmlList, "</files>", "</repository>");
  return sections.join("\n");
}

// src/modules/mixChunker.ts
var DEFAULT_MAX_CHUNK_CHARS = 85e3;
var HARD_GEMINI_CHAR_LIMIT = 1e5;
var MAX_GEMINI_PARTS = 10;
var DEFAULT_MAX_CHUNK_BYTES = 512 * 1024;
var DEFAULT_MAX_CHUNK_TOKENS = 125e3;
var MAX_RECENT_COMMITS_CHARS = 8e3;
var RECENT_COMMITS_TRUNCATION_MARKER = "... [recent_commits truncated to preserve character budget]";
var TRUNCATION_RESERVE_CHARS = 9e3;
function capRecentCommitsText(text, maxChars = MAX_RECENT_COMMITS_CHARS) {
  if (!text || text.trim().length === 0) return "";
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  const sliceBudget = limit - RECENT_COMMITS_TRUNCATION_MARKER.length - 1;
  if (sliceBudget <= 0) return RECENT_COMMITS_TRUNCATION_MARKER.slice(0, limit);
  const head = text.slice(0, sliceBudget);
  const lastNewline = head.lastIndexOf("\n");
  const kept = lastNewline > 0 ? head.slice(0, lastNewline) : head;
  return `${kept}
${RECENT_COMMITS_TRUNCATION_MARKER}`;
}
var DEFAULT_MIX_INSTRUCTIONS = [
  "<instructions>",
  "# REPOSITORY CONTEXT AND PROTOCOL",
  "1. CONTEXT: The files below represent the authoritative codebase snapshot at commit headOid.",
  "2. MULTI-PART: If split across parts, all parts form the complete repository (Part 1 contains the master file_tree).",
  "3. READ-ONLY TASKS: If the user asks questions, explains logic, or reviews code: Answer naturally in the requested language. Do NOT emit patches.",
  "4. MODIFICATION TASKS: If and only if the user explicitly requests code changes, bugfixes, or new files:",
  "   - Never rewrite whole existing files.",
  '   - Never use placeholders (e.g. "// ... existing code ...", "/* rest unchanged */").',
  "   - Search snippets must match existing code verbatim (including whitespace/indentation).",
  "   - Prefer the V2 GeminiPatchPayload JSON format below. It is a payload only; worker request fields are supplied separately.",
  "     ```json",
  "     {",
  '       "commitMessage": "feat: describe the change",',
  '       "patches": [',
  '         { "path": "src/example.ts", "action": "modify", "blocks": [{ "search": "export const oldValue = 1;", "replace": "export const newValue = 2;" }] },',
  '         { "path": "src/new-file.ts", "action": "create", "fullContent": "export const helper = () => true;\\n" },',
  '         { "path": "src/obsolete.ts", "action": "delete" }',
  "       ]",
  "     }",
  "     ```",
  "   - For V2 modify operations, use blocks with exact search and replace strings; create operations use fullContent; delete operations need no content fields.",
  "   - Keep the classic V1 Search/Replace block format as a separate fallback, not as a V2 JSON variant.",
  '     V1 BLOCK LAYOUT: the "// filepath: relative/path.ext" line must be the FIRST line INSIDE the code block, above the SEARCH marker.',
  '     V1 PATH PLACEMENT: never put the filename outside the code block. No markdown heading, no numbered list item such as "3. src/file.ts", and no path backticks above the block.',
  "     V1 GRANULARITY: exactly one code block per file. A multi-file change needs one block per file, each carrying its own filepath header.",
  "     V1 MARKERS: use the established SEARCH, separator, and REPLACE markers, each one alone on its own line.",
  "</instructions>"
].join("\n");
var CONTINUATION_MIX_INSTRUCTIONS = (partNum, totalParts) => `<instructions>
# Part ${partNum}/${totalParts} Continuation: Refer to Part 1 for master file_tree and modification protocol.
</instructions>`;
function buildChunkedMixXml(input) {
  const {
    owner,
    repo,
    branch,
    headOid,
    fileTreeEntries,
    files,
    maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    splitOutput
  } = input;
  const hasExplicitUserBudget = input.maxChunkChars !== void 0 || input.maxChunkBytes !== void 0 || input.maxChunkTokens !== void 0;
  const effectiveMaxChars = Math.min(
    maxChunkChars,
    maxChunkBytes,
    maxChunkTokens * 4,
    HARD_GEMINI_CHAR_LIMIT
  );
  const treeEntries = [...fileTreeEntries];
  const validFiles = [];
  const omitted = [];
  for (const f of files) {
    const fileXml = formatFileXml(f);
    const standaloneXml = buildPartXml({
      owner,
      repo,
      branch,
      headOid,
      partNum: 1,
      totalParts: 1,
      instructionsText: DEFAULT_MIX_INSTRUCTIONS,
      treeText: f.path,
      fileXmlList: [fileXml]
    });
    if (standaloneXml.length > HARD_GEMINI_CHAR_LIMIT) {
      omitted.push({ path: f.path, reason: "file_over_hard_limit", chars: f.content.length });
      continue;
    }
    validFiles.push({ path: f.path, content: f.content, fileXml });
  }
  if (validFiles.length === 0 && files.length > 0) {
    const sample = omitted.slice(0, 5).map((entry) => entry.path).join(", ");
    const suffix = omitted.length > 5 ? ` and ${omitted.length - 5} more` : "";
    throw new Error(
      `RepoMix cannot include any file: all ${files.length} file(s) exceed the ${HARD_GEMINI_CHAR_LIMIT}-character limit (${sample}${suffix}).`
    );
  }
  const maxTreeChars = Math.min(Math.floor(effectiveMaxChars * 0.45), 14e3);
  let fullTreeXml = capFileTree(treeEntries, maxTreeChars);
  const part1OverheadChars = buildPartXml({
    owner,
    repo,
    branch,
    headOid,
    partNum: 1,
    totalParts: MAX_GEMINI_PARTS,
    instructionsText: DEFAULT_MIX_INSTRUCTIONS,
    treeText: fullTreeXml,
    fileXmlList: []
  }).length;
  const metadataBudget = Math.max(
    0,
    Math.min(MAX_RECENT_COMMITS_CHARS, effectiveMaxChars - part1OverheadChars)
  );
  const cappedRecentCommitsText = capRecentCommitsText(input.recentCommitsText, metadataBudget);
  function fitPart(params) {
    const build = (treeText, metadata2, entries) => buildPartXml({
      owner,
      repo,
      branch,
      headOid,
      partNum: params.partNum,
      totalParts: params.totalParts,
      instructionsText: params.instructionsText,
      truncationNoticeText: params.truncationNoticeText,
      recentCommitsText: metadata2 || void 0,
      treeText,
      omittedManifestText: params.omittedManifestText,
      fileXmlList: entries.map((e) => e.fileXml)
    });
    let metadata = params.metadata;
    let xml = build(params.treeText, metadata, params.fileEntries);
    if (xml.length > HARD_GEMINI_CHAR_LIMIT && metadata) {
      metadata = capRecentCommitsText(
        metadata,
        Math.max(0, metadata.length - (xml.length - HARD_GEMINI_CHAR_LIMIT) - 1)
      );
      xml = build(params.treeText, metadata, params.fileEntries);
    }
    if (xml.length > HARD_GEMINI_CHAR_LIMIT && metadata) {
      metadata = "";
      xml = build(params.treeText, metadata, params.fileEntries);
    }
    return { xml, entries: params.fileEntries, metadata };
  }
  const singleRawXml = buildPartXml({
    owner,
    repo,
    branch,
    headOid,
    instructionsText: DEFAULT_MIX_INSTRUCTIONS,
    recentCommitsText: cappedRecentCommitsText || void 0,
    treeText: fullTreeXml,
    fileXmlList: validFiles.map((f) => f.fileXml)
  });
  const single = fitPart({
    instructionsText: DEFAULT_MIX_INSTRUCTIONS,
    metadata: cappedRecentCommitsText,
    treeText: fullTreeXml,
    fileEntries: validFiles
  });
  const shouldSplit = splitOutput === true || single.xml.length > HARD_GEMINI_CHAR_LIMIT || splitOutput !== false && validFiles.length > 1 && singleRawXml.length > effectiveMaxChars;
  if (!shouldSplit && omitted.length === 0) {
    if (single.xml.length > HARD_GEMINI_CHAR_LIMIT) {
      throw new Error(
        `RepoMix serialized to ${single.xml.length} characters, exceeding the ${HARD_GEMINI_CHAR_LIMIT}-character limit.`
      );
    }
    return {
      xmlContent: single.xml,
      isChunked: false,
      stats: {
        fileCount: single.entries.length,
        totalFileCount: files.length,
        estimatedTokens: Math.ceil(single.xml.length / 4),
        charCount: single.xml.length
      }
    };
  }
  let part1Extras = { notice: "", manifest: "" };
  function partitionFiles(budgetChars, source = validFiles) {
    const partBudget = Math.min(budgetChars, HARD_GEMINI_CHAR_LIMIT);
    const serializedSize = (bucket, index) => {
      const partNum = index + 1;
      const treeText = index === 0 ? fullTreeXml : `# Part ${partNum}/${MAX_GEMINI_PARTS} files (${bucket.length} files):
${bucket.map((f) => f.path).join("\n")}`;
      return buildPartXml({
        owner,
        repo,
        branch,
        headOid,
        partNum,
        totalParts: MAX_GEMINI_PARTS,
        instructionsText: partNum === 1 ? DEFAULT_MIX_INSTRUCTIONS : CONTINUATION_MIX_INSTRUCTIONS(partNum, MAX_GEMINI_PARTS),
        truncationNoticeText: partNum === 1 ? part1Extras.notice || void 0 : void 0,
        recentCommitsText: partNum === 1 ? cappedRecentCommitsText || void 0 : void 0,
        treeText,
        omittedManifestText: partNum === 1 ? part1Extras.manifest || void 0 : void 0,
        fileXmlList: bucket.map((f) => f.fileXml)
      }).length;
    };
    if (partBudget <= 0) return source.map((f) => [f]);
    const packList = [...source].sort(
      (a, b) => b.fileXml.length - a.fileXml.length || a.path.localeCompare(b.path)
    );
    const buckets = [];
    for (const file of packList) {
      let placed = false;
      for (let i = 0; i < buckets.length; i++) {
        const candidate = [...buckets[i], file];
        if (serializedSize(candidate, i) <= partBudget) {
          buckets[i] = candidate;
          placed = true;
          break;
        }
      }
      if (!placed) buckets.push([file]);
    }
    return buckets;
  }
  const maxPackBudget = hasExplicitUserBudget ? effectiveMaxChars : HARD_GEMINI_CHAR_LIMIT;
  const requiredParts = partitionFiles(maxPackBudget, validFiles).length;
  let keptFiles = validFiles;
  if (requiredParts > MAX_GEMINI_PARTS || omitted.length > 0) {
    const selectionBudget = Math.max(1, maxPackBudget - TRUNCATION_RESERVE_CHARS);
    const selection = selectFilesWithinPartLimit(
      validFiles,
      (subset) => partitionFiles(selectionBudget, subset).length,
      MAX_GEMINI_PARTS
    );
    keptFiles = selection.kept;
    omitted.push(...selection.omitted);
    if (keptFiles.length === 0) {
      throw new Error(
        `RepoMix cannot include any file within ${MAX_GEMINI_PARTS} parts and the ${HARD_GEMINI_CHAR_LIMIT}-character limit.`
      );
    }
    const keptPaths = new Set(keptFiles.map((file) => file.path));
    fullTreeXml = capFileTree(
      treeEntries.filter((entry) => keptPaths.has(entry)),
      maxTreeChars
    );
    part1Extras = {
      notice: buildTruncationNotice({
        includedFiles: keptFiles.length,
        totalFiles: files.length,
        omittedFiles: omitted,
        requiredParts,
        availableParts: MAX_GEMINI_PARTS
      }),
      manifest: buildOmittedManifest(omitted)
    };
  }
  const budgetLadder = hasExplicitUserBudget ? [effectiveMaxChars] : [
    effectiveMaxChars,
    Math.min(95e3, HARD_GEMINI_CHAR_LIMIT),
    HARD_GEMINI_CHAR_LIMIT
  ];
  const triedBudgets = [];
  let chunkBuckets = [];
  for (const budget of budgetLadder) {
    if (triedBudgets.includes(budget)) continue;
    chunkBuckets = partitionFiles(budget, keptFiles);
    triedBudgets.push(budget);
    if (chunkBuckets.length <= MAX_GEMINI_PARTS) break;
  }
  if (chunkBuckets.length > MAX_GEMINI_PARTS) {
    throw new Error(
      `RepoMix truncation invariant failed: ${chunkBuckets.length} parts after selecting within ${MAX_GEMINI_PARTS}.`
    );
  }
  const totalParts = chunkBuckets.length;
  const parts = [];
  let totalChars = 0;
  let emittedFileCount = 0;
  for (let i = 0; i < totalParts; i++) {
    const bucket = chunkBuckets[i];
    const partNum = i + 1;
    const partTreeText = i === 0 ? fullTreeXml : `# Part ${partNum}/${totalParts} files (${bucket.length} files):
${bucket.map((b) => b.path).join("\n")}`;
    const partInstructions = partNum === 1 ? DEFAULT_MIX_INSTRUCTIONS : CONTINUATION_MIX_INSTRUCTIONS(partNum, totalParts);
    const fitted = fitPart({
      partNum,
      totalParts,
      instructionsText: partInstructions,
      truncationNoticeText: partNum === 1 ? part1Extras.notice || void 0 : void 0,
      metadata: partNum === 1 ? cappedRecentCommitsText : "",
      treeText: partTreeText,
      omittedManifestText: partNum === 1 ? part1Extras.manifest || void 0 : void 0,
      fileEntries: bucket
    });
    const partXml = fitted.xml;
    if (partXml.length > HARD_GEMINI_CHAR_LIMIT) {
      throw new Error(
        `RepoMix part ${partNum} serialized to ${partXml.length} characters, exceeding the ${HARD_GEMINI_CHAR_LIMIT}-character limit.`
      );
    }
    totalChars += partXml.length;
    emittedFileCount += fitted.entries.length;
    parts.push({
      partIndex: partNum,
      totalParts,
      fileName: totalParts === 1 ? "repo-mix.txt" : `repo-mix.part${partNum}.txt`,
      xmlContent: partXml,
      stats: {
        fileCount: fitted.entries.length,
        estimatedTokens: Math.ceil(partXml.length / 4),
        charCount: partXml.length
      }
    });
  }
  if (parts.length > MAX_GEMINI_PARTS || emittedFileCount + omitted.length !== files.length) {
    throw new Error(
      `RepoMix output could not preserve the file accounting within ${MAX_GEMINI_PARTS} conforming parts.`
    );
  }
  const hasPartLimit = omitted.some((entry) => entry.reason === "part_limit_exceeded");
  const hasHardLimit = omitted.some((entry) => entry.reason === "file_over_hard_limit");
  const truncationReason = hasPartLimit && hasHardLimit ? "mixed" : hasPartLimit ? "part_limit_exceeded" : "file_over_hard_limit";
  const truncation = omitted.length > 0 ? {
    reason: truncationReason,
    requiredParts,
    availableParts: MAX_GEMINI_PARTS,
    includedFiles: emittedFileCount,
    totalFiles: files.length,
    omittedFiles: [...omitted].sort((a, b) => a.path.localeCompare(b.path)),
    omittedChars: omitted.reduce((sum, entry) => sum + (entry.chars ?? 0), 0)
  } : void 0;
  return {
    xmlContent: parts[0]?.xmlContent ?? single.xml,
    parts,
    isChunked: true,
    ...truncation ? { truncation } : {},
    stats: {
      fileCount: emittedFileCount,
      totalFileCount: files.length,
      estimatedTokens: Math.ceil(totalChars / 4),
      charCount: totalChars
    }
  };
}

// src/modules/recentCommits.ts
function escapeXml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function formatRecentCommitsXml(commits, volatileFiles) {
  if (!commits || commits.length === 0) {
    return "";
  }
  const sections = ["<recent_commits>"];
  for (const c of commits) {
    const authorAttr = escapeXml(c.author);
    const dateAttr = escapeXml(c.date);
    const hashAttr = escapeXml(c.hash);
    const titleText = escapeXml(c.title);
    sections.push(`  <commit hash="${hashAttr}" date="${dateAttr}" author="${authorAttr}">`);
    sections.push(`    <title>${titleText}</title>`);
    if (c.files.length > 0) {
      sections.push("    <files>");
      for (const f of c.files) {
        sections.push(`      <file path="${escapeXml(f.path)}" status="${escapeXml(f.status)}" />`);
      }
      sections.push("    </files>");
    }
    sections.push("  </commit>");
  }
  sections.push("</recent_commits>");
  if (volatileFiles && volatileFiles.length > 0) {
    sections.push("<volatile_files>");
    for (const v of volatileFiles) {
      sections.push(
        `  <file path="${escapeXml(v.path)}" touchCount="${v.touchCount}" latestStatus="${escapeXml(v.latestStatus)}" />`
      );
    }
    sections.push("</volatile_files>");
  }
  return sections.join("\n");
}
async function fetchRecentCommitsAndVolatileFiles(owner, repo, branch, token, count = 3) {
  const safeCount = Math.min(5, Math.max(1, count));
  const fallback = { commits: [], volatileFiles: [], xmlContent: "" };
  try {
    const listUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=${safeCount}`;
    const listRes = await fetch(listUrl, {
      headers: {
        "User-Agent": "Cloudflare-Worker-gemini-git-bridge",
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json"
      }
    });
    if (!listRes.ok) {
      return fallback;
    }
    const listData = await listRes.json();
    if (!Array.isArray(listData) || listData.length === 0) {
      return fallback;
    }
    const detailPromises = listData.slice(0, safeCount).map(async (c) => {
      const sha = c.sha || "";
      const rawMsg = c.commit?.message || "";
      const title = rawMsg.split("\n")[0] || "";
      const author = c.commit?.author?.name || c.author?.login || "unknown";
      const date = c.commit?.author?.date || c.commit?.committer?.date || "";
      try {
        const detailUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`;
        const detailRes = await fetch(detailUrl, {
          headers: {
            "User-Agent": "Cloudflare-Worker-gemini-git-bridge",
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json"
          }
        });
        if (detailRes.ok) {
          const detailData = await detailRes.json();
          const detailMsg = detailData.commit?.message || rawMsg;
          const detailTitle = detailMsg.split("\n")[0] || title;
          const detailAuthor = detailData.commit?.author?.name || detailData.author?.login || author;
          const detailDate = detailData.commit?.author?.date || detailData.commit?.committer?.date || date;
          const files = Array.isArray(detailData.files) ? detailData.files.map((f) => ({
            path: String(f.filename || ""),
            status: String(f.status || "modified")
          })).filter((f) => f.path.length > 0) : [];
          return {
            hash: sha,
            date: detailDate,
            author: detailAuthor,
            title: detailTitle,
            files
          };
        }
      } catch {
      }
      return {
        hash: sha,
        date,
        author,
        title,
        files: []
      };
    });
    const commits = await Promise.all(detailPromises);
    const fileMap = /* @__PURE__ */ new Map();
    for (let cIdx = 0; cIdx < commits.length; cIdx++) {
      const commit = commits[cIdx];
      for (const f of commit.files) {
        if (!f.path) continue;
        const existing = fileMap.get(f.path);
        if (!existing) {
          fileMap.set(f.path, {
            path: f.path,
            touchCount: 1,
            latestStatus: f.status,
            latestCommitIndex: cIdx
          });
        } else {
          existing.touchCount++;
        }
      }
    }
    const volatileFiles = Array.from(fileMap.values()).sort((a, b) => {
      if (b.touchCount !== a.touchCount) {
        return b.touchCount - a.touchCount;
      }
      return a.latestCommitIndex - b.latestCommitIndex;
    }).map(({ path, touchCount, latestStatus }) => ({ path, touchCount, latestStatus }));
    const xmlContent = formatRecentCommitsXml(commits, volatileFiles);
    return {
      commits,
      volatileFiles,
      xmlContent
    };
  } catch {
    return fallback;
  }
}

// src/modules/mixer.ts
async function describeTarballNotFound(owner, repo, branch, token) {
  try {
    const branchInfo = await getBranchHeadOid(owner, repo, branch, token);
    return ` The branch exists (HEAD ${branchInfo.headOid.slice(0, 7)}), so GitHub's tarball endpoint failed unexpectedly; verify the deployed worker and retry.`;
  } catch (err) {
    const message = err?.message || String(err);
    if (/Could not resolve to a Repository|not accessible|Repository .* not found/i.test(message)) {
      return ` Repository "${owner}/${repo}" was not found or is not accessible with this worker's GitHub token. Check the Repo field and the active account/worker.`;
    }
    if (/Branch .* was not found/i.test(message)) {
      let defaultBranch = "";
      try {
        const fallback = await getBranchHeadOid(owner, repo, "", token);
        defaultBranch = fallback.resolvedBranch || "";
      } catch {
      }
      const suggestion = defaultBranch ? ` The repository's default branch is "${defaultBranch}".` : "";
      return ` Branch "${branch}" does not exist in "${owner}/${repo}".${suggestion} Update the Branch field in the HUD and retry.`;
    }
    return ` Could not verify "${owner}/${repo}@${branch}": ${message}`;
  }
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
  const resolvedBranch = (req.branch || "").trim().replace(/^refs\/heads\//, "") || "main";
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
    const diagnosis = res.status === 404 ? await describeTarballNotFound(owner, repo, resolvedBranch, githubToken) : "";
    return {
      status: "ERROR",
      headOid: "",
      xmlContent: "",
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: `GitHub tarball fetch failed with HTTP ${res.status} (${res.statusText}) for ${owner}/${repo}@${resolvedBranch}: ${errorBody}${diagnosis}`
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
  let scan;
  try {
    scan = await scanTarGzipStream(res.body, req.includePaths);
  } catch (err) {
    if (err instanceof TarScanError) {
      return {
        status: "ERROR",
        headOid: err.headOid || "",
        xmlContent: "",
        stats: { fileCount: 0, estimatedTokens: 0 },
        errorMessage: err.message
      };
    }
    throw err;
  }
  let headOid = scan.headOid;
  const fileTreeEntries = scan.fileTreeEntries;
  const files = scan.files;
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
  let recentCommitsText = "";
  let recentCommitsCount = 0;
  let volatileFilesCount = 0;
  if (req.includeRecentCommits === true) {
    try {
      const commitsResult = await fetchRecentCommitsAndVolatileFiles(
        owner,
        repo,
        resolvedBranch,
        githubToken,
        req.recentCommitsCount || 3
      );
      recentCommitsText = commitsResult.xmlContent;
      recentCommitsCount = commitsResult.commits.length;
      volatileFilesCount = commitsResult.volatileFiles.length;
    } catch {
    }
  }
  let mixResult;
  try {
    mixResult = buildChunkedMixXml({
      owner,
      repo,
      branch: resolvedBranch,
      headOid,
      fileTreeEntries,
      files,
      recentCommitsText,
      maxChunkChars: req.maxChunkChars,
      maxChunkBytes: req.maxChunkBytes,
      maxChunkTokens: req.maxChunkTokens,
      splitOutput: req.splitOutput
    });
  } catch (err) {
    return {
      status: "ERROR",
      headOid,
      xmlContent: "",
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: err.message || "Failed to build chunked mix XML",
      ...scan.skippedFiles && scan.skippedFiles.length > 0 ? { skippedFiles: scan.skippedFiles } : {}
    };
  }
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
      const skippedFiles2 = scan.skippedFiles && scan.skippedFiles.length > 0 ? scan.skippedFiles : void 0;
      return {
        status: "ERROR",
        headOid,
        xmlContent: mixResult.xmlContent,
        parts: mixResult.parts,
        isChunked: mixResult.isChunked,
        ...mixResult.truncation ? { truncation: mixResult.truncation } : {},
        stats: {
          ...mixResult.stats,
          ...recentCommitsCount > 0 ? { recentCommitsCount, volatileFilesCount } : {}
        },
        errorMessage: `Failed to persist repo-mix.xml snapshot to GitHub: ${err.message}`,
        ...skippedFiles2 ? { skippedFiles: skippedFiles2 } : {}
      };
    }
  }
  const skippedFiles = scan.skippedFiles && scan.skippedFiles.length > 0 ? scan.skippedFiles : void 0;
  return {
    status: "OK",
    headOid,
    xmlContent: mixResult.xmlContent,
    parts: mixResult.parts,
    isChunked: mixResult.isChunked,
    ...mixResult.truncation ? { truncation: mixResult.truncation } : {},
    stats: {
      ...mixResult.stats,
      ...recentCommitsCount > 0 ? { recentCommitsCount, volatileFilesCount } : {}
    },
    ...persistedCommitOid ? { persistedCommitOid } : {},
    ...skippedFiles ? { skippedFiles } : {}
  };
}

// src/modules/webhookHandler.ts
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
    const contextText = Array.isArray(mixResult.parts) && mixResult.parts.length > 0 ? mixResult.parts.map((p) => p.xmlContent || "").join("\n\n") : mixResult.xmlContent || "";
    const userQuery = `Task Instruction:
${prompt}

Repository Context:
${contextText}`;
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
  const secret = env.GITHUB_WEBHOOK_SECRET || "";
  if (!secret) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized: GITHUB_WEBHOOK_SECRET not configured" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
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
  const action = payload.action;
  if (action && action !== "created" && action !== "opened") {
    return new Response(
      JSON.stringify({ status: "IGNORED", message: "Webhook action not eligible for processing" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  const authorAssociation = payload.comment?.author_association || payload.issue?.author_association;
  if (authorAssociation) {
    const allowed = ["OWNER", "MEMBER", "COLLABORATOR"];
    if (!allowed.includes(authorAssociation)) {
      return new Response(
        JSON.stringify({ status: "IGNORED", message: "Unauthorized sender association" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
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

// src/index.ts
var ClientValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientValidationError";
  }
};
var UpstreamRequestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamRequestError";
  }
};
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
  const enc = new TextEncoder();
  const secretBytes = enc.encode(secret);
  const customHeader = request.headers.get("x-bridge-secret");
  if (customHeader) {
    const headerBytes = enc.encode(customHeader);
    if (headerBytes.length === secretBytes.length) {
      let result = 0;
      for (let i = 0; i < headerBytes.length; i++) {
        result |= headerBytes[i] ^ secretBytes[i];
      }
      if (result === 0) {
        return true;
      }
    }
  }
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const tokenBytes = enc.encode(token);
    if (tokenBytes.length === secretBytes.length) {
      let result = 0;
      for (let i = 0; i < tokenBytes.length; i++) {
        result |= tokenBytes[i] ^ secretBytes[i];
      }
      if (result === 0) {
        return true;
      }
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
        version: "2.0.7",
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
          throw new ClientValidationError("Malformed JSON payload");
        });
        let owner = "";
        let repo = "";
        try {
          const parsed = parseRepoOwner(body.repo || "", body.owner);
          owner = parsed.owner;
          repo = parsed.repo;
        } catch {
          throw new ClientValidationError('Missing required fields: Repository must be specified as "owner/repo" or separate "owner" and "repo".');
        }
        const commitMessage = body.commitMessage || body.message;
        if (!commitMessage) {
          throw new ClientValidationError('Missing required field: "commitMessage" (or "message") must be specified.');
        }
        const targetBranch = body.targetBranch || body.branch || "main";
        const fileChanges = body.changes || body.files || [];
        const deletions = body.deletions || [];
        if (fileChanges.length === 0 && deletions.length === 0) {
          throw new ClientValidationError('Commit must include at least one entry in "changes" or "files" or "deletions".');
        }
        const { headOid, resolvedBranch } = await getBranchHeadOid(owner, repo, targetBranch, githubToken);
        if (body.expectedHeadOid && body.expectedHeadOid !== headOid) {
          return jsonResponse(
            {
              status: "GIT_CONFLICT",
              newHeadOid: headOid,
              errorMessage: `Expected HEAD "${body.expectedHeadOid}" but branch "${resolvedBranch}" is at "${headOid}". Fetch the latest repo mix and retry.`
            },
            409
          );
        }
        const additions = [];
        for (const fileInput of fileChanges) {
          const pathIssue = findRepoPathIssue(fileInput.path);
          if (pathIssue) {
            throw new ClientValidationError(pathIssue);
          }
          const filePath = normalizeRepoPath(fileInput.path);
          const contentFetcher = async (requestedPath) => {
            try {
              return await fetchFileContent(owner, repo, resolvedBranch, requestedPath, githubToken);
            } catch (err) {
              throw new UpstreamRequestError(err?.message || "Failed to fetch existing file from GitHub");
            }
          };
          let resolvedText;
          try {
            resolvedText = await resolveFileContent({ ...fileInput, path: filePath }, contentFetcher);
          } catch (err) {
            if (err instanceof UpstreamRequestError) {
              throw err;
            }
            throw new ClientValidationError(err?.message || "Invalid file change payload");
          }
          const encodedBase64 = utf8ToBase64(resolvedText);
          additions.push({
            path: filePath,
            contents: encodedBase64
          });
        }
        const formattedDeletions = deletions.map((del) => {
          const rawPath = typeof del === "string" ? del : del.path;
          const pathIssue = findRepoPathIssue(rawPath);
          if (pathIssue) {
            throw new ClientValidationError(pathIssue);
          }
          return { path: normalizeRepoPath(rawPath) };
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
      if (err instanceof ClientValidationError) {
        return errorResponse(err.message, 400);
      }
      console.error("Request processing error:", err);
      return errorResponse(err.message || "Internal server error", 500);
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
