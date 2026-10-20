# STATE.md – Projektstatus-Tracker (`cloudflare_orchestrator_Bridge`)

> **Verwendungszweck:** Single Source of Truth für den aktuellen Projektfortschritt.
> **Crash- & Quota-Recovery:** Bei Neustart eines Chats oder Subagenten zuerst diese Datei und die letzten 25 Zeilen von `plans/EXECUTION_LOG.md` sowie `plans/TEST_LOG.md` lesen!

## Aktuelle Phase
- **Aktive Stufe:** **Stufe 7.2 (Review-Fix-Welle Steps 1–5: konsolidiertes Regressions-Gate, Dokumentations-Drift & Protokoll-Sync)** erfolgreich abgeschlossen.
- **Modell-Politik:** 3-Tier-Modellmatrix: Vorab-Gesamtplanung auf **Argon High / Medium (`pro`/`inherit`)**; Ausführung mit Flash-First: Tier 1 (`flash_lite` [1–3]), Tier 2 (`flash` [4–6]), Tier 3 (`pro` [7–10]).
- **Letztes Update:** 2026-10-20T20:48:15+02:00 (Stufe 7.2 abgeschlossen: `run-regressions.mjs` als einheitliches lokales Gate, V2-Schema/Target-Snapshot/Opt-In-Commits/100k-Deckel dokumentarisch geschlossen; Runner 6/6 lokal bzw. 7/7 mit Live-Smoke, Type-Checks PASS, 28/28 TS-Dateien < 500 Zeilen, `git diff --check` PASS).

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
  - Ziel: `agents.md` im Root als führende Single Source of Truth inkl. verbindlicher **`P1` (1st Priority) für alle 6 Komponenten**, Modell-Politik, Planungs-/Ausführungs-Logging (`PLAN_START`/`PLAN_DONE`), `.agents/rules/*`, Skills und Smoke-Suite `scripts/patches_and_tests/worker-smoke.mjs` (`5/5 PASS`).
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
  - Ziel: `agents.md` mit Progressive Disclosure + End-to-End Datenflüssen aktualisiert; `plans/00_STARTCHAT_ORCHESTRATOR.md`, `plans/01_PROJECT_REVIEW_AND_HANDOFF.md` und `plans/02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md` erstellt.
