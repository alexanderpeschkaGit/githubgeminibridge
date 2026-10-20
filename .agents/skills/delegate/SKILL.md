---
name: delegate
description: >-
  Writes a focused execution plan to an Artifact and spawns a subagent to execute it from the file, preventing context bloat.
  Triggered by #delegate, /delegate, #deligate, or /deligate.
---

# Delegate Workflow

- **Purpose:** To prevent conversation bloat by giving a subagent a pristine, noise-free instruction set. This is the programmatic equivalent of starting a brand new chat just for execution.
- **Step 1: Create the Context Artifact:**
  - Write the exact step-by-step implementation instructions, file paths, and required context into a Markdown Artifact using the `write_to_file` tool.
  - You MUST provide `ArtifactMetadata` when creating this file.
  - You MUST set `RequestFeedback: false` so that the workflow does not pause. The artifact is strictly for the user's visual reference.
- **Step 2: Spawn the Subagent:**
  - Immediately after creating the artifact, use the `invoke_subagent` tool.
  - **Model Selection (3-Tier Intelligent Routing):**
    1. **Explicit Override:** If the prompt explicitly contains the word `flash` (with or without `#`), invoke the subagent using `flash`. If it explicitly specifies `pro` (or `#pro`), use `pro`.
    2. **Complexity-Gated Evaluation:** When a plan or task includes a Complexity Score (`1–10`) or clear execution blueprint:
       - **Complexity `<= 6` (Clear blueprint, localized edits, unit tests, smoke checks):** Set `Model: 'flash'` and enforce the Single-Action Protocol.
       - **Complexity `> 6` (Complex multi-package architecture, ambiguous root causes):** Set `Model: 'pro'` / `'inherit'`.
    3. **Default / Fallback:** Default to `inherit` (strictly preserves the user's currently selected IDE model, e.g. Flash High, rather than overriding with a heavy model).
  - **Role:** `Artifact Executor`
  - **Prompt:** Keep the prompt extremely minimal. Do NOT pass the plan inline. Example: *"Read the execution plan located at `[Absolute Path to Artifact]` and implement all steps thoroughly. Follow the Single-Action Protocol from `flash/SKILL.md` (no `&&` or `;` command chaining, sequential verification). Verify whether any referenced rule file in `.agents/rules/` requires synchronization with the new exports/components, and include it in the final verification step. Do not stop until all steps are complete."*
- **Step 3: Handoff:**
  - Inform the user that the artifact has been generated and the subagent is currently running in the background.
  - You MUST provide a clickable link to the subagent's isolated session using the exact format: `[View Subagent Stream](conversation://<subagent-conversation-id>)`. Note: Live progress can also be monitored via the IDE's subagent status pill / background task panel.
  - Stop calling tools and wait for the subagent to report back.
