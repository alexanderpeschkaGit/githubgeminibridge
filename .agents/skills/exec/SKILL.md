---
name: exec
description: >-
  Implement steps from the most recent plan.
  Triggered when the user uses the #exec tag or /exec command.
---

# Exec Workflow (`#exec <planId> <N|all>`)

Global contract (`AGENTS.md` preflight, scope, `< 500` lines, Decision Gate, Single-Action Protocol) applies and is not restated here. On new material ambiguity, pause and run `#grillme`.

## 0. Context Budget (Coordinator)

- Load plan metadata via `node scripts/plan-registry.mjs get <planId>` (one JSON line); never read the whole `.tmp/plan-registry.json`.
- From the plan artifact read only the header (Execution Metadata, `scope.files`, Acceptance & Invariant Checklist) plus the step(s) being executed.
- When delegating, pass **paths and IDs**, not inlined specs or file contents. Do not pre-read target source files the subagent will edit.
- Inspect results with `git diff --stat` / `--name-only`; open a full `git diff -- <file>` only for a failing or suspicious file.
- Report validation as pass/fail plus the first relevant errors; never paste full compiler or test logs.

## 1. Plan Binding

1. Resolve `<planId>`: if omitted, use the single `RUNNING` plan (`plan-registry.mjs running`); otherwise list `queued` plans and ask the user to pick one. Never guess "most recent".
2. Load `.tmp/plans/<planId>.md`. If `git rev-parse HEAD` ≠ `baseSha`, warn and require confirmation.
3. `node scripts/plan-registry.mjs lock <planId> <scope.files...>`, then `start <planId>`. Append `START <planId> step <N|all>` to `plans/EXECUTION_LOG.md`.
4. `N = all` ⇒ run all remaining steps in order without routine confirmations.

## 2. 3-Tier Routing (lockstep)

| Tier | Score | Model | Scope |
| :--- | :--- | :--- | :--- |
| 1 `FLASH_LITE` | 1–3 | `flash_lite` | Copy, config, type, CSS edits; files < 300 lines, ≤ 2–3 files |
| 2 `FLASH` (default) | 4–6 | `flash` | Bounded component/hook steps; ≤ 3–4 files, < 500 lines |
| 3 `PRO` | 7–10 | `pro` | Edge-worker request/commit pipeline, HUD patch-queue/OID state, GitHub GraphQL/tarball contracts, unsliced files ≥ 500 lines |

- **Hybrid plans:** only `PRO`-tagged steps go to `pro`; all others run on Flash tiers.
- **Flash Override:** with `Flash-Only Viability: YES` or `#flash`, ≥ 500-line files may run on `flash` if the step is sliced to Score ≤ 6 and uses Anchor-Snippet edits only (no whole-file rewrites).
- **Inline vs. Subagent:** run inline (under `.agents/skills/flash/SKILL.md`) only for a single `#exec N` whose tier ≤ the active session model. Otherwise delegate (`invoke_subagent`, `TypeName: 'self'`, `Role: 'Step Executor'`, tier `Model`). `#exec all` always delegates per step for context isolation.
- **Red-Team (Score ≥ 8 or high blast-radius `PRO`):** after implementation spawn `TypeName: 'research'`, `Model: 'pro'`, `Role: 'Red-Team Auditor'`, emit `[🛡️ Watch Red-Team Audit](conversation://<id>)` and require `1. Verdict: [PASS | BLOCKING_ISSUES]` `2. Findings: [file:line bullets or "None"]` before finalizing.

## 3. Subagent Prompt (fresh context — fill placeholders, do not inline the plan)

> Read step `<N>` of `.tmp/plans/<planId>.md` (planId: `<planId>`, baseSha: `<baseSha>`). Allowed files: `<scope.files>`. Implement exactly that step using file read/edit tools under `.agents/skills/flash/SKILL.md`. Inspect and modify every file in the step's File Inventory. Do NOT run `git` commands. Report only: `1. Status: [SUCCESS | BLOCKED | FAILED]` `2. Files Modified: [relative paths]` `3. Summary: [1-2 sentences]` `4. planId` `5. batchId/step`. Never paste source code.

