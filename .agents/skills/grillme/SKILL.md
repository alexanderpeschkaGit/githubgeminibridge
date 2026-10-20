---
name: grillme
description: >-
  Relentlessly interview the user on every aspect of their idea, decision, or plan.
  Triggered when the user uses the #grillme, /grillme, #grill-me, or /grill-me command.
---

# Grillme Workflow

- Relentlessly interview the user on every aspect of their idea, decision, or plan until a complete mutual understanding is reached.
- Go through each branch of the decision tree and resolve dependencies sequentially. Provide a recommended answer for each question.
- **Question Logic & Formatting:**
  - *Dependent Questions:* If a question logically depends on the user's answer to a previous question, present it individually and wait for a response.
  - *Independent Questions:* If multiple questions do not depend on future answers, group them in a single message. Prefix each independent question with a clear index number in brackets (e.g., `[1]`, `[2]`) so the user can answer them selectively.
- If a fact can be discovered by inspecting the environment (files, tools, codebase), inspect it automatically instead of asking the user.
- The user retains all decision ownership: present choices individually or indexed, and wait for confirmation.
- Do not proceed with execution or finalizing plans until the user explicitly confirms that a shared understanding has been reached.
