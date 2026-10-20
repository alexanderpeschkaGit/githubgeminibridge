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
   - **Content-derived Patch-Identität (`src/services/patchIdentity.ts`):** `createStablePatchId(mode, payload)` hasht `mode + commitMessage + canonicalize(payload.patches)` (rekursiv sortierte Objekt-Keys, damit JSON-Key-Reihenfolge die Identität nicht verändert) per djb2 zu `patch-<hash36>`. Zeit-/Zufalls-IDs (`Date.now()`, `Math.random()`) sind im Harvester verboten, weil sie dieselbe Payload nie wiedererkennen. Die Canvas-Karten-ID (`canvas-<timestamp>`) bleibt davon unberührt, da sie nie in die Queue gelangt.
   - **Single-Emission-Garantie:** `onPatchHarvested(...)` wird **erst nach** dem tatsächlichen `appendChild` des `.ggb-inline-btn` aufgerufen. Button- und Header-Suche sind auf den aktuellen Block gescoppt (`pre.closest('code-block') || pre.parentElement || pre`); Header werden über `Array.from(scope.querySelectorAll('.code-block-decoration, .code-header, [class*="header"]')).find((el) => !pre.contains(el))` ermittelt, damit kein fremder Codeblock-Header im selben Container beansprucht wird. Existiert im Scope bereits ein `.ggb-inline-btn`, kehrt der Harvester **vor** der Emission zurück. Re-Renders, doppelte DOM-Knoten und wiederholte `scanDOM()`-Läufe erzeugen daher weder einen zweiten Button noch einen zweiten Queue-Eintrag.
4. **Queue-Management & Sequenzieller FIFO Fail-Fast (Stufe 6.3):**
   - **Queue-Header:** `hudStylesAndDom.ts` rendert über der Patch-Kartenliste eine Flex-Leiste mit zwei Aktions-Buttons:
     - `⚡ Apply All (${patchCount})` (`hud-btn-primary`)
     - `🗑️ Clear` (`hud-btn-secondary`)
   - **FIFO-Abarbeitung:** Da neu geerntete Patches per `unshift` an den Anfang gelegt werden, liefert `fifoQueue()` (`src/services/patchQueue.ts`) die Liste chronologisch umgekehrt zurück, damit `runPatchQueue()` die Patches in der Reihenfolge ihrer Erzeugung anwendet.
   - **Fail-Fast & Concurrency-Schutz:** `runPatchQueue()` bricht sofort ab, sobald ein Patch fehlschlägt (`PREFLIGHT_FAILED`, `GIT_CONFLICT` oder `ERROR`) und meldet `{ applied, total }`, damit Folge-Patches nicht auf inkonsistenten Commits aufbauen.
   - **State-Pruning:** Erfolgreich committete oder idempotente Patches (`COMMITTED`, `NO_CHANGES_NEEDED`) werden über `removeHarvestedPatch()` nach jedem Schritt automatisch aus `state.harvestedPatches` entfernt; bei Fehlern bleiben Queue und OIDs unverändert.
   - **Defensive Dedupe bei der Aufnahme:** `enqueueHarvestedPatch()` (in `src/services/patchQueue.ts`, aufgerufen von `addHarvestedPatch` in `shadowHud.ts`) verwirft einen Patch, wenn `isDuplicatePatch()` bereits einen Eintrag mit gleicher `id` **oder** gleicher `computePatchSignature(mode, payload)` findet, und deckelt die Queue auf `MAX_QUEUED_PATCHES = 20`. Damit kann selbst ein extern eingespeister oder erneut geharvesteter Payload `⚡ Apply All` nicht doppelt ausführen.
   - **Kompakte Panel-Form & Queue-Höhe:** Die Config-Felder sind über `.hud-form-grid` in zwei Spalten angeordnet (Branch | Target Branch, Include Paths | Max Chunk Chars, Worker Secret | Head OID); `.hud-patch-queue` besitzt eine `min-height` (76px), damit geerntete Patches — Dateipfad als Titel, `commitMessage` als Unterzeile — dauerhaft lesbar bleiben. Deaktivierte Buttons (`.hud-btn:disabled`) sind ausgegraut.
5. **Storage & Secret Guardrail (`src/services/storage.ts`):**
   - Striktes Verbot von GitHub PATs via `sanitizeNoGithubPat` (Hard Guardrail `P1`).
   - Abwärtskompatible V1-Schlüssel via `getStoredValue` / `setStoredValue` (`gemini_bridge_` Fallback).
   - Konfiguration über `loadHudConfig` und `saveHudConfig` (`HudConfig`), inklusive optionalem `targetBranch` für isoliertes Committen auf neue/abweichende Zielbranches.
   - `includeRecentCommits` ist standardmäßig `false` (Checkbox „🕒 Volatile Dateien & Letzte Commits“ bleibt verfügbar). Ein einmaliger Migrationsmarker (`recent_commits_opt_in_migration_v1`) setzt ein legacy gespeichertes `"true"` genau einmal auf `false`; ein späteres explizites Opt-In bleibt danach dauerhaft erhalten. Fehlgeschlagene Migrationen werden geloggt und beim nächsten Laden erneut versucht.