Immediately after launch emit `[⚡ Watch Step Stream](conversation://<subagent-conversation-id>)` (Kilo: report `task_id`), then wait.

## 4. Gather & Combo Anti-Phantom Diff Audit (lockstep)

Before accepting `SUCCESS`, run `git diff --name-only` and `git status --porcelain` and reconcile their union against `scope.files` and the step File Inventory:
- Assigned file untouched ⇒ `INCOMPLETE_TASK` / `PHANTOM_REPORTING` → targeted completion pass.
- Modified file outside scope ⇒ `SCOPE_VIOLATION` → reject the report, never stage that file, and flag it to the user (no auto-revert).
Then verify the plan's **Acceptance & Invariant Checklist** point by point.

## 5. Validation (per package; no root `package.json`)

- **Intermediate step:** `npm run typecheck` in each touched package only (`packages/edge-worker`, `packages/userscript-hud`, `packages/local-cli`). Leave changes uncommitted, no version bump.
- **Plan completion (`all` or final step):** typecheck every touched package → `node scripts/patches_and_tests/worker-smoke.mjs` → `node scripts/patches_and_tests/run-regressions.mjs`.

## 6. Failure Ladder (never loop)

1. Flash failure (type/lint/test) ⇒ **one** targeted diagnose-and-repair attempt.
2. Still failing ⇒ escalate the step to `pro` (`TypeName: 'self'`, `Model: 'pro'`).
3. **Budget mode** (`--no-pro`, `--no-pro-escalation`, `#dflash`, or user instruction) ⇒ skip step 2 and go to Graceful Pause.
4. **Pro quota exhausted** (429 / ResourceExhausted) ⇒ fall back to `flash` with Single-Action Protocol and micro-batched edits; after 2 failed attempts ⇒ Graceful Pause.
5. **Graceful Pause (Dirty Inspection):** keep all modified files (never `git checkout`/`git reset`), show the scoped `git diff` and the failing compiler lines, log `BLOCKED_NEEDS_USER_INPUT`, and alert: `[Graceful Pause (Dirty Inspection): Step halted. Modified files preserved on disk for manual inspection.]`

## 7. Plan Completion Checkpoint (autonomous, never deferred)

1. Full gate from §5 green (otherwise fix or abort — never commit broken code).
2. Bump the patch version of touched package(s); `packages/userscript-hud` uses `npm run release:patch` (keeps `@version` in sync).
3. `git status --short`: warn about unrelated/untracked files; work stays on `main`.
4. Stage planned files explicitly (`git add <paths>`); never `git add .` / `-A`.
5. Conventional Commit `type(scope): subject` + short rationale body.
6. Never `git push` (Hard Stop).
7. `plan-registry.mjs complete <planId>` + `release <planId>` (on abort: `abort` + `release`). Append `DONE <planId>` to `plans/EXECUTION_LOG.md` and the gate results to `plans/TEST_LOG.md`.

## 8. Multi-IDE

Follow `.agents/rules/multi-ide-setup.md` (Mode A–E). Deltas for this skill: Mode A uses tier `Model` values above; Modes B/D/E inherit the active model (never pass `flash_lite`/`flash`/`pro` as Cursor/Kilo slugs; Kilo reports `task_id`, Cursor links `[Name](agent-id)`); Mode C runs steps inline and, before a Tier 3 step, advises a model switch or performs an explicit self-review pass.

## 9. Final Response

Bullets: what changed and why, validation actually run with results, remaining risks, required user action (refresh/deploy). Edit files directly; no code blocks or source in chat unless requested.

> [!NOTE] **Lockstep Dependency Group:** This file belongs to the execution lockstep group (`multi-ide-setup`, `plan`, `exec`, `exec-wave`, `delegate`, `solve`). The 3-tier routing table, the Combo Anti-Phantom Diff Audit, and the handoff link labels must stay identical across the group; see `.agents/rules/multi-ide-setup.md`.
