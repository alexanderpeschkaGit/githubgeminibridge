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
1. **Disjunkte Datei-Inventare:** Parallele Subagenten dürfen niemals dieselbe Datei zeitgleich editieren.
2. **Shell-Verbot für Subagenten:** Parallele Subagenten führen keine globalen Git- oder Deployment-Befehle aus. Alle Verifikationen und Commits erfolgen durch den Coordinator.
3. **Dateigrößen-Gesetz:** Alle erzeugten und modifizierten Dateien bleiben strikt `< 500` Zeilen.
