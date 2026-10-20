---
name: flash
description: >-
  Enforce high-stability execution rules optimized for high-speed / Flash models.
  Triggered when the user uses the #flash tag or /flash command.
---

# Flash Workflow

- Enforce high-stability execution rules optimized for high-speed / Flash models when modifying files, running terminal tasks, or debugging. Act as a global modifier enforcing these rules even if used without a specific workflow command.
- **Single-Action Protocol:** Perform exactly one state-changing shell command per step. Wait for output/exit codes before proceeding. Concurrent independent file edits are permitted if they do not violate model context limits.
- **No Command Chaining:** Never invent and chain shell commands using `&&` or `;`. Execute steps sequentially. (Pre-defined standard npm/project scripts are exempt).
- **Diagnostic Requirement:** If a step fails, execute an explicit diagnostic command (e.g., inspecting files, logs, or git status) to trace the root cause before attempting a secondary fix.
- **Structured Reasoning:** Keep reasoning concise and structured (e.g. in `<thought>` tags) to prevent tool-suppression issues.
- Can be combined with execution requests (e.g., `#flash #exec 1` or `/flash /refactor`) to enforce stability during automated edits.
