---
name: deep-refactor
description: >-
  Decompose large components, hooks, or server files (>300-500 lines) into modular subroutines, hooks, and utilities with 100% behavior parity. Supports step-by-step Batch Mode and fast One-Shot Blueprint Mode.
  Triggered by #deep-refactor, /deep-refactor, #refrag, /refrag, #oneshot, or /oneshot.
---

# Deep-Refactor Workflow (`#deep-refactor`)

**Purpose:** Safely decompose monolithic files into focused hooks (`src/hooks/`), pure utilities (`src/utils/` or `*Utils.ts`), types (`*.types.ts`), and leaf components without changing observable runtime behavior.

---

## 1. Execution Modes (Choose Based on Context)

### Mode A: Interactive Batch Mode _(Default when exploring & refactoring live)_

- **Limit:** Maximum **3 implementation files** per batch (test files `*.test.ts` and docs `*.md` do not count toward the limit).
- **Validation per Batch:** Run `npm run lint` and `npm test` after each batch and create a checkpoint commit on `preview`.
- **Handoff Checkpoint:** Pause after Batch 3 to offer a concise session-handoff summary unless Auto-Pilot is active.
- **Recommended Model:** `PRO` or `Flash (High Thinking)`.

### Mode B: One-Shot Blueprint Mode _(Triggered by `#oneshot`, "alle auf einmal", or when a complete plan/code blueprint is provided)_

- **No Batch/File Limit:** Write all new and updated modules in a **single pass** without intermediate stops.
- **Single Validation Pass:** Run `npx prettier --write <scoped-files>`, `npm run lint`, `npm test`, and `npm run check` **once** after all files are written.
- **Recommended Model:** `Flash (Low or Medium Thinking)` for maximum speed when applying pre-verified code. When using Flash, strictly follow the Single-Action Protocol from `flash/SKILL.md`.

---

## 2. Non-Negotiable Guardrails (Both Modes)

1. **100% Behavior & Export Parity:**
   - Preserve all public props, named/default exports, and re-exported types so parent callers require zero changes unless explicitly in scope.
   - Preserve all DOM querySelector classes (e.g., `.zoom-media-container`, `.media-zoom-target`, `[data-video-controls]`), inline math (letterbox/pillarbox geometry), event capture order (`onPointerDownCapture` vs `onClickCapture`), and platform keys (`ios-stable-video`).
   - Keep `useEffect`, `useMemo`, and `useCallback` dependency arrays semantically identical.
2. **Dirty Working Tree Protection:**
   - Run `git status --short` in Preflight (B0).
   - Never stage, revert, format, or overwrite pre-existing modified or untracked user files.
   - Never use `git add .`, `git reset`, `git checkout`, or `git clean`. Always stage explicit file paths.
3. **Branch & Remote Safety:**
   - Commit only on `preview` or a dedicated feature branch (`never` on `main`/`master`).
   - Never run `git push` automatically.

---

## 3. Standard Execution Phases

1. **Phase 0 (Preflight):** Check `git status --short`, inspect target file + all callers, record baseline for `npm run lint` and `npm test`.
2. **Phase 1 (Pure Utils & Types):** Extract `*.types.ts` and pure helper functions (`*Utils.ts`) + optional unit test (`*Utils.test.ts`).
3. **Phase 2 (Custom Hooks):** Extract state, timers, DOM observers, and event capture handlers into `src/hooks/<domain>/` and update `index.ts` barrel exports.
4. **Phase 3 (Leaf Components & Orchestrator):** Extract isolated JSX sub-trees into leaf components and reduce the main component to a clean orchestrator (<200 lines).
5. **Phase 4 (Documentation Sync — Mandatory):** Check whether `AGENTS.md` or any file in `.agents/rules/` (`core-react-state.md`, `mobile-touch.md`, `video-audio-media.md`, `styling-ui.md`, `cloudflare-architecture.md`) references the refactored file and update the architecture notes accordingly.
6. **Phase 5 (Final Verification & Commit):** Run scoped Prettier, `npm run lint`, `npm test`, `npm run check`, bump `package.json` patch version once (if `package.json` is clean), commit on `preview`, and output a concise Completion Report (line-count delta + parity checklist).
