# Gemini-to-GitHub Bridge

Universelle Edge-Brücke und Browser-Integration für atomare 1-Click-Git-Commits und Search/Replace-Patches direkt aus **Google Gemini** (`gemini.google.com`) und **Google AI Studio** (`aistudio.google.com`) in beliebige GitHub-Repositories.

---

## Architektur-Überblick

Das Projekt besteht aus zwei perfekt aufeinander abgestimmten Komponenten:

```
┌─────────────────────────────────────────┐
│ Browser (gemini.google.com / aistudio) │
│  └─ Tampermonkey: gemini-bridge.user.js │
└────────────────────┬────────────────────┘
                     │ HTTPS (JSON + x-bridge-secret)
                     ▼
┌─────────────────────────────────────────┐
│ Cloudflare Worker (cf-gemini-git-bridge)│
│  ├─ Auth & Health Check                 │
│  ├─ Hard Guardrails (Anti-Placeholder)  │
│  ├─ In-Memory Search/Replace Resolver   │
│  └─ GitHub GraphQL API v4               │
└────────────────────┬────────────────────┘
                     │ createCommitOnBranch (GraphQL)
                     ▼
┌─────────────────────────────────────────┐
│ GitHub Repository (Beliebige Branches)  │
└─────────────────────────────────────────┘
```

1. **Frontend-Layer (`gemini-bridge.user.js`)**: Userscript für Tampermonkey/Violentmonkey. Fügt Code-Blöcken und Chat-Antworten einen interaktiven „Commit to GitHub“-Button mit Diff-Vorschau und Branch-Auswahl hinzu.
2. **Backend-Layer (`cf-gemini-git-bridge/`)**: Serverless Cloudflare Worker. Validiert Secrets, prüft HEAD-OIDs (Race-Condition-Schutz), löst Patches gegen GitHub-Blobs auf, filtert LLM-Platzhalter (`// ... existing code ...`) heraus und führt atomare Commits via GitHub GraphQL API v4 durch.

---

## 1. Installation im Browser (Userscript)

Um die 1-Click-Commit-Buttons in Google Gemini und AI Studio zu aktivieren:

1. **Tampermonkey** oder **Violentmonkey** im Browser öffnen (falls noch nicht vorhanden, über den Browser-Extension-Store installieren).
2. Die Raw-URL des Skripts öffnen — Tampermonkey zeigt dann die Installations-/Update-Seite:
   `https://raw.githubusercontent.com/alexanderpeschkaGit/githubgeminibridge/main/gemini-bridge.user.js`
3. **Installieren** bzw. **Aktualisieren** klicken.

> [!WARNING]
> Das Skript **nicht** von Hand in den Editor kopieren. Ein abgeschnittener Paste führt zu
> `injected: env: missing script "<uuid>"` — Tampermonkey kann das Skript dann nicht injizieren und
> es läuft still gar nicht. Über `@downloadURL`/`@updateURL` aktualisiert Tampermonkey das Skript
> anschließend selbst, sobald im Repo eine höhere `@version` liegt.

### Updates

Tampermonkey prüft `@updateURL` nur nach seinem eigenen Zeitplan (Standard: alle 24 Stunden) —
eine frisch gepushte Version kann deshalb bis zu einen Tag unsichtbar bleiben. Der HUD prüft die
veröffentlichte `@version` daher zusätzlich selbst (alle 6 Stunden, plus manuell über `⟳` im
Panel-Header). Liegt eine höhere Version vor, erscheint oben im Panel ein Banner mit
`⬆ Install vX.Y.Z`; der Button öffnet die Tampermonkey-Installationsseite, auf der nur noch
**Aktualisieren** bestätigt werden muss. Ein Update wird nie automatisch im Hintergrund installiert.

> [!NOTE]
> Installationen **vor `2.0.7`** (ohne `@updateURL` im Header) und per Copy-Paste angelegte Skripte
> können sich nicht selbst aktualisieren. In diesem Fall die Raw-URL einmal manuell öffnen und
> **Aktualisieren** wählen — danach greifen `@updateURL` und der HUD-Update-Check.

