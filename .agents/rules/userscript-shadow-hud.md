---
trigger: model_decision
description: "Apply this rule whenever working on packages/userscript-hud/ or gemini-bridge.user.js (DOM injection, harvesting, Shadow DOM UI, Tampermonkey grants)."
---

# Tampermonkey Userscript & Shadow-DOM HUD (`packages/userscript-hud/`)

> **Historischer Kontext:** Verbindet die bewährten DOM-Scanner-, Diff-Parser- und `GM_*`-Storage-Mechanismen aus `_v1_backup/gemini-bridge.user.js` mit der neuen React Shadow-DOM HUD-Architektur (Stufe 3).

---

## 1. Host-Kompatibilität & Sicherheits-Grenzen

1. **Dual-Target Support (`@match`):**
   - Das Userscript muss zwingend auf beiden Plattformen funktionieren:
     - `https://gemini.google.com/*`
     - `https://aistudio.google.com/*`
2. **Strikte Secret-Trennung:**
   - Im Userscript (`GM_setValue` / `localStorage`) darf **niemals** ein GitHub Personal Access Token (`GITHUB_PAT` / `GITHUB_TOKEN`) gespeichert werden.
   - Es werden ausschließlich die Worker-URL (`https://gemini-git-bridge.sikanda.workers.dev`), das `WORKER_SECRET` (bzw. `BRIDGE_SECRET`), das Ziel-Repository (`owner/repo`) und der Ziel-Branch gespeichert.
3. **CSP-Bypass via `GM_xmlhttpRequest`:**
   - Da `gemini.google.com` und `aistudio.google.com` strikte Content Security Policies (`connect-src`) erzwingen, müssen sämtliche HTTP-Aufrufe zum Cloudflare Worker über `GM_xmlhttpRequest` (bzw. `GM.xmlHttpRequest`) mit `@connect *.workers.dev` erfolgen – niemals über ungekapsltes Browser-`fetch()`.

---

## 2. UI-Kapselung, Trusted-Types-Sicherheit & DOM-Interaktion

1. **Verpflichtendes Shadow DOM (`attachShadow`) & Trusted-Types-Konformität:**
   - Mounte niemals Komponenten oder globale Stylesheets direkt in `document.body` der Host-Seite (Gefahr von CSS-Leaks und Angular/Material-Konflikten in Gemini/AI Studio).
   - Erzeuge einen dedizierten Host-Container `#gemini-edge-hud-root` und mounte die gesamte HUD-UI + Styles innerhalb von `attachShadow({ mode: 'open' })`.
   - **Trusted-Types-Pflicht (`require-trusted-types-for 'script'`):** Da `gemini.google.com` und `aistudio.google.com` strikte Trusted-Types-Policies erzwingen, darf im Userscript niemals ungeschütztes `element.innerHTML = ...` verwendet werden. Nutze ausschließlich sichere DOM-APIs (`document.createElement`, `textContent`, `appendChild`) oder eine gekapselte `trustedTypes.createPolicy`-Brücke. Die Styles und Trusted-Types DOM-Bausteine sind modular in `src/ui/hudStylesAndDom.ts` gekapselt und werden von `src/ui/shadowHud.ts` gesteuert.
2. **DOM-Injector (`src/dom/injector.ts`):**
   - **Kontext-Upload (`repo-mix.xml` & Multi-Part Chunks):** Konstruiere `File`-Objekte (für Single-File `repo-mix.xml` oder für Multi-Part `repo-mix.part1.xml`, `repo-mix.part2.xml`, … via `injectRepoMixParts`), verpacke sie gemeinsam in ein `DataTransfer`-Objekt und dispatche ein synthetisches `ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })` auf das aktive Eingabefeld (`div[contenteditable="true"]` bzw. `textarea`). Gemini / AI Studio erzeugt dadurch mehrere saubere Datei-Chips nebeneinander.
   - **Scope-Filter & Chunk-Größe (`includePaths`, `maxChunkChars`):** Im HUD-Drawer (`hudStylesAndDom.ts`) können optional ein kommagetrennter Subpfad-Filter (`src/, packages/edge-worker/`) sowie das Zeichenbudget `maxChunkChars` (Standard: 85.000, unterhalb des 100k-Gemini-Limits) konfiguriert werden, die an `MixRequest` übergeben werden.
   - **Prompt-Text-Injektion:** Nutze `document.execCommand('insertText', false, promptText)` bzw. native `InputEvent`-Dispatches auf dem fokussierten Editor-Element, damit der interne State von Gemini/AI Studio die Eingabe zuverlässig registriert.
3. **DOM-Harvester (`src/dom/harvester.ts`):**
   - Überwache neu generierte LLM-Antwortblöcke per `MutationObserver` (mit Debounce/Streaming-Completion-Erkennung).
   - Extrahiere sowohl strukturierte V2 `GeminiPatchPayload`-JSON-Codeblöcke als auch klassische `<<<<<<< SEARCH ... >>>>>>> REPLACE`-Blöcke (V1-Fallback aus `_v1_backup/gemini-bridge.user.js` inkl. automatischer Konvertierung in `GeminiPatchPayload`).
4. **Storage & Secret Guardrail (`src/services/storage.ts`):**
   - Striktes Verbot von GitHub PATs via `sanitizeNoGithubPat` (Hard Guardrail `P1`).
   - Abwärtskompatible V1-Schlüssel via `getStoredValue` / `setStoredValue` (`gemini_bridge_` Fallback).
   - Konfiguration über `loadHudConfig` und `saveHudConfig` (`HudConfig`).
5. **Worker Client & CSP-Bypass (`src/services/workerClient.ts`):**
   - Kapselung aller Worker-Aufrufe über `gmRequestJson` (`GM_xmlhttpRequest` / `GM.xmlHttpRequest` mit `fetch`-Fallback).
   - Endpunkte: `checkWorkerHealth` (`GET /health`), `requestRepoMix` (`POST /api/mix`), `requestWorkerPatch` (`POST /api/patch`), `requestLegacyCommit` (`POST /push`).
6. **Optimistic Concurrency (`headOid` State-Machine) & Self-Healing Loop (`src/services/selfHealing.ts`):**
   - Speichere die von `/api/mix` gelieferte 40-stellige `headOid` im HUD-State (`mountShadowHud`).
   - Nach jedem erfolgreichen `/api/patch`-Commit (`status === "COMMITTED"`) aktualisiere `headOid` sofort auf `response.newHeadOid` und setze `retryCount = 0`, ohne das Repository neu mixen zu müssen.
   - Bei `status === "PREFLIGHT_FAILED"` und aktiviertem Auto-Pilot injiziere automatisch einen strukturierten `#solve`-Korrektur-Prompt mit der aggregierten `errors: LinterError[]`-Liste (maximal `retryCount < 3`, danach automatischer Stopp und User-Hinweis).
7. **Build-Pipeline (`packages/userscript-hud/scripts/build-userscript.mjs`):**
   - Bündelt TypeScript-Quellcode (`src/index.ts`) via `esbuild` in ein valides Tampermonkey-Userscript mit allen Grants (`@grant GM_xmlhttpRequest`, `@grant GM_setValue`, etc.).
   - Erzeugt `packages/userscript-hud/dist/gemini-bridge.user.js` und synchronisiert automatisch mit Root `gemini-bridge.user.js`.

