---
name: flash
description: >-
  Enforce high-stability execution rules optimized for high-speed / Flash models and DeepSeek-V4.1-Flash-1017 (#dflash).
  Triggered when the user uses the #flash, /flash, #dflash, or /dflash command.
---

# Flash Workflow

- Enforce high-stability execution rules optimized for high-speed / Flash models when modifying files, running terminal tasks, or debugging. Act as a global modifier enforcing these rules even if used without a specific workflow command.
- **Single-Action Protocol:** Perform exactly one state-changing shell command per step. Wait for output/exit codes before proceeding. Concurrent independent file edits are permitted if they do not violate model context limits.
- **No Command Chaining:** Never invent and chain shell commands using `&&` or `;`. Execute steps sequentially. (Pre-defined standard npm/project scripts are exempt).
- **Diagnostic Requirement:** If a step fails, execute an explicit diagnostic command (e.g., inspecting files, logs, or git status) to trace the root cause before attempting a secondary fix.
- **500+ Lines Exemption Protocol:** When modifying or decomposing files >= 500 lines under `#flash`, the mandatory Pro delegation is waived under the following strict conditions: (1) Never rewrite or output the full file; (2) Use strictly localized Anchor Snippets (1â€“3 lines context) for surgical search-and-replace edits; (3) Decompose monolithic files by extracting types (`*.types.ts`), pure helpers (`*Utils.ts`), or hooks (`use*.ts`) into separate files <= 300 lines first, keeping the diff in the main file minimal.
- **Structured Reasoning:** Keep reasoning concise and structured (e.g. in `<thought>` tags) to prevent tool-suppression issues.
- Can be combined with execution requests (e.g., `#flash #exec 1` or `/flash /refactor`) to enforce stability during automated edits.
- **Zero-PRO Token Guard:** When combined with execution workflows (`#flash #exec` or `#flash #wave-exec`), or when `--no-pro` / `--no-pro-escalation` is explicitly specified, automatic escalation to `pro` subagents on validation errors is suppressed. If a targeted Flash fix does not resolve a failure, execution halts cleanly in **Graceful Pause (Dirty Inspection)** to protect token budgets.

---

## DeepSeek-V4.1-Flash-1017 (`#dflash` / `/dflash`) Execution Profile

When triggered via `#dflash` or `/dflash`, enforce all stability rules of `#flash` above AND apply these model-specific adaptations for `deepseek-flash` (1017 snapshot) across Antigravity, Kilo Code, Copilot Chat, and Cursor:

- **Implicit `#flash` & `--no-pro-escalation` Inheritance:**
  - Treat `#dflash` (and `/dflash`) as an active `#flash` AND `--no-pro-escalation` (`--no-pro`) flag across all combined workflows (`#dflash #plan`, `#dflash #exec`, `#dflash #exec-wave`, `#dflash #solve`, `#dflash #delegate`, `#dflash #refactor`, `#dflash #review`).
  - Automatic escalation to external `pro` models is strictly disabled; if a targeted diagnostic repair attempt still fails validation (`npm run typecheck` in the touched package plus `node scripts/patches_and_tests/worker-smoke.mjs`), halt immediately in **Graceful Pause (Dirty Inspection)** with modified files preserved on disk.
- **3-Tier Reasoning & Slicing Adaptation (Local Override):**
  - **Planning (`#dflash #plan`):** Enforces Flash Slicing (`Score <= 6` per step/batch, `<= 3â€“4 files`) and sets `Flash-Only Viability: YES` by decomposing 500+ line targets via 1â€“3 line Anchor Snippets.
  - **Tier 1 (`FLASH_LITE`, Score 1â€“3):** Keep internal CoT to a brief 1â€“2 sentence verification check before tool invocation; execute trivial copy/config/CSS edits (< 300 lines) directly without exploratory multi-file reads.
  - **Tier 2 (`FLASH`, Score 4â€“6):** Use standard high-reasoning mode under the Single-Action Protocol, strictly capped at `<= 3â€“4 files` (< 500 lines) per batch.
  - **Tier 3 (`PRO`, Score 7â€“10):** Instead of escalating to a `pro` model, slice changes into `Score <= 6` micro-batches using localized 1â€“3 line Anchor Snippets. For `Score >= 8`, run a read-only verification audit (`TypeName: 'research'` in Mode A or `explore` in Mode D) against the `Acceptance & Invariant Checklist` before staging.
- **Antigravity (Mode A) & Multi-IDE Subagent Propagation:**
  - **Model Parameter Safety:** In Antigravity (`invoke_subagent`), valid `Model` enums are strictly `'inherit' | 'flash_lite' | 'flash' | 'pro'` (never pass raw provider slugs like `'deepseek-flash'`). Under `#dflash`, pass `Model: 'inherit'` (or the mapped `flash` agent in Kilo Code `kilo.jsonc`) so subagents retain the active model without triggering `pro` token usage, while preserving `TypeName: 'self'` (implementer), `TypeName: 'research'` (auditor), and clickable stream links (`[âš¡ Watch ...](conversation://<id>)`).
  - **Subagent Prompt Injection:** Because spawned subagents in `#exec`, `#exec-wave`, `#delegate`, and `#solve` start with an isolated context and cannot see parent chat tags, the Coordinator MUST prepend `[ACTIVE PROFILE: #dflash â€” Enforce DeepSeek-Flash rules in .agents/skills/flash/SKILL.md and --no-pro-escalation]` to the first line of every subagent `Prompt`, alongside the mandatory 3-point return contract (`1. Status`, `2. Files Modified`, `3. Summary`).
- **Anti-Overthinking & CoT Loop Guard:**
  - Because `deepseek-flash` runs with high thinking enabled by default, avoid speculative architectural tangents in `<thought>` blocks. Inspect at most `3â€“4 target files` per turn; once exact target lines/Anchor Snippets are verified on disk, invoke the file-edit tool immediately.
- **Prefix-Cache & Output Discipline:**
  - Never dump full files or large repository chunks into chat or subagent prompts despite the 1M context window, preserving prompt-cache prefix stability.
  - Use Markdown tables for audits/roadmaps and strictly respect workflow code-block bans (`#exec` = direct file tool edits only; `#ask` = prose without code dumps).