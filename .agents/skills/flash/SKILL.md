---
name: flash
description: >-
  Enforce high-stability execution rules optimized for high-speed / Flash models and the DeepSeek-Flash (V4.1) profile (#dflash).
  Triggered when the user uses the #flash, /flash, #dflash, or /dflash command.
---

# Flash Workflow

- Enforce high-stability execution rules optimized for high-speed / Flash models when modifying files, running terminal tasks, or debugging. Act as a global modifier enforcing these rules even if used without a specific workflow command.
- **Single-Action Protocol:** Perform exactly one state-changing shell command per step. Wait for output/exit codes before proceeding. Read-only tool calls may be batched in one message; state-changing shell commands are never batched. Concurrent independent file edits are permitted if they do not violate model context limits.
- **No Command Chaining:** Never invent and chain shell commands using `&&` or `;`. Execute steps sequentially. (Pre-defined standard npm/project scripts are exempt). This is mandatory on PowerShell 5.1, which does not support `&&` at all.
- **Diagnostic Requirement:** If a step fails, execute an explicit diagnostic command (e.g., inspecting files, logs, or git status) to trace the root cause before attempting a secondary fix.
- **500+ Lines Exemption Protocol:** When modifying or decomposing files >= 500 lines under `#flash`, the mandatory Pro delegation is waived under the following strict conditions: (1) Never rewrite or output the edited monolith in full; (2) Use strictly localized Anchor Snippets (1-3 lines context) for surgical search-and-replace edits; (3) Decompose monolithic files by extracting types (`*.types.ts`), pure helpers (`*Utils.ts`), or hooks (`use*.ts`) into separate files <= 300 lines first, keeping the diff in the main file minimal. The "no full file" restriction applies to the edited monolith only; newly extracted modules may be written in full while they stay `<= 300` lines.
- **Structured Reasoning:** Keep reasoning concise and structured. Never write reasoning, scratchpad text, or `<thought>` tags into chat messages, files, code, or commits.
- Can be combined with execution requests (e.g., `#flash #exec 1` or `/flash /refactor`) to enforce stability during automated edits.
- **Budget Mode (Zero-PRO):** When combined with execution workflows (`#flash #exec` or `#flash #exec-wave`), or when `#dflash`, `--no-pro`, `--no-pro-escalation`, or an explicit user instruction suppresses PRO escalation, automatic escalation to `pro` subagents on validation errors is disabled. If a targeted Flash fix does not resolve a failure, execution halts cleanly in **Graceful Pause (Dirty Inspection)** to protect token budgets. These tokens are intent markers, not CLI flags that Kilo parses.

---

## DeepSeek-Flash V4.1 Profile (`#dflash` / `/dflash`)

Applies to the runtime model IDs `deepseek/deepseek-flash` and `kilo/deepseek/deepseek-v4.1-flash`. `#dflash` is a profile modifier, not a separate workflow: all `#flash` rules above stay active.

- **Implicit `#flash` and Budget Mode:**
  - `#dflash` always implies `#flash` plus budget mode (no Pro escalation) across combined workflows: `#dflash #plan`, `#dflash #exec`, `#dflash #exec-wave`, `#dflash #solve`, `#dflash #delegate`, `#dflash #refactor`, `#dflash #review`.
  - Kilo has no automatic escalation and parses no CLI flags. Any mention of `--no-pro` / `--no-pro-escalation` is treated as the same budget mode: after exactly one targeted repair attempt that still fails validation (`npm run typecheck` in the touched package plus `node scripts/patches_and_tests/worker-smoke.mjs`), halt in **Graceful Pause (Dirty Inspection)**, preserve modified files, and report the failing command with its exit code.
- **Verify before edit (mandatory):**
  - Confirm every Anchor Snippet with `read` or `grep` on disk before calling `edit`; never edit from memory.
  - Resolve paths with `glob` or `grep` instead of inventing them; read `shared/types.ts` and the existing imports before using a type, export, or module path.
  - Never report a file as changed without a matching `read` or `git diff` observation.
- **Batch and tier limits:**
  - Planning (`#dflash #plan`): score each step `<= 6` and cap it at 3-4 files. Targets with >= 500 lines are sliced into Anchor-Snippet edits, never whole-file rewrites.
  - Tier 1-2 (`FLASH_LITE` 1-3, `FLASH` 4-6): execute directly under the Single-Action Protocol. Read-only calls may be batched; state-changing shell commands stay one per call.
  - Tier 3 (`PRO` 7-10): do not escalate. Slice into `Score <= 6` micro-batches. At `Score >= 8`, run a read-only audit against the `Acceptance & Invariant Checklist` before staging (`task` with `subagent_type: explore` in Kilo; `TypeName: 'research'` in Mode A).
  - Changes touching `P1` invariants in `agents.md` or the shared contracts in `shared/types.ts` require explicit user approval even when the slice itself scores `<= 6`.
- **Error budget:**
  - Run one diagnostic before any secondary fix. If the same error survives a second attempt, stop and report the exact command, exit code, and failing lines instead of trying further variations.
- **Subagent propagation (Kilo = Mode E):**
  - Prepend `[ACTIVE PROFILE: #dflash - .agents/skills/flash/SKILL.md, budget mode, no Pro escalation]` to every subagent prompt, because subagents cannot see parent chat tags.
  - Kilo: spawn via `task` (`explore` for read-only audits, `general` for implementers). Omit `model`, `provider`, and `variant` so the subagent inherits the active Flash model; override only when the user explicitly asks. There is no `TypeName` or `Model` enum and no `conversation://` stream; report the returned `task_id` instead.
  - Mode A (Antigravity) keeps `Model: 'inherit'` with `TypeName: 'self' | 'research'`. Never pass raw provider slugs such as `deepseek-flash` as a `Model` value.
- **Output and reasoning discipline:**
  - Do not dump complete files or large repository chunks into chat or subagent prompts. The context window is large, but output and prompt-cache costs are not free.
  - Keep reasoning concise without writing reasoning or `<thought>` tags into chat, files, code, or commits.
  - Use Markdown tables for audits and roadmaps, and respect workflow output bans (`#exec` edits files directly; `#ask` answers in prose).
