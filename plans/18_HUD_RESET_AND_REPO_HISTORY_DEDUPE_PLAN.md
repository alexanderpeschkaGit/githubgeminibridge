# Execution Plan: HUD Soft-Reset & Repo-History Deduplication (Rev 2)

## Execution Metadata
- **Plan ID:** `plan-20261031-hud-reset-repo-history`
- **Artifact Path:** `plans/18_HUD_RESET_AND_REPO_HISTORY_DEDUPE_PLAN.md`
- **Base SHA:** `bb40fa51e55a36d87349a7d4d32372f22819ad0e`
- **Recommended Workflow:** `#exec`
- **Recommended Execution Model:** `FLASH`
- **Flash-Only Viability:** `YES (Micro-Batched <= 6)` (All touched TypeScript files stay strictly `< 435` lines)
- **Complexity Assessment:** `3/10` (Canonical repoSlug deduplication, IIFE-safe callback wiring for Shift-Click soft reset, optional-chained event handling for Node regression harness compatibility, and MIXING/PATCHING concurrency guard)

---

## 1. Architecture & Logic

1. **Strict Prohibition of `(0, eval)` & Tampermonkey Scope Preservation:**
   - Runtime evaluation of remote JavaScript is completely rejected to preserve Tampermonkey sandbox grants (`GM_xmlhttpRequest`, `GM_getValue`, `GM_setValue`) and strict Google CSP / Trusted Types compliance.
   - Version updates remain handled by opening the raw install URL in a background tab via `window.open` with a transient reload hint.
   - A **Shift-Click** on the `⟳` header button triggers `resetGeminiEdgeHud()` via an explicit `onSoftReset` callback passed from `index.ts` -> `mountShadowHud` -> `initHudUpdateBanner` (with `window.resetGeminiEdgeHud` exposed as an additional convenience hook).
2. **Canonical Repo-History Deduplication (`repoSlug`):**
   - `repoHistory.ts` normalizes entries via `sanitizeRepo` and deduplicates strictly by canonical `owner/repo` slug (lowercase, stripped of leading/trailing slashes).
   - If `owner` is empty and `repo` contains no slash, `repoSlug` falls back cleanly to `repo` without prepending a leading slash (`formatRepoHistoryLabel` in `hudRepoHistoryDropdown.ts` mirrors this guard).
   - `pushRepoHistory()` upserts the active branch configuration to index `0` (max 4 unique repositories), and `loadRepoHistory()` automatically deduplicates legacy stored entries.
3. **Two-Stage Teardown Pipeline & Busy Guard:**
   - `stopDomHarvester(observer)` disconnects the `MutationObserver` and removes `.ggb-inline-btn`, `.ggb-canvas-btn`, `data-ggh-processed`, and `data-ggh-canvas-processed` across both `document` and any open `shadowRoot` on `<code-block>`/`<pre>` elements.
   - `controller.destroy()` unbinds global `document` click/keydown listeners (`unbindRepoHistoryDropdownListeners()`), clears the history refresher singleton (`setRepoHistorySelectRefresher(null)`), and removes `#gemini-edge-hud-root`.
   - `resetGeminiEdgeHud()` is blocked while `state.status === 'PATCHING'` or `state.status === 'MIXING'`.

---

## 2. File Inventory

1. `packages/userscript-hud/src/services/repoHistory.ts` — Export `repoSlug(entry)` using `sanitizeRepo`, deduplicate `loadRepoHistory()` and `pushRepoHistory()` by slug.
2. `packages/userscript-hud/src/dom/harvester.ts` — Export `stopDomHarvester(observer)` cleaning both `document` and open code-block shadow roots.
3. `packages/userscript-hud/src/ui/hudDomTree.ts` — Update `updateCheckBtn.title` to advertise `Shift-Click to soft reset HUD`.
4. `packages/userscript-hud/src/ui/hudConfigBindings.ts` — Allow `null` in `setRepoHistorySelectRefresher`.
5. `packages/userscript-hud/src/ui/hudRepoHistoryDropdown.ts` — Export `unbindRepoHistoryDropdownListeners()` and guard `formatRepoHistoryLabel` when `owner` is empty.
6. `packages/userscript-hud/src/ui/updateBanner.ts` — Add `onSoftReset?: () => void` to `HudUpdateBannerDeps` and guard `e?.shiftKey` in the click listener so `test-hud-update-banner.mjs` stays green.
7. `packages/userscript-hud/src/ui/shadowHud.ts` — Add `destroy()` to `ShadowHudController` and forward `options?.onSoftReset` to `initHudUpdateBanner`.
8. `packages/userscript-hud/src/index.ts` — Track `activeObserver`, export `destroyGeminiEdgeHud()` and `resetGeminiEdgeHud()` with `PATCHING`/`MIXING` concurrency guard.
9. `scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs` — Add `FakeElement.prototype.remove()`, wire `document.getElementById`, and add unit/lifecycle assertions (Sections 2.5 and 2.6).
10. `.agents/rules/userscript-shadow-hud.md` — Document Shift-Click HUD soft reset and canonical `repoSlug` deduplication.

---

## 3. Validation & Checkpoint Gate

1. `npm run typecheck` in `packages/userscript-hud`
2. `npm run build` in `packages/userscript-hud` (synchronizes `dist/gemini-bridge.user.js` and root `gemini-bridge.user.js`)
3. `node scripts/patches_and_tests/test-hud-update-banner.mjs`
4. `node scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs`
5. `node scripts/patches_and_tests/run-regressions.mjs`
6. `node scripts/patches_and_tests/worker-smoke.mjs` (14/14 probes PASS, Probe 10 confirms all TS files `< 500` lines and fresh bundle sync)

---

## 4. Acceptance & Invariant Checklist

- [x] **Repo-Slug Uniqueness:** Multiple branch or targetBranch switches on the same repository update the entry in-place at index 0 without creating duplicate slots; empty `owner` never produces a leading slash.
- [x] **Harvester Re-Scan After Soft-Reset:** Shift-clicking `⟳` invokes `resetGeminiEdgeHud()`, removes `#gemini-edge-hud-root` and `.ggb-inline-btn` buttons (including inside open shadow roots), and re-harvests existing chat code blocks.
- [x] **Concurrency Protection:** `resetGeminiEdgeHud()` is a no-op while `status === 'PATCHING'` or `'MIXING'`.
- [x] **100% CSP & Regression Compliance:** Zero `eval()` usage; `test-hud-update-banner.mjs` and `test-mix-continuation-and-hud-layout.mjs` pass without error.
