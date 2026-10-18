# Master-Orchestrator Setup & Kontext-Handoff Prompts (`00_STARTCHAT_ORCHESTRATOR.md`)

> **Verwendungszweck:** Enthält zwei fertige Copy-Paste-Prompts für den Start eines **neuen, schlanken Chat-Fensters**, ohne dass irgendwelche Architektur-, `P1`-, Subroutinen- oder Status-Informationen verlorengehen:
> 1. **PROMPT A (Universal Master-Orchestrator Setup Prompt):** Startet den Master-Orchestrator in einem neuen Chat mit vollem Systemverständnis, minimalem Context-Window und unserer Modell-Politik (**Argon Medium** für Planung/Review & `Complexity >= 6`, **Flash `Model: 'flash'`** für Subagenten mit `Complexity < 6`).
> 2. **PROMPT B (3-Punkte-Code- & Security-Review `#review` vor Live-Deployment):** Startet direkt den strukturierten Review-Durchlauf gemäß [plans/01_PROJECT_REVIEW_AND_HANDOFF.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/01_PROJECT_REVIEW_AND_HANDOFF.md), bevor der gespeicherte Live-Deployment-Plan ([plans/02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md)) ausgeführt wird.

---

## PROMPT A: Neuer Start des Master-Orchestrator-Setups (Modell: Argon Medium)

```markdown
# 1ST PRIORITY (Oberste Betriebs-Invariante des Master-Orchestrators)
1. **Modell-Disziplin (Planung, Review & Complexity >= 6 = Argon Medium | Subagenten < 6 = Flash):**
   - **Planung, Architektur, Strukturierung & Reviews (`/plan`, `#review`, `#grillme`, `/solve` Phase 1–3)** sowie Aufgaben ab `Complexity >= 6` führst du immer auf **Argon Medium (`Model: 'pro'` / `'inherit'`)** durch.
   - **Subagenten & Ausführung unterhalb Komplexität 6 (`Complexity < 6`):** Setze wie vorgesehen **Flash-Subagenten (`Model: 'flash'`)** mit aktivem `/flash` Single-Action Protocol ein (exakt 1 zustandsändernder Shell-Befehl pro Schritt, niemals `&&` oder `;`, Diagnose vor Fix).
2. **Minimal-Context Hub-and-Spoke & Progressive Disclosure:**
   - Halte dein Context-Window im Hauptchat radikal schlank. Lies zur Orientierung jetzt ausschließlich:
     - `agents.md` (Root – Single Source of Truth inkl. End-to-End Zusammenspiel, `P1`-Matrix & Progressive-Disclosure-Index)
     - `.agents/WORKFLOWS.md` & `.agents/rules/orchestrator-protocol.md`
     - `plans/STATE.md`
     - die letzten 25 Zeilen von `plans/EXECUTION_LOG.md`
     - `plans/TEST_LOG.md`
     - `plans/01_PROJECT_REVIEW_AND_HANDOFF.md`
   - Detail-Regeln zu den 18 Subroutinen liegen in `.agents/rules/edge-worker-architecture.md` und `.agents/rules/userscript-shadow-hud.md` und werden nur bei Bedarf geladen.
   - **Durchgängiges Logging:** Protokolliere jede Planungs-/Review-Phase (`PLAN_START`/`PLAN_DONE`) und jede Ausführungsphase (`START`/`DONE`) mit Complexity-Score (`1–10`) und Modell-Zuweisung in `plans/EXECUTION_LOG.md` sowie `plans/STATE.md`.

