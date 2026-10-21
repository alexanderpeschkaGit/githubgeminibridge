# RepoMix & Bridge Instruktionen für Gemini

> **Status:** Diese Instruktionen werden vom Edge-Worker automatisch an den Anfang jedes RepoMixes (`<instructions>...</instructions>`) eingebettet. Dadurch entsteht **kein zusätzlicher Datei-Upload** (wichtig für das 10-Dateien-Limit in Gemini Web) und das Modell liest die Regeln noch vor dem Dateibaum.

---

## 1. Universelles 2-Modi-Verhalten (Keine Prompt-Verwirrung)

Damit die eingebetteten Regeln niemals mit deinem eigentlichen Benutzer-Prompt kollidieren, unterscheidet Gemini strikt zwischen zwei Aufgabenarten:

* **Modus 1: Reine Lese- & Analyse-Aufgaben (Read-Only):**
  Wenn du Fragen stellst, Code-Erklärungen wünschst, Architekturen besprichst oder ein Review anforderst:
  * Gemini antwortet ganz normal und flüssig in natürlicher Sprache (z. B. auf Deutsch).
  * Es werden **keine** Patches oder leere JSON-Blöcke erzeugt.
* **Modus 2: Codeänderungen & Implementierungen (Modification):**
  **Nur wenn** du explizit Codeänderungen, Fehlerbehebungen, Refactorings oder neue Dateien verlangst:
  * Gemini gibt niemals ganze bestehende Dateien neu aus.
  * Gemini verwendet **keine Platzhalter** (`// ... existing code ...`).
  * Gemini formatiert Änderungen strikt nach Format A (JSON) oder Format B (Search/Replace).

---

## 2. Struktur des RepoMix-Snapshots

Jede generierte Textdatei enthält eine strukturierte XML-Momentaufnahme:
1. `<repository repo="..." branch="..." headOid="..." part="1" totalParts="N">`: Basis-Metadaten.
2. `<instructions>`: Die universellen Systemleitplanken direkt am Dokumentanfang.
3. `<file_tree>`: Vollständiger Dateibaum des Projekts (in Part 1).
4. `<files><file path="...">...<![CDATA[...]]></file></files>`: Reale Dateiinhalte.
5. **Multi-Part Splitting:** Bei großen Repositories teilen sich die Dateien auf Parts 1 bis N auf; alle Parts gehören zusammen.
6. **Opt-in-Metadaten:** `<recent_commits>` und `<volatile_files>` erscheinen nur, wenn der Client `includeRecentCommits: true` angefordert hat (Standard: `false`); die Metadaten sind auf 8.000 Zeichen gedeckelt.

---

## 3. Ausgabe-Formate bei Codeänderungen (GitHub-Bridge)

### Format A: V2 Patch-JSON (Standard für atomare Multi-File Commits)
```json
{
  "commitMessage": "feat: präzise beschreibung der änderung",
  "patches": [
    {
      "path": "relativer/pfad/zur/datei.ts",
      "action": "modify",
      "blocks": [
        {
          "search": "// exakter bisheriger Codeausschnitt aus dem RepoMix",
          "replace": "// neuer ersetzter Code"
        }
      ]
    },
    {
      "path": "relativer/pfad/zu/neuer_datei.ts",
      "action": "create",
      "fullContent": "// vollständiger Inhalt der neuen Datei"
    },
    {
      "path": "relativer/pfad/zu/alter_datei.ts",
      "action": "delete"
    }
  ]
}
```
`modify` benötigt `blocks` mit einem oder mehreren exakten `search`/`replace`-Paaren, `create` benötigt den vollständigen `fullContent`, `delete` benötigt keine Inhaltsfelder. `branch`, `expectedHeadOid`, `expectedTargetHeadOid` und `targetBranch` sind Worker-Request-Felder und dürfen nicht im Payload stehen.

### Format B: Search/Replace Blöcke (Für Einzelfiles)
```text
// filepath: relativer/pfad/zur/datei.ts
<<<<<<< SEARCH
exakter bisheriger Codeausschnitt aus dem RepoMix
=======
neuer ersetzter Code
>>>>>>> REPLACE
```
* **Pfad-Position:** Die `// filepath:`-Zeile ist die **erste Zeile innerhalb** des Codeblocks (vor `<<<<<<< SEARCH`). Der Dateiname darf **nicht** außerhalb des Blocks stehen (keine Überschrift, kein `3. \`src/datei.ts\``, keine Backtick-Zeile darüber).
* **Granularität:** Eine Datei pro Codeblock, jede mit eigener `// filepath:`-Zeile.

---

## 4. Strikte Guardrails
* **Verbot von Auslassungen:** Niemals `// ... existing code ...`, `/* rest unchanged */` oder `# ...` verwenden.
* **Exakte Übereinstimmung:** Der `search`-Block muss exakt Zeichen für Zeichen mit dem RepoMix übereinstimmen (inkl. Einrückung).
* **Single Source of Truth:** Nur vorhandene Pfade und Signaturen aus dem `<file_tree>` verwenden.
