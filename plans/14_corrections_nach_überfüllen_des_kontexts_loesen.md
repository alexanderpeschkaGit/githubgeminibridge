#flash #exec-wave

## Execution Metadata

- **Plan ID:** plan-20261030203000-rv01
- **Artifact Path:** .tmp/plans/plan-20261030203000-rv01.md
- **Base SHA:** 54182372500d895e3e5cf9472485107fdfc97263
- **Recommended Workflow:** `#exec-wave` (or `#exec all`)
- **Recommended Execution Model:** FLASH
- **Flash-Only Viability:** YES (Micro-Batched <= 6)
- **Complexity Assessment:** 3 disjoint Flash batches (Score 4–5/10 each) + 1 final verification/checkpoint gate (Score 3/10). All touched files stay strictly below 500 lines.

---

## 1. Architecture & Logic

### Phase 1 — Parallel Wave 1 (Disjoint File Scopes)

#### Batch 1: Mix-Engine Line-Budget Relief, Continuation Ordering & Priority Tiers `[Score: 5/10 | Tier: FLASH | Independent]`
1. **`packages/edge-worker/src/modules/mixSelection.ts`:**
   - Restrict ` priorityTier(filePath)` Tier 1 (`ENTRYPOINT_PATTERN`) to root or active source trees (`segments.length === 1 || filePath.startsWith('src/') || filePath.startsWith('shared/') || filePath.startsWith('packages/')`) so legacy read-only trees like `cf-gemini-git-bridge/src/index.ts` do not outrank `packages/*`.
   - Separate `.agents/` and `scripts/` into Tier 3, and push `plans/` and other miscellaneous files to Tier 4 so active rules and regression scripts are never dropped before historical plan markdown files.
   - Update `buildTruncationNotice` to accept optional `firstContinuationPart?: number` and clarify in `continuationNotice` that once continuation parts are attached in a follow-up prompt, their files may be patched (while preserving the exact substring `${summary.continuationFilesCount} omitted file(s) are pre-packed into ${summary.continuationPartsCount ?? 0} continuation part(s) (Parts ${firstCont}-${lastCont}) for follow-up prompt attachment`).
   - Extract and export `buildMixTruncation(...)` here from `mixChunker.ts` to keep `mixChunker.ts` well below 450 lines.
2. **`packages/edge-worker/src/modules/mixChunker.ts`:**
   - Guard the Step 3 single-part fast path so `singleRawXml` and `single = fitPart(...)` are only constructed when `validFiles` raw XML sum can plausibly fit within `HARD_GEMINI_CHAR_LIMIT`, avoiding multi-megabyte string allocations on large multi-part repositories.
   - Run the `budgetLadder` on `keptFiles` *before* invoking `buildContinuationParts`, then pass `basePartCount: chunkBuckets.length` into `buildContinuationParts` so continuation part numbering (`partIndex`) is always contiguous with the actual emitted base parts (`1..chunkBuckets.length`).
   - Delegate the final `MixTruncation` object construction to `buildMixTruncation` from `./mixSelection`, reducing `mixChunker.ts` from 491 lines to ~435 lines.
3. **`.repomixignore.cf`:**
   - Add `cf-gemini-git-bridge/` so the read-only V1 legacy folder is excluded from RepoMix snapshots alongside `gemini-bridge.user.js`.

#### Batch 2: HUD Continuation Safety, Shadow-DOM Popover Retargeting & CSS Compaction `[Score: 5/10 | Tier: FLASH | Independent]`
1. **`packages/userscript-hud/src/ui/hudMixAction.ts`:**
   - In `dom.continueMixBtn.onclick`, verify `findPromptInputElement()` is non-null before attempting to inject prompt text or file parts; if missing, set `status: 'ERROR'` and preserve `state.continuationQueue` untouched.
   - On successful injection of continuation parts, explicitly set `status: 'IDLE'` in `updateState` so a prior error state is cleared.
2. **`packages/userscript-hud/src/ui/hudRepoHistoryDropdown.ts`:**
   - Add `e.stopPropagation()` on `dom.repoHistoryMenu.onclick` and check `event.composedPath?.()` inside `handleOutsideClick` so Shadow-DOM retargeting to `dom.host` never prematurely closes the menu when clicking inside the popover.
   - Store and clean up any previous `document` `click`/`keydown` listeners across HUD re-mounts via a module-level cleanup reference, and expose `closeMenu` on `RepoHistoryDropdownRefresher` (or close the menu on `refresh()` when switching accounts).
