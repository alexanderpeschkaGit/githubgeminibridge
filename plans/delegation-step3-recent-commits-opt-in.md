# Delegated Execution: Plan Step 3 — Recent Commits Opt-In

## Objective

Make recent commit and volatile-file collection strictly opt-in while keeping the HUD checkbox available. On first upgrade from the prior default-on behavior, migrate any stored `include_recent_commits=true` value to false exactly once. Do not implement Plan Steps 4–6 or unrelated review findings.

## Confirmed decisions

- Worker defaults to no recent-commit API calls unless `includeRecentCommits === true`.
- HUD default and missing-storage fallback are false.
- Migrate legacy stored true to false one time; users may explicitly enable it again afterward.

## Preflight and scope protection

The worktree already has numerous unrelated modifications and untracked files from prior tasks. Inspect relevant file diffs before editing, preserve existing changes, and do not reset/revert or stage/commit anything.

Root `agents.md`, `plans/STATE.md`, the latest 25 lines of `plans/EXECUTION_LOG.md` and `plans/TEST_LOG.md`, and `.agents/WORKFLOWS.md` are the orientation sources. Relevant architecture guidance is in `.agents/rules/edge-worker-architecture.md` and `.agents/rules/userscript-shadow-hud.md`.

## Implementation steps

1. Inspect current changes to `mixer.ts`, `storage.ts`, HUD configuration/UI wiring, related tests, and the recent-commits documentation. Preserve unrelated hunks.
2. In `packages/edge-worker/src/modules/mixer.ts`, call `fetchRecentCommitsAndVolatileFiles` only when `req.includeRecentCommits === true`. Omitted and false values must not trigger any recent-commit API calls. Leave the opt-in count handling and response stats intact.
3. In HUD storage/config, change `DEFAULT_HUD_CONFIG.includeRecentCommits` and missing-key fallback to false. Add a one-time migration for an existing stored `"true"` value:
   - store a migration-version/marker key;
   - before returning config, if migration is not marked complete and the stored option is true, persist false;
   - mark migration complete so a later explicit user opt-in remains true on subsequent loads;
   - new installations with no stored setting remain false;
   - use the established GM/localStorage helpers and error-reporting patterns; avoid an opaque silent migration failure.
4. Keep the existing HUD checkbox and persistence/event behavior: explicit checking still stores true and passes it to `/api/mix`; unchecked state stores false.
5. Add focused regression coverage for worker omitted/false/true behavior and HUD default, legacy-true migration exactly once, and subsequent explicit opt-in persistence. Prefer executable tests with stubs/mocks around storage/fetch where feasible. Update the worker smoke probe if it currently assumes default-on or fails to assert the opt-in contract.
6. Synchronize only directly relevant statements in `.agents/rules/edge-worker-architecture.md` and `.agents/rules/userscript-shadow-hud.md` (and root `agents.md` only if it states a conflicting default). Do not edit logs/plans for later steps.
7. Run focused regression tests, edge-worker and HUD type checks, userscript build and dist/root bundle identity verification if HUD source changes, relevant smoke checks, and `git diff --check`. Report any unrelated live endpoint failure separately; do not bypass the probe.
8. Review the final diff to ensure only Step 3 behavior and directly necessary tests/docs/build artifacts changed. Report modified paths and validation. Do not commit, push, or deploy.

## Expected file scope

- `packages/edge-worker/src/modules/mixer.ts`
- `packages/userscript-hud/src/services/storage.ts`
- `packages/userscript-hud/src/types.ts` and `packages/userscript-hud/src/ui/*` only as needed
- focused test/harness files
- directly related architecture rules if needed
- userscript bundles only if required by the build

## Acceptance criteria

- `includeRecentCommits` omitted and false cause zero recent-commit fetches; true enables metadata fetch.
- New HUD configurations start unchecked/off.
- A legacy stored true is migrated to false once; after explicit opt-in, future config loads preserve true.
- Existing checkbox UI and request wiring continue to work.
- Focused tests, type checks, relevant smoke, build identity, and `git diff --check` pass; active TypeScript sources remain under 500 lines.
- No unrelated edits, commits, pushes, or deployments.

## Execution constraints

Follow `.agents/skills/flash/SKILL.md`: one state-changing shell command at a time, no command chaining, and diagnose failures before retries. This is a FLASH-tier task (complexity 5/10); keep edits localized.