6. **Worker Client & CSP-Bypass (`src/services/workerClient.ts`):**
   - Kapselung aller Worker-Aufrufe über `gmRequestJson` (`GM_xmlhttpRequest` / `GM.xmlHttpRequest` mit `fetch`-Fallback).
   - Endpunkte: `checkWorkerHealth` (`GET /health`), `requestRepoMix` (`POST /api/mix`), `requestWorkerPatch` (`POST /api/patch`), `requestLegacyCommit` (`POST /push`).
   - **Kein stiller Legacy-Fallback:** `handleApplyPatch` committet ausschließlich über `POST /api/patch`. Ohne gültige Snapshot-OID (`state.headOid` leer) bricht der Vorgang mit dem Hinweis „`Load Repo Mix` first“ ab, statt ungeprüft über `/push` (ohne `expectedHeadOid`) zu committen. `requestLegacyCommit` bleibt nur als V1-Paritäts-API von `workerClient.ts` erhalten.
7. **Optimistic Concurrency (getrennte Source-/Target-OIDs) & Self-Healing Loop (`src/services/selfHealing.ts`):**
   - Speichere die von `/api/mix` gelieferte 40-stellige Source-`headOid` im HUD-State. Halte den zuletzt bestätigten `targetHeadOid` zusätzlich zum zugehörigen `targetHeadBranch`; Zielbranch-Wechsel invalidieren nur diese Target-OID.
   - **Repo-/Branch-Scope (Pflicht, `src/services/patchOidStore.ts` + `buildOidScope`):** Eine Snapshot-OID ist nur für genau den `repo#branch` gültig, aus dem sie gemixt wurde. Persistiert werden `head_oid` + `head_oid_scope` (und Zielbranch-gebunden `target_head_oid`/`target_head_branch`); `loadPatchOidState()` verwirft beim Start jede OID mit fremdem Scope (Repo-/Branch-Wechsel, Legacy-Einträge ohne Scope-Marker, malformed OIDs). Das Ändern von Repo/Branch im HUD ruft `resetPatchOidState()` auf (State-Reset + Hinweis „Load Repo Mix“). Ohne diesen Scope sendete das HUD nach einem Repo-Wechsel die OID des *anderen* Repos als `expectedHeadOid` und der Worker antwortete korrekt, aber für den User unerklärlich, mit `GIT_CONFLICT`.
   - Sende für den Source-Branch `expectedHeadOid`; bei einem bekannten abweichenden Zielbranch sende dessen OID separat als `expectedTargetHeadOid`. FIFO-Folgepatches verwenden nach Erfolg oder `NO_CHANGES_NEEDED` die vom Worker gelieferte Target-OID und verändern die Source-OID nicht.
   - Aktualisiere OIDs und entferne Queue-Einträge ausschließlich bei `COMMITTED`/`NO_CHANGES_NEEDED`; `PREFLIGHT_FAILED`, `GIT_CONFLICT` und `ERROR` dürfen weder Source-/Target-OIDs fortschreiben noch erfolgreiche Patches prune’n. Ein `GIT_CONFLICT` bedeutet immer „Snapshot veraltet“ (Branch wurde extern bewegt oder Config gewechselt) und verlangt einen neuen Repo-Mix; die Statuszeile nennt den validierten Scope `repo@branch`. Ohne Snapshot-OID wird **nie** committet (kein `/push`-Fallback). Setze bei Commit den Retry-Zähler zurück und zeige Targetbranch sowie Compare-/PR-Link (`pullRequestUrl`) an.
   - **Konflikt-Selbstheilung (`resolveConflictOidReset`):** Ein `GIT_CONFLICT` muss den Token verwerfen, der den Concurrency-Check verloren hat — sonst replayt jeder Retry denselben falschen Wert. Klassifikation aus dem bestehenden Response-Vertrag: Antwort **ohne** `targetBranch` ⇒ Source-Konflikt (`clearPatchOidState`, Statuszeile „Load Repo Mix“), **mit** `targetBranch` ⇒ Target-Race (`clearTargetOidState`, nur Target-Token weg). Eine noch intakte Mix-OID darf ein Target-Race nicht mitreißen.
   - **Diagnose der laufenden Version:** Der HUD-Titel zeigt `⚡ Cloudflare Edge HUD v${GM_info.script.version}`. Damit ist eine veraltete Tampermonkey-Installation (häufigste Ursache für wiederkehrende `GIT_CONFLICT`-Meldungen nach einem Fix) direkt sichtbar, statt aus dem Verhalten geraten werden zu müssen.
   - Bei `status === "PREFLIGHT_FAILED"` und aktiviertem Auto-Pilot injiziere automatisch einen strukturierten `#solve`-Korrektur-Prompt mit der aggregierten `errors: LinterError[]`-Liste (maximal `retryCount < 3`, danach automatischer Stopp und User-Hinweis).
8. **Build-Pipeline (`packages/userscript-hud/scripts/build-userscript.mjs`):**
   - Bündelt TypeScript-Quellcode (`src/index.ts`) via `esbuild` in ein valides Tampermonkey-Userscript mit allen Grants (`@grant GM_xmlhttpRequest`, `@grant GM_setValue`, etc.).
   - Erzeugt `packages/userscript-hud/dist/gemini-bridge.user.js` und synchronisiert automatisch mit Root `gemini-bridge.user.js`.
