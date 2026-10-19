# STATE.md – Projektstatus-Tracker (`cloudflare_orchestrator_Bridge`)

> **Verwendungszweck:** Single Source of Truth für den aktuellen Projektfortschritt.
> **Crash- & Quota-Recovery:** Bei Neustart eines Chats oder Subagenten zuerst diese Datei und die letzten 25 Zeilen von `plans/EXECUTION_LOG.md` sowie `plans/TEST_LOG.md` lesen!

## Aktuelle Phase
- **Aktive Stufe:** **Stufe 6.2 (Gemini Web .txt Migration, 10-Parts Guardrail & .repomixignore.cf Support)** erfolgreich abgeschlossen (`12/12 PASS`, 22/22 Local-CLI PASS, 18/18 Webhook PASS). **100 % aller 24 aktiven TypeScript-Quelldateien im Monorepo sind strikt `< 500` Zeilen.**
- **Modell-Politik:** Vorab-Gesamtplanung & Strukturierung aller Parts auf **Argon High oder Argon Medium (`pro`/`inherit`)**; Ausführung & `/delegate` der Arbeitspakete mit `Complexity < 6` auf **Flash (`Model: 'flash'`)** und ab `Complexity >= 6` auf **Argon Medium (`Model: 'pro'`)**
- **Letztes Update:** 2026-10-19T14:12:00+02:00 (Stufe 6.2 abgeschlossen: `.txt` & MIME `text/plain` Dateilieferung, `MAX_GEMINI_PARTS = 10` Auto-Upscaling Guardrail, Python-Umgebungsfilter `.venv`/`venv`/`__pycache__`, dynamische `.repomixignore.cf` & `.repomixignore` Unterstützung im TAR-Stream, Userscript HUD Rebuild, Smoke Suite 12/12 PASS, 24/24 TS-Dateien < 500 Zeilen).

## Stufen-Fortschritt
- [x] **Stufe 0: Architektur, Schnittstellen (`shared/types.ts`) & Orchestrator-Design**
  - 3-Schichten-Modell, Hauptorchestrator + 3 Untertools und `shared/types.ts` verabschiedet.
  - Bestandsaufnahme abgeschlossen: `cf-gemini-git-bridge/` (`encoding.ts`, `github.ts`, `patch.ts`) und `gemini-bridge.user.js` werden integriert statt neu erfunden.
  - Crash-sicheres Logging (`plans/EXECUTION_LOG.md`, `plans/TEST_LOG.md`) und Token-Minimierung (`/delegate`, `/solve`, `/flash`) eingerichtet.
- [x] **Stufe 0.5a (Test-Subagent / `#flash`): Vorab-Test des bestehenden V1-Systems**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: TypeScript-Check (`tsc --noEmit`), Live-Worker Health-Check (`/health`) & lesender GraphQL-Verbindungstest (`/graphql`) ohne destruktive Änderungen. Dokumentation in `plans/TEST_LOG.md`.
- [x] **Stufe 0.5b (Merger-Subagent / `#flash`): Backup `_v1_backup/` & Monorepo-Portierung**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Sicherung von `cf-gemini-git-bridge/` und `gemini-bridge.user.js` nach `_v1_backup/`. Aufbau von `shared/types.ts`, `packages/edge-worker/` und `packages/userscript-hud/`. Portierung von `encoding.ts`, `github.ts` und `patch.ts` (inkl. `validateNoPlaceholders` Guardrail) auf die neuen Typen.
- [x] **Stufe 0.6 (Harness-Upgrade & `P1`-Konsolidierung): Root-`agents.md`, `.agents/rules/`, Skills & Smoke-Test-Suite**
  - Status: *ABGESCHLOSSEN (`PASS` / `PLAN_DONE`)*.
  - Ziel: `agents.md` im Root als führende Single Source of Truth inkl. verbindlicher **`P1` (1st Priority) für alle 6 Komponenten**, Modell-Politik (Argon High/Medium für Vorab-Planung aller Parts, Flash High für Ausführung bei `Complexity <= 6`), Planungs-/Ausführungs-Logging (`PLAN_START`/`PLAN_DONE`), `.agents/rules/*`, Skills (`exec-wave`, `solve`) und Smoke-Suite `scripts/patches_and_tests/worker-smoke.mjs` (`5/5 PASS`).
