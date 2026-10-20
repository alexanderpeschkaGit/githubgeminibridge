---
name: fetch-skill
description: >-
  Fetch, sanitize, and import external skill templates into the workspace.
  Triggered when the user requests finding, importing, or building a skill
  for a specific topic (e.g., "Find a skill for [topic]", "Import a skill for [topic]").
  Also triggered by #fetch-skill or /fetch-skill.
---

# Fetch-Skill Workflow

**Purpose:** Discover external skill templates, deep-transform them to match the project's tech stack and architectural conventions, and install them as first-class Antigravity skills in the workspace.

## Phase 1: Headless Discovery

1. **Search** for skill templates matching the user's topic using tool calls:
   - GitHub API or web search targeting `vercel-labs/skills`, `vercel-labs/agent-skills`, and `skills.sh` registry.
   - Broader web search for `"<topic> SKILL.md"` or `"<topic> agent skill template"` as fallback.
2. **Never** use interactive CLI tools like `npx skills` — these require TTY input and block the agent.
3. **Collect** up to 3 candidate results with name, source URL, and short description.

## Phase 2: Selection

- **Multiple matches (2+):** Present the top 3 candidates to the user with name, source, and one-line description. Let the user choose.
- **Single match:** Proceed directly with that result.
- **No match:** Inform the user that no suitable template was found and suggest refining the search terms or describing the desired skill manually.

## Phase 3: Raw Extraction

1. Read the raw content of the selected skill's `SKILL.md` directly from the web (GitHub raw URL or equivalent).
2. If the skill has a `references/` directory with additional documentation, note the file list but do not fetch unless needed for transformation.

## Phase 4: Deep Transform

Transform the extracted content into a clean Antigravity skill that matches the project's conventions:

1. **Strip LLM-specific boilerplate:**
   - Remove Claude XML tags (`<system>`, `<instructions>`, `<artifact>`, etc.).
   - Remove agent-specific CLI instructions (e.g., `claude mcp add`, `cursor settings`, `codex configure`).
   - Remove platform-specific installation steps that do not apply to Antigravity.

2. **Adapt to project tech stack:**
   - Derive the project's tech stack, architecture patterns, and coding conventions from the active project rules (`AGENTS.md` / `GEMINI.md`), which are already loaded into context.
   - Rewrite framework-specific instructions to match the project's actual stack (e.g., if the source assumes Next.js but the project uses Vite + React, adapt accordingly).
   - If no project rules are available (no active workspace or no `AGENTS.md`), import the skill generically without stack-specific adaptation and note this in the confirmation message.

3. **Rewrite into the project's skill style:**
   - Use clear, imperative bullet points for actionable instructions.
   - Remove philosophical preambles and generic advice the agent already knows.
   - Include validation/verification steps where appropriate.
   - Structure with numbered phases or steps for complex workflows.

4. **Generate valid YAML frontmatter (YAML Safe):**
   - `name`: lowercase, hyphenated, derived from the skill topic.
   - `description`: Always use folded block scalar (`description: >-`) or double quotes so `#tag` and `/command` triggers are never stripped as YAML comments. Include both `#<name>` and `/<name>`.

5. **Code Snippet & Import Coherence:**
   - If the template includes code snippets, type definitions, or boilerplate, never rely on blind LLM generation.
   - Ensure imports match actual workspace packages and follow valid TypeScript/JavaScript import syntax without hallucinated specifiers.

## Phase 5: Collision Check

- Check if `.agents/skills/<name>/` already exists in the workspace.
- **If it exists:** Abort immediately. Inform the user that a skill with this name already exists at the target path. Do not overwrite.
- **If clear:** Proceed to write.

## Phase 6: Write to Workspace & Auto-Register

1. Create the directory `.agents/skills/<name>/`.
2. Write the transformed content to `.agents/skills/<name>/SKILL.md`.
3. If the source had substantial reference documentation, create a `references/` subdirectory and write condensed reference files there.
4. Target is always the **workspace** (`.agents/skills/`) unless the user explicitly requests global installation (`~/.gemini/config/skills/`).
5. **Auto-Register in `.agents/WORKFLOWS.md`:** Append the new skill triggers to `.agents/WORKFLOWS.md`:
   `- #<name> (or /<name>): .agents/skills/<name>/SKILL.md`

## Phase 7: Validate

- Re-read the written `SKILL.md` file.
- Verify that YAML frontmatter contains valid `name` and un-truncated `description` fields.
- **AST / Import Validation on Code Assets:** If the skill generates runnable helper scripts (in `scripts/`) or code templates, run the project's deterministic terminal check (`npm run lint` or `tsc --noEmit`) to verify syntax and import integrity instead of trusting model output.
- If validation fails, fix the issues and re-write.

## Phase 8: Confirm

- Output a concise confirmation message stating:
  - Skill name and written target path.
  - Source it was derived from.
  - Stack adaptations applied (if any).
  - Any caveats or limitations.
- Do NOT reproduce the full skill content in chat.
