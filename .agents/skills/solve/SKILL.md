---
name: solve
description: >-
  Investigates an issue, drafts an execution plan, and immediately delegates execution via the #delegate skill.
  Triggered by #solve or /solve.
---

# Solve Workflow (Investigate, Plan & Delegate)

- **Purpose:** Automatically investigate an issue, formulate a verified execution plan, and immediately delegate the entire execution pipeline to the `#delegate` skill (`delegate/SKILL.md`).

- **Step 1: Investigate and Plan**
  - Inspect the relevant repository context, diffs, and files to understand the problem.
  - Follow the global preflight, scope, and decision-gate contract in `AGENTS.md`; if material ambiguity exists, resolve it first using `#grillme`.
  - Formulate the concrete step-by-step implementation plan and affected file inventory.
  - Assess the **Task Complexity (1–10)**:
    - `<= 6`: Localized edits, unit tests, single component refactors, smoke checks.
    - `> 6`: Cross-package architecture, complex state flows, high blast-radius changes.

- **Step 2: Delegate via `#delegate` Workflow**
  - Hand over execution directly to the `#delegate` skill (`delegate/SKILL.md` or `.agents/skills/delegate.md`).
  - Follow all protocols defined in `delegate`:
    1. **Context Artifact:** Create the execution plan artifact via `write_to_file` (`RequestFeedback: false`, `ArtifactMetadata`).
    2. **Model Selection (3-Tier Intelligent Routing):**
       - Strict adherence to the `delegate` routing:
         - Explicit prompt overrides (`flash` or `pro`).
         - Complexity `<= 6` $\rightarrow$ `flash` model with Single-Action Protocol.
         - Complexity `> 6` $\rightarrow$ `pro` / `inherit`.
         - Fallback $\rightarrow$ `inherit`.
    3. **Subagent Invocation & Prompts:** Spawn `Artifact Executor` with the centralized prompt template including `.agents/rules/` synchronization.
    4. **Handoff & Monitoring:** Inform the user with both the plan link and the subagent session link (`[View Subagent Stream](conversation://<subagent-conversation-id>)`). Remind the user that the subagent progress can also be tracked live via the IDE's Subagent panel / background task indicator.
    5. Stop calling tools and wait for the subagent to report back.

> [!IMPORTANT]
> **Single Source of Truth:** Do NOT duplicate subagent invocation, prompt formatting, or model selection logic inside `solve`. Always follow and inherit the active `#delegate` skill specifications so future updates to `delegate` automatically take effect for `solve`.
