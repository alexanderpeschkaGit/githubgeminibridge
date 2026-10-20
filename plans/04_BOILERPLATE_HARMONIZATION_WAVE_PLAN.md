# 04_BOILERPLATE_HARMONIZATION_WAVE_PLAN.md — Roadmap zur Verfassungs- & Regelwerks-Synchronisation

> **Execution Metadata:**
> - **Typ:** Multi-Batch Roadmap für `#exec-wave`
> - **Gesamt-Komplexität:** `4/10` (Dokumentations-, Regelwerks- und Repo-Hygiene-Harmonisierung; kein Code-Umbau, aber strikte Konsistenz)
> - **Modell-Tier-Mix:** `FLASH_LITE` (Batch 1), `FLASH` (Batches 2A, 2B, 4), `PRO` (Batch 3)
> - **Single-Action Protocol:** Einzelbefehle ohne `&&`/`;`-Verkettung
> - **Dateigrößen-Gesetz:** Alle Zieldateien bleiben strikt `< 500` Zeilen

---

## 1. Ausgangslage & Befund (Delta-Analyse)

In den letzten Tagen wurde die Codebase tiefgreifend und erfolgreich umgebaut:
- **Monorepo-Struktur:** 3 Pakete (`packages/edge-worker`, `packages/userscript-hud`, `packages/local-cli`) + `shared/`.
- **RepoMix Chunking & .txt Migration (Stage 6–6.2):** `mixChunker.ts`, `tarUtils.ts`, 85k-Char-Budget, 100k Hard Cutoff, max 10 Parts, dynamische `.repomixignore.cf`-Auswertung und MIME-Typ `text/plain` (`.txt` statt `.xml`).
- **Userscript Queue Management (Stage 6.3):** FIFO Fail-Fast "⚡ Apply All", "🗑️ Clear Queue", dynamische Badges und Concurrency-Schutz.
- **Skills-Modernisierung:** Umstellung von flachen `.agents/skills/*.md`-Dateien auf Skill-Ordner mit `SKILL.md` sowie neue Skills (`bundle`, `repomix`, `deep-refactor`, `zip-clean`, `fetch-skill`).

### Identifizierte Gaps & Inkonsistenzen:
1. **`AGENTS.md`:**
   - Invariante 3.1 ignoriert `packages/local-cli/` und `shared/`.
   - Datenfluss 1 (Mix-Flow) beschreibt noch das alte Single-File `.xml`-Pasting statt Multi-Part `.txt`.
   - Datenfluss 2 (Patch-Flow) ignoriert die Stage 6.3 Queue ("Apply All", FIFO Fail-Fast).
   - P1-Matrix führt noch die veraltete 2-Stufen-Modellpolitik (Argon vs. Flash) und unvollständige Modulverweise.
2. **`.agents/rules/`:**
   - `userscript-shadow-hud.md`: Fehlt die Dokumentation von Stage 6.3 (Queue Header, FIFO Fail-Fast, Auto-Pruning) und Multi-Part `.txt`-Injection.
   - `edge-worker-architecture.md`: Bezieht sich noch auf XML-Ausgabe statt der Stage 6.2 `.txt`-Migration.
   - `orchestrator-protocol.md`: Verwendet noch das binäre Modell-Routing statt der in `exec-wave` etablierten 3-Tier-Matrix (`flash_lite`, `flash`, `pro`).
   - **Toter Link:** `exec-wave/SKILL.md` verweist auf `.agents/rules/multi-ide-setup.md`, die Datei existiert jedoch noch nicht!
3. **Skill-Hygiene:**
   - 7 verwaiste Flat-Files (`ask.md`, `delegate.md`, `exec.md`, `flash.md`, `grillme.md`, `refactor.md`, `review.md`) liegen ungetrackt neben ihren neuen Verzeichnis-Pendants `*.agents/skills/*/SKILL.md`.

---

## 2. Multi-Batch Roadmap (`#exec-wave`)

```mermaid
flowchart TD
    subgraph Phase 1 [Phase 1: Repo-Hygiene]
        B1["Batch 1 (FLASH_LITE)<br/>Bereinigung redundanter Skills & Flat-Files"]
    end

    subgraph Phase 2 [Phase 2: Parallele Regelwerks-Synchronisation]
        B2A["Batch 2A (FLASH)<br/>multi-ide-setup.md erstellen &<br/>orchestrator-protocol.md anpassen"]
        B2B["Batch 2B (FLASH)<br/>userscript-shadow-hud.md &<br/>edge-worker-architecture.md updaten"]
    end

    subgraph Phase 3 [Phase 3: Verfassungs-Konsolidierung]
        B3["Batch 3 (PRO)<br/>AGENTS.md Single Source of Truth Harmonisierung"]
    end

    subgraph Phase 4 [Phase 4: End-to-End Verifikation]
        B4["Batch 4 (FLASH)<br/>TypeScript-, Smoke- & Test-Suiten + Git-Checkpoint"]
    end

    Phase 1 --> Phase 2
    B2A --> Phase 3
    B2B --> Phase 3
    Phase 3 --> Phase 4
```

---

## 3. Batch-Spezifikationen

