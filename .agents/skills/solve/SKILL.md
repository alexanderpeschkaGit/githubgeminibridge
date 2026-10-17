---
name: solve
description: Plans a multi-file solution on Argon High using the 4-phase impact analysis, logs the planning checkpoint, and delegates execution to a complexity-gated subagent (Flash High for <= 6, Argon High for > 6). Triggered by #solve or /solve.
---

# Solve Workflow (Argon High 4-Phase Plan & Complexity-Gated Delegate)

- **Purpose:** Investigate a multi-file task or stage requirement on **Argon High**, verify `P1` component invariants and type/rule boundaries (`shared/types.ts` and `.agents/rules/*.md`), log the planning step in `plans/EXECUTION_LOG.md`, write a concrete execution artifact, and spawn an isolated subagent to execute it.

- **Step 1: 4-Phase Impact Mapping & Complexity Check (Always on Argon High)**
  1. **Impact Mapping:** Identify all affected files across `shared/`, `packages/edge-worker/`, or `packages/userscript-hud/`.
  2. **Execution Sequence & Complexity Score:** Define the exact modification order and rate complexity (`1–10`) for each task and combined execution.
  3. **Rule, `P1` & Guardrail Check:** Verify compliance with root `agents.md` (`P1` of all components, `validateNoPlaceholders`, 1-subrequest limits, and V1/V2 route compatibility).
  4. **Ambiguity Gate:** If any architectural choice is unresolved, trigger `#grillme` before delegating.

- **Step 2: Log Planning & Create Context Artifact**
  - Append a `PLAN_DONE` entry to `plans/EXECUTION_LOG.md` (documenting the structured design, Complexity Score `X/10`, and target execution model) and update `plans/STATE.md` (and `agents.md` if architecture rules evolved).
  - Write the step-by-step implementation instructions into a Markdown Artifact using `write_to_file` (`RequestFeedback: false`).

- **Step 3: Spawn the Subagent (Complexity-Gated `/delegate`)**
  - Use `invoke_subagent` with model selection governed strictly by the Complexity Score:
    - **If Complexity `<= 6` (Low/Medium complexity, clear blueprint):** Set `Model: 'flash'` (Flash High) and enforce the `/flash` Single-Action Protocol.
    - **If Complexity `> 6` (High complexity, intricate cross-module refactor):** Set `Model: 'pro'` / `'inherit'` (Argon High).
  - **Role:** `Stage Solve Executor`
  - **Prompt:** *"Read the execution plan at `[Absolute Path to Artifact]` and `agents.md`. Follow the `/flash` Single-Action Protocol (no `&&` or `;`). Log START/DONE in `plans/EXECUTION_LOG.md`, run verification (`npx tsc --noEmit` and `node scripts/patches_and_tests/worker-smoke.mjs`), update `plans/TEST_LOG.md` and `plans/STATE.md`, and verify whether `agents.md` or `.agents/rules/` needs synchronization."*

- **Step 4: Handoff**
  - Provide a clickable link to the subagent session: `[View Subagent Stream](conversation://<subagent-conversation-id>)` and wait for completion.