### Konfiguration im Browser
Nach der Installation erscheint auf `gemini.google.com` und `aistudio.google.com`:
- Ein Einstellungs-Icon (Zahnrad / Bridge-Badge) unten rechts oder am Code-Block.
- Dort können die **Worker-URL**, das **Bridge-Secret**, das **Standard-Repository** (z. B. `owner/repo`) und der **Standard-Branch** (z. B. `main` oder `preview`) konfiguriert werden.
- Das **Bridge-Secret (`WORKER_SECRET`) ist bewusst nicht im Skript enthalten**. Es wird einmalig in dieses Feld eingetragen und ausschließlich im Userscript-Speicher (GM-Storage) abgelegt — niemals im Repository. Ohne Eintrag zeigt der HUD „Set your Worker Secret (WORKER_SECRET) …“ und der Worker antwortet mit `401`.

---

## 2. Cloudflare Worker Setup & Deployment

Der Worker befindet sich im Unterverzeichnis `cf-gemini-git-bridge/`.

### Schnellbefehle (Wrangler CLI)

Vor dem Ausführen von Befehlen immer in den Worker-Ordner wechseln:

```bash
cd cf-gemini-git-bridge
```

| Aktion | Befehl |
|---|---|
| Abhängigkeiten installieren | `npm install` |
| Lokaler Test | `npx wrangler dev` |
| Live Deployment | `npx wrangler deploy` |
| GitHub Token hinterlegen | `npx wrangler secret put GITHUB_TOKEN` |
| Bridge Secret hinterlegen | `npx wrangler secret put BRIDGE_SECRET` |

### Benötigte Secrets (Cloudflare Worker)
- **`GITHUB_TOKEN`**: Fine-Grained Personal Access Token (PAT) von GitHub mit der Berechtigung `Contents: Read and write` für die Ziel-Repositories.
- **`BRIDGE_SECRET`**: Frei wählbares Secret (z. B. 64-stelliger Hex-Token), das zur Absicherung der Worker-API dient.

---

## 3. API-Endpunkte & Authentifizierung

Der Worker akzeptiert Authentifizierung über:
- Header: `Authorization: Bearer <BRIDGE_SECRET>`
- Header: `x-bridge-secret: <BRIDGE_SECRET>`

### 1. Health-Check (öffentlich)
- **Methode:** `GET /` oder `GET /health`
- **Antwort:**
```json
{
  "status": "ok",
  "service": "gemini-git-bridge",
  "version": "1.0.0",
  "timestamp": "2026-10-15T14:30:00.000Z",
  "hasBridgeSecret": true,
  "hasGithubToken": true
}
```

### 2. Commit Relay (geschützt)
- **Methode:** `POST /push`, `POST /commit`, `POST /api/commit` oder `POST /`
- **Beispiel-Payload (Search/Replace Patch):**
```json
{
  "repo": "meinUser/meinRepo",
  "targetBranch": "main",
  "commitMessage": "fix: update button styles",
  "changes": [
    {
      "path": "src/styles.css",
      "search": "background: red;",
      "replace": "background: #2563eb;"
    }
  ]
}
```
- **Beispiel-Payload (Ganze Datei anlegen oder überschreiben):**
```json
{
  "repo": "meinUser/meinRepo",
  "targetBranch": "feature/login",
  "commitMessage": "feat: add config file",
  "changes": [
    {
      "path": "config.json",
      "content": "{\n  \"apiUrl\": \"https://api.example.com\"\n}"
    }
  ]
}
```
- **Beispiel-Payload (Datei löschen):**
```json
{
  "repo": "meinUser/meinRepo",
  "targetBranch": "main",
  "commitMessage": "chore: remove deprecated file",
  "deletions": [
    { "path": "old-file.txt" }
  ]
}
```

### 3. Raw GraphQL Proxy (geschützt)
- **Methode:** `POST /graphql`
- Leitet beliebige GraphQL-Queries/Mutationen direkt an die GitHub GraphQL API weiter.

---

## 4. Sicherheits-Features & Hard Guardrails

- **Zero-Local-State**: Worker läuft vollständig serverless auf Cloudflare Edge ohne Dateisystem-Abhängigkeiten.
- **LLM-Platzhalter-Schutz**: Verhindert Code-Zerstörung! Payloads, die Text wie `// ... existing code ...`, `/* ... rest of code ... */` oder `# ... existing code ...` enthalten, werden vom Worker strikt mit einem Fehler (`400 Bad Request`) abgelehnt.
- **HEAD-OID-Prüfung**: Vor jedem Commit wird die aktuelle Commit-OID des Ziel-Branches abgefragt (`expectedHeadOid`). So werden Race-Conditions und unbemerkte Überschreibungen verhindert.
- **Tolerantes Patching**: Suchblöcke tolerieren Windows- (CRLF) und Unix-Zeilenumbrüche (LF) sowie leicht abweichende Einrückungen.
