# AGENTS.md — System-Verfassung & Schnittstellen (`cloudflare_orchestrator_Bridge`)

> **Autoritative Single Source of Truth:** Diese Datei im Projekt-Root ist die zentrale System-Verfassung für den Master-Orchestrator, alle Subagenten (Stufe 1 bis 4) und externe AI-IDEs. Sie vereint die 3-Schichten-Gesamtarchitektur (ehemals `plans/AGENTS.md`), die globalen Invarianten der ursprünglichen V1-Bridge (`_v1_backup/agents.md`) sowie das Progressive-Disclosure- und Ausführungs-Harness. Der Master-Orchestrator gestaltet und pflegt diese Datei bei jeder relevanten Planungs-, Strukturierungs- oder Architektur-Erweiterung aktiv mit.

> [!IMPORTANT] IDE / ORCHESTRATOR ROUTING INSTRUCTIONS
> Externe AIs und Subagenten MÜSSEN vor Code-Änderungen die passende Domänen-Regeldatei unter `.agents/rules/*.md` lesen.
> Bei Workflow-Tags (z. B. `#ask`, `#grillme`, `#plan`, `#exec`, `#exec-wave`, `#flash`, `#delegate`, `#solve`) ist `.agents/WORKFLOWS.md` verbindlich zu konsultieren.
> Zur Crash-/Quota-Recovery sowie zur lückenlosen Dokumentation **aller Planungs-, Strukturierungs- und Ausführungsschritte** dienen `plans/STATE.md`, `plans/EXECUTION_LOG.md` (letzte 25 Zeilen) und `plans/TEST_LOG.md`.

> [!NOTE] Progressive Disclosure (Rule Architecture)
> Um das Context-Window minimal zu halten, sind modulspezifische Tiefenregeln und Legacy-Endpunkt-Spezifikationen in `.agents/rules/` ausgelagert:
> - `.agents/rules/edge-worker-architecture.md` (Cloudflare Worker `packages/edge-worker/`, V1/V2 Endpunkt-Synchronisation, 1-Subrequest Tarball-Stream mit Repomix-Filterlogik, GraphQL Batch-Read, `patcher.ts` & `linter.ts`)
> - `.agents/rules/userscript-shadow-hud.md` (Tampermonkey React HUD `packages/userscript-hud/`, Shadow-DOM-Isolation, `GM_xmlhttpRequest` CSP-Bypass, DOM-Injector & Harvester für Gemini & AI Studio)
> - `.agents/rules/orchestrator-protocol.md` (Hub-and-Spoke Orchestrierung, Modell-Politik Argon High vs. Flash High, Planungs-/Ausführungs-Logging, `/delegate`, `/flash`, `/solve`)

---

## 1. Ziel, 3-Schichten-Gesamtarchitektur & `P1` (1st Priority) aller Komponenten

### Primäres Ziel
Aufhebung der Read-Only-Beschränkung von Google Gemini (`gemini.google.com`) und Google AI Studio (`aistudio.google.com`) ohne lokale Daemons, Hintergrundprozesse oder Port-Forwardings auf Entwickler-Rechnern (100 % Cloud/Edge-basiert und damit auch mobil/auf Tablets nutzbar). Das System ermöglicht das Laden eines kompletten Repositories als strukturierten XML-Kontext sowie das automatisierte, AST-/lint-geprüfte und atomare Zurückschreiben von Code-Änderungen (Search/Replace-Patches) auf GitHub.

### Das 3-Schichten-Modell (Hauptorchestrator + 3 Untertools)

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. BROWSER-SCHICHT (Gemini & AI Studio Web-App Tab)                        │
│                                                                            │
│  ┌──────────────────────────────┐       ┌───────────────────────────────┐  │
│  │ LLM Web-DOM                  │       │ Tampermonkey Userscript       │  │
│  │ - Prompt-Feld (contentedit.) │ ◄───► │ - React HUD (Shadow DOM)      │  │
│  │ - File-Drop-Zone             │       │ - DOM-Injector (Paste/Submit) │  │
│  │ - Chat-Output (Code-Blöcke)  │       │ - DOM-Harvester (Observer)    │  │
│  └──────────────────────────────┘       └───────────────┬───────────────┘  │
└─────────────────────────────────────────────────────────┼──────────────────┘
                                                          │
                        HTTPS (via GM_xmlhttpRequest)     │ (JSON / XML)
                        Umgeht Browser-CSP                │ Bearer WORKER_SECRET / BRIDGE_SECRET
                                                          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 2. EDGE-ORCHESTRATOR (Cloudflare Worker – TypeScript)                      │
