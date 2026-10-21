## Execution Metadata

- **Recommended Workflow:** `#exec` (linear setup and validation)
- **Recommended Execution Model:** `FLASH`
- **Flash-Only Viability:** `YES (Micro-Batched <= 8)`
- **Complexity Assessment:** Operational setup with a small Wrangler configuration change, a minimal HUD addition (Worker URL input field), and documentation updates; credentials and deployment must remain user-controlled.

## 1. Architecture & Logic

### Scope and current behavior

- Use two independently deployed Cloudflare Workers, one for each GitHub account. Each Worker has its own GitHub Personal Access Token (PAT) and bridge-authentication secret.
- The active Worker source is in `packages/edge-worker/`. Its Wrangler config currently names the existing Worker `gemini-git-bridge`; preserve that name and deployment.
- The HUD supports editing the bridge secret, repository, and branches, but has **no Worker URL input field** today: `worker_url` is only read from storage with a hardcoded default. The plan therefore adds a minimal Worker URL field (Step 4) so account switching is done by editing URL, bridge secret, and repository/branch in the panel. The HUD stores one active configuration, not named account profiles.
- The GitHub PAT is **not** entered in Gemini, the userscript, or the HUD. The PAT is created while signed into GitHub account 2 and entered directly into Cloudflare as a Worker secret. The bridge secret is a separate random value shared between Worker 2 and the HUD.
- Assumption: both Workers will be deployed under the Cloudflare account currently configured in Wrangler. If Worker 2 must be deployed under a different Cloudflare account, stop before deployment and confirm the target account and credentials; do not change the existing `account_id` silently.

### Step 1 — Preflight access and scope [Score: 2/10 | Tier: FLASH_LITE]

1. Check `git status --short`; preserve unrelated work and do not stage it.
2. Confirm the user can sign into GitHub account 2, administer the intended repositories, and access the existing Cloudflare account.
3. Identify the repositories account 2 should access and verify that the existing Worker URL remains the account 1 endpoint. Do not read, print, or copy existing secret values.
4. Confirm that manual HUD switching is acceptable for this first setup. There is no profile selector; this plan adds the missing Worker URL field so switching happens through the panel (URL, bridge secret, repository/branch).

**Exit condition:** the target repositories, GitHub account 2, Cloudflare account, and existing account 1 Worker are identified. If account ownership or permissions are unclear, stop and resolve those first.

### Step 2 — Create a least-privilege GitHub credential for account 2 [Score: 3/10 | Tier: FLASH_LITE]

1. While signed into GitHub account 2, create a **fine-grained personal access token** for the required repository owner and only the repositories the bridge should access.
2. Grant the repository contents permission required to read and write files. Organization-owned repositories may require organization approval; wait for approval before testing.
3. Give the token a clear purpose and expiry, and store it in a password manager until it is entered into Cloudflare.
4. Never send the PAT through chat, put it in the repository, add it to `wrangler.jsonc`, or enter it into the browser HUD. If the selected repositories cannot be reached with a fine-grained token due to GitHub limitations, stop and choose an approved credential approach before broadening permissions.

### Step 3 — Add a named Wrangler environment for account 2 [Score: 4/10 | Tier: FLASH]

1. In `packages/edge-worker/wrangler.jsonc`, add a named environment such as `account2` whose Worker name is `gemini-git-bridge-account2`.
2. Keep the existing top-level Worker name, compatibility date, and Cloudflare account configuration unchanged. The named environment reuses the same worker code while deploying as a separate Worker service.
3. Do not place either PAT or bridge secret in the Wrangler configuration; they must be managed as encrypted Worker secrets.

### Step 4 — Add the Worker URL input field to the HUD [Score: 4/10 | Tier: FLASH]

1. In `packages/userscript-hud/src/ui/hudDomTree.ts`, add a "Worker URL (Edge Worker Endpoint)" label and input (reuse the `hud-input` styling, e.g. a dedicated row above the Worker Secret grid), initialised with `config.workerUrl`. Register the element in the returned `HudDomElements` and extend its type in `hudStylesAndDom.ts`.
2. In `packages/userscript-hud/src/ui/hudConfigBindings.ts`, bind the new field analogously to the existing secret binding: on change, run `sanitizeNoGithubPat`, trim trailing slashes, and `saveHudConfig({ workerUrl })`.
3. Leave `storage.ts` unchanged: `loadHudConfig`/`saveHudConfig` already persist `worker_url`; only the UI wiring is missing.
4. Bump the userscript version (`npm run release:patch` in `packages/userscript-hud/`) so Tampermonkey offers the update, run `npm run build`, and confirm the root `gemini-bridge.user.js` is re-synced with the new bundle.
5. Run `npm run typecheck` in `packages/userscript-hud/` and the existing HUD regressions (`node scripts/patches_and_tests/run-regressions.mjs` including the `test-hud-*.mjs` probes). The new field must not break Probe 10 (all source files stay under 500 lines) and must keep rejecting PAT-shaped values.

