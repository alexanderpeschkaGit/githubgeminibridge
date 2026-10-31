---
name: plan
description: >-
  Inspect the relevant repository context and create a detailed plan before proposing changes.
  Triggered when the user uses the #plan tag or /plan command.
---

# Plan Workflow (`#plan`)

Read-only: inspect context, never modify project files or run state-changing actions (except writing the plan artifact, registry entry, and log lines). Global contract (`AGENTS.md`) applies. Plans are always written in **English**.

## 0. Context Budget

- Read only files needed to locate edit points; prefer targeted searches and line ranges over whole files.
- Reference code via **Anchor Snippets** (1–3 exact lines, signatures, or anchor comments) — never full-file dumps or large rewrites.
- Write the full plan to the artifact; in chat return only the Execution Metadata header, a step list (one line per step with tag), and open questions.

## 1. Identity & Registration

1. `node scripts/plan-registry.mjs generate-id` → `planId`.
2. Write the plan to `.tmp/plans/<planId>.md` (SSOT).
3. `plan-registry.mjs register <planId> .tmp/plans/<planId>.md <exec|exec-wave> <tier> <baseSha> <description>` with `baseSha = git rev-parse HEAD`.
4. Append `PLAN_START <planId>` / `PLAN_DONE <planId>` to `plans/EXECUTION_LOG.md`.
5. **Auto-Grill:** unresolved architecture choices, high-risk trade-offs, or open dependencies ⇒ run `#grillme` before finalizing.

## 2. Execution Metadata Header (mandatory, top of plan)

```markdown
## Execution Metadata
- **Plan ID:** [plan-YYYYMMDDHHmmss-xxxx]
- **Artifact Path:** [.tmp/plans/<planId>.md]
- **Base SHA:** [git rev-parse HEAD]
- **Recommended Workflow:** [#exec | #exec-wave]
- **Recommended Execution Model:** [FLASH_LITE | FLASH | PRO | HYBRID (FLASH + PRO)]
- **Flash-Only Viability:** [YES (Micro-Batched <= 6) | NO (Step X requires PRO: rationale)]
- **Complexity Assessment:** [short rationale]
```

- **`#exec`:** linear/tightly coupled steps or ≤ 3–4 files. **`#exec-wave`:** multi-batch roadmaps (`plans/00_MASTER_ROADMAP.md`, `plans/Batch_*.md`) with disjoint parallel waves or when coordinator isolation matters.

## 3. 3-Tier Routing & Flash-First Slicing (lockstep)

| Tier | Score | Model | Scope |
| :--- | :--- | :--- | :--- |
| 1 `FLASH_LITE` | 1–3 | `flash_lite` | Copy, simple types, static config, minor CSS; files < 300 lines, ≤ 2–3 files (4+ files ⇒ `FLASH` or split) |
| 2 `FLASH` (default) | 4–6 | `flash` | Scoped batches ≤ 3–4 files, clear interfaces, < 500 lines |
| 3 `PRO` | 7–10 | `pro` | Edge-worker request/commit pipeline, HUD patch-queue/OID state, GitHub GraphQL/tarball contracts, unsliced files ≥ 500 lines, high blast radius (Reviewer at ≥ 8) |

- Slice by default into micro-steps (≤ 3–4 files, Score ≤ 6). `#plan #flash` ⇒ **no** step may exceed Score 6.
- `Flash-Only Viability: NO` only for indivisible high-risk refactors. ≥ 500-line targets do not force `NO` if micro-batched with Anchor Snippets (e.g. via `#deep-refactor`).
- **HYBRID:** tag routine steps `FLASH`, only the complex core `PRO`; instruct the executor to route `PRO` steps to a `pro` subagent (+ Red-Team Reviewer at ≥ 8).

## 4. Plan Body (6 sections, in order)

1. **Architecture & Logic:** steps tagged `[Score: X/10 | Tier: FLASH_LITE|FLASH|PRO | Depends on: Step X | Independent]`; include preflight findings, assumptions, fallbacks, exit conditions. State-changing plans end with a validation + checkpoint step; read-only plans end with findings.
2. **File Inventory:** every file with relative path and ≥ 1 numbered instruction with Anchor Snippets. This is the baseline of the executor's **Combo Anti-Phantom Diff Audit** (`git diff --name-only` ∪ `git status --porcelain`), so every listed file must change on disk. Refactoring a module documented in `.agents/rules/*.md` ⇒ add the rule file sync to the inventory.
3. **Risk & Complexity:** score per step and combined; mark any step > 6 or unsliced ≥ 500-line file as `PRO` / Viability `NO` (unless `#flash` slicing applies).
4. **Optimization Hint:** which steps can merge while staying ≤ 6; recommend `#exec-wave` scatter-gather for disjoint batches, `#exec` for coupled ones.
5. **Checkpoint Policy:** list touched packages and the gate (`npm run typecheck` per package + `node scripts/patches_and_tests/worker-smoke.mjs`); the executor applies the `exec` §7 checkpoint (Coordinator-only version bump, explicit staging, Conventional Commit, never `git push`).
6. **Acceptance & Invariant Checklist:** 3–5 falsifiable invariants (resilience, state/concurrency, API/schema contracts, keep-sets/edge cases) checkable deterministically after implementation.

## 5. Close

Do not force a confirmation question when only a plan was requested; suggest the next command (e.g. `#exec <planId> all`).

> [!NOTE] **Lockstep Dependency Group:** This file belongs to the execution lockstep group (`multi-ide-setup`, `plan`, `exec`, `exec-wave`, `delegate`, `solve`). The 3-tier routing table, the Combo Anti-Phantom Diff Audit, and the handoff link labels must stay identical across the group; see `.agents/rules/multi-ide-setup.md`.