- [x] **Stufe 5 (Subagent / `#delegate #flash`): Hybrides Routing (Local CLI `packages/local-cli/` vs. Edge-Worker GitHub-Webhook `packages/edge-worker/`)**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `shared/hybridTypes.ts` Verträge (`ExecutionMode`, `HybridTaskInput`, `HybridTaskResult`, `HybridWorkerEnv`), `packages/local-cli/` (Pfad A: Node.js CLI mit `@google/genai` / REST Fallback, in-Memory-Preflight Validierung via `applyPatchesInMemory` + `runPreflightLinter` & Git-Commit), `packages/edge-worker/src/modules/webhookHandler.ts` & Route `POST /api/webhook/github` (Pfad B: Web Crypto HMAC-SHA256 Signatur-Prüfung, sofortiges `202 Accepted` & `ctx.waitUntil` async Workflow), Probe 11 in `worker-smoke.mjs` (`11/11 PASS`), 0 Node.js-Imports im Worker, 22/22 TypeScript-Dateien `< 500` Zeilen.
- [x] **Stufe 6 (#exec): RepoMix Atomic Chunking, Multi-Part Ingestion & Scoped Path Filtering**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `MixPart`-Vertrag in `shared/types.ts`, atomare Zerlegung in `packages/edge-worker/src/modules/mixChunker.ts`, TAR-Helper in `packages/edge-worker/src/utils/tarUtils.ts`, Multi-File-Paste im Userscript-HUD via `injectRepoMixParts`, `includePaths`-UI im HUD Drawer, Probe 12 verifiziert (`12/12 PASS`), 24/24 TypeScript-Dateien strikt `< 500` Zeilen.
- [x] **Stufe 6.1 (Flash-Subagent / `#flash`): RepoMix 85k Character Limit & Atomic File Partitioning**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `DEFAULT_MAX_CHUNK_CHARS = 85_000`, `HARD_GEMINI_CHAR_LIMIT = 100_000`, exakte Zeichen-Budgetierung in `mixChunker.ts`, atomare Trennung ohne Filesplits, hierarchischer Filetree, Skip-Marker, HUD `maxChunkCharsInput`, Probe 12 verifiziert (`12/12 PASS`).
- [x] **Stufe 6.2 (Flash-Subagent / `#flash #solve`): Gemini Web .txt Migration, 10-Parts Guardrail & .repomixignore.cf Support**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Umstellung auf `.txt` und MIME `text/plain` (`mixChunker.ts`, `injector.ts`), `MAX_GEMINI_PARTS = 10` Guardrail, Python-Umgebungs-Ignorierlisten und dynamische Auswertung von `.repomixignore.cf` / `.repomixignore` in `mixer.ts` via `tarUtils.ts`. Rebuild von `gemini-bridge.user.js` und Smoke-Suite 12/12.
- [x] **Stufe 6.3 (Flash-Subagent / `#flash #solve`): Userscript HUD "Apply All" & "Clear Queue" (Sequential Fail-Fast)**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Queue-Header mit "⚡ Apply All" und "🗑️ Clear" in `hudStylesAndDom.ts`, FIFO-Umkehrung `[...state.harvestedPatches].reverse()`, sequenzielle Ausführung mit Fail-Fast und Head-OID-Fortschreibung in `shadowHud.ts`, Auto-Pruning erfolgreicher Patches, Rebuild `gemini-bridge.user.js` und Einhaltung `< 500` Zeilen.
- [x] **Stufe 6.4 (Option A / Direkt-Harmonisierung): Verfassungs-, Regelwerks- & Skill-Harmonisierung**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Bereinigung verwaister Flat-Files in `.agents/skills/`; Schließung toter Links durch Erstellung von `.agents/rules/multi-ide-setup.md`; Synchronisation von `orchestrator-protocol.md` (3-Tier-Matrix), `edge-worker-architecture.md` (Stage 6.2 `.txt`-MIME & 10-Parts) und `userscript-shadow-hud.md` (Stage 6.3 FIFO Fail-Fast Queue); Harmonisierung von `AGENTS.md` (3 Pakete, Multi-Part Ingestion, Queue, `< 500` Zeilen). Verifikation mit 12/12 Smoke Probes, CLI- & Worker-Tests.
- [x] **Stufe 6.5 (Flash-Subagent / `#flash #exec`): Volatile Files Detection & Recent Commits in RepoMix**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `includeRecentCommits` & `recentCommitsCount` in `shared/types.ts` (`MixRequest` & `MixResponse.stats`); neues Modul `packages/edge-worker/src/modules/recentCommits.ts` (paralleler GitHub REST Fetch für bis zu 5 Commits, Volatile-Files Aggregation nach Touch-Count/Aktualität, XML-Generierung); Integration in `mixChunker.ts` (dynamischer Part 1 Overhead & Budget-Absicherung) und `mixer.ts`; Userscript HUD Checkbox `🕒 Volatile Dateien & Letzte Commits` & Rebuild `gemini-bridge.user.js`; Erweiterung Smoke-Suite um Probe 13 (`13/13 PASS`), Probe 10 verifiziert (0/25 Dateien >= 500 Zeilen).
- [x] **Stufe 7 (Flash-Subagent / `#flash #exec`): Target Branch Support & Atomic Branch Creation**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: `targetBranch` & `createBranchIfNeeded` in `WorkerPatchRequest`, `targetBranch`, `createdBranch` und `pullRequestUrl` in `WorkerPatchResponse`; GraphQL `createRef` & REST Fallback in `packages/edge-worker/src/utils/github.ts` (`createBranchRef`); Concurrency Check auf Basisbranch und atomare Abspaltung an `expectedHeadOid` in `patcher.ts`; Userscript HUD UI Input `Target Branch (optional)` & Status-PR-Links; Userscript Rebuild; Regelwerks-Sync; Einhaltung Dateigrößen-Gesetz (25/25 Quelldateien < 500 Zeilen) und Smoke-Suite 13/13 PASS.

- [x] **Stufe 7.1 (PRO Step 2): Safe Existing Target Branches & FIFO Target OID Lifecycle**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Source-Frische erhalten; bestehende Zielbranches per exakt gelesener Target-Commit-OID patchen und atomar gegen diese Revision committen; nur eindeutigen Branch-Not-Found als fehlend behandeln; konkurrierende Ref-Erstellung auflösen; Source- und Target-OIDs im HUD getrennt fortschreiben; funktionale Worker-/HUD-Regressionen, 14/14 Smoke-Probes und Bundle-Identität verifizieren.

- [x] **Stufe 7.2 (Review-Fix-Welle Steps 1–5): Konsolidiertes Regressions-Gate, Dokumentations-Drift & Protokoll-Sync**
  - Status: *ABGESCHLOSSEN (`PASS`)*.
  - Ziel: Die vier Review-Fixes (V2-Payload-Schema, sichere bestehende Target-Branches mit getrennten Source-/Target-OIDs, Recent-Commits strikt opt-in mit einmaliger Migration, gedeckelte Metadaten + absoluter 100k-Part-Deckel) plus CLI- und Webhook-Suiten in einem einzigen Runner (`scripts/patches_and_tests/run-regressions.mjs`) mit wahrheitsgemäßem Aggregat-Exit bündeln; Live-Smoke bleibt explizit (`--include-smoke`) außerhalb des Default-Gates. Dokumentations-Drift in `agents.md`, `edge-worker-architecture.md` und `REPOMIX_INSTRUCTIONS.md` (legacy V2-Schema) geschlossen. Verifikation: Runner 6/6 lokal, 7/7 mit Live-Smoke, Negative-Pfad Exit 1, Type-Checks PASS, 28/28 TS-Dateien < 500 Zeilen, Bundle-Identität, `git diff --check` PASS.

## Offene Entscheidungen / Blocker
- **Release-Update (2026-10-20):** Live-Deployment abgeschlossen - Worker `gemini-git-bridge` auf `2.0.1` deployt (Version ID `89284b1d`), Userscript-Bundle synchron, Post-Deploy-`/health` `PASS` (14/14 Smoke), lokaler Checkpoint-Commit erfolgt; kein `git push` (kein Remote konfiguriert).
- Keine technischen Blocker. Target Branch Snapshot Concurrency, getrennte FIFO OID-Fortschreibung, Recent-Commits-Opt-In und der absolute 100k-Deckel sind vollständig integriert und verifiziert.