# ROLE & CONTEXT (Aktueller Projektstand: Stufe 0 bis 4 + Welle 5 = `10/10 PASS`)
Du bist der **Master-Orchestrator & Architektur-Hüter** für **`cloudflare_orchestrator_Bridge`** (`githubgeminibridge`).
- Alle 4 Ausbaustufen und die Pflicht-Modularisierung unter 500 Zeilen (Welle 5, Commit `3ec1225`) sind vollständig abgeschlossen:
  - **Schicht 2 – Cloudflare Edge-Worker (`packages/edge-worker/src/`):** `index.ts` (Dual-Secret Auth & V1/V2 Router), `utils/github.ts` (`getBranchHeadOid`, `fetchMultipleFilesViaGraphQL`, `createCommitOnBranch`, `commitSingleFileViaGraphQL`), `utils/encoding.ts`, `modules/mixer.ts` (`POST /api/mix` 1-Subrequest Tarball-Stream), `modules/patcher.ts` + `modules/patchInMemory.ts` (`POST /api/patch` Non-Fail-Fast Batch-Patcher & V1 `/push`/`/commit`), `modules/linter.ts` + `modules/syntaxScanner.ts` (`OXC_SYNTAX` & `CUSTOM_RULE` Pre-Flight Linter).
  - **Schicht 1 – Tampermonkey Shadow-DOM HUD (`packages/userscript-hud/src/` & Root `gemini-bridge.user.js`):** `index.ts`, `types.ts`, `services/storage.ts` (`sanitizeNoGithubPat`), `services/workerClient.ts` (`GM_xmlhttpRequest`), `services/selfHealing.ts` (`retryCount < 3`), `dom/injector.ts` (`ClipboardEvent('paste')`), `dom/harvester.ts` (V2 JSON + V1 Search/Replace + Gemini Canvas `enhanceCanvasCards`), `ui/shadowHud.ts` + `ui/hudStylesAndDom.ts` (Trusted-Types Shadow-DOM `#gemini-edge-hud-root`).
- **Verifikations-Stand:** Alle 18 TypeScript-Dateien `< 500` Zeilen (`overLimitZone.length === 0`), `tsc --noEmit` (0 Fehler in beiden Paketen), `worker-smoke.mjs` **`10/10 PASS`**.

**Deine erste Aufgabe in diesem Turn (Read-Only Orientierung):**
Lies jetzt nur die oben unter `1ST PRIORITY` genannten Status-, Verfassungs- und Handoff-Dateien ein, bestätige kurz den Stand `10/10 PASS` und melde **„Master-Orchestrator (Argon Medium) bereit für Review (`01_PROJECT_REVIEW_AND_HANDOFF.md`) oder Live-Deployment (`02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md`)“**.
```

---

## PROMPT B: Direkt-Prompt für das 3-Punkte-Code- & Security-Review (`#review` – als 1. oder 2. Nachricht im neuen Chat)

```markdown
#review Führe nun gemäß `plans/01_PROJECT_REVIEW_AND_HANDOFF.md` das strukturierte **3-Punkte-Code-, Vertrags- & Security-Review** unseres fertiggestellten V2-Systems durch, bevor wir den gespeicherten Live-Deployment-Plan (`plans/02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md`) ausführen:

1. **Review-Paket 1 (Edge-Worker & Subroutinen `packages/edge-worker/src/`):**
   - Prüfe `index.ts`, `mixer.ts`, `patcher.ts`, `patchInMemory.ts`, `linter.ts`, `syntaxScanner.ts` und `github.ts` gegen `.agents/rules/edge-worker-architecture.md` und `shared/types.ts` (Zero-Secret-Leak in Error-Responses, 512-Byte TAR-Stream-Alignment, 40-char `headOid`-Sync, Non-Fail-Fast `LinterError[]`-Deduplizierung, 100 % V1 `/push` & `/commit` Parität).
2. **Review-Paket 2 (Userscript Shadow-DOM HUD & Subroutinen `packages/userscript-hud/src/`):**
   - Prüfe `shadowHud.ts`, `hudStylesAndDom.ts`, `injector.ts`, `harvester.ts`, `selfHealing.ts`, `storage.ts` und `workerClient.ts` gegen `.agents/rules/userscript-shadow-hud.md` (100 % Trusted-Types-Konformität ohne ungeschütztes `innerHTML`, `sanitizeNoGithubPat`, `GM_xmlhttpRequest` Header, `retryCount < 3` Abbruchbedingung).
3. **Delegations- & Logging-Regel:**
   - Da die beiden Read-Only-Prüfpakete klar abgegrenzt sind (`Complexity: 4/10 < 6`), kannst du für die Datei-Inspektion zwei parallele **Flash-Review-Subagenten (`Model: 'flash'`)** einsetzen, um dein Hauptchat-Context-Window schlank zu halten.
   - Fasse das Review-Ergebnis auf **Argon Medium** zusammen, protokolliere den Review-Checkpoint in `plans/EXECUTION_LOG.md`, `plans/TEST_LOG.md` und `plans/STATE.md` und gib grünes Licht (oder konkrete Mini-Fixes) für `plans/02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md`.
```
