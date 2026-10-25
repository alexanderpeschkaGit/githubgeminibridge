---
name: exec-wave
description: >-
  Orchestrates multi-batch roadmaps (such as 00_MASTER_ROADMAP.md) across serial and parallel waves using tiered subagents (flash_lite, flash, pro) and Multi-IDE fallbacks without bloating the main Coordinator context.
  Triggered by #exec-wave, /exec-wave, #wave-exec, or /wave-exec.
---

# Exec-Wave Workflow (`#exec-wave`)

**Purpose:** Execute multi-batch architectural plans (`plans/Batch_*.md`) organized into serial phases and parallel waves while keeping the main Coordinator agent's context window minimal and routing each batch to the most cost- and speed-effective model tier.

---

## Core Execution Protocol

1. **Read Only the Master Roadmap & Resolve Batch Tiers:**
   - Read the referenced roadmap file (e.g., `plans/00_MASTER_ROADMAP.md`) to identify the execution topology (Serial Phases vs. Parallel Waves) and each batch's complexity metadata (`[Score: X/10 | Tier: FLASH_LITE | FLASH | PRO]`).
   - **CRITICAL:** The Coordinator MUST NOT read the full target source files or implement code inline in the main conversation (unless operating in a Mode C Single-Agent IDE without subagents; Mode D Cursor may use `Task` isolation instead — see Section 5).
   - **3-Tier Per-Batch Model Selection (Flash-First Strategy):** Triggering `#exec-wave` / `/exec-wave` (or `#wave-exec` / `/wave-exec`) constitutes explicit user authorization to pass `Model: 'flash_lite' | 'flash' | 'pro'` to `invoke_subagent` (overriding default `'inherit'` in Mode A). In Kilo (Mode E) the trigger authorizes `task` delegation, but `model` and `variant` overrides still require an explicit model request; omit them so subagents inherit:
     - **Tier 1 (`flash_lite` — Score 1–3):** Trivial/mechanical batches (copy, simple types, static config, minor Tailwind/CSS in files <300 lines, strictly capped at <= 2–3 files). Auto-Upgrade Guard: If a batch tagged `flash_lite` touches 4 or more files, the Coordinator MUST automatically escalate its Model to `flash` upon invocation to prevent subagent truncation and phantom reporting.
     - **Tier 2 (`flash` — Score 4–6, Default):** Standard scoped implementation batches (<= 3–4 files, clear interfaces, files <500 lines). If a batch has no explicit tier tag and touches only files <500 lines, default to `flash`.
     - **Tier 3 (`pro` — Score 7–10 or Unsliced Files >=500 Lines):** Complex cross-file changes (edge-worker request/commit pipeline, HUD patch-queue and OID state, GitHub GraphQL/tarball contracts), unsliced files >=500 lines (`AGENTS.md` Mandatory Pro Decomposition), or high blast-radius architecture batches. **Flash Wave Exemption:** If `#flash` is specified in the trigger or roadmap, batches touching >=500 line files route to `flash` instead of `pro`, provided the batch File Inventory <= 3 files and complexity score <= 6.

2. **Serial Phase Execution:**
   - For a serial batch (e.g., `plans/Batch_01_*.md`), spawn a single subagent via `invoke_subagent` using the batch's resolved tier:
     - **TypeName:** `self`
     - **Model:** `flash_lite` (Score 1–3) | `flash` (Score 4–6) | `pro` (Score 7–10)
     - **Role:** `Batch Executor`
     - **Prompt:** _"Read the execution plan at `<relative-path-to-batch.md>` and implement all file changes strictly as specified, adhering to `.agents/skills/flash/SKILL.md` stability rules. Do NOT run git commit or shell commands; only perform file read/edit/write operations. You MUST inspect and modify every file listed in your plan's File Inventory. Upon completing your assigned batch, report back strictly using this 3-point format:\n1. Status: [SUCCESS | BLOCKED | FAILED]\n2. Files Modified: [List ONLY the relative paths you actually modified or created]\n3. Summary: [1-2 sentences summarizing changes made or blockers encountered]\nDo NOT dump complete source files into the report."_
   - **Serial Launch Card (Clickable Stream Link, Mode A):** Immediately after invoking `invoke_subagent`, output a launch card with a clickable deep link to the subagent's live session before entering the wait state. In Kilo report the returned `task_id` rather than a `conversation://` link:
     - Format: `[⚡ Watch Batch Live Stream](conversation://<subagent-conversation-id>)`
   - **Gather & Validation:** Wait for the subagent to report back, log its 3-point feedback summary, run the validation gate (`npm run typecheck` in every touched package plus `node scripts/patches_and_tests/worker-smoke.mjs`), and create the checkpoint commit on the current branch (this repository develops directly on `main`; never `git push` without explicit user instruction).

