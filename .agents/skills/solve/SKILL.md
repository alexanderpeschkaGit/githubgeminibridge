---
name: solve
description: >-
  Investigates an issue, drafts an execution plan, and immediately delegates execution via the #delegate skill with an IDE-independent change report in .tmp/.
  Triggered by #solve or /solve.
---

# Solve Workflow (Investigate → Plan → Delegate → Report)

Investigate an issue, write a verified plan into the Living Change Report `.tmp/solve_report.md`, execute via `#delegate` (`.agents/skills/delegate/SKILL.md`), and finalize the report. Global contract (`AGENTS.md`) applies; material ambiguity ⇒ `#grillme` first. All report content in English.

## 1. Investigate & Plan (lean)

- Read only what is needed (targeted search, line ranges); record findings in the report, not in chat.
- **Reproduction-first** for bugs: define a falsifiable check (targeted test, repro script, or error state) before drafting the fix.
- Produce steps + File Inventory with Anchor Snippets and a complexity score (1–10) per the lockstep routing in `delegate` §2.

## 2. Initialize `.tmp/solve_report.md`

Title, problem, root cause, status `🟡 IN PROGRESS`, tier + score, steps, File Inventory (relative paths), acceptance & validation checklist. This file **is** the delegate context file (no extra artifact).

## 3. Delegate

Run `delegate` §2–§3 unchanged (model routing, Budget Mode, `Artifact Executor` prompt pointing at `.tmp/solve_report.md`). Handoff links: Mode A `[View Subagent Stream](conversation://<subagent-conversation-id>)`, Mode D `[Name](agent-id)`, Mode E `task_id`, plus `[📋 View Execution Plan & Report](file:///<workspace-path>/.tmp/solve_report.md)`. Stop and wait.

## 4. Audit, Validate, Finalize

1. **Combo Anti-Phantom Diff Audit (lockstep):** as in `delegate` §4 (also after inline Mode C / Cursor `Task` completion).
2. **Validation (sequential):** `npm run typecheck` in each touched package → `node scripts/patches_and_tests/worker-smoke.mjs`.
3. **Pass:** Coordinator bumps the patch version of touched packages (HUD: `npm run release:patch`), stages explicitly, Conventional Commit; never `git push`.
4. **Fail after escalation (or Budget Mode):** **Graceful Pause (Dirty Inspection)** — keep files on disk, log the exact errors in the report, status `❌ FAILED`, alert the user; no rollback.
5. Finalize the report: status `✅ COMPLETED` / `❌ FAILED`, modified files with `file:///` links + 1-sentence summaries, validation exit results, commit hash/message/version bump.
6. Chat: `[📋 Open Change Report](file:///<workspace-path>/.tmp/solve_report.md)` + 2–3 sentence summary.

> [!NOTE] **Lockstep Dependency Group:** This file belongs to the execution lockstep group (`multi-ide-setup`, `plan`, `exec`, `exec-wave`, `delegate`, `solve`). The 3-tier routing table, the Combo Anti-Phantom Diff Audit, and the handoff link labels must stay identical across the group; see `.agents/rules/multi-ide-setup.md`.
