import type { HarvestedPatch, FilePatchOperation, GeminiPatchPayload, LinterError } from '../types';
import { findRepoPathIssue, normalizeRepoPath } from '../../../../shared/repoPaths';
import { computePatchSignature, createStablePatchId } from './patchIdentity';

export const MAX_QUEUED_PATCHES = 20;

/**
 * A patch is a duplicate when it was already harvested by id or carries an identical payload.
 */
export function isDuplicatePatch(queue: HarvestedPatch[], candidate: HarvestedPatch): boolean {
  const signature = computePatchSignature(candidate.mode, candidate.payload);
  return queue.some(
    (existing) =>
      existing.id === candidate.id ||
      computePatchSignature(existing.mode, existing.payload) === signature
  );
}

export function enqueueHarvestedPatch(
  queue: HarvestedPatch[],
  patch: HarvestedPatch
): HarvestedPatch[] {
  if (isDuplicatePatch(queue, patch)) return queue;
  return [patch, ...queue].slice(0, MAX_QUEUED_PATCHES);
}

export function removeHarvestedPatch(queue: HarvestedPatch[], patchId: string): HarvestedPatch[] {
  return queue.filter((entry) => entry.id !== patchId);
}

/** FIFO order: the oldest harvest is applied first. */
export function fifoQueue(queue: HarvestedPatch[]): HarvestedPatch[] {
  return [...queue].reverse();
}

/**
 * Coalesces a multi-entry queue into one atomic V2 payload in FIFO order.
 * Returns null when fewer than two entries exist or any patch lacks a resolved
 * repo-relative path, so the caller can fall back to the sequential prompt flow.
 */