3. **Parallel Wave Execution (Hybrid Scatter-Gather):**
   - For a parallel wave (e.g., Wave 1: `Batch_02`, `Batch_03`, `Batch_04`), verify from the roadmap that their File Inventories are strictly disjoint (zero overlapping files).
   - **Scatter:** Spawn one subagent per batch concurrently via `invoke_subagent` with `TypeName: 'self'`, `Role: 'Batch Executor'`, and its batch-specific `Model` (`flash_lite`, `flash`, or `pro`). Routine `flash` batches and complex `pro` batches can run side-by-side in the same wave so only the complex batch uses Pro tokens.
     - **Strict Subagent Rule:** Parallel subagents are strictly forbidden from running terminal/shell commands (`npm`, `tsc`, `git`) to prevent lock contention and race conditions. They must ONLY read, create, or edit their assigned files.
     - **Standard Subagent Prompt:** Every parallel subagent MUST be instructed with the standard 3-point feedback contract:
       _"Read the execution plan at `<relative-path-to-batch.md>` and implement all file changes strictly as specified, adhering to `.agents/skills/flash/SKILL.md` stability rules. Do NOT run git commit or shell commands; only perform file read/edit/write operations. You MUST inspect and modify every file listed in your plan's File Inventory. Upon completing your assigned batch, report back strictly using this 3-point format:\n1. Status: [SUCCESS | BLOCKED | FAILED]\n2. Files Modified: [List ONLY the relative paths you actually modified or created]\n3. Summary: [1-2 sentences summarizing changes made or blockers encountered]\nDo NOT dump complete source files into the report."_
   - **Wave Launch Dashboard (Mode A: clickable links; Kilo: `task_id` column):** Immediately after triggering `invoke_subagent` or `task`, the Coordinator MUST render a structured Wave Launch Dashboard table in chat before stopping tool calls to wait:
     ```markdown
     ### 🌊 Parallel Wave Launched: Wave X

     | Batch      | Tier & Model                | Assigned Scope / Files | Live Stream Link                                   |
     | :--------- | :-------------------------- | :--------------------- | :------------------------------------------------- |
     | `Batch_02` | `FLASH` (`flash`)           | `packages/edge-worker/...` | [⚡ Watch Batch_02 Stream](conversation://<id-02>) |
     | `Batch_03` | `FLASH_LITE` (`flash_lite`) | `shared/...`           | [⚡ Watch Batch_03 Stream](conversation://<id-03>) |
     | `Batch_04` | `PRO` (`pro`)               | `packages/userscript-hud/...` | [⚡ Watch Batch_04 Stream](conversation://<id-04>) |
     ```
   - **Gather & Auto-Escalation Gate:** Once all parallel subagents in the wave have reported back:
     1. **Wave Completion Summary:** Aggregate the subagents' 3-point reports into a concise bulleted summary in the main chat (Status, modified files, brief summary).
     2. **Combo Anti-Phantom Diff Audit:** Run both `git diff --name-only` (modified tracked files) and `git status --porcelain` (adds untracked files) in the Coordinator terminal, then reconcile the union of both outputs against each batch plan's `File Inventory` — a single command is insufficient because `git diff --name-only` omits untracked files and `git status --porcelain` blurs the modified/created distinction. If any file assigned for modification shows zero diffs, immediately reject the subagent's SUCCESS status as an `INCOMPLETE_BATCH` / `PHANTOM_REPORTING` and perform a targeted completion/escalation pass before running validation commands.
     3. **Sequential Validation:** Run `npm run typecheck` in every touched package, then `node scripts/patches_and_tests/worker-smoke.mjs`, sequentially in the main Coordinator terminal.
     4. **Auto-Escalation (`FLASH` → `PRO`) & Zero-PRO Guard:**
        - **Standard:** If a `flash_lite` or `flash` batch caused a type, lint, or test failure that survives **one** targeted Coordinator fix, immediately re-delegate that specific batch's files to a `pro` subagent (`TypeName: 'self'`, `Model: 'pro'`, `Role: 'Batch Executor'`). Output the escalation stream link: `[🚨 Watch Escalation Stream (PRO)](conversation://<pro-conversation-id>; Mode A only, in Kilo report the returned task_id)`. Enforce the same 3-point feedback contract.
        - **Budget Mode (Zero-PRO; `--no-pro`, `--no-pro-escalation`, `#dflash`, or explicit user instruction):** When budget mode is active, do NOT escalate to `pro`. If the single targeted Coordinator fix does not resolve the failure, halt the wave immediately in **Graceful Pause (Dirty Inspection)**: preserve all modified intermediate files on disk without destructive resets, run `git diff` and compiler checks to log the exact errors, and notify the user: `[Graceful Pause (Dirty Inspection): Wave halted without PRO escalation. Modified files preserved on disk for manual inspection.]`.
     5. **Red-Team Audit for Critical Batches:** If any batch in the wave had Score >= 8 (`Tier: PRO`), spawn a read-only Reviewer subagent via `invoke_subagent` with `TypeName: 'research'`, `Model: 'pro'`, `Role: 'Red-Team Auditor'` on that batch's modified files before committing. Output the reviewer stream link: `[🛡️ Watch Red-Team Audit](conversation://<reviewer-conversation-id>; Mode A only, in Kilo report the returned task_id)`, and require a compact 2-point audit report (`1. Verdict: [PASS | BLOCKING_ISSUES]`, `2. Findings: [Concise file:line bullets or "None"]`).
     6. Stage all files from the wave explicitly by relative path (`git add <file1> <file2> ...` derived directly from the audited diffs — NEVER run blind `git add .` or `git add -A`) and create a single consolidated checkpoint commit for the wave.

