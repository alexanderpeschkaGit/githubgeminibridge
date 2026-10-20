# Delegated Execution: Plan Step 1 — V2 Patch Prompt Contract

## Objective

Correct the RepoMix-embedded and standalone Gemini instructions so generated V2 patches match the contract consumed by the userscript harvester and worker. Add focused regression coverage. Do not implement plan Steps 2–6 or address unrelated review findings.

## Required context

- Canonical V2 contract: `shared/types.ts` (`GeminiPatchPayload`, `FilePatchOperation`).
- Harvester recognition: `packages/userscript-hud/src/dom/harvester.ts` (`parseGeminiPatchPayload`).
- Embedded instructions: `packages/edge-worker/src/modules/mixChunker.ts` (`DEFAULT_MIX_INSTRUCTIONS`).
- User-facing prompt templates: `gemini_prompt_instructions.txt`.
- Existing checks: `scripts/patches_and_tests/worker-smoke.mjs` and the applicable TypeScript package checks.
- Root `agents.md` and `.agents/rules/` are authoritative. Read existing relevant rules before editing.

## Implementation steps

1. Inspect the current contents and existing diff for the above files before editing. The worktree has pre-existing modified and untracked files. Preserve all changes not made for this task; do not reset or overwrite the current user work.
2. Make embedded and standalone V2 instructions use the accepted payload shape:
   - top level: `commitMessage`, `patches`;
   - each patch: `path`, `action` (`modify`, `create`, or `delete`);
   - modify: `blocks` containing exact `search` and `replace` strings;
   - create: `fullContent`;
   - delete: no content fields required.
   Do not put legacy `message`, `files`, or `type` fields in V2 examples. Do not put worker request fields such as `branch` or `expectedHeadOid` in `GeminiPatchPayload`; these belong to the surrounding worker request.
3. Keep the V1 Search/Replace format clearly identified as a separate fallback, not a V2 JSON variant. Preserve the no-placeholder guidance.
4. Ensure the embedded instructions are valid XML text. Replace raw placeholder tags such as `<headOid>` with plain text or XML-escaped text. Avoid literal merge-conflict-marker examples that break `git diff --check`; keep the search/replace illustration unambiguous without literal marker-looking lines if necessary.
5. Add a focused regression check proving the prompt example has the canonical V2 field names and does not advertise the legacy JSON schema. Where practical, parse/validate the example using the harvester parser or the existing V2 contract, and verify the embedded instruction text remains valid XML. Prefer a meaningful functional assertion over brittle source-only checks.
6. Run relevant type checks and the focused smoke/regression test. Run `git diff --check` for the touched changes. Do not claim the full smoke suite passes if the unrelated live health probe is unavailable; report that probe separately.
7. Review the final diff and report only the files changed for this step plus validation results. Do not commit or push.

## Scope

Expected files are `packages/edge-worker/src/modules/mixChunker.ts`, `gemini_prompt_instructions.txt`, and focused existing test/harness files as needed. Touch `shared/types.ts`, `harvester.ts`, or rule files only if inspection shows a direct contract or documentation update is necessary. Do not edit generated userscript bundles for a prompt-only change unless the build workflow demonstrably includes the changed source.

## Acceptance criteria

- Both prompt sources describe the harvester-compatible V2 schema accurately.
- The V2 example can be accepted by the harvester contract; it contains no legacy `message/files/type/content` schema.
- Embedded instructions contain no unescaped placeholder XML tags.
- V1 block format remains a distinct fallback and placeholder prohibitions remain intact.
- Focused checks and `git diff --check` pass; unrelated existing modifications remain untouched.

## Execution constraints

- Follow `.agents/skills/flash/SKILL.md`: one state-changing shell command per step, no shell command chaining, and diagnose failures before retrying.
- Use the Flash tier for this scoped task.
- Never stage or commit unrelated files, and do not deploy or push.
