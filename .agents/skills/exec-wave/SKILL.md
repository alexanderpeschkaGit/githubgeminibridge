---
name: exec-wave
description: >-
  Orchestrates multi-batch roadmaps (such as 00_MASTER_ROADMAP.md) across serial and parallel waves using tiered subagents (flash_lite, flash, pro) and Multi-IDE fallbacks without bloating the main Coordinator context.
  Triggered by #exec-wave, /exec-wave, #wave-exec, or /wave-exec.
---

# Exec-Wave Workflow (`#exec-wave <planId>`)

Execute multi-batch plans (`plans/Batch_*.md` or `.tmp/plans/<planId>.md`) in serial phases and parallel waves. The Coordinator **orchestrates only**: it never implements batch code itself (except one targeted fix in §5) and keeps its context to the roadmap plus subagent reports. Global contract (`AGENTS.md`) applies and is not restated here.

## 0. Context Budget (Coordinator)

- Read only the roadmap / plan header: topology (phases, waves), per-batch tier/score, File Inventory, `scope.files`. **Do not open batch plan bodies or target source files** — subagents read them.
- Plan metadata via `node scripts/plan-registry.mjs get <planId>`; never dump the whole registry.
- Audit with `git diff --name-only` / `git status --porcelain` / `git diff --stat`; full `git diff -- <file>` only for failing files.
- Keep subagent reports to the 5-line contract; summarize validation as pass/fail + first errors.

## 1. Plan Binding

1. Bind to exactly one `planId`; never mix batches from different plans. Verify `baseSha` against `git rev-parse HEAD` (mismatch ⇒ warn + confirm).
2. Check that each wave's File Inventories are disjoint and do not collide with other `RUNNING` plans; then `plan-registry.mjs lock <planId> <files...>` and `start <planId>`.
3. Append `START <planId> wave <X>` to `plans/EXECUTION_LOG.md` per phase/wave.

## 2. 3-Tier Per-Batch Routing (lockstep)

Triggering `#exec-wave` authorizes per-batch `Model` overrides in Mode A (Kilo/Cursor still inherit unless the user names a model).

| Tier | Score | Model | Scope |
| :--- | :--- | :--- | :--- |
| 1 `FLASH_LITE` | 1–3 | `flash_lite` | Copy, simple types, static config, minor CSS; files < 300 lines, ≤ 2–3 files. **Auto-upgrade to `flash` at ≥ 4 files.** |
| 2 `FLASH` (default) | 4–6 | `flash` | Scoped batches ≤ 3–4 files, clear interfaces, < 500 lines. Untagged batches with only < 500-line files ⇒ `flash`. |
| 3 `PRO` | 7–10 | `pro` | Edge-worker request/commit pipeline, HUD patch-queue/OID state, GitHub GraphQL/tarball contracts, unsliced files ≥ 500 lines, high blast radius. |

**Flash Wave Exemption:** with `#flash` in trigger or roadmap, ≥ 500-line batches route to `flash` if File Inventory ≤ 3 files and score ≤ 6.

## 3. Batch Executor Prompt (single template for serial and parallel)

`invoke_subagent` with `TypeName: 'self'`, `Role: 'Batch Executor'`, `Model: <tier>`:

> Read the execution plan at `<batch-path>` (planId: `<planId>`, batchId: `<batchId>`, baseSha: `<baseSha>`). Implement all changes strictly as specified under `.agents/skills/flash/SKILL.md`. Only read/create/edit files — NO shell, `npm`, `tsc` or `git` commands. Inspect and modify every file in your File Inventory; touch nothing else. Report only: `1. Status: [SUCCESS | BLOCKED | FAILED]` `2. Files Modified: [relative paths actually changed]` `3. Summary: [1-2 sentences]` `4. planId` `5. batchId`. Never paste source code.

## 4. Execution

