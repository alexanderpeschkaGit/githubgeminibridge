# 04_BOILERPLATE_HARMONIZATION_EXECUTION_PLAN.md — Exekutionsplan für Verfassungs- & Regelwerks-Harmonisierung

> **Execution Metadata:**
> - **Execution Mode:** Optimiert für `#flash` / `#exec-wave`
> - **Gesamt-Komplexität:** `4/10` (Dokumentations-, Regelwerks- und Repo-Hygiene-Harmonisierung; kein Breaking Code Change)
> - **Single-Action Protocol:** Einzelbefehle in PowerShell ohne `&&`/`;`-Verkettung
> - **Dateigrößen-Gesetz:** Alle Dateien bleiben strikt `< 500` Zeilen (Probe 10 Enforced)
> - **Referenzen:** [AGENTS.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/AGENTS.md), [plans/STATE.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/STATE.md), [plans/04_BOILERPLATE_HARMONIZATION_WAVE_PLAN.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/04_BOILERPLATE_HARMONIZATION_WAVE_PLAN.md)

---

## 1. Übersicht & Zielsetzung

Dieser Exekutionsplan harmonisiert die Verfassung (`AGENTS.md`), die Regelwerke in `.agents/rules/` und die Repo-Hygiene in `.agents/skills/` mit dem aktuellen Codebestand nach den Meilensteinen Stage 5 (Hybrides Routing), Stage 6–6.2 (RepoMix Atomic Chunking & `.txt`-Migration) und Stage 6.3 (Userscript "Apply All" FIFO Fail-Fast Queue).

```mermaid
flowchart TD
    subgraph Phase 1 [Phase 1: Repo-Hygiene]
        B1["Batch 01 (FLASH_LITE)<br/>Bereinigung verwaister Flat-Files"]
    end

    subgraph Phase 2 [Phase 2: Parallele Regelwerks-Synchronisation]
        B2A["Batch 02A (FLASH)<br/>multi-ide-setup.md & orchestrator-protocol.md"]
        B2B["Batch 02B (FLASH)<br/>userscript-shadow-hud.md & edge-worker-architecture.md"]
    end

    subgraph Phase 3 [Phase 3: Verfassungs-Konsolidierung]
        B3["Batch 03 (PRO)<br/>AGENTS.md Single Source of Truth Update"]
    end

    subgraph Phase 4 [Phase 4: End-to-End Verifikation]
        B4["Batch 04 (FLASH)<br/>TypeScript Checks, Smoke Tests & Checkpoint Commit"]
    end

    Phase 1 --> Phase 2
    B2A --> Phase 3
    B2B --> Phase 3
    Phase 3 --> Phase 4
```

---

## 2. Detaillierte Batch-Abläufe (`#flash` Exekutionsschritte)

### Phase 1: Repo- & Skill-Hygiene (Seriell)

#### Batch 01: Bereinigung redundanter Flat-Files
- **Complexity:** `2/10` | **Modell-Tier:** `FLASH_LITE` (`flash_lite` oder `flash`)
- **Ziel:** Beseitigung der 7 verwaisten `.agents/skills/*.md`-Dateien, die durch die Verzeichnis-Migration (`*.agents/skills/*/SKILL.md`) obsolet geworden sind.
- **Betroffene Dateien (Löschung):**
  1. `.agents/skills/ask.md`
  2. `.agents/skills/delegate.md`
  3. `.agents/skills/exec.md`
  4. `.agents/skills/flash.md`
  5. `.agents/skills/grillme.md`
  6. `.agents/skills/refactor.md`
  7. `.agents/skills/review.md`

- **Exekutionsbefehl (Single-Action PowerShell):**
  ```powershell
  Remove-Item .agents/skills/ask.md, .agents/skills/delegate.md, .agents/skills/exec.md, .agents/skills/flash.md, .agents/skills/grillme.md, .agents/skills/refactor.md, .agents/skills/review.md -Force
  ```

- **Verifikationsbefehl:**
  ```powershell
  Get-ChildItem -Directory .agents/skills | Select-Object Name
  ```
- **Akzeptanzkriterien:**
  - [ ] Keine losen `.md`-Dateien direkt in `.agents/skills/` (nur Unterordner).
  - [ ] Alle 15 Skill-Verzeichnisse bleiben vollständig vorhanden (`ask`, `bundle`, `deep-refactor`, `delegate`, `exec`, `exec-wave`, `fetch-skill`, `flash`, `grillme`, `plan`, `refactor`, `repomix`, `review`, `solve`, `zip-clean`).

---

