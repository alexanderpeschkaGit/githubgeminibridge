# Gemini-to-GitHub Bridge

[![Beta](https://img.shields.io/badge/Status-Beta-orange.svg)](#beta-status)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](#lizenz)

Universelle Edge-Brücke und Browser-Integration für atomare 1-Click-Git-Commits und Search/Replace-Patches direkt aus **Google Gemini** (`gemini.google.com`) und **Google AI Studio** (`aistudio.google.com`) in beliebige GitHub-Repositories.

## Tech-Stack

- [**React**](https://react.dev/) – UI-Komponenten für den HUD
- [**Vite**](https://vitejs.dev/) – Build-Tooling und Entwicklung
- [**TypeScript**](https://www.typescriptlang.org/) – Typsicherer Code
- [**Tailwind CSS**](https://tailwindcss.com/) – Styling
- [**Cloudflare Workers**](https://developers.cloudflare.com/workers/) – Serverless Edge-Orchestrierung
- [**GitHub GraphQL API v4**](https://docs.github.com/en/graphql) – Atomare Commits
- [**Tampermonkey/Violentmonkey**](https://www.tampermonkey.net/) – Browser-Integration

## Hauptfeatures

- **1-Click Commits** – Code-Blöcke direkt aus Gemini oder AI Studio als GitHub-Commits übertragen
- **Search/Replace-Patches** – Präzises Patchen bestehender Dateien mit automatischer Diff-Vorschau
- **Atomare Commits** – Über die GitHub GraphQL API mit HEAD-OID-Race-Condition-Schutz
- **Shadow-DOM HUD** – Isolierte UI-Integration ohne Konflikte mit Gemini/AI Studio
- **Hard Guardrails** – Verhindert LLM-Platzhalter wie `// ... existing code ...` vor dem Commit
- **Branch- & Repo-Auswahl** – Flexible Konfiguration pro Commit
- **Self-Healing** – Automatische Korrektur bei Lint-/Syntaxfehlern
- **Multi-Part Repo-Mix** – Kontext aus dem Repository für bessere Patches laden

## Installation & Start für Entwickler

### Voraussetzungen

- [Node.js](https://nodejs.org/) (aktuelle LTS-Version)
- [npm](https://www.npmjs.com/) oder kompatibler Paketmanager
- [Cloudflare Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Ein GitHub Personal Access Token (PAT) mit `Contents: Read and write`
- Tampermonkey oder Violentmonkey im Browser

### 1. Repository klonen

```bash
git clone https://github.com/alexanderpeschkaGit/githubgeminibridge.git
cd githubgeminibridge
```

### 2. Cloudflare Worker einrichten

```bash
cd packages/edge-worker
npm install
```

Secrets für den Worker setzen:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put BRIDGE_SECRET
```

Worker lokal entwickeln oder deployen:

```bash
# Lokale Entwicklung
npx wrangler dev

# Auf Cloudflare deployen
npx wrangler deploy
```

### 3. Userscript bauen (optional)

Das fertige Userscript liegt als `gemini-bridge.user.js` im Repository-Root. Falls du Änderungen am HUD vornehmen möchtest:

```bash
cd packages/userscript-hud
npm install
npm run build
```

### 4. Userscript im Browser installieren

1. Tampermonkey/Violentmonkey installieren
2. Öffne [`gemini-bridge.user.js`](./gemini-bridge.user.js) im Browser – Tampermonkey bietet direkt die Installation an
3. Nach der Installation öffne Gemini oder AI Studio und konfiguriere im HUD: Worker-URL, Bridge-Secret, Repository und Branch

## Beta-Status

> **Dieses Projekt befindet sich noch im Beta-Stadium.**  
> Repomix funktioniert gut, der GitHub-Upload befindet sich noch in der experimentellen Phase.  
> Änderungen, Breaking Changes und Anpassungen vorbehalten. Feedback, Bug Reports und Verbesserungsvorschläge sind sehr willkommen – sende sie an [vijay.sikanda@gmail.com](mailto:vijay.sikanda@gmail.com) oder erstelle einfach ein [Issue](https://github.com/alexanderpeschkaGit/githubgeminibridge/issues).

## Lizenz

Dieses Projekt steht unter der [MIT-Lizenz](LICENSE).
