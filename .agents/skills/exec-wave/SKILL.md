---
name: exec-wave
description: Orchestrates multi-stage blueprints (such as plans/STAGE_BLUEPRINTS.md) across serial stages and parallel waves using complexity-gated subagents (Flash High for <= 6, Argon High for > 6) without bloating the main Orchestrator context. Triggered by #exec-wave, /exec-wave, #wave-exec, or /wave-exec.
---

# Exec-Wave Workflow (`#exec-wave`)

**Purpose:** Execute multi-stage architectural blueprints (`plans/STAGE_BLUEPRINTS.md` and `plans/STATE.md`) organized into serial stages or parallel package waves (`packages/edge-worker` vs. `packages/userscript-hud`) while keeping the Master-Orchestrator context window minimal.

---

## Core Execution Protocol

1. **Minimal-Context Orientation & Planning Log Check (Argon High):**
   - Read ONLY `agents.md`, `plans/STATE.md`, the last 25 lines of `plans/EXECUTION_LOG.md`, and `plans/TEST_LOG.md`.
   - Ensure the wave/stage structure and complexity assessment (`1–10`) are logged as `PLAN_DONE` in `plans/EXECUTION_LOG.md` before spawning execution subagents.
   - **CRITICAL:** The Master-Orchestrator MUST NOT read full implementation files or run long debugging loops inline in the main conversation.

2. **Serial Stage Execution (Stufe 1–4 – Complexity-Gated Model Selection):**
   - Check the stage's Complexity Score (`1–10`) from the plan:
     - **Complexity `<= 6` (Standard Stage / Clear Blueprint):** Spawn a `flash` subagent (`Model: 'flash'`).
     - **Complexity `> 6` (High-Risk Cross-File Refactor):** Spawn a `pro` subagent (`Model: 'pro'` / `'inherit'`).
   - **Role:** `Stage Executor`
   - **Prompt:** *"Lies `agents.md`, die passende Regel in `.agents/rules/` sowie deinen Abschnitt in `plans/STAGE_BLUEPRINTS.md` (bzw. das Plan-Artefakt). Trage `START` in `plans/EXECUTION_LOG.md` ein, setze die Stufe mit dem `/flash` Single-Action Protocol (keine `&&`/`;`-Verkettung) um, führe den Typ-/Smoke-Test aus und protokolliere das Ergebnis in `plans/TEST_LOG.md`, `plans/EXECUTION_LOG.md` und `plans/STATE.md`."*

3. **Parallel Wave Execution (Scatter-Gather across Disjoint Packages):**
   - When executing disjoint packages concurrently (e.g., `packages/edge-worker/` and `packages/userscript-hud/` after `shared/types.ts` is locked) with package complexity `<= 6`:
   - **Scatter:** Spawn one `flash` subagent per package concurrently (`invoke_subagent` with `Model: 'flash'`).
     - **Strict Subagent Rule:** Parallel subagents must NOT run git commands or modify shared log files (`plans/EXECUTION_LOG.md`) simultaneously; they only edit files inside their assigned package directory and report back.
   - **Gather:** Once all parallel subagents report back:
     1. Run `npx tsc --noEmit` in `packages/edge-worker` (Single-Action Protocol).
     2. Run `node scripts/patches_and_tests/worker-smoke.mjs`.
     3. Update `plans/TEST_LOG.md`, `plans/EXECUTION_LOG.md`, and `plans/STATE.md`.