│    Hauptorchestrator: packages/edge-worker/src/index.ts                    │
│                                                                            │
│  ┌──────────────────┐   ┌───────────────────────┐   ┌───────────────────┐  │
│  │ Untertool A:     │   │ Untertool B:          │   │ Untertool C:      │  │
│  │ Mix-Engine       │   │ In-Memory Patcher     │   │ Lint-Engine       │  │
│  │ (uithub/Repomix) │   │ - GraphQL Batch-Read  │   │ - oxc-parser WASM │  │
│  │ - Tarball-Stream │   │ - Wendet Search/      │   │ - AST SyntaxCheck │  │
│  │ - Decompress-RAM │   │   Replace im RAM an   │   │ - Aggreg. Errors  │  │
│  │ - XML-Generator  │   │ - Placeholder-Guard   │   │   (Kein FailFast) │  │
│  └────────┬─────────┘   └───────────┬───────────┘   └─────────┬─────────┘  │
│           │                         └────────────►────────────┘            │
│           │ (1 Subrequest)                       │ (Nur wenn 0 Fehler!)    │
│           ▼                                      ▼                         │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ D. GitHub-Connector (REST Tarball API & GraphQL createCommitOnBranch)│  │
│  └──────────────────────────────────┬───────────────────────────────────┘  │
└─────────────────────────────────────┼──────────────────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 3. PERSISTENZ-SCHICHT (GitHub Repository)                                  │
│  - Quellcode-Branches (geschützt durch 40-char expectedHeadOid)            │
│  - Meta-Steuerung: agents.md, plans/STATE.md, plans/EXECUTION_LOG.md       │
│  - Optionaler Kontext-Snapshot: /_context/repo-mix.xml                     │
└────────────────────────────────────────────────────────────────────────────┘
```

### Verbindliche `P1 (1st Priority)` Definitionen aller System-Komponenten

Jede Komponente besitzt eine unumstößliche **1st Priority (`P1`)**, der sich alle Detailentscheidungen unterordnen müssen:

| Komponente | Pfad / Ort | `P1` (1st Priority / Oberste Invariante) |
| :--- | :--- | :--- |
| **0. Master-Orchestrator** | Hauptchat, `plans/*`, `.agents/*` | **Argon-Medium/High-Planung, Complexity-Gated Flash-Delegation & Lückenloses Logging:** Sämtliche Planungs-, Architektur- und Strukturierungsphasen aller System-Parts (Stufe 1 bis 4) sowie Aufgaben ab Komplexität `>= 6` laufen auf **Argon Medium (bzw. Argon High, `Model: 'pro'` / `'inherit'`)**. Für Subagenten und Ausführungen unterhalb einer Komplexität von 6 (`Complexity < 6` bzw. `<= 6`) wird **Flash (`Model: 'flash'`)** mit aktivem `/flash` Single-Action Protocol eingesetzt. Sowohl Planungs-/Strukturierungsschritte (`PLAN_START`/`PLAN_DONE`) als auch Ausführungen (`START`/`DONE`) werden zwingend in `plans/EXECUTION_LOG.md`, `plans/STATE.md` und `agents.md` dokumentiert. |
| **1. Edge-Hauptorchestrator & GitHub-Connector** | `packages/edge-worker/src/index.ts`, `src/utils/github.ts` | **Zero-Trust Auth & 100 % V1/V2-Vertragstreue:** Strikte Validierung von `WORKER_SECRET`/`BRIDGE_SECRET` und `GITHUB_PAT`/`GITHUB_TOKEN` (niemals Secrets im Klartext loggen oder zurückgeben), Schutz vor Race-Conditions durch 40-stellige `expectedHeadOid` und volle Abwärtskompatibilität der V1-Routen (`/health`, `/push`, `/commit`, `/graphql`) parallel zu V2 (`/api/mix`, `/api/patch`). |
| **2. Untertool A: Mix-Engine (`mixer.ts`)** | `packages/edge-worker/src/modules/mixer.ts` | **1-Subrequest Tarball-Streaming & 128 MB RAM-Überlaufschutz:** Laden des gesamten Repos in exakt **1 HTTP-Subrequest** via `DecompressionStream('gzip')`; sofortiges Überspringen von Ignorierlisten (`.git/`, `node_modules/`, `dist/`, `_v1_backup/`, Lockfiles, Binaries, Dateien `> 512 KB`) bereits am 512-Byte-TAR-Header **vor** jeder String-Allokation (`shouldSkipTarEntry`); Verlustfreie Extraktion der 40-char `headOid` (PAX Global Header `typeflag === 'g'`, Fallback Root-Prefix + `getBranchHeadOid`, `headOid`-Sync bei `persistToGitHub`) und CDATA-sicherer XML-Output (`escapeCdata`). |
| **3. Untertool B: In-Memory Patcher (`patcher.ts`)** | `packages/edge-worker/src/modules/patcher.ts` | **Atomare Datenintegrität & Hard Guardrail (`validateNoPlaceholders`):** 1-Subrequest GraphQL Batch-Read über dynamische Aliases (`fetchMultipleFilesViaGraphQL`), Vorrang für gezielte 3-Stufen `search`/`replace`-Patches statt Full-Overwrite, **unverhandelbare Ablehnung jedes LLM-Platzhalter-Kommentars** (`// ... existing code ...`), Non-Fail-Fast Fehler-Aggregation inkl. `PreflightLinterHook` für Stufe 4, Idempotenz-Erkennung (`NO_CHANGES_NEEDED`) und ein einziger atomarer Commit via `createCommitOnBranch`. |
| **4. Untertool C: Pre-Flight Linter (`linter.ts`)** | `packages/edge-worker/src/modules/linter.ts` | **Aggregierende Fehler-Sammlung ohne Fail-Fast (`errors: LinterError[]`):** Lokale AST-/Syntaxprüfung (`oxc-parser` WASM + deterministischer Worker-Syntax-Verifier für `.ts`/`.tsx`/`.js`/`.jsx`/`.json`) + Custom Rules (`forbidPatterns`, `requireExports`, `validateNoPlaceholders`) im Worker-RAM über **sämtliche** geänderten Dateien hinweg sammeln (niemals beim ersten Fehler abbrechen!), damit Gemini im Self-Healing-Loop alle Fehler in einem einzigen Korrektur-Turn beheben kann. |
| **5. Browser-HUD (`userscript-hud`)** | `packages/userscript-hud/` | **Shadow-DOM-Isolation, Trusted-Types-Sicherheit, CSP-Bypass & Client-Secret-Verbot:** Vollständige UI-Kapselung in `attachShadow({ mode: 'open' })` auf `gemini.google.com` und `aistudio.google.com` ohne ungeschütztes `innerHTML` (Trusted-Types-konform), Kommunikation ausschließlich über `GM_xmlhttpRequest` (umgeht Browser-CSP), **niemals Speicherung eines `GITHUB_PAT` im Browser**, synthetischer `ClipboardEvent('paste')` für `repo-mix.xml`, automatische `headOid`-Fortschreibung und Self-Healing-Loop (`retryCount < 3`). |

---

## 2. Modell-, Delegations- & Logging-Verfassung

### Modell-Disziplin: Argon Medium / High (Planung & höhere Complexity) vs. Flash (`Complexity < 6`)
1. **Gesamtplanung & Strukturierung aller Parts auf Argon Medium (bzw. Argon High, `pro` / `inherit`):**
   - Alle Architektur-Entscheidungen, `/plan`-Entwürfe für sämtliche System-Stufen (Stufe 1 bis 4), `#grillme`-Abstimmungen, Risiko-/Komplexitäts-Bewertungen und Multi-File-Strukturierungen finden vorab mit **Argon Medium** (oder Argon High) statt.
2. **Complexity-Gate für Code-Ausführung & `/delegate` (Flash unter Complexity 6, sonst Argon Medium):**
   - **Niedrige bis mittlere Komplexität (`Complexity < 6` bzw. `<= 6`, klar spezifizierte Blaupausen):** Subagenten werden wie vorgesehen mit dem **Flash-Modell (`Model: 'flash'`)** und aktivem `/flash` Single-Action Protocol eingesetzt.
   - **Höhere Komplexität (`Complexity >= 6` / `> 6`, komplexe Architektur-Diffs oder Refactorings):** Sowohl direkte Umsetzung als auch `/delegate`-Subagenten laufen ausschließlich mit **Argon Medium (`Model: 'pro'` / `'inherit'`)**.

### Verpflichtendes Logging während Planung, Strukturierung UND Ausführung
- **Keine unsichtbaren Zwischenschritte:** Jeder relevante Verlauf – ausdrücklich **auch während der Planung und Strukturierung** – erhält einen strukturierten Log-Eintrag in [plans/EXECUTION_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/EXECUTION_LOG.md) und aktualisiert [plans/STATE.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/STATE.md):
  - **Planungs- & Strukturierungs-Phasen:** Protokolliere `PLAN_START` und `PLAN_DONE` (inkl. entschiedener Architektur-Punkte, Complexity-Score `X/10`, gewähltem Ausführungsmodell `FLASH` vs. `PRO` und aktualisierten Dateien).
  - **Ausführungs- & Delegations-Phasen:** Protokolliere `START` und `DONE` (bzw. `BLOCKED_NEEDS_USER_INPUT`) sowie alle Testergebnisse in [plans/TEST_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/TEST_LOG.md).
- **Lebende Dokumentation in `agents.md`:** Sobald in einer Planungs- oder Ausführungsphase neue dauerhafte Konventionen, Routen, Komponenten-Prioritäten (`P1`) oder Modulgrenzen festgelegt werden, aktualisiert der Orchestrator `agents.md` (und ggf. `.agents/rules/*.md`) unmittelbar mit.

---

## 3. Kanonische Monorepo-Verzeichnisstruktur & Globale Invarianten

```text
githubgeminibridge/
├── agents.md                      # DIESE DATEI: Autoritative Root-Verfassung (Single Source of Truth)
├── GEMINI.md                      # IDE-Pointer auf agents.md & .agents/WORKFLOWS.md
├── .agents/
│   ├── WORKFLOWS.md               # Routing für #plan, #exec, #exec-wave, #flash, #delegate, #solve
│   ├── rules/                     # Progressive-Disclosure Domänen-Regeln
│   │   ├── edge-worker-architecture.md
│   │   ├── userscript-shadow-hud.md
│   │   └── orchestrator-protocol.md
│   └── skills/                    # Lokale Workflow-Skills (solve, exec-wave)
├── plans/
│   ├── 00_STARTCHAT_ORCHESTRATOR.md
│   ├── AGENTS.md                  # Pointer / Synchronisations-Brücke auf Root agents.md
│   ├── STATE.md                   # Aktueller Stufen-Status (Single Source of Truth für Fortschritt)
│   ├── STAGE_BLUEPRINTS.md        # Fokussierte Baupläne für Stufe 0.5 bis 4
│   ├── EXECUTION_LOG.md           # Append-Only Protokoll für Planung, Strukturierung & Ausführung
│   └── TEST_LOG.md                # Dediziertes Test- & Verifikations-Log (PASS/FAIL/BLOCKED)
├── scripts/
│   └── patches_and_tests/
│       └── worker-smoke.mjs       # Deterministisches Smoke-Test-Harness für Worker & Module
├── shared/
│   └── types.ts                   # Verbindliche TypeScript-Verträge (V2 Orchestrator + V1 Legacy)
├── packages/
│   ├── edge-worker/               # AKTIVER Cloudflare Worker (Name: gemini-git-bridge)
│   └── userscript-hud/            # AKTIVES Tampermonkey React Shadow-DOM HUD (Stufe 3)
├── _v1_backup/                    # Archiviertes, unverändertes V1-Backup (Read-Only)
└── cf-gemini-git-bridge/          # LEGACY V1 FALLBACK (Read-Only – NICHT mehr bearbeiten!)
```

### Globale Invarianten (V1 + V2)
1. **Path Awareness:** Aktiver Worker-Code liegt ausschließlich in `packages/edge-worker/`, aktiver HUD-Code in `packages/userscript-hud/`. `cf-gemini-git-bridge/` im Root und `_v1_backup/` sind strikt **Read-Only**.
2. **Security First:** Niemals `GITHUB_TOKEN`/`GITHUB_PAT` oder `BRIDGE_SECRET`/`WORKER_SECRET` in Logs, Responses oder UI ausgeben. Im Userscript niemals ein `GITHUB_PAT` speichern.
3. **Hard Guardrail (`validateNoPlaceholders`):** Jeder Patch oder Dateiinhalt mit faulen LLM-Platzhaltern (`// ... existing code ...` etc.) wird kompromisslos abgelehnt.
4. **Patch Preference & Optimistic Concurrency:** Gezielte `search`/`replace`-Blöcke statt Full-Overwrite; jeder Commit prüft die 40-stellige `expectedHeadOid`.
5. **No Local State:** 100 % zustandslose Ausführung an der Cloudflare Edge (keine lokalen Daemons/Server/SQLite).

---

## 4. Host-Umgebung, Code-Qualität & Ausführungs-Sicherheit

### Host Environment (Windows 11 / PowerShell)
- **OS & Shell:** Windows 11 (x64) mit PowerShell (`pwsh` / Windows PowerShell 5.1+); Pfadtrenner `\`.
- **Verbotene Unix-Only Tools:** `sed`, `awk`, `grep` (nutze `Select-String`), `chmod`, `touch`, `cat` (nutze `Get-Content`), `rm` (nutze `Remove-Item`), `cp` (nutze `Copy-Item`), `mv` (nutze `Move-Item`). Nutze vorrangig die nativen Datei-Tools (`view_file`, `replace_file_content`, `write_to_file`).
- **Skript-Organisation:** Alle Test-, Probe- und Hilfsskripte gehören in `scripts/patches_and_tests/`.

### Terminal & Agent Execution Safety (`/flash` Single-Action Protocol)
- **Single-Action Protocol:** Führe zustandsändernde Shell-Befehle strikt einzeln nacheinander aus. **Verwende niemals `&&` oder `;` zur Befehlsverkettung** in automatisierten Agenten-Schritten.
- **Trace & Verify:** Bei Fehlern zuerst gezielte Diagnose (`Get-Content`, `Select-String`, `git status`) vor einem Fix-Versuch.
- **Stopp bei `BLOCKED_NEEDS_USER_INPUT`:** Bei kritischen Blockern in `plans/TEST_LOG.md` oder `plans/EXECUTION_LOG.md` sofort stoppen und User-Entscheidung einholen.

### Dateigrößen-Limits & Decision Gate
- **Dateigrößen-Schwellenwerte:** **300–499 Zeilen** = Warnung & Modularisierungs-Vorschlag; **500+ Zeilen** = Pflicht-Dekomposition in Submodule (via Argon High / `pro` Subagent).
- **Decision Gate:** Default ist Aktion und Fakten-Reporting statt Rückfrage (*Quiet Zone* für Read-Only, geplante Schritte und lokale Checkpoint-Commits). *Hard Stops (Immer fragen):* `git push`, `npx wrangler deploy` auf Produktiv-Worker, History-Rewrites oder Datenlöschung.

---

## 5. Verbindliche Schnittstellen-Verträge ([shared/types.ts](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/shared/types.ts))

Die vollständigen TypeScript-Definitionen für V2 (`WorkerEnv`, `MixRequest`, `MixResponse`, `PatchBlock`, `FilePatchOperation`, `GeminiPatchPayload`, `WorkerPatchRequest`, `LinterError`, `WorkerPatchResponse`) sowie die V1-Kompatibilitätstypen (`FilePatch`, `FileChange`, `CommitRequestPayload`) sind zentral in [shared/types.ts](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/shared/types.ts) verankert und werden in `packages/edge-worker/src/types.ts` re-exportiert.