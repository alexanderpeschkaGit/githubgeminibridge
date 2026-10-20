# HUD Queue UX Fix — Execution Plan (Artifact)

## Context / Findings
- The E2E retest commit landed successfully on GitHub: `78fd7d0cd7d30d628db1b5f9ae8f12230b33b08c`
  (`feat: add optional label field to SocialLink interface`, diff `+1/-0` in `src/types.ts` only).
  The user's "no change on GitHub" observation was a stale browser view — NOT a code bug. Do not fix anything there.
- Two real issues to fix in the userscript HUD:
  - **A:** Disabled buttons (Apply All / Clear Queue / per-item Apply) keep their enabled look (light blue).
    There is no `:disabled` CSS rule. After a successful commit the queue is pruned to empty and the button
    is disabled, but it still looks active.
  - **B:** The patch queue list is too small (`max-height: 150px`) and each item shows only the truncated
    `commitMessage`, not the file path. The acceptance criterion "one entry for src/types.ts" is therefore
    not visible. Fix: show the file path(s) as the item title and the commit message as a sub-line.

## Mandatory Rules (Flash / Single-Action Protocol)
- Perform exactly ONE state-changing shell command per step. Never chain with `&&` or `;`.
- Wait for the exit code of each command before the next. If a step fails, run a diagnostic command first.
- Windows PowerShell; use native tools only (no `sed`/`awk`/`grep`/`cat`/`rm`).
- `_v1_backup/` and `cf-gemini-git-bridge/` are strictly read-only. Do not touch them.
- Do NOT `git push`. Do NOT `wrangler deploy`.

## Step 1 — Edit `packages/userscript-hud/src/ui/hudStylesAndDom.ts`

### 1a. Disabled-state CSS (replace the hover rule)
old_str:
```
  .hud-btn-primary:hover {
    background: #0284c7;
    box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
  }
```
new_str:
```
  .hud-btn-primary:hover:not(:disabled) {
    background: #0284c7;
    box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
  }
  .hud-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    box-shadow: none;
  }
  .hud-btn-primary:disabled {
    background: #334155;
    border-color: #475569;
    color: #94a3b8;
  }
```

### 1b. Larger queue list
old_str:
```
    padding: 8px;
    max-height: 150px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
```
new_str:
```
    padding: 8px;
    max-height: 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
```

### 1c. Item meta/sub classes
old_str:
```
  .hud-patch-item-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #e2e8f0;
    flex: 1;
  }
```
new_str:
```
  .hud-patch-item-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #e2e8f0;
    flex: 1;
    min-width: 0;
  }
  .hud-patch-item-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    flex: 1;
    min-width: 0;
  }
  .hud-patch-item-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: #94a3b8;
  }
```

## Step 2 — Edit `packages/userscript-hud/src/ui/shadowHud.ts`

Replace the queue-item rendering block inside `renderState`:
old_str:
```
      state.harvestedPatches.forEach((patch) => {
        const item = createHudElement('div', 'hud-patch-item');
        const itemTitle = createHudElement(
          'div',
          'hud-patch-item-title',
          `${patch.mode === 'v2_json' ? '⚡' : '📝'} ${patch.commitMessage}`
        );
        itemTitle.title = patch.commitMessage;

        const applyBtn = createHudElement('button', 'hud-btn hud-btn-primary', 'Apply');
        applyBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';
        applyBtn.disabled = isBusy;
        applyBtn.onclick = () => {
          controller.handleApplyPatch(patch);
        };

        item.appendChild(itemTitle);
        item.appendChild(applyBtn);
        dom.patchQueueEl.appendChild(item);
      });
```
new_str:
```
      state.harvestedPatches.forEach((patch) => {
        const item = createHudElement('div', 'hud-patch-item');
        const meta = createHudElement('div', 'hud-patch-item-meta');
        const paths = (patch.payload.patches || []).map((p) => p.path);
        const pathLabel = paths.length > 0 ? paths.join(', ') : patch.commitMessage;
        const itemTitle = createHudElement(
          'div',
          'hud-patch-item-title',
          `${patch.mode === 'v2_json' ? '⚡' : '📝'} ${pathLabel}`
        );
        itemTitle.title = pathLabel;
        const itemSub = createHudElement('div', 'hud-patch-item-sub', patch.commitMessage);
        itemSub.title = patch.commitMessage;

        const applyBtn = createHudElement('button', 'hud-btn hud-btn-primary', 'Apply');
        applyBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';
        applyBtn.disabled = isBusy;
        applyBtn.onclick = () => {
          controller.handleApplyPatch(patch);
        };

        meta.appendChild(itemTitle);
        meta.appendChild(itemSub);
        item.appendChild(meta);
        item.appendChild(applyBtn);
        dom.patchQueueEl.appendChild(item);
      });
```

## Step 3 — Validate (run ONE command per step, wait for exit code)

1. `node packages/local-cli/node_modules/typescript/lib/tsc.js --noEmit -p packages/userscript-hud/tsconfig.json`
2. `node scripts/patches_and_tests/test-harvest-dedupe.mjs`
3. `node scripts/patches_and_tests/run-regressions.mjs`
4. `node packages/userscript-hud/scripts/build-userscript.mjs`
5. Verify byte-identity: compare SHA256 and byte length of
   `packages/userscript-hud/dist/gemini-bridge.user.js` and root `gemini-bridge.user.js`.
   (e.g. `Get-FileHash <file> -Algorithm SHA256` and `(Get-Item <file>).Length` for both, one command per file.)
6. File-size audit: every active TypeScript source file must be < 500 lines
   (metric `split('\n').length`). Confirm 0 files >= 500 lines.
7. `git --no-pager diff --check`

## Step 4 — Local checkpoint commit (NO push)

1. `git status --short` — inspect. Warn in summary about any unrelated/untracked files; do not stage them.
2. Stage explicitly by path (never `git add .`):
   - `packages/userscript-hud/src/ui/hudStylesAndDom.ts`
   - `packages/userscript-hud/src/ui/shadowHud.ts`
   - `packages/userscript-hud/dist/gemini-bridge.user.js`
   - `gemini-bridge.user.js`
   - `plans/TEST_LOG.md`
   - `plans/EXECUTION_LOG.md`
3. Commit (conventional + rationale + required trailer):
   message: `fix(hud): disabled-button styling and queue file-path display`
   body: explain Bug A (no :disabled state) and Bug B (queue item now shows file path + larger list).
   trailer: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

## Step 5 — Log sync

- Append a `TEST_LOG.md` entry: new suite result summary (tsc PASS, harvest-dedupe PASS,
  run-regressions 7/7 PASS, build PASS, dist≡root, file-size audit, diff --check).
- Append an `EXECUTION_LOG.md` entry: `DONE`, changes, validation, `Overall: PASS`, no push/deploy.

## Deterministic Invariants (verify before finishing)
1. `.hud-btn:disabled` and `.hud-btn-primary:disabled` exist in `hudStylesAndDom.ts`.
2. Queue item renders file path(s) from `patch.payload.patches[].path` as title, `commitMessage` as sub-line.
3. `tsc --noEmit` = 0 errors; `test-harvest-dedupe` PASS; `run-regressions` = 7/7 PASS.
4. `dist/gemini-bridge.user.js` and root `gemini-bridge.user.js` byte-identical (same SHA256).
5. No active TS file >= 500 lines; `git diff --check` clean; no `git push` performed.
