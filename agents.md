# AGENTS.md — System-Verfassung & Progressive-Disclosure Hub (`cloudflare_orchestrator_Bridge`)

> **Autoritative Single Source of Truth:** Diese Datei verankert die Gesamtarchitektur, das Zusammenspiel aller System-Schichten, die `P1`-Invarianten sowie die Verweise auf sämtliche Subroutinen- und Workflow-Dateien.

> [!IMPORTANT] PROGRESSIVE DISCLOSURE & ROUTING (Pflicht-Verweise gegen Context-Bloat)
> Lies im Hauptchat zur Orientierung **nur** diese `agents.md`, [plans/STATE.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/STATE.md), die **letzten 25 Zeilen** von [plans/EXECUTION_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/EXECUTION_LOG.md) und [plans/TEST_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/TEST_LOG.md).
> Modulspezifische Tiefenregeln, Subroutinen-Spezifikationen und Pläne sind ausgelagert und werden **zielgerichtet bei Bedarf** geladen:
> - **Workflows & Tag-Routing (`#plan`, `#review`, `#delegate`, `#flash`, `#exec-wave`, `#solve`, `#grillme`):** [.agents/WORKFLOWS.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/WORKFLOWS.md)
> - **Orchestrierung, Modell-Matrix (Argon Medium vs. Flash) & Logging:** [.agents/rules/orchestrator-protocol.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/orchestrator-protocol.md)
> - **Edge-Worker & Subroutinen (`index.ts`, `mixer.ts`, `patcher.ts`, `patchInMemory.ts`, `linter.ts`, `syntaxScanner.ts`, `webhookHandler.ts`, `github.ts`, `encoding.ts`):** [.agents/rules/edge-worker-architecture.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/edge-worker-architecture.md)
> - **Userscript Shadow-DOM HUD & Subroutinen (`shadowHud.ts`, `hudStylesAndDom.ts`, `injector.ts`, `harvester.ts`, `selfHealing.ts`, `storage.ts`, `workerClient.ts`):** [.agents/rules/userscript-shadow-hud.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/userscript-shadow-hud.md)
> - **Lokale CLI & Hybrides Routing (`packages/local-cli/`, `shared/hybridTypes.ts`):** [plans/03_HYBRID_ROUTING_PLAN.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/03_HYBRID_ROUTING_PLAN.md)
> - **Verbindliche TypeScript-Verträge (V2 + V1 Legacy):** [shared/types.ts](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/shared/types.ts)
> - **Start-Prompts für neuen Master-Orchestrator-Chat & Review:** [plans/00_STARTCHAT_ORCHESTRATOR.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/00_STARTCHAT_ORCHESTRATOR.md)
> - **Dokumentation des Zusammenspiels aller 18 Module & Review-Checkliste:** [plans/01_PROJECT_REVIEW_AND_HANDOFF.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/01_PROJECT_REVIEW_AND_HANDOFF.md)
> - **Gespeicherter Plan für Live-Deployment & Browser-E2E-Test:** [plans/02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md)

---

## 1. Zusammenspiel der Einzelteile (End-to-End Datenfluss über alle 3 Schichten)

1. **Kontext-Laden (`Mix-Flow` – Schicht 1 -> 2 -> 3):**
   - `shadowHud.ts` (im isolierten `#gemini-edge-hud-root` Shadow DOM) liest Konfiguration via `storage.ts` (`sanitizeNoGithubPat`) und ruft über `workerClient.ts` (`GM_xmlhttpRequest` CSP-Bypass) `POST /api/mix` an `packages/edge-worker/src/index.ts` auf.
   - `index.ts` prüft Auth (`verifyAuth`) und delegiert an `mixer.ts` (`handleMixRequest`).
   - `mixer.ts` lädt den GitHub-Tarball in **1 Subrequest**, dekomprimiert ihn per `DecompressionStream('gzip')`, liest die 40-stellige `headOid` aus dem PAX Global Header (`typeflag === 'g'`, Fallback `getBranchHeadOid` in `github.ts`), verwirft Ignorierlisten & Dateien `> 512 KB` direkt am 512-Byte-Header (`shouldSkipTarEntry`), erzeugt CDATA-sicheres XML (`escapeCdata`) und persistiert optional via `commitSingleFileViaGraphQL`.
   - `shadowHud.ts` speichert die 40-char `headOid` im State und übergibt `xmlContent` an `injector.ts` (`injectRepoMixFile`), der `repo-mix.xml` per synthetischem `ClipboardEvent('paste')` in Gemini / AI Studio einfügt.
