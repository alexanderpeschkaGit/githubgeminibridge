---
trigger: model_decision
description: "Apply this rule when orchestrating multi-stage tasks, delegating to subagents, recovering from crashes/quotas, or configuring multi-IDE adapters."
---

# Orchestrator Protocol, Modell-Disziplin & Logging-Verfassung

## 1. Modell-Politik: 3-Tier-Modellmatrix & Complexity-Gates

1. **Gesamtplanung & Strukturierung vorab mit Argon Medium (oder Argon High, `pro` / `inherit`):**
   - Sämtliche `/plan`-, Architektur-, Strukturierungs- und `#grillme`-Phasen für alle System-Parts laufen vorab auf **Argon Medium** (bzw. Argon High).
   - Jeder generierte Plan bewertet die Komplexität jedes Arbeitspakets auf einer Skala von `1–10` im `Execution Metadata`-Header.
2. **3-Tier Per-Batch Model Routing (Flash-First-Strategie):**
   - **Tier 1 (`flash_lite` — Score 1–3):** Trivial/mechanische Tasks (Kopieren, Löschen, Bereinigung, einfache Typen, Docs/Rules in Dateien < 300 Zeilen).
   - **Tier 2 (`flash` — Score 4–6, Default):** Standard-Implementierungen (<= 3–4 Dateien, klare Interfaces, Scoped Features, Unit-Tests in Dateien < 500 Zeilen) mit aktivem `/flash` Single-Action Protocol (keine `&&`/`;`-Verkettung).
   - **Tier 3 (`pro` / `inherit` — Score 7–10):** Hohe Komplexität, architekturkritische Eingriffe, Cross-Package-Refactorings oder Pro Decomposition.
3. **Multi-IDE & Live-Streaming Deep-Links:**
   - In Mode A (Google Antigravity) erzeugt der Orchestrator bei jedem Subagent-Start sofort einen klickbaren Stream-Link: `[⚡ Watch Stream](conversation://<conversation-id>)`. In Mode E (Kilo Code) entfällt der Link; der `task`-Aufruf liefert eine `task_id`, die im Bericht genannt wird.
   - Die Multi-IDE-Betriebsmodi (Mode A-E) sind verbindlich in [.agents/rules/multi-ide-setup.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/.agents/rules/multi-ide-setup.md) definiert.

---

## 2. Minimal-Context Hub-and-Spoke & Durchgängiges Logging (Planung + Ausführung)

1. **Striktes Context-Window-Minimum im Hauptchat:**
   - Der Master-Orchestrator liest zur Orientierung ausschließlich `agents.md`, `plans/STATE.md`, die **letzten 25 Zeilen** von `plans/EXECUTION_LOG.md` sowie `plans/TEST_LOG.md`.
2. **Verpflichtendes Logging AUCH während Planung & Strukturierung (`EXECUTION_LOG.md` & `STATE.md`):**
   - Nicht nur Code-Ausführungen, sondern **auch jede Planungs- und Strukturierungsphase** muss in `plans/EXECUTION_LOG.md` und `plans/STATE.md` protokolliert werden:
     - Vor/bei einer Planungs- oder Strukturierungsphase: Eintrag `PLAN_START` / `PLAN_DONE` mit Zusammenfassung der Architektur-Entscheidung, dem ermittelten Complexity-Score (`X/10`), der Modell-Tier-Zuweisung (`FLASH_LITE`, `FLASH` oder `PRO`) und den vorbereiteten Blaupausen/Artefakten.
     - Bei jeder Code-Ausführung durch Subagenten: Eintrag `START` und `DONE` (oder `BLOCKED_NEEDS_USER_INPUT`) in `plans/EXECUTION_LOG.md` sowie strukturierter Prüfbericht in `plans/TEST_LOG.md`.
3. **Laufende Pflege von `agents.md`:**
   - Werden in einer Planungs- oder Strukturierungsphase neue Komponenten-Verträge, Routen oder `P1`-Prioritäten präzisiert, aktualisiert der Orchestrator `agents.md` (und die betroffene Datei in `.agents/rules/*.md`) direkt im selben Schritt.
