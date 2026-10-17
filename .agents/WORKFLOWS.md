# Global Workflow Commands (`cloudflare_orchestrator_Bridge`)

When a user request or stage blueprint begins with a workflow command tag, read the corresponding skill file in addition to root `agents.md`:

- `#ask` (or `/ask`): `.agents/skills/ask/SKILL.md` (or global `ask` skill – read-only investigation without modifying files)
- `#grillme` (or `/grillme`): `.agents/skills/grillme/SKILL.md` (or global `grillme` skill – structured decision interview with `[1]`, `[2]` indexing)
- `#plan` (or `/plan`): `.agents/skills/plan/SKILL.md` (5-step architectural plan with Execution Metadata Header)
- `#exec` (or `/exec`): `.agents/skills/exec/SKILL.md` (execute approved plan steps with Single-Action Protocol)
- `#exec-wave` (or `/exec-wave`, `#wave-exec`): `.agents/skills/exec-wave/SKILL.md` (orchestrate serial and parallel subagent waves across disjoint monorepo packages)
- `#flash` (or `/flash`): `.agents/skills/flash/SKILL.md` (enforce Single-Action Protocol, zero `&&`/`;` command chaining, minimal context)
- `#delegate` (or `/delegate`): `.agents/skills/delegate/SKILL.md` (write focused execution plan to artifact/blueprint and spawn isolated subagent)
- `#solve` (or `/solve`): `.agents/skills/solve/SKILL.md` (4-phase impact analysis, plan artifact, virtual review, and subagent delegation / JSON-patch generation)
- `#review` (or `/review`): `.agents/skills/review/SKILL.md` (audit code and contracts without modifying files)
- `#refactor` (or `/refactor`): `.agents/skills/refactor/SKILL.md` (improve modularity while preserving 100 % V1/V2 behavior parity)