### Step 5 — Provision account 2 secrets in the named environment [Score: 3/10 | Tier: FLASH_LITE]

From `packages/edge-worker/`, enter the account 2 PAT into the Wrangler prompt using `npx wrangler secret put GITHUB_PAT --env account2`. Enter a newly generated, unique bridge secret using `npx wrangler secret put WORKER_SECRET --env account2`.

- Use a different bridge secret from account 1. Keep it in a password manager so the HUD can be configured and later switched back.
- Generate the bridge secret with a password manager's cryptographically secure generator (at least 32 random bytes); do not use a memorable password or reuse the GitHub PAT.
- The command prompts for each value; do not append secret values to commands, shell history, logs, or files. Both commands are interactive user gates: the user must type each value into the Wrangler prompt; never pipe or echo values into the command.
- After provisioning, run `npx wrangler secret list --env account2` (reveals only key names) and confirm exactly `GITHUB_PAT` and `WORKER_SECRET` exist for the environment; confirm account 1's secrets were not touched.
- The Worker accepts `GITHUB_PAT`/`GITHUB_TOKEN` and `WORKER_SECRET`/`BRIDGE_SECRET` as equivalent aliases; this plan provisions `GITHUB_PAT` + `WORKER_SECRET` and Step 8 standardises the documentation on that pair.
- Do not copy account 1's PAT. The new PAT belongs to GitHub account 2 and is scoped to its intended repositories.

### Step 6 — Deploy the second Worker only after approval [Score: 4/10 | Tier: FLASH]

1. Review the Wrangler environment configuration and confirm the deployment target is the intended Cloudflare account and the new Worker name.
2. Obtain explicit user approval before the live deployment; deployment is a hard stop.
3. After approval, deploy only the named environment with `npx wrangler deploy --env account2`. Do not deploy the default environment as a shortcut.
4. Record the resulting account 2 Worker URL. Do not expose secret values in deployment notes.

**Exit condition:** account 1 remains deployed at its existing URL, and the account 2 Worker is deployed separately with its own two secrets.

### Step 7 — Configure and verify the HUD for account 2 [Score: 4/10 | Tier: FLASH]

1. Open the HUD settings and set the Worker URL to the account 2 URL and the bridge-secret field to the account 2 `WORKER_SECRET`.
2. Set the repository to the exact `owner/repo` account 2 should access and select the desired source and target branches.
3. Save account 1's Worker URL and bridge secret in the password manager before switching. Because the HUD has one active configuration, switch back by restoring account 1's URL and secret; no account-profile selector is included in this scope. A config switch resets the repo/branch-scoped snapshot OIDs — on switching back, the HUD recovers the current HEAD via `requestBranchHead`; this is expected behavior, not an error.
4. Check the account 2 Worker `/health` response. It should indicate that a bridge secret and GitHub token are configured, without exposing their values.
5. Use the HUD's **Load Repo Mix** to verify authenticated read access. For write verification, use a dedicated test repository or non-production feature branch and obtain user approval before creating a test commit. Do not test by committing to `main` or another protected/default branch. After the write, confirm in the GitHub UI that the test commit's author is associated with account 2.
6. If authentication fails, verify the URL/bridge-secret pair and the correct Wrangler environment. If GitHub denies repository access, correct the PAT scope or organization approval; never work around the failure by placing a PAT in the browser.

### Step 7b — Account-Switch-Button & Owner-Erkennung (Kurzfassung von Plan 09) [Score: 7/10 | Tier: PRO]

Vollständige Spezifikation: `plans/09_ACCOUNT_SWITCH_AND_OWNER_DETECTION_EXECUTION_PLAN.md`. Kernpunkte:

1. **Profil-gescopte Storage-Keys** (`packages/userscript-hud/src/services/storage.ts`): `active_profile` + `account1_*`/`account2_*` für die 6 Profilfelder (`worker_url`, `worker_secret`, `owner`, `owner_repo`, `branch`, `target_branch`); einmalige Migration `account_profiles_migration_v1` seedet Account 1 aus den Legacy-Flat-Keys (Owner aus dem migrierten Repo, Default `alexanderpeschkaGit`), Account 2 Owner = `vijaysikanda`. **Kein Account-2-Fallback auf Account-1-Werte** (leeres Profil bleibt leer); Legacy-Flat-Keys bleiben als Spiegel bestehen.
2. **Neue Module:** `src/services/accountProfiles.ts` (`switchAccountProfile`, `switchAccountProfileWithRepo` [typed_wins], `ownerOfRepo`, `classifyRepoOwner`, `isProfileConfigured`; kein Import aus `ui/`) und `src/ui/hudAccountSwitch.ts` (`bindAccountSwitch`, `refreshAccountHint`; kein Import von `shadowHud`).
3. **HUD-UI** (`hudDomTree.ts`, `hudStylesAndDom.ts`): Owner-Feld „GitHub Owner (active account)“, `👤 Account 1`/`👤 Account 2`-Buttons (aktiver Button `hud-btn-primary` + `aria-pressed`), Inline-Hinweis `ownerHintEl` (`.hud-account-hint`, Warnfarbe `.foreign`). Account-Wechsel leert die Patch-Queue (Confirm-Guard) und setzt `resetPatchOidState()`.
4. **Owner-Erkennung:** Repo des anderen Profils → Inline-Hinweis mit Button „🔁 Zu Account N wechseln“ (typed Repo wird ins Zielprofil übernommen, kein Auto-Switch). Fremde Owner → Warnung; **Mix bleibt erlaubt, Patches werden im HUD vor dem Senden blockiert** (Patch-Guard in `handleApplyPatch`, kein Netzwerk-Call).
5. **Validierung:** HUD `typecheck` PASS, neue Regression `scripts/patches_and_tests/test-account-profiles.mjs` im Aggregat-Gate, `run-regressions.mjs` 13/13, `worker-smoke.mjs` 14/14 (Probe 10 `< 500` Zeilen grün, 38 TS-Dateien), Userscript `2.0.13` (Bundle enthält Account-Buttons + Owner-Feld). Edge-Worker/Wrangler/Secrets unberührt.

### Step 8 — Update setup documentation, validate, and checkpoint [Score: 5/10 | Tier: FLASH]

1. Update `README.md` to describe the active `packages/edge-worker/` directory, the account 2 named environment, secret provisioning, the distinction between the GitHub PAT and bridge secret, manual HUD switching via the new Worker URL field, and safe token rotation/revocation. Document that the Worker accepts `GITHUB_PAT`/`GITHUB_TOKEN` and `WORKER_SECRET`/`BRIDGE_SECRET` as equivalent aliases and standardise the documented commands on the provisioned pair (`GITHUB_PAT`, `WORKER_SECRET`).
2. Run the Worker type check (`npm run typecheck` from `packages/edge-worker/`) and validate the Wrangler configuration without deploying via `npx wrangler deploy --dry-run --env account2` (builds and schema-validates the `env` block; a plain default-environment deploy remains prohibited). Re-confirm the userscript type check, build, and HUD regressions from Step 4 pass.
3. Review `git status --short` and the complete diff. Confirm no secret values, unrelated files, or changes to the existing default Worker name/credentials are included.
4. Stage only the intended paths: `packages/edge-worker/wrangler.jsonc`, `packages/userscript-hud/src/ui/hudDomTree.ts`, `packages/userscript-hud/src/ui/hudConfigBindings.ts`, `packages/userscript-hud/src/ui/hudStylesAndDom.ts`, `packages/userscript-hud/package.json`, root `gemini-bridge.user.js`, `README.md`, and `plans/08_TWO_GITHUB_ACCOUNTS_PLAN.md`. Create a local Conventional Commit with a concise rationale if requested/authorized. Do not push; a push is a separate hard stop requiring explicit user instruction.

## 2. File Inventory

- `packages/edge-worker/wrangler.jsonc` — add the named account 2 deployment environment; leave the existing default Worker intact.
- `packages/userscript-hud/src/ui/hudDomTree.ts` — add the Worker URL label/input to the panel and expose it in `HudDomElements`.
- `packages/userscript-hud/src/ui/hudConfigBindings.ts` — persist the URL through the existing guarded `saveHudConfig({ workerUrl })`.
- `packages/userscript-hud/src/ui/hudStylesAndDom.ts` — extend the `HudDomElements` type with the new field.
- `packages/userscript-hud/package.json` — patch/minor version bump so Tampermonkey can offer the update.
- `gemini-bridge.user.js` (root) — re-synced bundle artifact of the userscript build.
- `README.md` — document account separation, secret setup, switching, verification, and rotation.
- `plans/08_TWO_GITHUB_ACCOUNTS_PLAN.md` — this execution plan.