4. **Crash- & Quota-Recovery:**
   - Bei einem Verbindungsabbruch oder `Quota Exceeded`-Event genügt in einem neuen Chat folgender Startbefehl:
     > *„Lies `agents.md`, `plans/STATE.md`, die letzten 25 Zeilen von `plans/EXECUTION_LOG.md` und `plans/TEST_LOG.md`. Setze die Orchestrierung am letzten Checkpoint gemäß unserer 3-Tier Modellpolitik fort.“*

---

## 3. Entscheidungs-Matrix des Auktionators (Modell-Routing)

| Task-Typ | Score & Tier | Ausführende Einheit | Begründung |
| :--- | :--- | :--- | :--- |
| **Architektur-Planung, `/plan`, `#grillme` & Strukturierung** | **Score 7–10 (`PRO`)** | Master-Orchestrator (`pro`/`inherit`) | Hohe Reasoning-Tiefe für Schnittstellen, `P1`-Invarianten und Impact-Mapping |
| **Komplexe Tasks & Multi-File-Refactorings** | **Score 7–10 (`PRO`)** | Subagent (`Model: 'pro'`) | Verhindert subtile Logik- oder Typbrüche über Paketgrenzen hinweg |
| **Standard-Implementierung & Scoped Features** | **Score 4–6 (`FLASH`)** | Subagent (`Model: 'flash'` + `#flash`) | Schnelle, kosteneffiziente Umsetzung anhand exakter Blaupausen & `shared/types.ts` |
| **Mechanische Cleanups, Typen & File-Ops** | **Score 1–3 (`FLASH_LITE`)** | Subagent (`Model: 'flash_lite'` / `'flash'`) | Minimale Latenz und Kosten für triviale Dateioperationen |
| **Parallele Paket-Ausführung (disjunkte Pfade)** | **Score <= 6 (`FLASH`)** | `#exec-wave` Subagenten (`flash`) | Disjunkte Datei-Inventare erlauben Scatter-Gather ohne Lock-Konflikte |
| **Vorab-Test, Smoke-Suite & Checkpoints** | **Score <= 3 (`FLASH_LITE`)** | Test-Subagent / Orchestrator | Deterministische Einzelbefehle (`tsc --noEmit`, `worker-smoke.mjs`, `git status`) |
| **Repo-Mix & Tarball-Streaming / AST-Syntaxcheck** | **0 LLM-Tokens (Edge/WASM)** | `mixer.ts` Stream / `oxc-parser` WASM | Reiner Binär-Stream bzw. Rust-WASM lokal im Cloudflare Worker (< 5 ms) |

---

## 4. Das `#solve` 4-Phasen Meta-Protokoll

1. **Phase 1 – Problem-Analyse & Impact-Mapping (Argon High):** Identifiziere alle direkt und indirekt betroffenen Dateien, `P1`-Prioritäten, Typ-Abhängigkeiten (`shared/types.ts`) und Edge-Cases.
2. **Phase 2 – Strukturierter Exekutions-Plan & Complexity-Check (Argon High):** Lege die Reihenfolge der Datei-Modifikationen und den Complexity-Score (`1–10`) fest; protokolliere `PLAN_DONE` in `plans/EXECUTION_LOG.md`.
3. **Phase 3 – Virtuelles Multi-Agenten-Review:**
   - *Architect:* Prüft Konformität gegen `agents.md` (`P1` aller Komponenten) und `.agents/rules/*.md`.
   - *Code Modifier:* Konstruiert minimale, eindeutige `search`/`replace`-Blöcke (ohne Platzhalter-Kommentare!).
   - *Reviewer:* Prüft auf vergessene Imports, Exporte und TypeScript-Typen.
4. **Phase 4 – Delegierte Umsetzung (Tier-Gated):** Im lokalen Projekt Ausführung durch isolierten Subagenten (Tier 1–3) inkl. `worker-smoke.mjs`-Verifikation; im Gemini-Webchat Ausgabe exakt **eines** fenced `json`-Codeblocks gemäß `GeminiPatchPayload`.