- [x] **Stufe 1 (Sub-Chat / `#delegate #flash`): Cloudflare Worker – Hauptorchestrator & Untertool A (`mixer.ts`)**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `POST /api/mix` (1-Subrequest Tarball-Stream, Gzip-Decompress, 512-Byte-TAR-Parser mit PAX/USTAR, RAM-Filter `shouldSkipTarEntry`, XML-Output inkl. `<file_tree>` & 40-char `headOid` mit `getBranchHeadOid`-Fallback + `persistToGitHub`-Sync).
- [x] **Stufe 2 (Sub-Chat / `#delegate #solve #flash`): Cloudflare Worker – Untertool B (`patcher.ts` & `github.ts` Batch-Read)**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `POST /api/patch` aufbauend auf `patcher.ts` (`applySearchReplace` + `validateNoPlaceholders` + `PreflightLinterHook`) und `github.ts` (`fetchMultipleFilesViaGraphQL`, Aggregation in `LinterError[]` ohne Fail-Fast, Idempotenz `NO_CHANGES_NEEDED`, atomarer Commit mit `expectedHeadOid` + 100 % Abwärtskompatibilität für `/push` & `/commit` + Smoke-Probes 6–7).
- [x] **Stufe 3 (Sub-Chat / `#delegate #solve #flash`): Tampermonkey Userscript – Shadow-DOM HUD (`packages/userscript-hud/`)**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Trusted-Types-konformes Shadow-DOM-HUD (`#gemini-edge-hud-root`, `z-index: 2147483647`) auf `gemini.google.com` und `aistudio.google.com`, `GM_xmlhttpRequest` Client (`workerClient.ts`), `sanitizeNoGithubPat`-Storage (`storage.ts`), synthetischer File-Paste (`injector.ts`), V2-JSON + V1-Diff `MutationObserver` (`harvester.ts`), Bundler `build-userscript.mjs` nach `packages/userscript-hud/dist/gemini-bridge.user.js` und Sync zu Root `gemini-bridge.user.js`.
- [x] **Stufe 4 (Sub-Chat / `#delegate #solve #flash`): Cloudflare Worker – Untertool C (`linter.ts`) & Self-Healing Loop**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: AST-/Syntax-Prüfung (`stage: "OXC_SYNTAX"`) + Custom Rules (`forbidPatterns`, `requireExports`, `validateNoPlaceholders` als `stage: "CUSTOM_RULE"`) ohne Fail-Fast in `packages/edge-worker/src/modules/linter.ts`, Self-Healing Auto-Retry-Loop (`retryCount < 3`) in `packages/userscript-hud/src/services/selfHealing.ts` sowie E2E-Smoke-Probes 8–9 (`9/9 PASS`).
- [x] **Welle 4 (Sub-Chat / `#delegate #flash`): Funktionaler E2E-Runtime-Test, Dateigrößen-Audit & Lokaler Git-Checkpoint**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Erweiterung der Smoke-Suite um Probe 10 (`10/10 PASS`), Dateigrößen-Audit aller 15 TypeScript-Dateien, Userscript-Bundle Byte-Identitätsprüfung, Root `.gitignore` und lokaler Git-Checkpoint-Commit.
- [x] **Welle 5 (Sub-Chat / `#delegate #flash`): Pflicht-Dekomposition unter 500 Zeilen & Probe 10 Modularity-Enforcement**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Zerlegung von `linter.ts` (90 Z.) + `syntaxScanner.ts` (335 Z.), `patcher.ts` (366 Z.) + `patchInMemory.ts` (290 Z.) und `shadowHud.ts` (382 Z.) + `hudStylesAndDom.ts` (406 Z.) bei 100 % Export- und Verhaltensparität. Verschärfung von Probe 10 auf `overLimitZone.length === 0` (`10/10 PASS`). Alle 18 aktiven TypeScript-Quelldateien liegen ausnahmslos unter dem 500-Zeilen-Grenzwert!
- [x] **Kontext-Handoff, Komponenten-Zusammenspiel & Live-Deployment-Plan (`plans/00_*`, `01_*`, `02_*`)**
  - Status: *ABGESCHLOSSEN (`PLAN_DONE`)*.
  - Ziel: `agents.md` mit Progressive Disclosure + End-to-End Datenflüssen aktualisiert; `plans/00_STARTCHAT_ORCHESTRATOR.md` (Prompt A: Neuer Master-Orchestrator-Chat + Prompt B: 3-Punkte `#review`), `plans/01_PROJECT_REVIEW_AND_HANDOFF.md` (Mermaid-Sequenzdiagramm & 18-Modul-Interplay-Matrix) und `plans/02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md` (5-Schritte Live-Deployment & Browser-E2E-Plan) erstellt.
