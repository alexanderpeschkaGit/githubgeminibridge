# Delegated Execution: Plan Step 4 — Bound Metadata and Enforce Final Part Size

## Objective

Prevent recent-commit metadata from pushing any RepoMix part over Gemini's 100,000-character hard cutoff, and guarantee that every emitted part (including the single-part path) is measured and kept within that absolute limit. Do not implement Plan Steps 5–6 or unrelated review findings.

## Confirmed decisions

- Recent commits remain an explicit opt-in (Step 3 is complete); this step only bounds the metadata when it is enabled.
- `HARD_GEMINI_CHAR_LIMIT` is an absolute ceiling. A user-supplied `maxChunkChars` may tighten but never raise it above 100,000.
- Truncate/cap metadata deterministically with a visible marker rather than silently overflowing.
- Never return an oversized part as a successful result.

## Preflight and scope protection

The worktree already contains many unrelated modifications and untracked files from earlier steps. Inspect current diffs before editing, preserve all existing changes, and do not reset, revert, or stage anything.

Orientation: root `agents.md`, `plans/STATE.md`, last 25 lines of `plans/EXECUTION_LOG.md` and `plans/TEST_LOG.md`. Architecture rule: `.agents/rules/edge-worker-architecture.md` (Mix-Engine section).

## Current defects to fix in `packages/edge-worker/src/modules/mixChunker.ts`

1. `input.recentCommitsText` is injected unbounded into the single-part path and Part 1, while the oversized-file check considers only a standalone file envelope.
2. `const hardFileLimit = Math.max(effectiveMaxChars, HARD_GEMINI_CHAR_LIMIT)` lets a large user budget raise the ceiling above the true hard limit instead of clamping to it.
3. No post-construction validation measures the final serialized `xmlContent.length` of each emitted part (single-part result included).

## Implementation steps

1. Inspect `mixChunker.ts` and the Step 3 tests first. Note the current 306-line size; keep the file and any helper module well under the 500-line law.
2. Introduce an explicit metadata cap constant (for example `MAX_RECENT_COMMITS_CHARS`) and a small exported helper that truncates the metadata deterministically:
   - preserve complete leading lines where practical;
   - append a clear marker such as `... [recent_commits truncated to preserve character budget]`;
   - return an empty string for empty/absent metadata.
3. Cap metadata before partitioning, and additionally clamp it to the actual remaining Part 1 budget so the combined instructions + file tree + metadata + file envelopes stay within the target budget and always below the hard limit.
4. Use the capped metadata consistently in: the single-part fast path, `partitionFiles` Part 1 overhead, `totalRawChars` upscale math, and the Part 1 `buildPartXml` call. Do not let the raw value reach any of these paths.
5. Clamp budgets against the absolute hard limit so no configuration can exceed it. A user `maxChunkChars` above 100,000 must not raise the ceiling; treat it as an upper bound only after clamping to `HARD_GEMINI_CHAR_LIMIT`.
6. After building every part (single-part result and each multi-part entry), measure the final serialized size and enforce `<= HARD_GEMINI_CHAR_LIMIT`:
   - if only metadata is responsible, re-truncate metadata and rebuild the part;
   - if an indivisible file still cannot fit after metadata removal, resolve deterministically (skip that file with a visible `[SKIPPED: ...]` tree annotation or fail explicitly per the existing design intent) rather than returning an oversized part;
   - keep the resolution deterministic and non-recursive-looped (bounded retries).
7. Preserve existing public exports and behavior for normal-size inputs, the max-10-parts guardrail, atomic no-file-splitting, `.txt` file naming, and stats shape.
8. Add a focused executable regression test (new script next to the existing Step 1–3 tests) that proves:
   - very large recent-commit metadata yields no part above 100,000 characters;
   - a user budget above 100,000 cannot produce an oversized part;
   - a pathological combination of large metadata plus an indivisible large file still yields only conforming parts and a visible skip/truncation signal;
   - normal small inputs keep their existing single/multi-part behavior and stats.
   Prefer constructing inputs and asserting measured lengths on the returned parts over source-substring checks.
9. Extend `scripts/patches_and_tests/worker-smoke.mjs` only with a meaningful assertion for this invariant if the existing probe does not already cover it; avoid brittle string-only checks.
10. Synchronize the Mix-Engine invariant text in `.agents/rules/edge-worker-architecture.md` (and root `agents.md` only if it states a conflicting rule) to document: metadata is capped before partitioning and every emitted part is validated against the absolute 100k ceiling.
11. Run: focused new test, `node scripts/patches_and_tests/test-recent-commits-opt-in.mjs`, edge-worker type check, worker smoke suite (report an unrelated live-health failure separately, do not skip it), and `git diff --check`. Confirm all active TypeScript sources stay under 500 lines.
12. Review the final diff to confirm only Step 4 behavior and directly necessary tests/docs changed. Report modified paths, measured worst-case part sizes from the regression, and validation results. Do not commit, push, or deploy.

## Expected file scope

- `packages/edge-worker/src/modules/mixChunker.ts` (and a small new helper module only if the 500-line law requires it)
- a new focused regression test under `scripts/patches_and_tests/`
- `scripts/patches_and_tests/worker-smoke.mjs` only if a meaningful invariant assertion is missing
- `.agents/rules/edge-worker-architecture.md` (and root `agents.md` only if conflicting)

Do not modify `patcher.ts`, `mixer.ts`, HUD sources, or generated bundles for this step. `mixer.ts` already passes capped metadata? Verify: if `mixer.ts` supplies an uncapped value but the cap belongs in the chunker contract, enforce it in the chunker. Only touch `mixer.ts` if a direct contract change is unavoidable.

## Acceptance criteria

- Recent-commit metadata is capped before partitioning and never injected unbounded.
- No configuration (including `maxChunkChars > 100000`) can raise the effective ceiling above `HARD_GEMINI_CHAR_LIMIT`.
- Every returned part — single or multi, including Part 1 with metadata — is measured and `<= 100_000` characters.
- Oversized indivisible files are handled by a deterministic, visible skip/failure; no oversized success-shaped result.
- Existing behavior for normal-sized repos, part naming, the 10-part guardrail, and atomic file separation is unchanged.
- Focused tests, type check, smoke suite, and `git diff --check` pass; all active TS files under 500 lines.
- No unrelated edits, commits, pushes, or deployments.

## Execution constraints

Follow `.agents/skills/flash/SKILL.md`: one state-changing shell command at a time, no `&&` or `;` chaining, and run a diagnostic command before retrying a failure. This is a FLASH-tier task (complexity 6/10); keep edits localized and verify with measured assertions.
