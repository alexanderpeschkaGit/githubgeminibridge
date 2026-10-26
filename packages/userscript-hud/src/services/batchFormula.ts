import type { HudConfig, HudState } from '../types';

/**
 * Builds the prompt that makes Gemini emit one integratable V2 batch payload:
 * one JSON block, one patches[] entry per file, and search anchors grounded in
 * the active RepoMix snapshot.
 */
export function buildBatchFormulaPrompt(
  config: Pick<HudConfig, 'repo' | 'branch' | 'targetBranch' | 'includePaths'>,
  state: Pick<HudState, 'headOid'>
): string {
  const branchLabel = config.targetBranch?.trim() || config.branch || 'main';
  const headLabel = state.headOid ? ` (base headOid: ${state.headOid.slice(0, 7)})` : '';
  const scopeLabel = config.includePaths?.length
    ? `\n- Active path scope: ${config.includePaths.join(', ')}`
    : '';

  return [
    `Output all code changes for this batch as a SINGLE atomic V2 GeminiPatchPayload JSON code block targeting ${config.repo}@${branchLabel}${headLabel}.${scopeLabel}`,
    'Batch Integration Rules:',
    '1. Emit exactly ONE ```json block with top-level keys "commitMessage" and "patches" (do NOT include worker request fields like branch or expectedHeadOid).',
    '2. Consolidate edits so each file path appears at most ONCE in "patches":',
    '   - Existing files: { "path": "repo/relative/path.ts", "action": "modify", "blocks": [{ "search": "...", "replace": "..." }] }',
    '   - New files: { "path": "repo/relative/new.ts", "action": "create", "fullContent": "..." }',
    '   - Deleted files: { "path": "repo/relative/old.ts", "action": "delete" }',
    '3. Every "search" string MUST include 2-4 lines of unique verbatim surrounding context from the RepoMix snapshot.',
    '4. NEVER use placeholders ("// ... existing code ...", "/* rest unchanged */") or unclosed brackets/JSX tags.',
  ].join('\n');
}
