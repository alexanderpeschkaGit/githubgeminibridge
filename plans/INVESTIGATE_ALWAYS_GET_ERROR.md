# Plan: Investigate why \"always get this error\" occurs

## Problem statement recap
The user says: \"investigate why i always get this error. #plan how to solve step by step. write only on e file: the plan with as .md\"
They see \"always get this error\" in context. The codebase has HUD/patch flow where missing snapshot gives errors like:
- \"No repo mix snapshot for ...\" (patchOidState.patchSnapshotRequiredMessage)
- Live HEAD recovery path exists (requestBranchHead + setSourceHeadOid in hudApplyPatch)
- Scope logic separates source/target OIDs (patchOidStore/patchOidState)
- GIT_CONFLICT handling discards stale OIDs with hints

But \"always get\" could refer to recurring errors: GIT_CONFLICT, missing snapshot, foreign owner block, etc.

## Root cause (confirmed 2026-10-29, live reproduction)
The reported error comes from the **mix** path, not the patch path:

`❌ Mix error: GitHub tarball fetch failed with HTTP 404 (Not Found): 404: Not Found`

Reproduced against the deployed default worker (`/health` = `2.0.4`) using the HUD's shipped defaults:
- `POST /api/mix` with `repo=alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0`, `branch=preview` -> HTTP 400 with the exact error above.
- The same worker's `/graphql` confirms the repository exists with `defaultBranchRef.name = "main"`; `refs/heads/preview` is `null`.
- The same request with `branch=main` -> `status: OK`, `headOid=faeaefa...`.

So the worker, secret and GitHub token are healthy. GitHub returns the tarball 404 because the **configured branch does not exist** in the configured repository. GitHub uses the same 404 for a missing ref and for a private/inaccessible repository, which is why the raw message is ambiguous. A fresh install or cleared GM storage falls back to the shipped default pair, and that pair paired `Portfolio_VJ_Brave_V2_0` with the non-existent `preview` branch — so every "Load Repo Mix" repeated the error.

## Investigation
### Relevant code paths
1. Userscript HUD apply flow (packages/userscript-hud/src/ui/hudApplyPatch.ts)
- Checks foreign owner first (blocks commit on foreign owner)
- Resolves patch paths
- If !isPatchSnapshotReady(state): calls requestBranchHead to get current HEAD via worker /graphql proxy, calls setSourceHeadOid(config, state, resolvedOid). Catches and rethrows with patchSnapshotRequiredMessage + \"(HEAD lookup failed: ...)\"
- Builds request with buildWorkerPatchRequest (uses state.headOid; for distinct target may send expectedTargetHeadOid)
- Handles COMMITTED, PREFLIGHT_FAILED (self-healing), GIT_CONFLICT/ERROR (resets source or target OID via resolveConflictOidReset), NO_CHANGES_NEEDED
- If no headOid after recovery attempt, throws patchSnapshotRequiredMessage

2. OID scope/state (packages/userscript-hud/src/services/patchOidState.ts, patchOidStore.ts)
- OIDs scoped to repo#branch via buildOidScope. If scope mismatches on load, state cleared.
- On GIT_CONFLICT: if response.targetBranch present -> reset target only; else reset source.
- advancePatchOidState updates source/target based on response.

3. Worker patch (packages/edge-worker/src/modules/patcher.ts / patchInMemory.ts) - enforces expectedHeadOid/concurrency, validates paths, lints, may return GIT_CONFLICT/PREFLIGHT_FAILED

### Likely causes of \"always get this error\"
- Stale/mismatched OID scope: after repo/branch switch, stored head_oid_scope differs -> cleared; if user didn't run \"Load Repo Mix\" and HEAD lookup also fails (network/auth/branch not found) -> error repeats
- Fresh install / cleared storage: no snapshot, HEAD lookup fails (wrong workerUrl/secret, repo not accessible via token, branch name case/refs) -> fallback message
- Foreign owner: classifyRepoOwner returns 'foreign' for non-registered accounts -> hard block with specific message
- Target branch race: target OID stale -> GIT_CONFLICT with targetBranch set -> target reset, user retries but target keeps moving or logic issue
- Worker auth/config: wrong workerSecret/workerUrl -> requests fail

## Step by step plan to solve
### Step 1: Reproduce and capture exact error
- Check HUD status message text when error occurs (copy full message)
- Look at browser console/network for failing requests (requestBranchHead to /graphql, /api/patch)
- Check Tampermonkey script version, storage keys (head_oid_scope/head_oid/target_*)

### Step 2: Verify storage/scope state
- Inspect GM_getValue for keys: head_oid_scope, head_oid, target_head_oid, target_head_branch, repo, branch, targetBranch, owner, workerUrl, workerSecret, active_profile
- If scope mismatch -> normal; need fresh mix or HEAD recovery

### Step 3: Test HEAD recovery path
- Ensure workerUrl/secret valid
- Test requestBranchHead manually against /graphql for repo@branch
- Check if branch exists and token has read access

### Step 4: Fixes based on findings
- If HEAD lookup fails due to auth: fix workerSecret / ensure logged into correct GitHub account
- If foreign owner: switch to registered account or use allowed repo
- If scope keeps clearing: verify repo/branch normalization (case, refs/heads/)
- If target branch issues: clear target OID or use correct targetBranch
- If persistent: add logging/better error surfacing

### Step 5: Verification
- Run smoke/regression tests: node scripts/patches_and_tests/run-regressions.mjs (or relevant)
- Test full flow: Load Repo Mix -> make change in Gemini -> Push via Bridge
- Verify OIDs stored with correct scope

## Concrete next actions
1. Read full error message from user (exact text). Ask for it if truncated.
2. Check packages/userscript-hud/src/ui/hudApplyPatch.ts and workerClient.ts for the exact message
3. Add defensive logging or test with reproduction
4. Apply fix and verify

Note: The codebase already implements HEAD recovery (added in 2.0.6). If user \"always gets this error\", likely HEAD lookup fails silently or foreign owner blocks. Current @version 2.0.15.

## Resolution (executed 2026-10-29)
1. `packages/edge-worker/src/modules/mixer.ts`: normalize `refs/heads/...`/blank branch fields to the plain branch (`main` as the last resort) before building the tarball URL. On a tarball 404, verify the ref via the existing GraphQL helper and return an actionable diagnosis: missing branch plus the repository's actual default branch, inaccessible repository/token, or an unexpected tarball failure. The generic HTTP body is kept in the message.
2. `packages/userscript-hud/src/services/storage.ts`: ship a valid default pair (`Portfolio_VJ_Brave_V2_0@main` instead of the non-existent `preview` branch).
3. New regression `scripts/patches_and_tests/test-mix-tarball-404.mjs` covers all three diagnosis paths and is registered in the aggregate gate.
4. Operator action: set the HUD **Branch** field to an existing branch (`main` for `Portfolio_VJ_Brave_V2_0`; `preview` for `sikanda_projectinart_11-on-main`), update the userscript, and deploy the worker. The raw tarball 404 cannot be fixed by retrying or by a repo mix.

5. Consolidated Release (`plan-20261029221634-0f4k`): `describeTarballNotFound` was further optimized to reuse `BranchNotFoundError.defaultBranch` in a single GraphQL query (1 subrequest instead of 2). The live Worker rollout (`v2.0.8` on Default + Account-2) and HUD release (`v2.0.20`) are unified into `plan-20261029221634-0f4k`.
