---
name: review
description: >-
  Audit the code in context without modifying it.
  Triggered when the user uses the #review tag or /review command.
---

# Review Workflow

- Audit the code in context without modifying it.
- Treat all applicable local project instructions (like `AGENTS.md`) as the authoritative review contract. Check the reviewed code against its protected behaviors, architecture boundaries, performance requirements, and implementation safeguards rather than limiting the review to generic code quality.
- Prioritize findings by severity: security, correctness, data loss, deployment, performance, maintainability, then style.
- For every finding, identify the affected file and location, explain the impact, and give a concise remediation direction.
- Check cross-system, browser, and device compatibility where relevant, including OS styling, browser behavior, responsive layouts, touch/mouse/hybrid input, dynamic viewport behavior, and capability-gated fallbacks.
- **Checklist-Driven Audit Mode (`#review #flash`):**
  When a review is triggered with an `Acceptance & Invariant Checklist` (from a plan or prompt), systematically audit each target file against every specified invariant (Point-by-Point Evaluation). Structure the audit report into:
  1. **Invariant Evaluation Table / Findings:** For each criterion, state `[PASS | FAIL | WARNING]` with file:line citations and root-cause analysis.
  2. **Targeted Polish / Remediation (when explicitly requested):** If the user requests fixing issues found during review (e.g. "Post-Audit Polish"), apply targeted fixes directly under the Single-Action Protocol from `flash/SKILL.md`, followed by sequential verification (`npm run lint`, `npm test`, `npm run build`).
- State clearly when no material issues are found and mention any validation limits.
- Small illustrative excerpts are allowed when necessary, but do not rewrite complete files.
