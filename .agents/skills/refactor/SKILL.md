---
name: refactor
description: >-
  Improve structure and maintainability without intentionally changing observable behavior.
  Triggered when the user uses the #refactor tag or /refactor command.
---

# Refactor Workflow

- Improve structure and maintainability without intentionally changing observable behavior.
- **Scope Boundary (`#refactor` vs. `#deep-refactor`):** `#refactor` covers structural improvements that stay inside the current architecture: extracting subcomponents, hooks, or utilities, tightening types, removing duplication, and splitting files that are still under ~300 lines. When a target file is >= 300 lines and must be decomposed into hooks, pure utilities, types, and leaf components with 100% behavior parity, switch to `#deep-refactor` (`deep-refactor/SKILL.md`) — it owns the batch/blueprint decomposition protocol. If ownership, state boundaries, or parity guarantees are ambiguous, run `#grillme` before touching code.
- **Subagent 3-Point Return Contract:** Subagents spawned for parallel refactors MUST report back exactly `1. Status: [SUCCESS | BLOCKED | FAILED]`, `2. Files Modified: [relative paths]`, `3. Summary: [1-2 sentences]`. Any other shape counts as an incomplete report and must be re-requested.
- **Parallel Refactoring (Scatter-Gather):** When performing bulk edits across independent files, spawn multiple `flash` subagents concurrently. These subagents must ONLY perform read/edit file operations. They are strictly forbidden from running shell commands to prevent terminal lock contention. The main agent ("Coordinator") gathers the results and executes a single sequential type-check/build at the end.
- **Flash Execution Protocol:** Whenever executing under a Flash model or with `#flash`, strictly follow the Single-Action Protocol from `flash/SKILL.md` (no command chaining with `&&` or `;`, sequential verification, diagnostic check on error).
- **AST & Compiler Validation over LLM Trust:** Never rely on model assumptions that imports or types remain valid across modified files. Run a deterministic terminal check (`npm run typecheck` in the touched package) to establish a baseline before changes and verify strictly after each batch.
- **Diff Limits & Bottom-Up Dependency Traversal:** Never rewrite an entire codebase or broad cross-cutting layer in one prompt. Refactor incrementally module-by-module along the dependency tree in strict bottom-up order:
  1. Types, interfaces, and foundational utilities (`types/`, `utils/`)
  2. Core business logic, services, stores, and state managers (`store/`, `hooks/`)
  3. UI presentation components and routing layers
- Inspect callers, shared types, state ownership, and platform-specific behavior before editing.
- Prefer focused extractions with clear responsibilities over broad rewrites.
- Edit files directly, then run the deterministic terminal validation (`npm run typecheck` in the touched package plus `node scripts/patches_and_tests/worker-smoke.mjs`).
- If preserving behavior is impossible or requirements conflict, stop and explain the required behavioral decision before proceeding.
- Summarize structural changes, validation results, and any remaining risks without reproducing complete files.
- **Documentation Evaluation & Prompt:** First, evaluate the refactor's impact. If the changes were purely cosmetic, strictly localized, or did not alter the overall system architecture, skip this step. However, if the refactor introduced new architectural patterns, modified global state, altered cross-component logic, or changed dependencies: (1) Read `AGENTS.md` and any relevant `.agents/rules/` files to analyze the current guidelines. (2) Strictly initiate a `#grillme`-style interview. Use your analysis to ask the prompter highly targeted, contextual questions about if and how these new patterns should modify the existing documentation.