3. **`packages/userscript-hud/src/ui/hudConfigBindings.ts`:**
   - In `dom.repoInput.onchange`, sync `dom.repoInput.value = sanitized;` after `sanitizeRepo(...)` so pasted full GitHub URLs display in canonical `owner/repo` form and `typed_wins` switches read the sanitized value.
4. **`packages/userscript-hud/src/ui/hudStylesAndDom.ts`:**
   - Compact multi-line CSS rules in `HUD_STYLES` (without changing any selectors or property values) to reduce `hudStylesAndDom.ts` from 473 lines to ~420 lines.

#### Batch 3: Regression Suite Coverage `[Score: 4/10 | Tier: FLASH | Depends on: Batch 1, Batch 2]`
1. **`scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs`:**
   - Add assertions verifying:
     - `.agents/rules/*` and `scripts/*` rank ahead of `plans/*` and `cf-gemini-git-bridge/*` in `rankFilesForOmission`.
     - `mixChunker.ts` and `hudStylesAndDom.ts` line counts remain `< 465` lines.
     - `dom.repoInput.onchange` writes the sanitized `owner/repo` back to `dom.repoInput.value`.
     - Clicking inside `dom.repoHistoryMenu` (non-item container click) does not trigger `handleOutsideClick` dismissal.

### Phase 2 — Serial Verification & Checkpoint Gate

#### Batch 4: Build, Full Verification Gate & Local Checkpoint Commit `[Score: 3/10 | Tier: FLASH_LITE | Depends on: Batch 1, Batch 2, Batch 3]`
- Run sequential `typecheck` and `build` across `packages/edge-worker`, `packages/userscript-hud` (`npm run release:patch`), and `packages/local-cli`.
- Run `node scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs`, `node scripts/patches_and_tests/run-regressions.mjs`, and `node scripts/patches_and_tests/worker-smoke.mjs`.
- Stage only the planned files explicitly and create the local Conventional Commit checkpoint (no `git push`, no `wrangler deploy`).

---

## 2. File Inventory

### Batch 1 Files
- `packages/edge-worker/src/modules/mixSelection.ts`
  - **Anchor 1 (`priorityTier`):**
    ```ts
    function priorityTier(filePath: string): number {
      const segments = filePath.split('/');
      const baseName = segments[segments.length - 1] ?? '';
      if (segments.length === 1 && ROOT_CONFIG_FILES.has(baseName)) return 0;
      if (ENTRYPOINT_PATTERN.test(baseName)) return 1;
      if (filePath.startsWith('src/') || filePath.startsWith('shared/') || filePath.startsWith('packages/')) {
        return 2;
      }
      return 3;
    }
    ```
    Replace with active-tree-aware tiers (Tier 0: root configs; Tier 1: entrypoints in root or `src/`/`shared/`/`packages/`; Tier 2: `src/`, `shared/`, `packages/`; Tier 3: `.agents/`, `scripts/`; Tier 4: everything else including `plans/` and `cf-gemini-git-bridge/`).
  - **Anchor 2 (`buildTruncationNotice` & `buildMixTruncation`):**
    ```ts
    export interface TruncationSummary {
      includedFiles: number;
      totalFiles: number;
      omittedFiles: MixOmittedFile[];
      requiredParts: number;
      availableParts: number;
      continuationPartsCount?: number;
      continuationFilesCount?: number;
      firstContinuationPart?: number;
    }
    ```
    Use `const firstCont = summary.firstContinuationPart ?? 11;` and `const lastCont = firstCont + (summary.continuationPartsCount ?? 0) - 1;` in `continuationNotice`, and export `buildMixTruncation(params)` to build the `MixTruncation | undefined` object.
