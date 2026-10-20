---
name: plan
description: >-
  Inspect the relevant repository context and create a detailed plan before proposing changes.
  Triggered when the user uses the #plan tag or /plan command.
---

# Plan Workflow

- Inspect the relevant repository context before proposing changes.
- Do not modify files or execute state-changing actions.
- Follow the global preflight, scope, and decision-gate contract in `AGENTS.md`.
- **Interactive Ambiguity Check (Auto-Grill):** If any part of the request or requirements contains unresolved architecture/logic choices, high-risk trade-offs, or open dependencies, trigger the `/grillme` workflow first. Interview the user using indexed/sequential questions to resolve open choices before rendering the final plan.
- **Mandatory Execution Metadata Header:** Every generated plan (whether written to a file or output in chat) MUST start with this exact markdown block at the very top:

  ```markdown
  ## Execution Metadata

  - **Recommended Workflow:** [#exec | #exec-wave] (e.g. `#exec all` or `#exec-wave`)
  - **Recommended Execution Model:** [FLASH_LITE | FLASH | PRO | HYBRID (FLASH + PRO)]
  - **Flash-Only Viability:** [YES (Micro-Batched <= 6) | NO (Step X requires PRO: rationale)]
  - **Complexity Assessment:** [Short rationale, e.g. "Standard UI component update (Flash)" vs "Hybrid: 3 Flash UI batches + 1 Pro state refactor"]
  ```
  - **Workflow Selection Rules (`#exec` vs. `#exec-wave`):**
    - **Recommend `#exec` (or `#exec all`):** For linear, sequential implementations, single-batch updates, tightly coupled steps, or tasks touching <= 3–4 files where steps build directly on preceding changes.
    - **Recommend `#exec-wave`:** For multi-batch roadmaps (`plans/00_MASTER_ROADMAP.md` / `plans/Batch_*.md`) partitioned into serial phases and parallel waves with disjoint file sets (Scatter-Gather pattern), or when coordinator context isolation is critical.
  - **Flash-First Slicing Strategy & Flash-Only Viability:**
    - **Default Flash Partitioning:** Planners MUST by default cut architectures into small, low-context micro-batches/steps (<= 3–4 files, complexity score <= 6) so that execution can run entirely on fast, token-efficient `FLASH` models without context bloat or quality degradation.
    - **Enforced Flash Slicing (`#plan #flash`):** When `#flash` is combined with `#plan`, the planner is strictly required to decompose all tasks so that NO individual step or batch exceeds Score 6.
    - **`Flash-Only Viability: NO` Criteria:** Set to `NO` ONLY when architectural limits prevent Flash execution: e.g. target file >= 500 lines (`AGENTS.md` Mandatory Pro Decomposition), or an indivisible, high-risk state/lifecycle refactoring requiring holistic deep reasoning.
  - **3-Tier Model Recommendation Rules (Flash-First Strategy):** Default to Flash models for speed and token efficiency, escalating to `PRO` strictly where architectural complexity demands it:
    - **Tier 1 — `FLASH_LITE` (Score 1–3, Trivial / Mechanical):** Copy updates, simple type exports, static config tweaks, or minor Tailwind/CSS classes in isolated files (<300 lines).
    - **Tier 2 — `FLASH` (Score 4–6, Standard Scoped Batch):** Default workhorse tier. Component/hook updates across max. 3–4 files with clear interfaces and files <500 lines. Plans should be cut by default into small, low-context `FLASH` batches (complexity <= 6) so they can be implemented without context bloat.
    - **Tier 3 — `PRO` (Score 7–10, Complex / Architectural):** High-risk cross-file state refactors (Zustand, SSR/Hydration, Audio/Video lifecycles), files >=500 lines (`AGENTS.md` Mandatory Pro Decomposition), or massive blast-radius changes.
    - **Hybrid Plans (`HYBRID`):** When a large task contains both routine changes and a complex core, split the plan so routine steps/batches are tagged `[Tier: FLASH | Score: <=6]` and only the complex step/batch is tagged `[Tier: PRO | Score: >=7]`.
  - **Advise the Executor:** Whenever a plan or specific batch is tagged `PRO`, explicitly instruct `#exec` / `#exec-wave` to route that step/batch to a `pro` subagent (and spawn a `pro` Reviewer subagent for Red-Teaming when Score >= 8).