4. **Final Verification Gate (After Final Phase):**
   - Run the full repository verification suite sequentially (Single-Action Protocol):
     1. `npm run typecheck` in `packages/edge-worker`
     2. `npm run typecheck` in `packages/userscript-hud`
     3. `npm run typecheck` in `packages/local-cli`
     4. `node scripts/patches_and_tests/worker-smoke.mjs`
     5. `node scripts/patches_and_tests/run-regressions.mjs`
   - Bump the patch version of the touched package(s) once (exclusively by the Coordinator, unless an explicit config batch in the roadmap already bumped it; `packages/userscript-hud` uses `npm run release:patch` to keep the userscript `@version` banner in sync) and commit the final state on the current branch (this repository develops directly on `main`; never `git push` without explicit user instruction).

5. **Multi-IDE Capability Translation (Cross-IDE Portability):**
   - Adapt wave execution automatically to the host environment (see `.agents/rules/multi-ide-setup.md`):
     - **Mode A — Native Multi-Model Subagents (e.g., Antigravity):** Execute full parallel Scatter-Gather with `TypeName: 'self'` (or `'research'` for Red-Team audits) and per-batch `Model: 'flash_lite' | 'flash' | 'pro'`. Emit live clickable links via `[⚡ Watch Stream](conversation://<conversation-id>)` and aggregate the 3-point feedback reports in the Gather phase.
     - **Mode B — Fixed-Model or Rate-Limited Subagents (e.g., Kimi Code / CLI Agents):** Spawn subagents with `Model: 'inherit'` to preserve context isolation, enforce `.agents/skills/flash/SKILL.md` and the 3-point feedback contract inside each subagent, and respect host concurrency rules (e.g., sequential subagent queue with pacing in `KIMI.md`). If the UI cannot handle `conversation://` URIs, output the subagent ID and the absolute path to its transcript file (`file:///<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`) as a readable fallback.
     - **Mode C — Single-Agent IDEs without Subagents (e.g., Cline / Windsurf):** Execute batches sequentially in strict context-hygiene passes (read only the current batch's target files, apply `.agents/skills/flash/SKILL.md` Single-Action Protocol, emit short 3-point feedback per batch pass, and validate per wave). Before starting a `Tier: PRO` batch (Score >= 7), emit a brief model-switch advisory if running on a fast/lightweight model, or perform an explicit self-review pass before staging.
     - **Mode D — Cursor (Task Subagents):** Map each batch to Cursor `Task` (`generalPurpose` implementer; `explore` for Score >= 8 auditors). Default `model: "inherit"`; never pass `flash_lite`/`flash`/`pro` as Cursor model slugs. Parallel Scatter-Gather only for disjoint file inventories; otherwise serial. Link via `[Name](agent-id)`; enforce Flash SKILL + 3-point feedback inside each subagent; persist wave plans/reports in `.tmp/`.
      - **Mode E - Kilo Code (`task` Subagents):** Map each batch to `task` (`general` implementer; `explore` for Score >= 8 auditors). Omit `model`, `provider`, and `variant` so subagents inherit the active model; overrides only on explicit user request. Parallel scatter-gather only for disjoint file inventories. Report each returned `task_id` instead of a `conversation://` link; enforce Flash SKILL + 3-point feedback; persist wave plans/reports in `.tmp/`.

> [!NOTE] **Lockstep Dependency Group:** This file belongs to the execution lockstep group (`multi-ide-setup`, `plan`, `exec`, `exec-wave`, `delegate`, `solve`). The 3-tier routing table, the Combo Anti-Phantom Diff Audit, and the handoff link labels must stay identical across the group; see `.agents/rules/multi-ide-setup.md`.
