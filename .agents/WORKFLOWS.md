# Global Workflow Commands

When a user request begins with a command, read the corresponding local skill file in addition to `AGENTS.md`. In Kilo the `#...` tags below are prompt markers. The matching skill is also listed as `/skill-name` (here `/flash`) and loads through the `skill` tool; `#dflash` must load the `flash` skill and apply its DeepSeek profile.

- `#ask` (or `/ask`): `.agents/skills/ask/SKILL.md`
- `#grillme` (or `/grillme`, `#grill-me`, `/grill-me`): `.agents/skills/grillme/SKILL.md`
- `#plan` (or `/plan`): `.agents/skills/plan/SKILL.md`
- `#exec` (or `/exec`): `.agents/skills/exec/SKILL.md`
- `#exec-wave` (or `/exec-wave`, `#wave-exec`, `/wave-exec`): `.agents/skills/exec-wave/SKILL.md`
- `#flash` (or `/flash`): `.agents/skills/flash/SKILL.md` — `#dflash` (or `/dflash`) loads the same skill and additionally activates the DeepSeek-Flash V4.1 profile (`#flash` + budget mode, no Pro escalation).
- `#review` (or `/review`): `.agents/skills/review/SKILL.md`
- `#refactor` (or `/refactor`): `.agents/skills/refactor/SKILL.md`
- `#delegate` (or `/delegate`, `#deligate`, `/deligate`): `.agents/skills/delegate/SKILL.md`
- `#solve` (or `/solve`): `.agents/skills/solve/SKILL.md`
- `#deep-refactor` (or `/deep-refactor`, `#refrag`, `/refrag`, `#oneshot`, `/oneshot`): `.agents/skills/deep-refactor/SKILL.md`
- `#zip-clean` (or `/zip-clean`, `#export-zip`, `/export-zip`, `#zip`, `/zip`): `.agents/skills/zip-clean/SKILL.md`
- `#repomix` (or `/repomix`): `.agents/skills/repomix/SKILL.md`
- `#bundle` (or `/bundle`, `#repomix-split`, `/repomix-split`): `.agents/skills/bundle/SKILL.md`
- `#fetch-skill` (or `/fetch-skill`): `.agents/skills/fetch-skill/SKILL.md`