- [x] **Stufe 5 (Subagent / `#delegate #flash`): Hybrides Routing (Local CLI `packages/local-cli/` vs. Edge-Worker GitHub-Webhook `packages/edge-worker/`)**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `shared/hybridTypes.ts` Verträge (`ExecutionMode`, `HybridTaskInput`, `HybridTaskResult`, `HybridWorkerEnv`), `packages/local-cli/` (Pfad A: Node.js CLI mit `@google/genai` / REST Fallback, in-Memory-Preflight Validierung via `applyPatchesInMemory` + `runPreflightLinter` & Git-Commit), `packages/edge-worker/src/modules/webhookHandler.ts` & Route `POST /api/webhook/github` (Pfad B: Web Crypto HMAC-SHA256 Signatur-Prüfung, sofortiges `202 Accepted` & `ctx.waitUntil` async Workflow), Probe 11 in `worker-smoke.mjs` (`11/11 PASS`), 0 Node.js-Imports im Worker, 22/22 TypeScript-Dateien `< 500` Zeilen.
- [x] **Stufe 6 (#exec): RepoMix Atomic Chunking, Multi-Part Ingestion & Scoped Path Filtering**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `MixPart`-Vertrag in `shared/types.ts` (`maxChunkBytes`, `maxChunkTokens`, `splitOutput`, `parts?: MixPart[]`), atomare Zerlegung ohne Code-Zerschneiden in `packages/edge-worker/src/modules/mixChunker.ts`, TAR-Helper-Extraktion in `packages/edge-worker/src/utils/tarUtils.ts` (Schutz der `< 500`-Zeilen-Grenze für `mixer.ts`), Multi-File-Paste im Userscript-HUD via `injectRepoMixParts` (`injector.ts` & `shadowHud.ts`), `includePaths`-UI-Konfiguration im HUD Drawer (`hudStylesAndDom.ts`), Probe 12 verifiziert (`12/12 PASS`), 24/24 TypeScript-Dateien strikt `< 500` Zeilen.
- [x] **Stufe 6.1 (Flash-Subagent / `#flash`): RepoMix 85k Character Limit & Atomic File Partitioning**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `DEFAULT_MAX_CHUNK_CHARS = 85_000`, `HARD_GEMINI_CHAR_LIMIT = 100_000`, exakte Zeichen-Budgetierung in `mixChunker.ts`, atomare Trennung ohne Filesplits, hierarchischer Filetree (Part 1 vollständiger Baum bis 14k Chars, Folgeparts fokussierter Teilbaum), Skip-Marker `[SKIPPED: >100k chars for Gemini Chat limit]`, HUD `maxChunkCharsInput`, Probe 12 verifiziert (`12/12 PASS`), 24/24 TypeScript-Dateien strikt `< 500` Zeilen.
- [x] **Stufe 6.2 (Flash-Subagent / `#flash #solve`): Gemini Web .txt Migration, 10-Parts Guardrail & .repomixignore.cf Support**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Umstellung auf `.txt` und MIME `text/plain` (`mixChunker.ts`, `injector.ts`), `MAX_GEMINI_PARTS = 10` Guardrail, Python-Umgebungs-Ignorierlisten (`.venv`, `venv`, `__pycache__`) und dynamische Auswertung von `.repomixignore.cf` / `.repomixignore` in `mixer.ts` via `tarUtils.ts`. Rebuild von `gemini-bridge.user.js` und Smoke-Suite 12/12.

## Offene Entscheidungen / Blocker
- Keine Blocker. Stage 6.2 erfolgreich umgesetzt und verifiziert (12/12 Probes PASS, 22/22 Local-CLI PASS, 18/18 Webhook PASS, 24/24 TS-Dateien < 500 Zeilen). Bereit für Live-Deployment (`npx wrangler deploy`).


