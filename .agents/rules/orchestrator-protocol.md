---
trigger: model_decision
description: "Apply this rule when orchestrating multi-stage tasks, delegating to subagents, recovering from crashes/quotas, or configuring multi-IDE adapters."
---

# Orchestrator Protocol, Modell-Disziplin & Logging-Verfassung

## 1. Modell-Politik: Argon Medium / High (Planung & `Complexity >= 6`) vs. Flash (`Complexity < 6`)

1. **Gesamtplanung & Strukturierung aller Parts vorab mit Argon Medium (oder Argon High, `pro` / `inherit`):**
   - Sämtliche `/plan`-, Architektur-, Strukturierungs- und `#grillme`-Phasen für **alle System-Parts (Stufe 1 bis 4)** laufen vorab auf **Argon Medium** (bzw. Argon High).
   - Jeder generierte Plan bewertet die Komplexität jedes Arbeitspakets auf einer Skala von `1–10` im `Execution Metadata`-Header.
2. **Complexity-Gate für Code-Ausführung & `/delegate` (Flash bei `< 6`, sonst Argon Medium):**
   - **Geringe Komplexität (`Complexity < 6`, klar definierte Blaupause):** Subagenten werden mit dem **Flash-Modell (`Model: 'flash'`)** und aktivem `/flash` Single-Action Protocol (keine `&&`/`;`-Verkettung) gestartet.
   - **Mittlere bis hohe Komplexität (`Complexity >= 6`) oder komplexe Multi-File-Architektur-Eingriffe:** Die Ausführung und `/delegate`-Subagenten laufen auf **Argon Medium (`Model: 'pro'` bzw. `'inherit'`)**.


---

## 2. Minimal-Context Hub-and-Spoke & Durchgängiges Logging (Planung + Ausführung)

1. **Striktes Context-Window-Minimum im Hauptchat:**
   - Der Master-Orchestrator liest zur Orientierung ausschließlich `agents.md`, `plans/STATE.md`, die **letzten 25 Zeilen** von `plans/EXECUTION_LOG.md` sowie `plans/TEST_LOG.md`.
2. **Verpflichtendes Logging AUCH während Planung & Strukturierung (`EXECUTION_LOG.md` & `STATE.md`):**
   - Nicht nur Code-Ausführungen, sondern **auch jede Planungs- und Strukturierungsphase** muss in `plans/EXECUTION_LOG.md` und `plans/STATE.md` protokolliert werden:
     - Vor/bei einer Planungs- oder Strukturierungsphase: Eintrag `PLAN_START` / `PLAN_DONE` mit Zusammenfassung der Architektur-Entscheidung, dem ermittelten Complexity-Score (`X/10`), der Modell-Zuweisung (`FLASH` bei `< 6` vs. `Argon Medium / PRO` ab `>= 6`) und den vorbereiteten Blaupausen/Artefakten.
     - Bei jeder Code-Ausführung durch Subagenten: Eintrag `START` und `DONE` (oder `BLOCKED_NEEDS_USER_INPUT`) in `plans/EXECUTION_LOG.md` sowie strukturierter Prüfbericht in `plans/TEST_LOG.md`.
3. **Laufende Pflege von `agents.md`:**
   - Werden in einer Planungs- oder Strukturierungsphase neue Komponenten-Verträge, Routen oder `P1`-Prioritäten präzisiert, aktualisiert der Orchestrator `agents.md` (und die betroffene Datei in `.agents/rules/*.md`) direkt im selben Schritt.
4. **Crash- & Quota-Recovery:**
   - Bei einem Verbindungsabbruch oder `Quota Exceeded`-Event genügt in einem neuen Chat folgender Startbefehl:
     > *„Lies `agents.md`, `plans/STATE.md`, die letzten 25 Zeilen von `plans/EXECUTION_LOG.md` und `plans/TEST_LOG.md`. Setze die Orchestrierung am letzten Checkpoint gemäß unserer Argon-Medium / Flash Modellpolitik fort.“*

---

## 3. Entscheidungs-Matrix des Auktionators (Modell-Routing)

| Task-Typ | Modell-Stufe | Ausführende Einheit | Begründung |
| :--- | :--- | :--- | :--- |
| **Architektur-Planung, `/plan`, `#grillme` & Strukturierung** | **Argon Medium / High (`pro`/`inherit`)** | Master-Orchestrator | Hohe Reasoning-Tiefe für Schnittstellen, `P1`-Invarianten und Impact-Mapping |
| **Komplexe Tasks & Multi-File-Refactorings (`Complexity >= 6`)** | **Argon Medium (`pro`/`inherit`)** | `/delegate` Subagent (`Model: 'pro'`) | Verhindert subtile Logik- oder Typbrüche über Paketgrenzen hinweg |
| **Klar spezifizierte Umsetzung (`Complexity < 6`)** | **Flash (`flash`)** | `/delegate` Subagent (`Model: 'flash'` + `#flash`) | Schnelle, kosteneffiziente Umsetzung anhand exakter Blaupausen & `shared/types.ts` |
| **Parallele Paket-Ausführung (`Complexity < 6`)** | **Flash (`flash`)** | `#exec-wave` Subagenten (`Model: 'flash'`) | Disjunkte Datei-Inventare erlauben Scatter-Gather ohne Lock-Konflikte |
| **Vorab-Test, Smoke-Suite, Verifikation & Checkpoints (`< 6`)** | **Flash (`flash`)** | Test-Subagent (`#delegate` `Model: 'flash'`) | Deterministische Einzelbefehle (`tsc --noEmit`, `worker-smoke.mjs`, `git status`) |
| **Repo-Mix & Tarball-Streaming / AST-Syntaxcheck** | **0 LLM-Tokens (Edge/WASM)** | `mixer.ts` Stream / `oxc-parser` WASM | Reiner Binär-Stream bzw. Rust-WASM lokal im Cloudflare Worker (< 5 ms) |

---

## 4. Das `#solve` 4-Phasen Meta-Protokoll

1. **Phase 1 – Problem-Analyse & Impact-Mapping (Argon High):** Identifiziere alle direkt und indirekt betroffenen Dateien, `P1`-Prioritäten, Typ-Abhängigkeiten (`shared/types.ts`) und Edge-Cases.
2. **Phase 2 – Strukturierter Exekutions-Plan & Complexity-Check (Argon High):** Lege die Reihenfolge der Datei-Modifikationen und den Complexity-Score (`1–10`) fest; protokolliere `PLAN_DONE` in `plans/EXECUTION_LOG.md`.
3. **Phase 3 – Virtuelles Multi-Agenten-Review:**
   - *Architect:* Prüft Konformität gegen `agents.md` (`P1` aller Komponenten) und `.agents/rules/*.md`.
   - *Code Modifier:* Konstruiert minimale, eindeutige `search`/`replace`-Blöcke (ohne Platzhalter-Kommentare!).
   - *Reviewer:* Prüft auf vergessene Imports, Exporte und TypeScript-Typen.
4. **Phase 4 – Delegierte Umsetzung (Flash High bei `<= 6`, Argon High bei `> 6`):** Im lokalen Projekt Ausführung durch isolierten Subagenten inkl. `worker-smoke.mjs`-Verifikation; im Gemini-Webchat Ausgabe exakt **eines** fenced `json`-Codeblocks gemäß `GeminiPatchPayload`.
