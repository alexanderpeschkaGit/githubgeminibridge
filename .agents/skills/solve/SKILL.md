---
name: solve
description: >-
  Investigates an issue, drafts an execution plan, and immediately delegates execution via the #delegate skill with an IDE-independent change report in .tmp/.
  Triggered by #solve or /solve.
---

# Solve Workflow (Investigate, Plan, Delegate & Report)

- **Purpose:** Automatically investigate an issue, formulate a verified execution plan, delegate execution to `#delegate` (`delegate/SKILL.md`), and maintain an IDE-independent Living Change Report (`.tmp/solve_report.md`) with a clickable link for the user.

- **Step 1: Investigate and Plan**
  - Inspect the relevant repository context, diffs, and files to understand the problem.
  - **Reproduction-First Principle (Bug Resolution):** For bug fixes or unexpected errors, formulate an explicit, verifiable reproduction check or falsifiable assertion (e.g., targeted unit test, reproduction script, or console error state) before drafting fixes.
  - Follow the global preflight, scope, and decision-gate contract in `AGENTS.md`; if material ambiguity exists, resolve it first using `#grillme`.
  - Formulate the concrete step-by-step implementation plan and affected file inventory with Anchor Snippets. All reports and plan steps are written in English.
  - Assess the **Task Complexity (1–10)**:
    - `<= 6`: Localized edits, unit tests, single component refactors, smoke checks.
    - `> 6`: Cross-package architecture, complex state flows, high blast-radius changes.

- **Step 2: Initialize IDE-Independent Living Report**
  - Path: `.tmp/solve_report.md` (relative to the workspace root; `.tmp/` is gitignored).
  - Initialize the Living Report with:
    - Task title, problem description, and root cause analysis.
    - Initial Status: `🟡 IN PROGRESS`
    - Assigned execution tier (`FLASH` or `PRO`) and complexity score.
    - Planned step-by-step actions and affected file inventory (with relative paths).
    - Planned acceptance & validation checklist.

- **Step 3: Delegate via `#delegate` Workflow**
  - Hand over execution directly to `#delegate` (`delegate/SKILL.md`), passing `.tmp/solve_report.md` as the context file.
  - Follow all protocols defined in `delegate`:
    1. **Context File:** Use `.tmp/solve_report.md` directly as the single source of truth (no redundant IDE artifact required).
    2. **Model Selection (3-Tier Intelligent Routing):**
       - Strict adherence to the `delegate` routing:
         - Explicit prompt overrides (`flash_lite`, `flash`, or `pro`).
         - Complexity `1–3` $\rightarrow$ `flash_lite` (copy/config/minor CSS).
         - Complexity `4–6` $\rightarrow$ `flash` model with Single-Action Protocol.
         - Complexity `7–10` $\rightarrow$ `pro` (plus a Reviewer at `>= 8`).
         - Fallback $\rightarrow$ `inherit`.
       - **Budget Mode (Zero-PRO; `--no-pro`, `--no-pro-escalation`, `#dflash`, or explicit user instruction):** PRO escalation is suppressed; a failed targeted repair halts in **Graceful Pause (Dirty Inspection)** with modified files preserved.
    3. **Subagent Invocation & Prompts:** Spawn `Artifact Executor` instructing it to read `.tmp/solve_report.md`, execute all steps thoroughly adhering to `flash/SKILL.md` (Single-Action Protocol), perform validation (`npm run typecheck` in every touched package plus `node scripts/patches_and_tests/worker-smoke.mjs`), and finalize `.tmp/solve_report.md`.
    4. **Handoff & Monitoring:** Inform the user with the subagent session link (Mode A: `[View Subagent Stream](conversation://<subagent-conversation-id>)`; Mode D Cursor: `[Name](agent-id)`; Mode E Kilo: the returned `task_id`) and the local report link (`[📋 View Execution Plan & Report](file:///<workspace-path>/.tmp/solve_report.md)`). Stop calling tools and wait for the subagent to report back.

- **Step 4: Finalize Living Change Report (Audit & Completion)**
  - When the subagent completes (or upon inline completion in Mode C, or Cursor `Task` return in Mode D), the Coordinator MUST execute a **Combo Anti-Phantom Diff Audit** before declaring completion:
    1. **Combo Diff & Untracked Inspection:** Run `git diff --name-only` (for modified tracked files) and `git status --porcelain` (to capture newly created untracked files).
    2. **Anti-Phantom Verification:** Compare the union of modified and created files against the plan's File Inventory. If any assigned file is completely untouched on disk, reject the subagent's `SUCCESS` status as an `INCOMPLETE_TASK` / `PHANTOM_REPORTING` and perform a targeted completion/escalation pass.
  - **Validation & Failure Handling:** Run sequential validation (`npm run typecheck` in every touched package, then `node scripts/patches_and_tests/worker-smoke.mjs`).
    - If validation passes: The Coordinator increments the patch version of the touched package(s) and creates the checkpoint commit.
    - If validation fails and cannot be resolved after auto-escalation: Execute a **Graceful Pause (Dirty Inspection)** — preserve intermediate modified files on disk for user inspection, log exact diagnostic errors in `.tmp/solve_report.md`, set status to `❌ FAILED`, and alert the user without destructive rollbacks.
  - Ensure `.tmp/solve_report.md` is updated to its final state (strictly in English):
    - Final Status: `✅ COMPLETED` (or `❌ FAILED`)
    - **Modified Files Inventory:** All touched files with clickable links (`file:///...`) and a 1-sentence summary of changes.
    - **Quality & Validation Results:** Exit codes/results for `npm run typecheck` (per touched package), `node scripts/patches_and_tests/worker-smoke.mjs`, and Single-Action Protocol adherence.
    - **Git & Checkpoint Status:** Commit hash, message, and version bump info (if executed).
  - In the final chat message, emit a clickable link to the report:
    `[📋 Open Change Report](file:///<workspace-path>/.tmp/solve_report.md)`
    along with a concise 2–3 sentence executive summary.

> [!IMPORTANT]
> **Cross-IDE Compatibility:** Storing the living report in `.tmp/solve_report.md` ensures that ANY IDE (Antigravity, Cursor, Windsurf, Trae, VS Code, or CLI) can open and render the report identically, while keeping the Git working tree clean.

> [!NOTE] **Lockstep Dependency Group:** This file belongs to the execution lockstep group (`multi-ide-setup`, `plan`, `exec`, `exec-wave`, `delegate`, `solve`). The 3-tier routing table, the Combo Anti-Phantom Diff Audit, and the handoff link labels must stay identical across the group; see `.agents/rules/multi-ide-setup.md`.
