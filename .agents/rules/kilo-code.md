# Kilo Code - Regeln & Kontext-Disziplin

> **Zweck:** Kilo-spezifische Betriebsregeln für Plan/Ask-Modi, um Context-Bloat durch Permissions/Tool-Allowlists zu minimieren.

## 1. Architektur (Mode E)

- **Subagenten:** Nutze das `task`-Tool. `subagent_type: explore` für Read-Only-Audits, `general` für Implementierer.
- **Modell-Vererbung:** `model`, `provider`, `variant` weglassen (erbt aktives Modell). Overrides nur auf ausdrücklichen Nutzerwunsch.
- **Hintergrund:** `background: true` nur für disjunkte, nicht-blockierende Arbeit.
- **Keine Agent-Manager-Links:** Kein `conversation://`, kein Transcript-Fallback. `task` liefert `task_id`. Agent-Manager-Sessions (`ses_...`) nur bei explizitem Start durch Nutzer.
- **Skills:** `#...`-Tags sind Prompt-Marker, keine Slash-Commands. Skills über `skill`-Tool laden.

## 2. Shell & Ausführung (PowerShell 5.1)

- **Kein Verkettung:** Keine `&&`, `;` oder `&` Verkettung. Pro Shell-Befehl einzeln ausführen.
- **Native Tools bevorzugen:** `read`/`glob`/`grep`/`edit`/`write` vor Shell wo möglich.
- **Nur lesende Git-Befehle:** Nur lesende Git-Kommandos wie `git log`, `git diff`, `git status` etc. sind erlaubt; mutierende Git-Befehle sind verboten.
- **Projektregel:** Zustandsändernde Befehle strikt einzeln ausführen.

## 3. Plan/Ask Kontext-Policy (gegen Bloat)

**Nur das Nötigste laden:**
- `AGENTS.md` (Orientierung)
- `plans/STATE.md` 
- Letzten 25 Zeilen von `plans/EXECUTION_LOG.md` und `plans/TEST_LOG.md`
- Nur gezielt benötigte Dateien für die konkrete Frage/Planung

**Vermeiden:**
- Vollständige Permissions-/Tool-Allowlist dumpen
- Breite Discovery-Suchen die Permission-Listen triggern
- Shell-Introspektion nur um Permissions zu sehen
- Mehrere große Regeldateien gleichzeitig laden

**Verhalten:**
- Falls Permission-Matrix im Kontext erscheint: ignorieren, auf task-relevante Dateien fokussieren
- Statt Shell-Introspektion direkt `read` auf bekannte Pfade nutzen
- Nur benötigte Skills laden (z. B. `plan`, `ask`)

## 4. Plan-Pfade

- Pläne in `.kilo/plans/` ablegen (siehe auch Root-`plans/` für projektweite Pläne)
- Dateinamen folgen dem bestehenden Pattern im Repo

## 5. Tool-Disziplin

- **Read zuerst:** Bei Code-Fragen erst gezielt lesen, nicht alles durchsuchen
- **Batching:** Mehrere unabhängige Reads zusammenfassen wo sinnvoll
- **Keine Verifikation via Shell:** Keine Tests/Lint via Shell erzwingen - nur wenn explizit angefragt oder im Plan vorgesehen
- **Fokussiert bleiben:** Keine tangentialen Informationen einfügen

## 6. Quick Checklist für Plan/Ask

- [ ] Nur minimalen Kontext geladen
- [ ] Permission-Dumps ignoriert
- [ ] Keine Shell-Verkettung
- [ ] Task-relevante Dateien gelesen
- [ ] Skills gezielt geladen
- [ ] Keine unnötigen Dateien editiert