2. **Code-Ernte & Atomarer Patch-Commit (`Patch-Flow` – Schicht 1 -> 2 -> 3):**
   - `harvester.ts` überwacht per `MutationObserver` Chat-Codeblöcke sowie Gemini Canvas-Karten (`enhanceCanvasCards`) und extrahiert V2 `GeminiPatchPayload`-JSON (oder konvertiert V1 `<<<<<<< SEARCH ... >>>>>>> REPLACE`-Blöcke).
   - Bei Klick auf Apply (oder automatisch im Auto-Pilot) sendet `workerClient.ts` `POST /api/patch` inkl. `expectedHeadOid` an `index.ts` -> `patcher.ts` (`handlePatchRequest`).
   - `patcher.ts` prüft `expectedHeadOid` gegen `getBranchHeadOid` (`GIT_CONFLICT`-Schutz), lädt alle Zieldateien in **1 Subrequest** (`fetchMultipleFilesViaGraphQL` in `github.ts`) und ruft `patchInMemory.ts` (`applyPatchesInMemory`) auf.
   - `patchInMemory.ts` wendet `applySearchReplace` (3-Stufen-Kaskade) an, prüft `checkPlaceholderErrors` (`validateNoPlaceholders`) und ruft den Standard-Hook `runPreflightLinter` in `linter.ts` auf.
   - `linter.ts` + `syntaxScanner.ts` prüfen alle geänderten Dateien **ohne Fail-Fast** auf AST-/Lexikal-Syntaxfehler (`validateSyntaxInWorker`, `stage: 'OXC_SYNTAX'`) und Custom Rules (`forbidPatterns`, `requireExports`, `validateNoPlaceholders`, `stage: 'CUSTOM_RULE'`).
   - **Bei `0` Fehlern:** Atomarer Commit via `createCommitOnBranch` (`github.ts`); `shadowHud.ts` aktualisiert `headOid = response.newHeadOid` und setzt `retryCount = 0`.
3. **Self-Healing Loop (`PREFLIGHT_FAILED` – Schicht 2 -> 1):**
   - Sind Fehler in `errors: LinterError[]` vorhanden, bricht der Worker vor dem Commit mit `status: 'PREFLIGHT_FAILED'` ab.
   - `selfHealing.ts` (`executeSelfHealingTurn`) baut aus allen gesammelten Fehlern einen präzisen `#solve`-Korrektur-Prompt (`buildSelfHealingPrompt`) und injiziert ihn bei aktivem Auto-Pilot bis zu `retryCount < 3` (`MAX_SELF_HEALING_RETRIES = 3`) automatisch über `injector.ts` in den Chat.

---

## 2. Verbindliche `P1 (1st Priority)` Matrix aller System-Komponenten

