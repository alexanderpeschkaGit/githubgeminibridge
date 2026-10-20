---
trigger: model_decision
description: "Apply this rule whenever working on packages/userscript-hud/ or gemini-bridge.user.js (DOM injection, harvesting, Shadow DOM UI, Tampermonkey grants)."
---

# Tampermonkey Userscript & Shadow-DOM HUD (`packages/userscript-hud/`)

> **Historischer Kontext:** Verbindet die bewährten DOM-Scanner-, Diff-Parser- und `GM_*`-Storage-Mechanismen aus `_v1_backup/gemini-bridge.user.js` mit der neuen React Shadow-DOM HUD-Architektur (Stufe 3 bis 6.3).

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
   - Da `gemini.google.com` und `aistudio.google.com` strikte Content Security Policies (`connect-src`) erzwingen, müssen sämtliche HTTP-Aufrufe zum Cloudflare Worker über `GM_xmlhttpRequest` (bzw. `GM.xmlHttpRequest`) mit `@connect *.workers.dev` erfolgen – niemals über ungekapseltes Browser-`fetch()`.

---

## 2. UI-Kapselung, Trusted-Types-Sicherheit & DOM-Interaktion

1. **Verpflichtendes Shadow DOM (`attachShadow`) & Trusted-Types-Konformität:**
   - Mounte niemals Komponenten oder globale Stylesheets direkt in `document.body` der Host-Seite (Gefahr von CSS-Leaks und Angular/Material-Konflikten in Gemini/AI Studio).
   - Erzeuge einen dedizierten Host-Container `#gemini-edge-hud-root` und mounte die gesamte HUD-UI + Styles innerhalb von `attachShadow({ mode: 'open' })`.
   - **Trusted-Types-Pflicht (`require-trusted-types-for 'script'`):** Da `gemini.google.com` und `aistudio.google.com` strikte Trusted-Types-Policies erzwingen, darf im Userscript niemals ungeschütztes `element.innerHTML = ...` verwendet werden. Nutze ausschließlich sichere DOM-APIs (`document.createElement`, `textContent`, `appendChild`) oder eine gekapselte `trustedTypes.createPolicy`-Brücke. Die Styles und Trusted-Types DOM-Bausteine sind modular in `src/ui/hudStylesAndDom.ts` gekapselt und werden von `src/ui/shadowHud.ts` gesteuert.
2. **DOM-Injector (`src/dom/injector.ts`):**
   - **Kontext-Upload (Multi-Part `.txt`-Chunks):** Konstruiere `File`-Objekte für Multi-Part `repo-mix.part1.txt`, `repo-mix.part2.txt`, … (MIME `text/plain` zur Vermeidung von XML-Parsing-Bugs) via `injectRepoMixParts`, verpacke sie gemeinsam in ein `DataTransfer`-Objekt und dispatche ein synthetisches `ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })` auf das aktive Eingabefeld (`div[contenteditable="true"]` bzw. `textarea`). Gemini / AI Studio erzeugt dadurch saubere Datei-Chips nebeneinander.
   - **Scope-Filter & Chunk-Größe (`includePaths`, `maxChunkChars`):** Im HUD-Drawer (`hudStylesAndDom.ts`) können optional ein kommagetrennter Subpfad-Filter (`src/, packages/edge-worker/`) sowie das Zeichenbudget `maxChunkChars` (Standard: 85.000, unterhalb des 100k-Gemini-Limits) konfiguriert werden, die an `MixRequest` übergeben werden.
   - **Prompt-Text-Injektion:** Nutze `document.execCommand('insertText', false, promptText)` bzw. native `InputEvent`-Dispatches auf dem fokussierten Editor-Element, damit der interne State von Gemini/AI Studio die Eingabe zuverlässig registriert. Siehe auch [REPOMIX_INSTRUCTIONS.md](../../REPOMIX_INSTRUCTIONS.md) als Referenz für Prompt-Leitplanken.
3. **DOM-Harvester (`src/dom/harvester.ts`):**
   - Überwache neu generierte LLM-Antwortblöcke per `MutationObserver` (mit Debounce/Streaming-Completion-Erkennung).
   - Extrahiere sowohl strukturierte V2 `GeminiPatchPayload`-JSON-Codeblöcke als auch klassische `<<<<<<< SEARCH ... >>>>>>> REPLACE`-Blöcke (V1-Fallback aus `_v1_backup/gemini-bridge.user.js` inkl. automatischer Konvertierung in `GeminiPatchPayload`).
