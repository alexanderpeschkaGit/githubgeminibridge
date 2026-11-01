## Execution Metadata
- **Plan ID:** `plan-20261101165300-u1v2`
- **Artifact Path:** `plans/16_UNIFY_COMMIT_GRAPHQL_ERRORS_AND_TARGET_STALENESS_PLAN.md`
- **Base SHA:** `1c01be95986be9c47df0f1db9f4f74dc467616ae`
- **Recommended Workflow:** `#exec`
- **Recommended Execution Model:** `PRO`
- **Flash-Only Viability:** `YES (Micro-Batched <= 6)`
- **Complexity Assessment:** `6/10` — Unifies V1/V2 commit execution, normalizes GitHub GraphQL/REST errors into actionable statuses, and completes target-branch staleness handling across Worker and HUD.

---

## 1. Architecture & Logic

1. **Step 1 — Shared Error & Legacy Target-Branch Contracts (`shared/types.ts`)** `[Score: 2/10 | Tier: FLASH_LITE]`
   - Add `GitHubErrorCode` (`GIT_CONFLICT`, `BRANCH_PROTECTED`, `REPO_NOT_FOUND`, `BRANCH_NOT_FOUND`, `AUTH_FORBIDDEN`, `RATE_LIMITED`, `VALIDATION_FAILED`, `UPSTREAM_ERROR`).
   - Add optional `errorCode?: GitHubErrorCode` and `retryable?: boolean` to `WorkerPatchResponse`.
   - Add optional `expectedTargetHeadOid?: string` and `createBranchIfNeeded?: boolean` to `CommitRequest`.

2. **Step 2 — GitHub GraphQL & HTTP Error Normalization (`packages/edge-worker/src/utils/githubError.ts`, `githubGraphQL.ts`, `github.ts`)** `[Score: 5/10 | Tier: FLASH]`
   - Throw `GitHubApiError` from `executeGraphQL` while keeping exact legacy `err.message` prefixes (`GitHub GraphQL error: ...` and `GitHub GraphQL HTTP error ...`).
   - Classify stale-ref / non-fast-forward errors (`Expected branch to point to ... but it points to ...`) into `GIT_CONFLICT` (HTTP 409) and extract the 40-char actual HEAD OID.
   - Classify protected branch / ruleset violations (`GH006`, `GH013`, `protected branch`, `repository rule violations`, `Changes must be made through a pull request`) into `BRANCH_PROTECTED` (HTTP 403) with actionable HUD guidance.

3. **Step 3 — Unify V1 and V2 Commit Paths (`packages/edge-worker/src/modules/commitLegacy.ts`, `patcher.ts`, `index.ts`)** `[Score: 6/10 | Tier: PRO]`
   - Implement `handleCommitRequest` in `commitLegacy.ts` (re-exported by `patcher.ts`) using 1-subrequest `fetchMultipleFilesViaGraphQL` at the pinned `commitExpectedHeadOid`, working-tree file chaining, target-branch creation, and normalized commit race handling.

4. **Step 4 — Complete Target-Branch Staleness Handling (`patcher.ts`, `patchOidState.ts`, `patchOidStore.ts`, `hudMixAction.ts`, `hudApplyPatch.ts`, `workerClient.ts`)** `[Score: 6/10 | Tier: PRO]`
   - Return `targetBranch` when a target branch no longer exists at `expectedTargetHeadOid` (both normal and `dryRun`).
   - Omit `targetBranch` on same-branch commit-time `GIT_CONFLICT` and disambiguate same-branch vs. distinct-target conflicts in `resolveConflictOidReset(res, config)`.
   - Annotate `SEARCH_REPLACE` errors when an existing target branch has diverged from the source branch snapshot OID.
   - Reset cached `targetHeadOid` when a fresh RepoMix is loaded or the source `headOid` changes.

5. **Step 5 — Regression Tests & Rule Sync (`test-target-branch-concurrency.mjs`, `edge-worker-architecture.md`, `agents.md`)** `[Score: 4/10 | Tier: FLASH]`
   - Add executable coverage for GraphQL error classification, target-branch staleness edge cases, and unified V1 `handleCommitRequest` execution.
