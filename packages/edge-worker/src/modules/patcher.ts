import type {
  FileChangeInput,
  PatchItem,
  FilePatchOperation,
  GeminiPatchPayload,
  WorkerPatchRequest,
  LinterError,
  WorkerPatchResponse
} from '../types';
import { utf8ToBase64 } from '../utils/encoding';
import {
  parseRepoOwner,
  getBranchHeadOid,
  fetchMultipleFilesViaGraphQL,
  createCommitOnBranch
} from '../utils/github';
import { runPreflightLinter } from './linter';

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
 * Stage 4 Linter Hook type: enables modules/linter.ts to inject AST/syntax checks
 * into the patch preflight pipeline without modifying patcher.ts.
 */
export type PreflightLinterHook = (
  files: { path: string; content: string }[],
  preflight?: GeminiPatchPayload['preflight']
) => Promise<LinterError[]> | LinterError[];

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
    return original.replace(search, replace);
  }

  // 2. Normalized newline match (CRLF -> LF)
  const normOriginal = original.replace(/\r\n/g, '\n');
  const normSearch = search.replace(/\r\n/g, '\n');
  const normReplace = replace.replace(/\r\n/g, '\n');

  if (normOriginal.includes(normSearch)) {
    const updated = normOriginal.replace(normSearch, normReplace);
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

/**
 * Handles POST /api/patch requests (Stage 2 & Stage 4).
 * Performs concurrency checks, fetches files in 1 subrequest via GraphQL,
 * applies in-memory search/replace patches, runs preflight validations,
 * and commits atomically with createCommitOnBranch.
 */
export async function handlePatchRequest(
  req: WorkerPatchRequest,
  githubToken: string,
  preflightHook: PreflightLinterHook = runPreflightLinter
): Promise<WorkerPatchResponse> {
  if (!req.repo || !req.branch || !req.expectedHeadOid || !req.payload?.patches) {
    return {
      status: 'ERROR',
      errorMessage: 'Missing required fields: "repo", "branch", "expectedHeadOid", and "payload.patches" must be specified.'
    };
  }

  let owner = '';
  let repo = '';
  try {
    const parsed = parseRepoOwner(req.repo);
    owner = parsed.owner;
    repo = parsed.repo;
  } catch (err: any) {
    return {
      status: 'ERROR',
      errorMessage: err.message || 'Invalid repository format'
    };
  }

  const requestedBranch = req.branch.trim();

  // 1. Concurrency Check: verify branch HEAD matches expectedHeadOid
  let currentHeadOid = '';
  let resolvedBranch = requestedBranch;
  try {
    const branchInfo = await getBranchHeadOid(owner, repo, requestedBranch, githubToken);
    currentHeadOid = branchInfo.headOid;
    resolvedBranch = branchInfo.resolvedBranch;
  } catch (err: any) {
    return {
      status: 'ERROR',
      errorMessage: `Failed to resolve branch "${requestedBranch}": ${err.message}`
    };
  }

  if (currentHeadOid !== req.expectedHeadOid) {
    return {
      status: 'GIT_CONFLICT',
      newHeadOid: currentHeadOid,
      errorMessage: `Expected HEAD "${req.expectedHeadOid}" but branch "${resolvedBranch}" is at "${currentHeadOid}". Fetch the latest repo-mix.xml and retry.`
    };
  }

  // 2. Batch-read all target files in 1 Subrequest via GraphQL
  const allTargetPaths = Array.from(new Set(req.payload.patches.map((p) => p.path)));
  let existingFiles: Record<string, string | null> = {};
  try {
    existingFiles = await fetchMultipleFilesViaGraphQL(owner, repo, resolvedBranch, allTargetPaths, githubToken);
  } catch (err: any) {
    return {
      status: 'ERROR',
      errorMessage: `Batch fetch failed for target files: ${err.message}`
    };
  }

  // 3. Apply Patches in Memory
  const patchResult = await applyPatchesInMemory(
    req.payload.patches,
    existingFiles,
    req.payload.preflight,
    preflightHook
  );

  // If preflight or search/replace errors occurred, collect and return all without committing
  if (patchResult.errors.length > 0) {
    return {
      status: 'PREFLIGHT_FAILED',
      errors: patchResult.errors
    };
  }

  // 4. Idempotency Check: if no effective changes, return NO_CHANGES_NEEDED
  if (!patchResult.hasEffectiveChanges) {
    return {
      status: 'NO_CHANGES_NEEDED',
      newHeadOid: currentHeadOid
    };
  }

  // 5. Encode additions to base64 for GraphQL createCommitOnBranch
  const encodedAdditions = patchResult.additions.map((a) => ({
    path: a.path,
    contents: utf8ToBase64(a.content)
  }));

  // 6. Execute atomic commit via createCommitOnBranch
  try {
    const commitResult = await createCommitOnBranch(
      owner,
      repo,
      resolvedBranch,
      req.expectedHeadOid,
      req.payload.commitMessage || 'chore: apply patches via gemini-git-bridge',
      encodedAdditions,
      patchResult.deletions,
      githubToken
    );

    return {
      status: 'COMMITTED',
      newHeadOid: commitResult.oid,
      commitUrl: commitResult.url
    };
  } catch (err: any) {
    const errMsg = err.message || '';
    if (
      errMsg.includes('expectedHeadOid') ||
      errMsg.includes('conflict') ||
      errMsg.includes('stale') ||
      errMsg.includes('HEAD')
    ) {
      const latestHead = await getBranchHeadOid(owner, repo, resolvedBranch, githubToken).catch(() => ({
        headOid: currentHeadOid
      }));
      return {
        status: 'GIT_CONFLICT',
        newHeadOid: latestHead.headOid,
        errorMessage: errMsg
      };
    }

    return {
      status: 'ERROR',
      errorMessage: `Commit execution failed: ${errMsg}`
    };
  }
}

/**
 * Resolves a FileChangeInput into full updated file content.
 * Kept for 100% backward compatibility with V1 routes (/push, /commit).
 */
export async function resolveFileContent(
  fileInput: FileChangeInput,
  existingContentFetcher: (path: string) => Promise<string>
): Promise<string> {
  const patchesToApply: PatchItem[] = [];

  // Check explicit single search/replace
  if (typeof fileInput.search === 'string' && typeof fileInput.replace === 'string') {
    patchesToApply.push({ search: fileInput.search, replace: fileInput.replace });
  }

  // Check array of patches
  if (Array.isArray(fileInput.patches)) {
    for (const p of fileInput.patches) {
      if (typeof p.search === 'string' && typeof p.replace === 'string') {
        patchesToApply.push(p);
      }
    }
  }

  // Check diff or content for <<<<<<< SEARCH blocks
  const diffToCheck = fileInput.diff || fileInput.content || '';
  if (diffToCheck.includes('<<<<<<<') || diffToCheck.includes('=====')) {
    const parsed = parseSearchReplaceBlocks(diffToCheck);
    patchesToApply.push(...parsed);
  }

  // If no search/replace patches found, treat as full file content replacement/creation
  if (patchesToApply.length === 0) {
    if (typeof fileInput.content === 'string') {
      validateNoPlaceholders(fileInput.content, fileInput.path);
      return fileInput.content;
    }
    throw new Error(`File change for "${fileInput.path}" must provide either "content" or search/replace patches.`);
  }

  // Validate that replace blocks do not contain placeholders
  for (const patch of patchesToApply) {
    validateNoPlaceholders(patch.replace, fileInput.path);
  }

  // Fetch existing content
  const existingContent = await existingContentFetcher(fileInput.path);
  let resolved = existingContent;

  for (const patch of patchesToApply) {
    resolved = applySearchReplace(resolved, patch.search, patch.replace, fileInput.path);
  }

  // Validate the final resolved file
  validateNoPlaceholders(resolved, fileInput.path);

  return resolved;
}