4. **Queue-Management & Sequenzieller FIFO Fail-Fast (Stufe 6.3):**
   - **Queue-Header:** `hudStylesAndDom.ts` rendert über der Patch-Kartenliste eine Flex-Leiste mit zwei Aktions-Buttons:
     - `⚡ Apply All (${patchCount})` (`hud-btn-primary`)
     - `🗑️ Clear` (`hud-btn-secondary`)
   - **FIFO-Abarbeitung:** Da neu geerntete Patches per `unshift` an den Anfang gelegt werden, kehrt `handleApplyAllPatches` die Liste chronologisch um (`[...state.harvestedPatches].reverse()`), um die Patches in der Reihenfolge ihrer Erzeugung anzuwenden.
   - **Fail-Fast & Concurrency-Schutz:** Bricht sofort ab, sobald ein Patch fehlschlägt (`PREFLIGHT_FAILED`, `GIT_CONFLICT` oder `ERROR`), damit Folge-Patches nicht auf inkonsistenten Commits aufbauen.
   - **State-Pruning:** Erfolgreich committete oder idempotente Patches (`COMMITTED`, `NO_CHANGES_NEEDED`) werden nach jedem Schritt automatisch aus `state.harvestedPatches` entfernt; bei Fehlern bleiben Queue und OIDs unverändert.
5. **Storage & Secret Guardrail (`src/services/storage.ts`):**
   - Striktes Verbot von GitHub PATs via `sanitizeNoGithubPat` (Hard Guardrail `P1`).
   - Abwärtskompatible V1-Schlüssel via `getStoredValue` / `setStoredValue` (`gemini_bridge_` Fallback).
   - Konfiguration über `loadHudConfig` und `saveHudConfig` (`HudConfig`), inklusive optionalem `targetBranch` für isoliertes Committen auf neue/abweichende Zielbranches.
   - `includeRecentCommits` ist standardmäßig `false` (Checkbox „🕒 Volatile Dateien & Letzte Commits“ bleibt verfügbar). Ein einmaliger Migrationsmarker (`recent_commits_opt_in_migration_v1`) setzt ein legacy gespeichertes `"true"` genau einmal auf `false`; ein späteres explizites Opt-In bleibt danach dauerhaft erhalten. Fehlgeschlagene Migrationen werden geloggt und beim nächsten Laden erneut versucht.
6. **Worker Client & CSP-Bypass (`src/services/workerClient.ts`):**
   - Kapselung aller Worker-Aufrufe über `gmRequestJson` (`GM_xmlhttpRequest` / `GM.xmlHttpRequest` mit `fetch`-Fallback).
   - Endpunkte: `checkWorkerHealth` (`GET /health`), `requestRepoMix` (`POST /api/mix`), `requestWorkerPatch` (`POST /api/patch`), `requestLegacyCommit` (`POST /push`).
7. **Optimistic Concurrency (getrennte Source-/Target-OIDs) & Self-Healing Loop (`src/services/selfHealing.ts`):**
   - Speichere die von `/api/mix` gelieferte 40-stellige Source-`headOid` im HUD-State. Halte den zuletzt bestätigten `targetHeadOid` zusätzlich zum zugehörigen `targetHeadBranch`; Zielbranch-Wechsel invalidieren nur diese Target-OID.
   - Sende für den Source-Branch `expectedHeadOid`; bei einem bekannten abweichenden Zielbranch sende dessen OID separat als `expectedTargetHeadOid`. FIFO-Folgepatches verwenden nach Erfolg oder `NO_CHANGES_NEEDED` die vom Worker gelieferte Target-OID und verändern die Source-OID nicht.
   - Aktualisiere OIDs und entferne Queue-Einträge ausschließlich bei `COMMITTED`/`NO_CHANGES_NEEDED`; `PREFLIGHT_FAILED`, `GIT_CONFLICT` und `ERROR` dürfen weder Source-/Target-OIDs fortschreiben noch erfolgreiche Patches prune’n. Setze bei Commit den Retry-Zähler zurück und zeige Targetbranch sowie Compare-/PR-Link (`pullRequestUrl`) an.
   - Bei `status === "PREFLIGHT_FAILED"` und aktiviertem Auto-Pilot injiziere automatisch einen strukturierten `#solve`-Korrektur-Prompt mit der aggregierten `errors: LinterError[]`-Liste (maximal `retryCount < 3`, danach automatischer Stopp und User-Hinweis).
8. **Build-Pipeline (`packages/userscript-hud/scripts/build-userscript.mjs`):**
   - Bündelt TypeScript-Quellcode (`src/index.ts`) via `esbuild` in ein valides Tampermonkey-Userscript mit allen Grants (`@grant GM_xmlhttpRequest`, `@grant GM_setValue`, etc.).
   - Erzeugt `packages/userscript-hud/dist/gemini-bridge.user.js` und synchronisiert automatisch mit Root `gemini-bridge.user.js`.