| Komponente | Aktiver Pfad & Subroutinen | `P1` (1st Priority / Oberste Invariante) | Detail-Regel |
| :--- | :--- | :--- | :--- |
| **0. Master-Orchestrator** | `plans/*`, `.agents/*` | **Argon-Medium-Planung/Review, Flash-Delegation (`< 6`) & Lückenloses Logging:** Planung, Architektur, Review und Tasks ab `Complexity >= 6` laufen auf **Argon Medium (`Model: 'pro'`/`'inherit'`)**. Subagenten unterhalb `Complexity < 6` laufen auf **Flash (`Model: 'flash'`)** mit `/flash` Single-Action Protocol. Alle `PLAN_START`/`PLAN_DONE`- und `START`/`DONE`-Schritte werden in `EXECUTION_LOG.md` & `STATE.md` protokolliert. | [orchestrator-protocol.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/orchestrator-protocol.md) |
| **1. Edge-Hauptorchestrator & GitHub-Connector** | `packages/edge-worker/src/index.ts`, `utils/github.ts`, `utils/encoding.ts` | **Zero-Trust Auth & 100 % V1/V2-Vertragstreue:** Dual-Secret-Validierung (`WORKER_SECRET`/`BRIDGE_SECRET`, `GITHUB_PAT`/`GITHUB_TOKEN`, niemals Klartext-Leaks), 40-char `expectedHeadOid` Concurrency-Gate und volle V1-Parität (`/health`, `/push`, `/commit`, `/graphql`) parallel zu V2 (`/api/mix`, `/api/patch`). | [edge-worker-architecture.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/edge-worker-architecture.md) |
| **2. Untertool A: Mix-Engine** | `src/modules/mixer.ts` | **1-Subrequest Tarball-Streaming & 128 MB RAM-Schutz:** 1 HTTP-Subrequest via `DecompressionStream('gzip')`; Header-Level Stream-Skip (`shouldSkipTarEntry`) vor String-Allokation; 40-char `headOid` (PAX `typeflag === 'g'` + `getBranchHeadOid`-Fallback + `persistToGitHub`-Sync) und CDATA-sicheres XML (`escapeCdata`). | [edge-worker-architecture.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/edge-worker-architecture.md) |
| **3. Untertool B: In-Memory Patcher** | `src/modules/patcher.ts`, `src/modules/patchInMemory.ts` | **Atomare Datenintegrität & Hard Guardrail (`validateNoPlaceholders`):** 1-Subrequest GraphQL Batch-Read (`fetchMultipleFilesViaGraphQL`), 3-Stufen `applySearchReplace`, kompromisslose Ablehnung von LLM-Platzhaltern (`// ... existing code ...`), Non-Fail-Fast Aggregation, Idempotenz (`NO_CHANGES_NEEDED`) & atomarer Commit. | [edge-worker-architecture.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/edge-worker-architecture.md) |
| **4. Untertool C: Pre-Flight Linter** | `src/modules/linter.ts`, `src/modules/syntaxScanner.ts` | **Aggregierende Fehler-Sammlung ohne Fail-Fast (`errors: LinterError[]`):** AST-/Syntax-Check (`validateSyntaxInWorker` / `oxc-parser` WASM) + Custom Rules (`forbidPatterns`, `requireExports`, `validateNoPlaceholders`) über **alle** geänderten Dateien hinweg sammeln. | [edge-worker-architecture.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/edge-worker-architecture.md) |
| **5. Browser Shadow-DOM HUD** | `packages/userscript-hud/src/*`, Root `gemini-bridge.user.js` | **Shadow-DOM-Isolation, Trusted-Types, CSP-Bypass & Zero-PAT:** Kapselung in `#gemini-edge-hud-root` (`attachShadow`, kein rohes `innerHTML`), `GM_xmlhttpRequest`, niemals `GITHUB_PAT` im Browser (`sanitizeNoGithubPat`), synthetischer `ClipboardEvent('paste')`, `headOid`-Sync & Self-Healing (`retryCount < 3`). | [userscript-shadow-hud.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/userscript-shadow-hud.md) |
| **6. Hybrides Routing & GitHub-Webhook** | `packages/local-cli/src/*`, `packages/edge-worker/src/modules/webhookHandler.ts`, `shared/hybridTypes.ts` | **HMAC-SHA256 Zero-Trust, 202 Accepted Async-Bridge & In-Memory Preflight:** Webhook HMAC-Validierung via Pure Web Crypto API (`crypto.subtle.verify`), sofortiges `202 Accepted` mit Hintergrundverarbeitung via `ctx.waitUntil`, Zero-Node.js-Imports im Worker und identischer In-Memory Preflight (`applyPatchesInMemory` + `runPreflightLinter`) im lokalen CLI (`localRunner.ts`). | [edge-worker-architecture.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/edge-worker-architecture.md) & [03_HYBRID_ROUTING_PLAN.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/03_HYBRID_ROUTING_PLAN.md) |

---

## 3. Globale Invarianten, Host-Umgebung & Ausführungs-Sicherheit

1. **Path Awareness & Read-Only Legacy:** Aktiver Code liegt ausschließlich in `packages/edge-worker/` und `packages/userscript-hud/` (synchronisiert nach Root `gemini-bridge.user.js`). `_v1_backup/` und `cf-gemini-git-bridge/` sind strikt **Read-Only**.
2. **Dateigrößen-Gesetz (`< 500` Zeilen Pflicht):** **300–499 Zeilen** = Warnzone; **ab 500 Zeilen** = sofortige Pflicht-Dekomposition in Submodule (überprüft durch **Probe 10** in [worker-smoke.mjs](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/scripts/patches_and_tests/worker-smoke.mjs)).
3. **Windows 11 / PowerShell & Single-Action Protocol (`/flash`):**
   - Nutze native Datei-Tools (`view_file`, `replace_file_content`, `write_to_file`); keine Unix-Only CLI-Befehle (`sed`, `awk`, `grep`, `cat`, `rm`, `cp`, `mv`).
   - Führe Shell-Befehle strikt einzeln nacheinander aus (**niemals `&&` oder `;` verketten**).
4. **Decision Gate (Quiet Zone vs. Hard Stops):**
   - *Quiet Zone (Direkt ausführen & berichten):* Read-Only-Analysen, geplante Schritte, `tsc --noEmit`, `worker-smoke.mjs` und lokale Git-Checkpoint-Commits.
   - *Hard Stops (Immer vorher User fragen):* `git push`, `npx wrangler deploy` auf den Live-Worker, History-Rewrites oder Datenlöschung.