### Phase 2: Parallele Regelwerks-Synchronisation (Parallel Wave)

#### Batch 02A: Multi-IDE-Setup & Orchestrator-Protokoll
- **Complexity:** `4/10` | **Modell-Tier:** `FLASH` (`flash`)
- **Ziel:** Erstellung der fehlenden Datei `.agents/rules/multi-ide-setup.md` zur Schließung des toten Links in `exec-wave/SKILL.md` und Anpassung von `.agents/rules/orchestrator-protocol.md` an die 3-Tier-Modellmatrix.

- **Schritt 1: Erstellung `.agents/rules/multi-ide-setup.md`**
  - **Pfad:** `.agents/rules/multi-ide-setup.md`
  - **Inhalt & Struktur:**
    ```markdown
    ---
    trigger: model_decision
    description: "Apply this rule when configuring or executing tasks across different IDE environments (Antigravity, Kimi Code, Cursor, Cline)."
    ---

    # Multi-IDE Setup & Execution Adapters

    Dieses Regelwerk definiert die standardisierten Betriebsmodi zur Ausführung von `#exec-wave`, `#delegate` und Subagenten in verschiedenen Entwicklungs- und IDE-Umgebungen.

    ---

    ## 1. Die drei Betriebsmodi (Mode A, Mode B, Mode C)

    ### Mode A: Native Multi-Model Subagents (z. B. Google Antigravity)
    - **Architektur:** Vollwertige Unterstützung für `invoke_subagent` mit variabler Modell-Zuweisung (`flash_lite`, `flash`, `pro`).
    - **Scatter-Gather:** Parallele Waves laufen echt nebenläufig über disjunkte Dateisätze.
    - **Live-Streaming:** Der Coordinator erzeugt sofort nach Subagent-Start anklickbare Deep-Links im Format:
      `[⚡ Watch Stream](conversation://<subagent-conversation-id>)`.
    - **3-Point Feedback Contract:** Jeder Subagent berichtet beim Abschluss strictly:
      1. `Status: [SUCCESS | BLOCKED | FAILED]`
      2. `Files Modified: [Liste relativer Pfade]`
      3. `Summary: [1-2 Sätze Kernänderungen]`

    ### Mode B: Fixed-Model oder Rate-Limited Subagents (z. B. Kimi Code / CLI Agents)
    - **Architektur:** Subagenten laufen mit `Model: 'inherit'`, um die Kontext-Isolation zu wahren.
    - **Pacing & Concurrency:** Bei strikten Rate-Limits oder fehlendem Multithreading werden parallele Batches als sequenzielle FIFO-Warteschlange abgearbeitet.
    - **Fallback-Verlinkung:** Kann die IDE keine `conversation://`-Links auflösen, gibt der Coordinator den Pfad zum Transcript an:
      `file:///<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`.

    ### Mode C: Single-Agent IDEs ohne Subagent-Engine (z. B. Cursor Composer / Cline)
    - **Architektur:** Ein einziger Agent führt alle Batches nacheinander in separaten Kontext-Hygiene-Durchgängen aus.
    - **Kontext-Disziplin:** Lade jeweils nur die im aktuellen Batch spezifizierten Zieldateien.
    - **Single-Action Protocol:** Strikt ein Terminal-Befehl pro Schritt, keine Verkettung mit `&&` oder `;`.
    - **Modell-Switch-Hinweis:** Vor dem Start von `Tier: PRO`-Batches (Komplexität >= 7) empfiehlt der Agent einen Modellwechsel auf ein Pro-Modell oder führt einen expliziten Self-Review-Pass durch.

    ---

    ## 2. Invarianten & Qualitäts-Gates
    1. **Disjunkte Datei-Inventare:** Parallele Subagenten dürfen niemals dieselbe Datei editieren.
    2. **Shell-Verbot für Subagenten:** Parallele Subagenten führen keine Terminal-Befehle (`git`, `npm`, `tsc`) aus. Alle Verifikationen und Commits erfolgen durch den Coordinator.
    3. **Dateigrößen-Gesetz:** Alle erzeugten und modifizierten Dateien bleiben strikt `< 500` Zeilen.
    ```

- **Schritt 2: Update `.agents/rules/orchestrator-protocol.md`**
  - **Pfad:** `.agents/rules/orchestrator-protocol.md`
  - **Änderungen:**
    1. Angleichung von Section 1 & Section 3 an die 3-Tier-Matrix aus `exec-wave/SKILL.md`:
       - Tier 1: `flash_lite` (Komplexität 1–3: Trivial/Mechanisch, Types, Cleanups)
       - Tier 2: `flash` (Komplexität 4–6: Standard-Implementierungen, Scoped Features, Unit-Tests)
       - Tier 3: `pro` / `inherit` (Komplexität 7–10: Architektur, Cross-Package State, Pro Decomposition)
    2. Integration der Pflicht zur Erzeugung von klickbaren Stream-Links `[⚡ Watch Stream](conversation://<subagent-conversation-id>)`.
    3. Verweis auf `.agents/rules/multi-ide-setup.md` für die Multi-IDE-Adaption.

- **Verifikationsbefehle:**
  ```powershell
  Test-Path ".agents/rules/multi-ide-setup.md"
  Get-Content ".agents/rules/orchestrator-protocol.md" | Measure-Object -Line
  ```
- **Akzeptanzkriterien:**
  - [ ] `.agents/rules/multi-ide-setup.md` existiert und ist `< 500` Zeilen.
  - [ ] `.agents/rules/orchestrator-protocol.md` enthält die 3-Tier-Matrix und bleibt `< 500` Zeilen.

---

#### Batch 02B: Edge-Worker- & Userscript-Regelwerk
- **Complexity:** `4/10` | **Modell-Tier:** `FLASH` (`flash`)
- **Ziel:** Dokumentation der Stage 6.2 `.txt`-Migration in `edge-worker-architecture.md` und der Stage 6.3 Queue-Controls in `userscript-shadow-hud.md`.

- **Schritt 1: Update `.agents/rules/edge-worker-architecture.md`**
  - **Pfad:** `.agents/rules/edge-worker-architecture.md`
  - **Änderungen in Section 2 (Routentabelle):**
    - Zeile zu `/api/mix`: Ergänzung von MIME-Typ `text/plain` / `.txt`-Dateien und `buildChunkedMixFiles`.
  - **Änderungen in Section 3.A (Mixer & Chunking):**
    - Absatz 5 & 6 präzisieren: Migration von `.xml` zu `.txt` (`part-01.txt` etc.), 85k Target-Budget (`DEFAULT_MAX_CHUNK_CHARS`), 100k Cutoff-Schutz, Auswertung von dynamischen `.repomixignore.cf`-Dateien direkt im TAR-Stream, max 10 Parts Guardrail.
    - Auslagerung von TAR-Header-Parsing nach `src/utils/tarUtils.ts` und Chunking nach `src/modules/mixChunker.ts`.

- **Schritt 2: Update `.agents/rules/userscript-shadow-hud.md`**
  - **Pfad:** `.agents/rules/userscript-shadow-hud.md`
  - **Änderungen in Section 2.2 (DOM-Injector):**
    - Kontext-Upload verwendet `.txt`-Dateien (`repo-mix.part1.txt` usw.) mit MIME `text/plain` anstelle von `.xml`.
  - **Ergänzung neuer Abschnitt (Queue-Management & FIFO Fail-Fast):**
    - Dokumentation von Stage 6.3:
      - Flex-Header über der Harvested-Patches-Liste mit `⚡ Apply All (${patchCount})` (`hud-btn-primary`) und `🗑️ Clear` (`hud-btn-secondary`).
      - Sequenzielle FIFO-Abarbeitung (`[...state.harvestedPatches].reverse()`) mit direktem Fail-Fast bei Fehler (`PREFLIGHT_FAILED`, `GIT_CONFLICT`, `ERROR`).
      - Automatisches Pruning erfolgreich committeter oder idempotenter Patches (`COMMITTED`, `NO_CHANGES_NEEDED`) aus `state.harvestedPatches`.

- **Verifikationsbefehle:**
  ```powershell
  Get-Content ".agents/rules/edge-worker-architecture.md" | Measure-Object -Line
  Get-Content ".agents/rules/userscript-shadow-hud.md" | Measure-Object -Line
  ```
- **Akzeptanzkriterien:**
  - [ ] Beide Regelwerksdateien sind synchron mit dem Stage 6.2/6.3 Code.
  - [ ] Beide Dateien bleiben strikt `< 500` Zeilen.

---

### Phase 3: Verfassungs-Konsolidierung (Seriell)

#### Batch 03: `AGENTS.md` Single Source of Truth Harmonisierung
- **Complexity:** `6/10` | **Modell-Tier:** `PRO` (`pro` / Master-Orchestrator)
- **Ziel:** Angleichung der Verfassung `AGENTS.md` an alle drei Packages, Stage 6.2 Multi-Part `.txt`, Stage 6.3 Userscript Queue und die 3-Tier-Modellmatrix.

- **Schritt 1: Progressive Disclosure Header anpassen**
  - Ergänzung des Verweises auf `.agents/rules/multi-ide-setup.md`.
  - Ergänzung der expliziten Nennung von `packages/local-cli/` und `shared/`.

- **Schritt 2: Section 1 (End-to-End Datenflüsse) anpassen**
  - **Datenfluss 1 (Mix-Flow):** Aktualisierung von Single-File `.xml` auf Multi-Part `.txt`-Chunking (85k Target, 100k Hard Limit, dynamic `.repomixignore.cf`, Multi-Chip File-Paste via `injectRepoMixParts`).
  - **Datenfluss 2 (Patch-Flow):** Integration der Stage 6.3 Queue-Controls ("⚡ Apply All", sequenzieller FIFO Fail-Fast, "🗑️ Clear Queue", State-Pruning).

- **Schritt 3: Section 2 (P1-Matrix) anpassen**
  - **Master-Orchestrator:** 3-Tier-Matrix (`flash_lite` [1–3], `flash` [4–6], `pro` [7–10]), Live-Stream-Links `conversation://`.
  - **Untertool A (Mix-Engine):** RepoMix Chunking, 85k Budget, 100k Cutoff, max 10 Parts, MIME `text/plain` (`.txt`).
  - **Browser Shadow-DOM HUD:** Stage 6.3 Queue Controls, Multi-Part Ingestion, FIFO Fail-Fast.
  - **Hybrides Routing & Local CLI:** Präziser Pfad `packages/local-cli/` und `shared/hybridTypes.ts`.

- **Schritt 4: Section 3 (Globale Invarianten) anpassen**
  - Invariante 1: Aktiver Code liegt in `packages/edge-worker/`, `packages/userscript-hud/`, `packages/local-cli/` und `shared/`.

- **Verifikationsbefehl:**
  ```powershell
  Get-Content "AGENTS.md" | Measure-Object -Line
  ```
- **Akzeptanzkriterien:**
  - [ ] `AGENTS.md` ist 100 % konsistent mit dem Code und allen Teilregeln.
  - [ ] `AGENTS.md` bleibt strikt `< 500` Zeilen (Ziel: ~70–85 Zeilen).

---

### Phase 4: End-to-End Verifikation & Checkpoint (Seriell)

#### Batch 04: Verifikation & Lokaler Git-Checkpoint
- **Complexity:** `3/10` | **Modell-Tier:** `FLASH` (`flash`)
- **Ziel:** Vollständige Überprüfung aller TypeScript-Projekte, Smoke-Tests und Erstellung eines sauberen Git-Checkpoints.

- **Schritt 1: TypeScript-Kompilierungsprüfung über alle Pakete (Strikt Single-Action, kein `cd`, keine Verkettung)**
  ```powershell
  npm --prefix packages/edge-worker run typecheck
  ```
  ```powershell
  node ./packages/edge-worker/node_modules/typescript/bin/tsc --project packages/userscript-hud/tsconfig.json --noEmit
  ```
  ```powershell
  node ./packages/edge-worker/node_modules/typescript/bin/tsc --project packages/local-cli/tsconfig.json --noEmit
  ```

- **Schritt 2: Smoke-Suite & Test-Suiten ausführen (Sequenziell)**
  ```powershell
  node scripts/patches_and_tests/worker-smoke.mjs
  ```
  *Bedingung: 12/12 PASS, 0/24 Dateien >= 500 Zeilen.*

  ```powershell
  node scripts/patches_and_tests/test-local-cli.mjs
  ```
  *Bedingung: 22/22 Assertions PASS.*

  ```powershell
  node scripts/patches_and_tests/test-webhook-worker.mjs
  ```
  *Bedingung: 18/18 Assertions PASS.*

- **Schritt 3: Logging & Status-Aktualisierung**
  - Aktualisiere [plans/STATE.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/STATE.md) um Stufe 6.4 (Verfassungs- & Regelwerks-Harmonisierung abgeschlossen).
  - Trage den Ausführungsbericht in [plans/EXECUTION_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/EXECUTION_LOG.md) ein.

- **Schritt 4: Lokaler Git-Checkpoint-Commit (Zwei Einzelschritte)**
  ```powershell
  git add .agents/ AGENTS.md plans/
  ```
  ```powershell
  git commit -m "docs: harmonize AGENTS.md, rules and skills with Stage 6.3 architecture"
  ```

- **Akzeptanzkriterien:**
  - [ ] Alle Smoke- und CLI/Worker-Tests grün.
  - [ ] Git-Working-Tree für die dokumentierten Bereiche sauber.
