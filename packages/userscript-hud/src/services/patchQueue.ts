import type { HarvestedPatch } from '../types';
import { computePatchSignature } from './patchIdentity';

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