- **Mandatory Output Structure:** After the Metadata Header, you MUST strictly follow this 6-step structure, adapting to the language of the user's prompt (e.g., English for English prompts, German for German prompts):
  1. **Architecture & Logic (Architektur & Logik):** Create a logical step-by-step architecture compatible with the project constraints. Tag every individual step or batch header with its execution tier and score: `[Score: X/10 | Tier: FLASH_LITE | FLASH | PRO]`. For non-trivial work, include the global preflight findings, assumptions, gaps, fallbacks, and exit conditions. For state-changing plans (involving file modifications), the final planned step MUST explicitly define the validation and checkpoint commit adhering to the Git & Checkpoint Policy (Step 5). For read-only/investigative plans without code changes, conclude with the analytical findings or recommendations.
  2. **File Inventory (Datei-Inventar):** List all affected files with their relative paths. Whenever an orchestrator component or hook listed in `.agents/rules/core-react-state.md` or `.agents/rules/app-architecture.md` (or other rule file) is refactored, the plan generator must automatically append the relevant rule file to the plan's File Inventory (e.g. `Batch N: Sync .agents/rules/app-architecture.md`).
  3. **Risk & Complexity Check (Risiko- & Komplexitäts-Check):** Evaluate the complexity on a scale of 1-10 for a) each individual task/batch (assigning `FLASH_LITE` for 1–3, `FLASH` for 4–6, `PRO` for 7–10), b) the combined execution. Assess Flash-Only Viability: if any step exceeds score 6 or touches a file >=500 lines, mark `Flash-Only Viability: NO` and assign `Tier: PRO` to that specific step/batch while keeping all independent lower-score steps on `FLASH` / `FLASH_LITE`.
  4. **Optimization/Combination Hint (Optimierungshinweis):** Check if individual tasks can be combined in a way that their joint complexity remains manageable (<= 6 for `FLASH`). Provide a concrete recommendation for these step combinations. For parallel execution across multiple independent batches with disjoint files, recommend the Scatter-Gather pattern via `#exec-wave` (where `FLASH_LITE`, `FLASH`, and `PRO` subagents process disjoint batches in isolation without intermediate commits, and the Coordinator consolidates validation and commit). For linear or tightly coupled steps, recommend `#exec`.
  5. **Git & Checkpoint Policy (Git- & Checkpoint-Leitfaden):** Explicitly list the validation and commit guidelines for the executor:
     - **Pre-Commit Verification:** Run type-check/linter (`npm run lint` or `npm run check`); fix any failures before committing. Increment patch version in `package.json` on code updates.
     - **Branch Check:** Prefer committing on development branches (`preview` or dedicated `feature/*`/`task/*` branches). If on `main`/`master`, issue a clear warning, but do not hard-block if working directly on main or explicitly authorized.
     - **Scope Inspection:** Check `git status --short`. If untracked or unrelated files exist, warn in the summary, but proceed without staging foreign files.
     - **Path-Specific Staging:** Stage modified files explicitly by relative path (NEVER blind `git add .`).
     - **Commit Format:** Conventional Commits with a concise rationale in the commit body.
     - **Remote Safety:** NEVER push automatically to remote (`git push` is a strict Hard Stop requiring explicit user instruction).
  6. **Acceptance & Invariant Checklist (Audit-Kriterien für Flash):** Formulate 3–5 explicit, falsifiable invariants and acceptance criteria that a Flash model or verification pass can evaluate deterministically after implementation:
     - **Container- & System-Resilience:** e.g. every file/disk I/O (`fs`) guarded in `try/catch` for diskless cloud container compatibility.
     - **State-Lifecycle & Concurrency:** e.g. no duplicate mutations/pushes, ISO-8601 timestamps guaranteed, race-condition shields active.
     - **Data, Schema & API Contracts:** e.g. canonical field names, immutable caching headers, strictly defined MIME types and path conventions.
     - **Keep-Sets & Edge-Case Protection:** e.g. preservation of sibling poster files, untouched external CDN URLs, graceful fallbacks.

- Describe the implementation strategy, affected files, dependencies, validation, and meaningful risks.
- Keep the plan concrete enough that an implementation turn can follow it without rediscovering the design.
- Avoid code-level rewrites and fenced code blocks unless the user explicitly asks for them.
- Do not force a confirmation question when the user requested only a plan and all context is already clear, but naturally ask the user how they would like to proceed based on the plan.