export function coalescePatchesIntoBatch(queue: HarvestedPatch[]): HarvestedPatch | null {
  const ordered = fifoQueue(queue);
  if (ordered.length < 2) return null;

  const patches: FilePatchOperation[] = [];
  const forbidPatterns: string[] = [];
  const requireExports: Record<string, string[]> = {};
  const commitMessages: string[] = [];

  for (const entry of ordered) {
    const operations = entry.payload?.patches ?? [];
    if (operations.length === 0) return null;

    for (const operation of operations) {
      if (!operation.path || !operation.path.trim()) return null;
      patches.push(operation);
    }

    for (const pattern of entry.payload.preflight?.forbidPatterns ?? []) {
      if (!forbidPatterns.includes(pattern)) forbidPatterns.push(pattern);
    }

    for (const [filePath, symbols] of Object.entries(entry.payload.preflight?.requireExports ?? {})) {
      const normExportPath = normalizeRepoPath(filePath) || filePath;
      const merged = requireExports[normExportPath] ?? [];
      for (const symbol of symbols) {
        if (!merged.includes(symbol)) merged.push(symbol);
      }
      requireExports[normExportPath] = merged;
    }

    if (entry.commitMessage) commitMessages.push(entry.commitMessage);
  }

  if (patches.length === 0) return null;

  const payload: GeminiPatchPayload = {
    commitMessage: `batch: ${commitMessages.join(' | ') || `${ordered.length} harvested patches`}`,
    patches,
  };

  if (forbidPatterns.length > 0 || Object.keys(requireExports).length > 0) {
    payload.preflight = {};
    if (forbidPatterns.length > 0) payload.preflight.forbidPatterns = forbidPatterns;
    if (Object.keys(requireExports).length > 0) payload.preflight.requireExports = requireExports;
  }

  return {
    id: createStablePatchId('v2_json', payload),
    mode: 'v2_json',
    commitMessage: payload.commitMessage,
    payload,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Applies the queue sequentially and stops at the first failure (fail-fast).
 * `total` equals the queue length at start; `applied < total` means the run was aborted.
 */
export async function runPatchQueue(
  queue: HarvestedPatch[],
  apply: (patch: HarvestedPatch) => Promise<boolean>,
  onProgress: (patch: HarvestedPatch, index: number, total: number) => void
): Promise<{ applied: number; total: number }> {
  const ordered = fifoQueue(queue);
  const total = ordered.length;
  let applied = 0;

  for (let index = 0; index < total; index++) {
    const patch = ordered[index];
    onProgress(patch, index, total);
    if (!(await apply(patch))) return { applied, total };
    applied++;
  }

  return { applied, total };
}

export interface HolisticQueuePartition {
  validBatch: HarvestedPatch | null;
  localErrors: LinterError[];
  targetFiles: string[];
  totalSnippets: number;
}

/**
 * Aggregates all harvested snippets into a consolidated batch and collects missing-path
 * errors across all snippets non-fail-fast so the self-healing loop can repair them holistically.
 */
export function partitionQueueForHolisticCheck(queue: HarvestedPatch[]): HolisticQueuePartition {
  const ordered = fifoQueue(queue);
  const totalSnippets = ordered.length;
  const localErrors: LinterError[] = [];
  const targetFiles: string[] = [];
  const validOperations: FilePatchOperation[] = [];
  const forbidPatterns: string[] = [];
  const requireExports: Record<string, string[]> = {};
  const commitMessages: string[] = [];

  for (let snippetIndex = 0; snippetIndex < ordered.length; snippetIndex++) {
    const entry = ordered[snippetIndex];
    const operations = entry.payload?.patches ?? [];
    if (operations.length === 0) {
      localErrors.push({
        file: `(empty snippet #${snippetIndex + 1})`,
        stage: 'SEARCH_REPLACE',
        message: 'Code snippet contains no valid patch operations.'
      });
    }

    for (const op of operations) {
      const issue = findRepoPathIssue(op.path);
      if (issue !== null) {
        const preview = (op.blocks?.[0]?.search || op.fullContent || entry.commitMessage || '').slice(0, 120);
        localErrors.push({
          file: op.path?.trim() || `(missing path in snippet #${snippetIndex + 1})`,
          stage: 'SEARCH_REPLACE',
          message: `${issue} Provide a repo-relative path (e.g. "src/App.tsx") in the consolidated patch.`,
          codeSnippet: preview || undefined
        });
        continue;
      }

      const normPath = normalizeRepoPath(op.path);
      if (!targetFiles.includes(normPath)) {
        targetFiles.push(normPath);
      }

      const clonedOp: FilePatchOperation = {
        ...op,
        path: normPath,
        ...(op.blocks ? { blocks: op.blocks.map((b) => ({ ...b })) } : {})
      };

      let lastIdx = -1;
      for (let i = validOperations.length - 1; i >= 0; i--) {
        if (validOperations[i].path === normPath) {
          lastIdx = i;
          break;
        }
      }
      const existingOp = lastIdx >= 0 ? validOperations[lastIdx] : undefined;

      if (existingOp) {
        if (existingOp.action === 'modify' && clonedOp.action === 'modify' && existingOp.blocks && clonedOp.blocks) {
          existingOp.blocks.push(...clonedOp.blocks);
        } else if (
          existingOp.action === 'create' &&
          clonedOp.action === 'modify' &&
          typeof existingOp.fullContent === 'string' &&
          clonedOp.blocks &&
          clonedOp.blocks.length > 0
        ) {
          // Keep create followed by modify in sequence so applyPatchesInMemory chains them in workingFiles
          validOperations.push(clonedOp);
        } else {
          validOperations[lastIdx] = clonedOp;
        }
      } else {
        validOperations.push(clonedOp);
      }
    }

    for (const pattern of entry.payload?.preflight?.forbidPatterns ?? []) {
      if (!forbidPatterns.includes(pattern)) forbidPatterns.push(pattern);
    }

    for (const [filePath, symbols] of Object.entries(entry.payload?.preflight?.requireExports ?? {})) {
      const normExportPath = normalizeRepoPath(filePath) || filePath;
      const merged = requireExports[normExportPath] ?? [];
      for (const symbol of symbols) {
        if (!merged.includes(symbol)) merged.push(symbol);
      }
      requireExports[normExportPath] = merged;
    }

    if (entry.commitMessage) {
      commitMessages.push(entry.commitMessage);
    }
  }

  let validBatch: HarvestedPatch | null = null;
  if (validOperations.length > 0) {
    const payload: GeminiPatchPayload = {
      commitMessage: `batch: ${commitMessages.join(' | ') || `${ordered.length} harvested patches`}`,
      patches: validOperations
    };

    if (forbidPatterns.length > 0 || Object.keys(requireExports).length > 0) {
      payload.preflight = {};
      if (forbidPatterns.length > 0) payload.preflight.forbidPatterns = forbidPatterns;
      if (Object.keys(requireExports).length > 0) payload.preflight.requireExports = requireExports;
    }

    validBatch = {
      id: createStablePatchId('v2_json', payload),
      mode: 'v2_json',
      commitMessage: payload.commitMessage,
      payload,
      timestamp: new Date().toISOString()
    };
  }

  return {
    validBatch,
    localErrors,
    targetFiles,
    totalSnippets
  };
}
