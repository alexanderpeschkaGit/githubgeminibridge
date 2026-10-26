# Plan 12 — RepoMix part-count optimisation (DFLASH, budget mode)

> Active profile: `#dflash` — `.agents/skills/flash/SKILL.md`, budget mode, no Pro escalation.
> Executor: Batch Executor (Kilo Mode E). Single-Action Protocol enforced.

## Objective
Prevent the false-positive error `RepoMix needs more than 10 parts to preserve all files within the 100000-character limit.` when raw file content is well under the limit. Root causes: input-order first-fit packing, per-part XML/tree/instructions overhead, and a budget search that only escalates after failure.

## Invariants (must not change)
- `MAX_GEMINI_PARTS = 10`, `HARD_GEMINI_CHAR_LIMIT = 100_000`, `DEFAULT_MAX_CHUNK_CHARS = 85_000`, `.txt` part naming, `repo-mix.part${partNum}.txt`, `<file path="...">`, full master `file_tree` in part 1, continuation instructions.
- Never split a file. Never silently drop a file. If impossible, fail explicitly with diagnostics.
- `packages/edge-worker/src/modules/mixChunker.ts` must remain `< 500` lines (currently 439). If edits would reach 500, extract pure helpers into a new module `<= 300` lines and report it; do not exceed 500.
- **`mixChunker.ts` must stay `< 500` lines — Probe 10 in `scripts/patches_and_tests/worker-smoke.mjs` enforces this.**
- Scope: `mixChunker.ts` only, plus `plans/12_...md`. A test-file change is allowed ONLY under the explicit condition in Batch 3.

## Execution batches (serial; same file => no parallel agents)

### Batch 0 — Baseline (no edits to source)
Read `mixChunker.ts` and `scripts/patches_and_tests/test-metadata-budget-hard-limit.mjs`. Run the existing regression once on the unmodified source and record the printed part counts for the 1,500-long-path cases and whether the 5,000-long-path case throws. This is the before-baseline.

### Batch 1 — First-Fit Decreasing (FFD) packing (highest ROI)
In `partitionFiles` (~lines 317-362):
1. Build `packList = [...validFiles].sort(size desc by fileXml.length, tie-break path asc)`.
2. Place each file into the FIRST existing bucket whose `serializedSize([...bucket, file], bucketIndex) <= partBudget`; only open a new bucket when no existing bucket fits.
3. Keep using the existing `serializedSize` as the source of truth (it accounts for part index, tree text, instructions, envelope). Do not substitute a cheaper estimate for the final fit decision.
4. Preserve the single-part fast path and `fitPart` behavior. Keep deterministic output.

### Batch 2 — Overhead-aware budgeting
1. Add a small helper that measures part overhead (empty bucket) via `buildPartXml` for a given part index/total/meta state; use it only to short-circuit obviously non-fitting candidates. Always confirm with `serializedSize` before committing a bucket.
2. Replace the rough `part1OverheadGuess` decision path with the measured overhead where practical; keep the existing metadata cap logic.
3. Guard against `usable <= 0` and infinite/pathological loops: fall back to existing behavior and let precise errors report sizes.

### Batch 3 — Budget ladder + actionable errors
1. Budget order MUST be: first `effectiveMaxChars` (85k default), then only if `parts > MAX_GEMINI_PARTS` try `min(95_000, HARD_GEMINI_CHAR_LIMIT)`, then `HARD_GEMINI_CHAR_LIMIT`. Do NOT try 95k first: `test-metadata-budget-hard-limit.mjs` Case 4b asserts normal parts stay `<= DEFAULT_MAX_CHUNK_CHARS`.
2. If all attempts exceed 10 parts, throw the existing human-readable error plus metrics: `files`, `largestFileXmlChars`, `partsTriedAt85k`, `partsTriedAt95k`, `partsTriedAt100k`, `part1OverheadChars`, `treeChars`, `cappedMetaChars`.
3. Preserve all other explicit error paths; optionally include `partNum` and measured chars.
4. Do NOT increase `MAX_GEMINI_PARTS` and do NOT relax the 100k hard ceiling.
5. Test-change condition: `test-metadata-budget-hard-limit.mjs` Case 3d expects 5,000 long paths to throw. If FFD now legitimately fits all 5,000 files in `<= 10` conforming parts (`<= 100_000` chars each, all files accounted for), you MAY update ONLY that assertion to accept the improved success with strict assertions (part count, per-part ceiling, file accounting). If it still throws, leave the test untouched. Report which happened with measured numbers. Do not weaken any guardrail.

### Batch 4 — Validation (sequential, no chaining)
Run each command separately and capture output:
1. `cd packages/edge-worker` then `npm run typecheck`
2. `node scripts/patches_and_tests/test-metadata-budget-hard-limit.mjs`
3. `node scripts/patches_and_tests/test-recent-commits-opt-in.mjs`
4. `node scripts/patches_and_tests/worker-smoke.mjs`
Also confirm `mixChunker.ts` is `< 500` lines and the exact strings required by Probe 10 survive: `DEFAULT_MAX_CHUNK_CHARS = 85_000`, `MAX_GEMINI_PARTS = 10`, `repo-mix.part${partNum}.txt`.
If a check fails, run one diagnostic, attempt ONE targeted repair, then re-run. If it still fails, STOP in Graceful Pause (Dirty Inspection): keep edits on disk, do not revert, and report the exact command, exit code, and failing lines. Budget mode forbids Pro escalation.

## Out of scope
No git commit/push, no deploy, no version bumps, no change to `MAX_GEMINI_PARTS`/100k limit, no changes to HUD/injector, no whole-file rewrites.

## Acceptance
- FFD packing implemented deterministically; normal inputs still produce the same single-part/multi-part contract and 85k target.
- Part count does not increase vs baseline for the 1,500-long-path cases; ideally decreases.
- If still impossible, the error carries the metrics.
- Typecheck, hard-limit regression, recent-commits regression, and worker-smoke pass (or a documented Graceful Pause with exact failures).
- Plan file saved at `plans/12_REPOMIX_PART_COUNT_OPTIMIZATION_DFLASH_PLAN.md`.
