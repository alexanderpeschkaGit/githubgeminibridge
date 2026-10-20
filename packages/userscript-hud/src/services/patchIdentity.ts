import type { GeminiPatchPayload, HarvestedPatch } from '../types';

/**
 * Recursively sorts object keys so that JSON key order cannot change the identity of a payload.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * Content-derived signature of a harvested patch (mode + commit message + canonical patch list).
 */
export function computePatchSignature(
  mode: HarvestedPatch['mode'],
  payload: GeminiPatchPayload
): string {
  return JSON.stringify([mode, payload.commitMessage, canonicalize(payload.patches)]);
}

function djb2Hash(input: string): number {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return hash >>> 0;
}

/**
 * Deterministic patch id: re-harvesting the same payload always yields the same id,
 * so the HUD queue can never hold duplicates of one distinct patch.
 */
export function createStablePatchId(
  mode: HarvestedPatch['mode'],
  payload: GeminiPatchPayload
): string {
  return 'patch-' + djb2Hash(computePatchSignature(mode, payload)).toString(36);
}