- `packages/edge-worker/src/modules/mixChunker.ts`
  - **Anchor 1 (Single-part fast-path guard):**
    ```ts
      // 3. Single-part fast path: the split decision uses the unconstrained size,
      // the emitted part is then measured against the absolute ceiling.
      const rawFilesChars = validFiles.reduce((sum, f) => sum + f.fileXml.length + 1, 0);
    ```
    Only call `buildPartXml` / `fitPart` for `single` when `part1OverheadChars + rawFilesChars <= HARD_GEMINI_CHAR_LIMIT`; otherwise set `shouldSplit = true` directly without allocating full-repo single-part strings.
  - **Anchor 2 (Continuation part packing after base `budgetLadder`):**
    Ensure `basePartCount` passed to `buildContinuationParts` matches the actual base part count (`chunkBuckets.length` when `< MAX_GEMINI_PARTS`, or `MAX_GEMINI_PARTS`), and replace the inline `truncation` object construction at the end of `buildChunkedMixXml` with `buildMixTruncation(...)`.
- `.repomixignore.cf`
  - **Anchor:**
    ```text
    gemini-bridge.user.js
    ```
    Append `cf-gemini-git-bridge/`.

### Batch 2 Files
- `packages/userscript-hud/src/ui/hudMixAction.ts`
  - **Anchor (`dom.continueMixBtn.onclick`):**
    ```ts
      dom.continueMixBtn.onclick = () => {
        if (!state.continuationQueue || state.continuationQueue.length === 0) return;
    ```
    Check `const promptEl = findPromptInputElement();` first; if `!promptEl`, call `updateState({ status: 'ERROR', statusMessage: ... })` and return without mutating `state.continuationQueue`. On success (`if (injected)`), include `status: 'IDLE'` in `updateState({...})`.
- `packages/userscript-hud/src/ui/hudRepoHistoryDropdown.ts`
  - **Anchor (`handleOutsideClick` & listener cleanup):**
    ```ts
      const handleOutsideClick = (event: Event) => {
        if (dom.repoHistoryMenu.style.display === 'none') return;
    ```
    Check `const path = typeof event.composedPath === 'function' ? event.composedPath() : []; if (path.includes(dom.repoHistoryBtn) || path.includes(dom.repoHistoryMenu)) return;`, add `dom.repoHistoryMenu.onclick = (e) => e.stopPropagation();`, call `closeMenu()` at the start of `refresh()`, and remove any previously registered `document` `click`/`keydown` listeners before registering new ones.
- `packages/userscript-hud/src/ui/hudConfigBindings.ts`
  - **Anchor (`dom.repoInput.onchange`):**
    ```ts
      dom.repoInput.onchange = () => {
        try {
          const sanitized = sanitizeRepo(sanitizeNoGithubPat(dom.repoInput.value.trim(), 'repo'));
          const previousRepo = config.repo;
          config.repo = sanitized;
          dom.repoInput.value = sanitized;
    ```
- `packages/userscript-hud/src/ui/hudStylesAndDom.ts`
  - **Anchor (`.hud-repo-menu` / `.hud-combo-arrow` CSS block):**
    Compact multi-line CSS rules in `HUD_STYLES` so the file drops from 473 lines to ~420 lines without altering any CSS class or property.

### Batch 3 Files
- `scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs`
  - **Anchor (End of Part 1 & Part 2 suites):**
    Add assertions for `rankFilesForOmission` priority ordering (`.agents/rules/*` before `plans/*` and `cf-gemini-git-bridge/*`), `dom.repoInput.onchange` value canonicalization, and line-count checks (`< 465` lines) for `mixChunker.ts` and `hudStylesAndDom.ts`.

### Batch 4 Files (Coordinator Build & Sync Artifacts)
- `packages/edge-worker/dist/worker.mjs`
- `packages/userscript-hud/package.json`
- `packages/userscript-hud/dist/gemini-bridge.user.js`
- `gemini-bridge.user.js`
- `scripts/patches_and_tests/worker-baseline.json`

---

## 3. Risk & Complexity Check

