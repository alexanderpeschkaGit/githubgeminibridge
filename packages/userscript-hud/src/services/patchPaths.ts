import type { GeminiPatchPayload } from '../types';
import { findRepoPathIssue, normalizeRepoPath } from '../../../../shared/repoPaths';

/** Asks for a missing path. Returning `null` cancels the apply. */
export type PathPrompt = (index: number, total: number) => string | null;

export interface ResolvedPatchPaths {
  payload: GeminiPatchPayload;
  cancelled: boolean;
  reason?: string;
}

/**
 * Fills in patch paths that could not be detected from the chat output.
 * The harvester must never invent a target path (the former `src/update.ts`
 * fallback silently pointed every path-less search/replace block at a file that
 * usually does not exist), so the user is asked exactly once per missing path.
 */
export function resolvePatchPaths(
  payload: GeminiPatchPayload,
  prompt: PathPrompt
): ResolvedPatchPaths {
  const patches = (payload.patches || []).map((patch) => ({
    ...patch,
    path: normalizeRepoPath(patch.path),
  }));
  const missing = patches.filter((patch) => findRepoPathIssue(patch.path) !== null);

  for (let index = 0; index < missing.length; index++) {
    const answer = prompt(index + 1, missing.length);
    if (answer === null || answer === undefined) {
      return {
        payload,
        cancelled: true,
        reason: 'Patch cancelled — no file path provided. Add a "// filepath: src/your-file.ts" hint to the code block and harvest it again.',
      };
    }
    const candidate = normalizeRepoPath(answer);
    const issue = findRepoPathIssue(candidate);
    if (issue) {
      return { payload, cancelled: true, reason: issue };
    }
    missing[index].path = candidate;
  }

  return { payload: { ...payload, patches }, cancelled: false };
}