- **Serial batch:** launch one executor, emit `[⚡ Watch Batch Live Stream](conversation://<id>)`, wait, then run §5.
- **Parallel wave (disjoint inventories only):** launch all executors of the wave concurrently (Flash and Pro batches may share a wave). Before waiting, render one dashboard:

  ```markdown
  ### 🌊 Parallel Wave Launched: Wave X
  | Batch | Tier & Model | Scope | Live Stream |
  | :-- | :-- | :-- | :-- |
  | `Batch_02` | `FLASH` (`flash`) | `packages/edge-worker/...` | [⚡ Watch Batch_02 Stream](conversation://<id-02>) |
  ```

  Kilo: replace links with `task_id`.

## 5. Gather Gate (after every serial batch / wave)

1. **Summary:** aggregate the reports in ≤ 1 bullet per batch.
2. **Combo Anti-Phantom Diff Audit (lockstep):** reconcile the union of `git diff --name-only` + `git status --porcelain` against each File Inventory and `scope.files`. Untouched assigned file ⇒ `INCOMPLETE_BATCH` / `PHANTOM_REPORTING` → targeted completion pass. Out-of-scope file ⇒ `SCOPE_VIOLATION` → reject, do not stage, flag to user.
3. **Validation (sequential, Coordinator terminal):** `npm run typecheck` in each touched package → `node scripts/patches_and_tests/worker-smoke.mjs`.
4. **Failure Ladder (never loop):**
   - One targeted Coordinator fix; still failing ⇒ re-delegate that batch's files to `pro` (`Role: 'Batch Executor'`, same prompt) and emit `[🚨 Watch Escalation Stream (PRO)](conversation://<id>)`.
   - **Budget mode** (`--no-pro`, `--no-pro-escalation`, `#dflash`, user instruction) or **Pro quota exhausted** (after 2 Flash attempts) ⇒ **Graceful Pause (Dirty Inspection):** keep files on disk (no `git checkout`/`reset`), show scoped diff + failing lines, log `BLOCKED_NEEDS_USER_INPUT`, alert `[Graceful Pause (Dirty Inspection): Wave halted without PRO escalation. Modified files preserved on disk for manual inspection.]`
5. **Red-Team (any batch Score ≥ 8):** `TypeName: 'research'`, `Model: 'pro'`, `Role: 'Red-Team Auditor'` on that batch's files; emit `[🛡️ Watch Red-Team Audit](conversation://<id>)`; require `1. Verdict: [PASS | BLOCKING_ISSUES]` `2. Findings: [file:line bullets or "None"]`.
6. **Checkpoint:** stage audited files explicitly (`git add <paths>`, never `.`/`-A`), one Conventional Commit per batch/wave on `main`. Append `DONE <planId> wave <X>` to `plans/EXECUTION_LOG.md`.

## 6. Final Verification (after last phase)

1. Sequentially: `npm run typecheck` in `packages/edge-worker`, `packages/userscript-hud`, `packages/local-cli` → `worker-smoke.mjs` → `run-regressions.mjs`; record results in `plans/TEST_LOG.md`.
2. Bump patch version of touched packages once (Coordinator only, unless a roadmap batch already did; HUD via `npm run release:patch`) and commit.
3. `plan-registry.mjs complete <planId>` + `release <planId>` (on abort: `abort` + `release`). Never `git push` (Hard Stop).

## 7. Multi-IDE

Follow `.agents/rules/multi-ide-setup.md` (Mode A–E). Deltas: Mode A = full parallel scatter-gather with tier models; Mode B = `inherit`, sequential FIFO if rate-limited, transcript-path fallback for links; Mode C = batches run inline in sequential context-hygiene passes (load only the current batch's files), model-switch advisory or self-review before Tier 3; Mode D (Cursor `Task`) / Mode E (Kilo `task`) = inherit model, `explore` auditors at Score ≥ 8, parallel only for disjoint inventories, link `[Name](agent-id)` / report `task_id`, persist reports in `.tmp/`.

> [!NOTE] **Lockstep Dependency Group:** This file belongs to the execution lockstep group (`multi-ide-setup`, `plan`, `exec`, `exec-wave`, `delegate`, `solve`). The 3-tier routing table, the Combo Anti-Phantom Diff Audit, and the handoff link labels must stay identical across the group; see `.agents/rules/multi-ide-setup.md`.