### Phase 1: Bereinigung & Skill-Hygiene (Seriell)
#### Batch 01: Bereinigung verwaister Flat-Files
- **Complexity:** `2/10` | **Tier:** `FLASH_LITE` (`flash_lite`)
- **Dateien:**
  - Löschen: `.agents/skills/ask.md`, `.agents/skills/delegate.md`, `.agents/skills/exec.md`, `.agents/skills/flash.md`, `.agents/skills/grillme.md`, `.agents/skills/refactor.md`, `.agents/skills/review.md`
  - Prüfen: Vollständigkeit aller 15 Skill-Verzeichnisse (`ask`, `bundle`, `deep-refactor`, `delegate`, `exec`, `exec-wave`, `fetch-skill`, `flash`, `grillme`, `plan`, `refactor`, `repomix`, `review`, `solve`, `zip-clean`)
- **Akzeptanzkriterium:** Keine doppelten `.md`-Dateien mehr in `.agents/skills/`.

---

### Phase 2: Parallele Regelwerks-Synchronisation (Parallel Wave)
#### Batch 02A: Multi-IDE-Setup & Orchestrator-Protokoll
- **Complexity:** `4/10` | **Tier:** `FLASH` (`flash`)
- **Dateien:**
  - Neu: `.agents/rules/multi-ide-setup.md` (Schließen des toten Links aus `exec-wave/SKILL.md`; Spezifikation von Mode A [Antigravity Multi-Model], Mode B [Kimi / Fixed Model], Mode C [Cursor / Cline Single-Agent])
  - Update: `.agents/rules/orchestrator-protocol.md` (Integration der 3-Tier-Modell-Matrix: `flash_lite` [1–3], `flash` [4–6], `pro` [7–10], Clickable Stream Links `conversation://` und Multi-IDE-Adaption)
- **Akzeptanzkriterium:** Kein toter Link mehr in `exec-wave/SKILL.md`; vollständige Konsistenz zwischen Orchestrator-Protokoll und `exec-wave`.

#### Batch 02B: Edge-Worker- & Userscript-Regelwerk
- **Complexity:** `4/10` | **Tier:** `FLASH` (`flash`)
- **Dateien:**
  - Update: `.agents/rules/edge-worker-architecture.md` (Ergänzung der Stage 6.2 `.txt`-Migration [MIME `text/plain`], 10-Parts-Guardrail und dynamische `.repomixignore.cf`-Auswertung)
  - Update: `.agents/rules/userscript-shadow-hud.md` (Ergänzung von Stage 6.3 Queue-Controls ["⚡ Apply All" FIFO Fail-Fast, "🗑️ Clear Queue", State-Pruning] und Multi-Part `.txt`-Pasting)
- **Akzeptanzkriterium:** Beide Architektur-Regeln spiegeln 100 % der im Code aktiven Features wider; beide Dateien bleiben `< 500` Zeilen.

---

### Phase 3: Verfassungs-Konsolidierung (Seriell)
#### Batch 03: `AGENTS.md` Single Source of Truth Harmonisierung
- **Complexity:** `6/10` | **Tier:** `PRO` (`pro` / Master-Orchestrator)
- **Dateien:** `AGENTS.md`
- **Inhalte:**
  1. *Section 1 (Datenflüsse):*
     - Mix-Flow: Multi-Part `.txt`-Chunking (`part-01.txt` etc.), 85k-Target, 100k-Cutoff, dynamic `.repomixignore.cf`, Multi-File-Paste via `injectRepoMixParts`.
     - Patch-Flow: Queue-Management, "⚡ Apply All" mit sequenziellem FIFO Fail-Fast, "🗑️ Clear Queue".
  2. *Section 2 (P1-Matrix):*
     - Orchestrator: 3-Tier-Matrix (`flash_lite`, `flash`, `pro`).
     - Mixer: RepoMix Atomic Chunking, 85k-Budget, `.txt`-MIME.
     - Userscript: Queue-Management & Multi-Part Ingestion.
     - Hybrides Routing & Local CLI: Klare Verweise auf `packages/local-cli/`.
  3. *Section 3 (Invarianten):*
     - Invariante 1: Präzisierung auf `packages/edge-worker/`, `packages/userscript-hud/`, `packages/local-cli/` und `shared/`.
- **Akzeptanzkriterium:** `AGENTS.md` ist wieder 100 % deckungsgleich mit dem Codebestand und bleibt `< 500` Zeilen (aktuell 63 Zeilen).

---

### Phase 4: End-to-End Verifikation & Checkpoint (Seriell)
#### Batch 04: Verifikation & Git-Checkpoint
- **Complexity:** `3/10` | **Tier:** `FLASH` (`flash`)
- **Dateien:** `plans/STATE.md`, `plans/EXECUTION_LOG.md`, `plans/TEST_LOG.md`
- **Schritte:**
  1. TypeScript-Prüfung (`tsc --noEmit`) über alle 3 Packages (`edge-worker`, `userscript-hud`, `local-cli`).
  2. Smoke-Suite `node scripts/patches_and_tests/worker-smoke.mjs` (Ziel: `12/12 PASS`, 0 Dateien >= 500 Zeilen).
  3. Lokale Tests `test-local-cli.mjs` und `test-webhook-worker.mjs`.
  4. Aktualisierung der Status- und Log-Dateien.
  5. Lokaler Git-Commit des harmonisierten Stands.
- **Akzeptanzkriterium:** Alle Tests grün, sauberes Git-Working-Directory.
