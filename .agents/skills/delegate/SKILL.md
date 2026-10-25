---
name: delegate
description: >-
  Writes a focused execution plan to an Artifact and spawns a subagent to execute it from the file, preventing context bloat.
  Triggered by #delegate, /delegate, #deligate, or /deligate.
---

# Delegate Workflow

- **Purpose:** To prevent conversation bloat by giving a subagent a pristine, noise-free instruction set. This is the programmatic equivalent of starting a brand new chat just for execution.
- **Step 1: Create or Identify the Context File:**
  - **IDE-Independent Storage (Recommended):** If called by `#solve` or when cross-IDE persistence is desired, use a workspace-local markdown file in `.tmp/` (e.g. `.tmp/solve_report.md` or `.tmp/delegate_plan.md`, ensuring `.tmp/` is in `.gitignore`).
  - **IDE-Native Artifacts:** Alternatively, write the instructions into a Markdown Artifact in the IDE artifact directory using `write_file` (`RequestFeedback: false`, `ArtifactMetadata`).
  - Keep this context file as the pristine Single Source of Truth for the subagent.
- **Step 2: Spawn the Subagent:**
  - Immediately after creating/identifying the context file, spawn the host's isolated executor (`invoke_subagent` in Mode A; Cursor `Task` with `subagent_type: "generalPurpose"` in Mode D; Mode B host equivalent with `inherit`). Never call a tool name the host does not expose.
  - **Model Selection (3-Tier Intelligent Routing):**
    1. **Explicit Override:** If the prompt explicitly contains the word `flash_lite`, use `flash_lite`. If it contains `flash` (with or without `#`), use `flash`. If it explicitly specifies `pro` (or `#pro`), use `pro`.
    2. **Complexity-Gated Evaluation:** When a plan or task includes a Complexity Score (`1–10`) or a clear execution blueprint:
       - **Tier 1 — `1–3` (`flash_lite`):** Copy updates, simple type exports, config tweaks, minor CSS/Tailwind (< 300 lines).
       - **Tier 2 — `4–6` (`flash`):** Standard component/hook batches (<= 3–4 files, clear interfaces, < 500 lines) under the Single-Action Protocol.
       - **Tier 3 — `7–10` (`pro`):** Cross-package architecture, ambiguous root causes, edge-worker/HUD lifecycle and OID-state changes, files >= 500 lines (plus a Reviewer at `>= 8`).
    3. **Default / Fallback:** Default to `inherit` (strictly preserves the user's currently selected IDE model, e.g. Flash High, rather than overriding with a heavy model).
    - **Zero-PRO Guard (`--no-pro` / `--no-pro-escalation`):** When flagged, PRO escalation is suppressed. A targeted repair that still fails halts in **Graceful Pause (Dirty Inspection)** — modified files stay on disk for inspection, with no destructive rollback and no further PRO token spend.
  - **Role:** `Artifact Executor`
  - **Prompt & Capability Guardrails:** Keep the prompt minimal and enforce strict subagent execution boundaries:
    - **Strict Git & Versioning Boundary:** Subagents are strictly forbidden from running `git commit`, `git push`, or modifying `package.json` version numbers. The Coordinator strictly owns all version bumping and git commits.
    - **Standard 3-Point Return Format:** Subagents MUST report back strictly using this 3-point format:
      `1. Status: [SUCCESS | BLOCKED | FAILED]`
      `2. Files Modified: [List ONLY relative paths actually modified or created]`
      `3. Summary: [1-2 sentences summarizing changes made or blockers encountered]`
    - **Prompt Template:** *"Read the execution plan located at `[Absolute Path to File]` and implement all file changes thoroughly. Follow the Single-Action Protocol from `flash/SKILL.md` (no `&&` or `;` command chaining, sequential verification). You must ONLY perform file read/edit/write operations. Do NOT execute git commit, git push, or package.json version bumps — the Coordinator strictly owns all versioning and git commits. Verify whether any referenced rule file in `.agents/rules/` requires synchronization with new exports/components, and include it in the final verification step. If the context file is an IDE-independent Living Report (e.g. in `.tmp/`), update it upon completion with the final execution report. Report back strictly using the 3-point format:\n1. Status: [SUCCESS | BLOCKED | FAILED]\n2. Files Modified: [Relative paths]\n3. Summary: [1-2 sentences]"*
- **Step 3: Handoff:**
  - Inform the user that the context file has been prepared and the subagent is currently running in the background.
  - You MUST provide clickable links to both the context file (`[📋 View Execution Plan & Report](file:///<absolute-path-forward-slashes>)`) and the subagent session: Mode A `[View Subagent Stream](conversation://<subagent-conversation-id>)`, Mode D Cursor `[Name](agent-id)`, Mode B/C host-appropriate ID or transcript path fallback. Note: Live progress can also be monitored via the IDE's subagent status pill / background task panel.
  - Stop calling tools and wait for the subagent to report back.
- **Step 4: Combo Anti-Phantom Diff Audit:**
  - On subagent return, run `git diff --name-only` and `git status --porcelain`, then reconcile the union of both outputs against the plan's File Inventory.
  - Reject a reported `SUCCESS` as `INCOMPLETE_TASK` / `PHANTOM_REPORTING` when any assigned file is untouched on disk, and run a targeted completion pass before reporting completion.

> [!NOTE] **Lockstep Dependency Group:** This file belongs to the execution lockstep group (`multi-ide-setup`, `plan`, `exec`, `exec-wave`, `delegate`, `solve`). The 3-tier routing table, the Combo Anti-Phantom Diff Audit, and the handoff link labels must stay identical across the group; see `.agents/rules/multi-ide-setup.md`.
