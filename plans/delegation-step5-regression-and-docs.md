# Delegated Execution: Plan Step 5 — Consolidate Regression Coverage and Project Guidance

## Objective

Consolidate the four review fixes into one reproducible regression gate, close remaining documentation drift, and record the work in the project protocol files. Do not implement Plan Step 6 (final validation/checkpoint commit) — you may run the validations needed to prove this step.

## Context: what already exists

Steps 1–4 are complete and validated:

- `scripts/patches_and_tests/test-v2-prompt-contract.mjs` — V2 payload schema accepted by the harvester, XML validity, V1 fallback preserved.
- `scripts/patches_and_tests/test-target-branch-concurrency.mjs` — target-snapshot patching, `expectedTargetHeadOid`, FIFO source/target OID separation.
- `scripts/patches_and_tests/test-recent-commits-opt-in.mjs` — opt-in default, one-time migration, persistence, checkbox wiring.
- `scripts/patches_and_tests/test-metadata-budget-hard-limit.mjs` — metadata cap and absolute 100k part ceiling.
- Pre-existing suites: `worker-smoke.mjs`, `test-local-cli.mjs`, `test-webhook-worker.mjs`.
- Rule files `.agents/rules/edge-worker-architecture.md`, `.agents/rules/userscript-shadow-hud.md`, and root `agents.md` were updated incrementally.

There is **no root `package.json`** — use Node directly (e.g. `node scripts/patches_and_tests/<file>.mjs`).

## Preflight and scope protection

The worktree contains many modifications from Steps 1–4 and earlier unrelated work. Inspect diffs before editing, preserve everything, and do not reset, revert, or stage anything.

Orientation: root `agents.md`, `plans/STATE.md`, last 25 lines of `plans/EXECUTION_LOG.md` and `plans/TEST_LOG.md`.

## Implementation steps

1. Inspect the four focused tests plus the smoke, CLI, and webhook suites to confirm each review finding has real executable coverage (not only source-substring assertions). Note any genuine gap; do not rewrite existing passing tests wholesale.
2. Add a single consolidated regression runner at `scripts/patches_and_tests/run-regressions.mjs`:
   - runs the four focused review tests plus `test-local-cli.mjs` and `test-webhook-worker.mjs` sequentially;
   - executes each as a child process, captures exit code and concise output, never chains shell operators;
   - prints a compact PASS/FAIL summary table and exits non-zero if any suite fails;
   - accepts an optional flag to skip the live-endpoint smoke suite (documented as such) so an unavailable external `/health` can be separated from local regressions — but never silently skips it by default;
   - keeps the smoke suite available as a separate explicit invocation rather than embedding a network-dependent probe in the default local gate unless it already is local-only.
3. Verify the runner works end-to-end and reports the true status of every suite.
4. Close documentation drift. Check for and fix only real inconsistencies in:
   - root `agents.md` (P1 matrix, mix-flow description, invariant statements about the 100k ceiling, opt-in recent commits, and source/target OID separation);
   - `.agents/rules/edge-worker-architecture.md`;
   - `.agents/rules/userscript-shadow-hud.md`;
   - `REPOMIX_INSTRUCTIONS.md` and `gemini_prompt_instructions.txt` only if they still describe the legacy JSON schema or a default-on recent-commits behavior.
   Do not restate the same rule in multiple files beyond each file's existing role.
5. Record the completed review-fix work in the project protocol:
   - append one `EXECUTION_LOG.md` entry for the consolidated review-fix wave, covering Steps 1–5 with the decisions the user confirmed (existing target branches supported safely; recent commits opt-in with one-time migration);
   - append a corresponding `TEST_LOG.md` entry with the actual commands and real results you observed (mark any external probe failure honestly);
   - update `plans/STATE.md` active stage / last-update line and add the wave to the stage progress list;
   - follow the existing formatting conventions in those files.
6. Run the full validation you need for honest logging: the consolidated runner, the smoke suite, edge-worker / userscript HUD / local-cli type checks, userscript build with dist/root bundle identity check if the build output could have changed, and `git diff --check`. Confirm all active TypeScript files stay under 500 lines.
7. Review the final diff. Report: new/changed paths, the runner's summary output, any remaining documentation gap you deliberately left, and validation results. Do not commit, push, or deploy.

## Expected file scope

- `scripts/patches_and_tests/run-regressions.mjs` (new)
- focused test files only if a genuine coverage gap is proven
- `agents.md`, `.agents/rules/edge-worker-architecture.md`, `.agents/rules/userscript-shadow-hud.md` (drift fixes only)
- `REPOMIX_INSTRUCTIONS.md` / `gemini_prompt_instructions.txt` only for proven legacy-schema or default-on drift
- `plans/EXECUTION_LOG.md`, `plans/TEST_LOG.md`, `plans/STATE.md`

Do not modify worker/HUD source logic, `patcher.ts`, `mixChunker.ts`, generated bundles, or `worker-baseline.json` for this step. If a validation reveals a real defect in Steps 1–4, stop and report it instead of silently broadening scope.

## Acceptance criteria

- One command runs all four review regressions plus CLI and webhook suites and returns a truthful aggregate exit code.
- Each of the four review findings has executable coverage; no finding relies solely on string matching of source text.
- Project documentation states the corrected contracts consistently: V2 payload schema, safe existing-target patching with separate source/target OIDs, recent commits opt-in with one-time migration, and the absolute 100k part ceiling with capped metadata.
- `EXECUTION_LOG.md`, `TEST_LOG.md`, and `STATE.md` accurately reflect what was implemented and what actually passed.
- Validation commands pass (external live-endpoint status reported separately if unavailable); all active TS files under 500 lines; `git diff --check` clean.
- No unrelated edits, no commit, push, or deploy.

## Execution constraints

Follow `.agents/skills/flash/SKILL.md`: one state-changing shell command at a time, no `&&` or `;` chaining, and run a diagnostic command before retrying any failure. This is a FLASH-tier task (complexity 5/10).