A minimal userscript change is required because the HUD cannot edit the Worker URL today — without it, manual account switching would be impossible from the panel. No Worker application-code change is required. If a future request asks for saved account profiles or one-click switching, treat it as a separate HUD feature and design/review its storage behavior before implementation.

## 3. Risk & Complexity Check

| Task | Score | Tier | Main risk / mitigation |
|---|---:|---|---|
| Preflight and access confirmation | 2/10 | FLASH_LITE | Avoid exposing existing credentials; inspect names/status only. |
| Create account 2 PAT | 3/10 | FLASH_LITE | Over-broad or unapproved access; restrict repositories and permissions, wait for organization approval. |
| Add Wrangler environment | 4/10 | FLASH | Accidental replacement of account 1 Worker; preserve the default name and use a distinct environment name. |
| Add HUD Worker URL field | 4/10 | FLASH | UI regression or broken save; reuse the existing `worker_url` storage key and guardrail, run HUD regressions, keep all files under 500 lines. |
| Provision secrets | 3/10 | FLASH_LITE | Secret leakage or wrong environment; enter values only at Wrangler prompts and specify `--env account2`. |
| Deploy account 2 | 4/10 | FLASH | Live change; require explicit approval and deploy only the named environment. |
| Configure and verify HUD | 4/10 | FLASH | Wrong URL/secret pairing or unintended commit; use health/read checks and a dedicated test branch. |
| Documentation, validation, checkpoint | 5/10 | FLASH | Unrelated changes staged; inspect diff and stage explicit paths. |

**Combined execution complexity:** 5/10. Steps are sequential but operationally contained.

**Flash-Only Viability:** YES. No planned source file is at or above the repository's 500-line decomposition threshold, and no high-risk application state refactor is required.

## 4. Optimization / Combination Hint

Use `#exec` sequentially. Steps 1–2 prepare the credential and access; steps 3–4 configure the Wrangler environment and the HUD URL field; steps 5–6 provision secrets and deploy (both user-gated); steps 7–8 verify, document, and checkpoint. Keep credential entry and live deployment as explicit user-controlled gates. A `#exec-wave` split is not appropriate because these steps are dependent and touch a small, shared configuration surface.

## 5. Git & Checkpoint Policy

- Before changes, inspect `git status --short`; preserve all pre-existing and unrelated changes.
- Run `npm run typecheck` in `packages/edge-worker/` and `packages/userscript-hud/`, the HUD regressions, and `npx wrangler deploy --dry-run --env account2` before committing. Fix failures caused by the planned changes.
- This plan changes deployment configuration and the userscript UI. Bump the userscript version (versioned code, Step 4); do not bump the edge-worker package version because no Worker code changes.
- Prefer a development branch such as `preview` or a dedicated `task/*` branch. If currently on `main`/`master`, report that before committing.
- Stage only `packages/edge-worker/wrangler.jsonc`, `packages/userscript-hud/src/ui/hudDomTree.ts`, `packages/userscript-hud/src/ui/hudConfigBindings.ts`, `packages/userscript-hud/src/ui/hudStylesAndDom.ts`, `packages/userscript-hud/package.json`, root `gemini-bridge.user.js`, `README.md`, and `plans/08_TWO_GITHUB_ACCOUNTS_PLAN.md`; never use blind `git add .`.
- If committing, use a Conventional Commit message with a concise rationale in the body. Keep the checkpoint local.
- Never push automatically. Live deployment and any test commit to GitHub require their own explicit approvals.

## 6. Acceptance & Invariant Checklist

1. The existing default Wrangler Worker name remains `gemini-git-bridge`; the second environment resolves to a distinct Worker name.
2. Account 2's GitHub PAT and bridge secret exist only as secrets for the account 2 Worker environment; neither appears in source, documentation, shell arguments, chat, or the userscript.
3. Account 2's PAT is scoped to the intended repositories and has the required contents permissions; account 1's PAT and existing deployment remain unchanged.
4. The HUD can authenticate to account 2 using its Worker URL (entered via the new URL field) and matching bridge secret, and can read a permitted repository without placing a GitHub PAT in browser storage.
5. The documented verification uses a dedicated test repository/branch for writes, confirms the resulting test commit is associated with the intended GitHub account, and the Worker/userscript type checks, HUD regressions, and Wrangler dry-run validation pass before any local checkpoint commit.

## References

- [Cloudflare Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