| Batch | Score | Tier | Risk & Mitigation |
| :--- | :---: | :---: | :--- |
| **Batch 1 (Mix Engine & Ignore)** | `5/10` | `FLASH` | Keep `DEFAULT_MIX_INSTRUCTIONS`, `DEFAULT_MAX_CHUNK_CHARS`, `MAX_GEMINI_PARTS`, and `capRecentCommitsText` in `mixChunker.ts` so `test-v2-prompt-contract.mjs` AST checks and `worker-smoke.mjs` probes pass 100%. |
| **Batch 2 (HUD & Dropdown)** | `5/10` | `FLASH` | Zero `innerHTML` assignments (Trusted-Types P1); preserve all existing `HudDomElements` properties and CSS class names. |
| **Batch 3 (Regression Tests)** | `4/10` | `FLASH` | Extend `test-mix-continuation-and-hud-layout.mjs` without breaking existingFakeElement shims. |
| **Batch 4 (Build & Gate)** | `3/10` | `FLASH_LITE` | Single-Action Protocol (no `&&` or `;` chaining in PowerShell). |
| **Combined Execution** | `5/10` | `FLASH` | **Flash-Only Viability: YES.** |

---

## 4. Optimization / Combination Hint

- **With `#exec-wave`:** Spawn **Batch 1** and **Batch 2** in parallel in Wave 1 (100% disjoint file sets), then run **Batch 3** and **Batch 4** sequentially in the Coordinator.
- **With `#exec all`:** Execute Batches 1 → 2 → 3 → 4 sequentially inline under the `.agents/skills/flash/SKILL.md` Single-Action Protocol.

---

## 5. Git & Checkpoint Policy

Run each command sequentially as a separate tool call (never chain with `&&` or `;`):

1. `npm --prefix packages/edge-worker run typecheck`
2. `npm --prefix packages/userscript-hud run typecheck`
3. `npm --prefix packages/local-cli run typecheck`
4. `npm --prefix packages/edge-worker run build`
5. `npm --prefix packages/userscript-hud run release:patch`
6. `node scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs`
7. `node scripts/patches_and_tests/run-regressions.mjs`
8. `node scripts/patches_and_tests/worker-smoke.mjs`
9. `git --no-pager diff --check`
10. `git status --short` (verify no unrelated files are staged)
11. Stage explicitly by path:
    `git add .repomixignore.cf packages/edge-worker/src/modules/mixSelection.ts packages/edge-worker/src/modules/mixChunker.ts packages/edge-worker/dist/worker.mjs packages/userscript-hud/src/ui/hudMixAction.ts packages/userscript-hud/src/ui/hudRepoHistoryDropdown.ts packages/userscript-hud/src/ui/hudConfigBindings.ts packages/userscript-hud/src/ui/hudStylesAndDom.ts packages/userscript-hud/package.json packages/userscript-hud/dist/gemini-bridge.user.js gemini-bridge.user.js scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs scripts/patches_and_tests/worker-baseline.json`
12. Commit locally:
    `git commit -m "fix(mix,hud): harden continuation numbering, omission tiers, dropdown retargeting and file-size budgets"`
13. **Hard Stop:** Do NOT run `git push` or `npx wrangler deploy` without explicit user confirmation.

---

## 6. Acceptance & Invariant Checklist

1. **Modularity & Line-Count Law:** `packages/edge-worker/src/modules/mixChunker.ts` and `packages/userscript-hud/src/ui/hudStylesAndDom.ts` both measure `< 465` lines (and all 53 active TypeScript files remain `< 500` lines in Probe 10).
2. **Omission Priority & Ignore Integrity:** `rankFilesForOmission` ranks `.agents/rules/*` and `scripts/*` ahead of `plans/*` and `cf-gemini-git-bridge/*`, and `.repomixignore.cf` excludes `cf-gemini-git-bridge/`.
3. **Contiguous Continuation Parts:** Pre-packed continuation parts always start at `baseParts.length + 1` (`11` when 10 base parts are emitted) and every emitted part stays `<= 100,000` characters (`HARD_GEMINI_CHAR_LIMIT`).
4. **HUD Continuation & Dropdown Resilience:** Clicking `continueMixBtn` when no prompt input exists in the DOM does not drain `state.continuationQueue`; `dom.repoInput.onchange` writes the sanitized `owner/repo` back to `dom.repoInput.value`; Shadow-DOM retargeted clicks inside `dom.repoHistoryMenu` do not close the menu.
5. **Full Regression & Bundle Sync Gate:** `run-regressions.mjs` (16/16 PASS) and `worker-smoke.mjs` (14/14 PASS, `bundleContentIdentical: true`) pass with zero errors.