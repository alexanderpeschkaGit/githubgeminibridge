# Delegated Execution: Plan Step 2 — Safe Existing Target Branches

## Objective

Fix target-branch patching so an existing target branch's content is never overwritten by a patch computed from the source branch, and ensure FIFO HUD patching advances the correct branch OID. Treat this as a high-risk cross-package concurrency/state change and execute at PRO tier. Do not implement Plan Steps 3–6 or unrelated findings.

## Decisions already confirmed by the user

- Existing target branches remain supported; do not reject them.
- When an existing target branch is selected, read and apply the patch against the current target branch content and commit with concurrency protection for that target HEAD.
- A newly created target branch starts from the source branch's validated `expectedHeadOid`.
- Keep source and target HEADs distinct in HUD state. For queued target-branch patches, advance the target OID from each successful commit response. For patches to the source branch, continue advancing the source OID.
- Preserve sequential FIFO execution, fail-fast behavior, and successful-patch pruning.

## Required context

- Contract: `shared/types.ts` (`WorkerPatchRequest`, `WorkerPatchResponse`).
- Worker implementation: `packages/edge-worker/src/modules/patcher.ts`, plus GitHub helpers in `packages/edge-worker/src/utils/github.ts`.
- HUD state and queue: `packages/userscript-hud/src/types.ts`, `packages/userscript-hud/src/ui/shadowHud.ts`, and relevant storage/helpers.
- Existing target-branch and queue rules: `.agents/rules/edge-worker-architecture.md`, `.agents/rules/userscript-shadow-hud.md`, and root `agents.md`.
- Regression harness: `scripts/patches_and_tests/worker-smoke.mjs` and relevant existing test scripts.
- Read current diffs and status before editing. This worktree already contains unrelated modifications and generated/untracked files. Preserve them.

## Implementation requirements

1. Inspect the current patch flow end-to-end before editing. Preserve source-branch freshness verification against `expectedHeadOid`.
2. Resolve the effective target branch before fetching files. Fetch target file contents from the branch whose HEAD will receive the commit, then run the existing in-memory patch/preflight pipeline against those contents.
3. For an existing target branch, capture the exact target HEAD used for the read and pass that OID into the atomic commit operation. If that target HEAD changes before commit, return `GIT_CONFLICT`; never silently use a later target HEAD with additions derived from an earlier/source snapshot.
4. For a missing target branch, retain the existing `createBranchIfNeeded` behavior, create it at the source `expectedHeadOid`, and apply against the resulting branch snapshot. Handle concurrent branch creation explicitly; do not broadly swallow target-lookup or API failures as “branch does not exist” unless the GitHub response reliably distinguishes not-found from other errors.
5. Add an optional target-branch expected OID field to the request if needed for queued concurrency. Keep it separate from source `expectedHeadOid`. Ensure the worker validates supplied target OIDs and returns the effective target branch HEAD on successful commits and no-op responses as needed for queue continuation. Preserve backward compatibility for clients that omit the optional field.
6. Update HUD state/request construction so source and target OIDs cannot be confused:
   - requests to the source branch use and advance the source OID;
   - requests to a distinct target branch use the target OID when known and advance it from the worker response;
   - do not update the source OID merely because a target branch was committed;
   - failures/conflicts do not advance OIDs or incorrectly prune queued patches.
7. Add focused functional regression coverage for:
   - an existing target with target-only file content, proving the patch read/apply path preserves it;
   - stale target HEAD conflict behavior;
   - new target branch creation from the validated source OID;
   - FIFO follow-up request using the returned target OID while source OID remains unchanged;
   - no-op / failure paths leaving OID state consistent.
   Prefer executable behavior tests with mocked GitHub calls over only checking for source substrings. Update the worker smoke probe only as one layer of coverage.
8. Synchronize `.agents/rules/edge-worker-architecture.md`, `.agents/rules/userscript-shadow-hud.md`, and root `agents.md` where their branch/OID invariants are now inaccurate. Keep all active TS files under 500 lines; extract a small helper if necessary rather than breaching the limit.
9. Run the relevant edge-worker and HUD type checks, focused tests, worker smoke suite (report live-health failure separately if the unrelated endpoint is unavailable), userscript build if source changes require it, and `git diff --check`. Verify generated bundle identity if rebuilt.
10. Review the final diff and report changed paths, behavioral guarantees, tests, and any blocked checks. Do not commit, push, or deploy.

## Expected file scope

- `packages/edge-worker/src/modules/patcher.ts`
- `shared/types.ts`
- `packages/userscript-hud/src/types.ts`
- `packages/userscript-hud/src/ui/shadowHud.ts` and only directly relevant HUD state/storage helpers
- focused test/harness files
- `.agents/rules/edge-worker-architecture.md`
- `.agents/rules/userscript-shadow-hud.md`
- `agents.md`
- generated userscript bundle only if HUD source changes require it

Do not modify `packages/edge-worker/src/modules/patchInMemory.ts` unless the end-to-end investigation proves a necessary, tightly coupled change; it is a tagged file and currently 290 lines. Avoid touching unrelated pre-existing edits.

## Acceptance criteria

- Existing target-branch patches are computed from target-branch content and committed atomically against the same target HEAD.
- Source freshness validation remains in place; creating a new target uses the source's validated OID.
- A target race yields a conflict, not an overwrite.
- HUD maintains independent source/target OIDs and sequential target-branch patches use the prior target commit's OID.
- OID advancement and queue pruning occur only on successful/idempotent outcomes consistent with existing fail-fast semantics.
- Focused tests and relevant type checks pass; all modified active TS sources remain below 500 lines.
- No commit, push, deploy, or unrelated cleanup.
