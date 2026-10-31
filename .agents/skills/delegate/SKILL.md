---
name: delegate
description: >-
  Writes a focused execution plan to an Artifact and spawns a subagent to execute it from the file, preventing context bloat.
  Triggered by #delegate, /delegate, #deligate, or /deligate.
---

# Delegate Workflow (`#delegate`)

Give an isolated subagent a pristine instruction file instead of chat history — the programmatic equivalent of a fresh chat for execution.

## 1. Context File (SSOT)

- **Preferred:** workspace-local `.tmp/<name>.md` (e.g. `.tmp/delegate_plan.md`; `#solve` uses `.tmp/solve_report.md`). `.tmp/` is gitignored and readable by any IDE.
- **Alternative:** IDE artifact via `write_file` (`ArtifactMetadata`, `RequestFeedback: false`).
- Content: goal, File Inventory with Anchor Snippets, steps, validation, acceptance checklist. No chat transcript, no full-file dumps.

## 2. Spawn

- Host tool: Mode A `invoke_subagent` (`TypeName: 'self'`); Mode B host equivalent with `inherit`; Mode D Cursor `Task` (`generalPurpose`); Mode E Kilo `task` (`general`, `explore` for audits; omit `model`/`variant`). Never call a tool the host does not expose.
- **Role:** `Artifact Executor`
- **Model (Mode A; others inherit):**
  1. Explicit `flash_lite` / `flash` / `pro` in the prompt wins.
  2. Else by score (lockstep): `1–3` → `flash_lite` (copy/config/minor CSS, < 300 lines); `4–6` → `flash` (≤ 3–4 files, < 500 lines); `7–10` → `pro` (cross-package, ambiguous root causes, edge-worker/HUD lifecycle & OID state, files ≥ 500 lines; Reviewer at ≥ 8).
  3. Else `inherit`.
- **Budget Mode** (`--no-pro`, `--no-pro-escalation`, `#dflash`, user instruction): no PRO escalation; a failed targeted repair ends in **Graceful Pause (Dirty Inspection)** (files kept on disk, no rollback).
- **Prompt template:**

  > Read the execution plan at `<absolute path>` and implement all changes. Follow the Single-Action Protocol from `.agents/skills/flash/SKILL.md`. Only read/edit/write files — NO `git commit`, `git push`, or `package.json` version bumps (Coordinator owns them). Sync any affected `.agents/rules/` file if the plan requires it. If the context file is a `.tmp/` Living Report, update it with your final execution report. Report only: `1. Status: [SUCCESS | BLOCKED | FAILED]` `2. Files Modified: [relative paths]` `3. Summary: [1-2 sentences]`. Never paste source code.

## 3. Handoff

Emit `[📋 View Execution Plan & Report](file:///<absolute-path-forward-slashes>)` and the session link — Mode A `[View Subagent Stream](conversation://<subagent-conversation-id>)`, Mode D `[Name](agent-id)`, Mode B/C host ID or transcript path, Mode E `task_id`. Then stop calling tools and wait.

## 4. Combo Anti-Phantom Diff Audit (lockstep)

Reconcile the union of `git diff --name-only` + `git status --porcelain` against the File Inventory (use `--stat`, not full diffs). Untouched assigned file ⇒ `INCOMPLETE_TASK` / `PHANTOM_REPORTING` → targeted completion pass. Out-of-scope file ⇒ `SCOPE_VIOLATION` → do not stage, flag to user.

> [!NOTE] **Lockstep Dependency Group:** This file belongs to the execution lockstep group (`multi-ide-setup`, `plan`, `exec`, `exec-wave`, `delegate`, `solve`). The 3-tier routing table, the Combo Anti-Phantom Diff Audit, and the handoff link labels must stay identical across the group; see `.agents/rules/multi-ide-setup.md`.
