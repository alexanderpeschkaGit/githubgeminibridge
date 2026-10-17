# STAGE_BLUEPRINTS.md – Sub-Agent & Sub-Chat Blaupausen (Stufe 0.5 bis 4)

> **Verwendungszweck:** Enthält die fokussierten, kontext-minimierten Baupläne für alle Stufen.
> **Ausführungs-Standard:** Alle Blaupausen sind für `/delegate` + `/flash` (Single-Action Protocol, keine `&&`/`;`-Verkettung, Logging in `plans/EXECUTION_LOG.md` & `plans/TEST_LOG.md`) optimiert.

---

## STUFE 0.5a: Vorab-Test des bestehenden Systems (Test-Agent / `#flash`)

```markdown
# Aufgabe: Stufe 0.5a – Vorab-Test Bestandsprojekt (`#flash`)

Beachte strikt das `/flash`-Protokoll:
- **Single-Action Protocol:** Führe immer nur exakt EINEN Shell-Befehl pro Schritt aus.
- **Kein Command-Chaining:** Verwende niemals `&&` oder `;` in Shell-Befehlen.
- **Minimaler Kontext:** Lies nur die nötigsten Dateien.

## Schritte
1. Trage in `plans/EXECUTION_LOG.md` einen `START`-Eintrag für `Stufe 0.5a (Test-Agent)` ein.
2. Prüfe in `cf-gemini-git-bridge` die TypeScript-Kompilierung mit `npx tsc --noEmit` (Arbeitsverzeichnis: `cf-gemini-git-bridge`).
3. Prüfe den Live-Health-Endpunkt `https://gemini-git-bridge.sikanda.workers.dev/health`.
4. Führe über den bestehenden Worker (`POST https://gemini-git-bridge.sikanda.workers.dev/graphql`) mit dem `BRIDGE_SECRET` aus `gemini-bridge.user.js` eine rein lesende GraphQL-Testabfrage (`query { viewer { login } }`) aus, um sicherzustellen, dass `BRIDGE_SECRET` und `GITHUB_TOKEN` auf Cloudflare gültig sind.
   *(Wichtig: Gib niemals die Secrets im Klartext im Log aus!)*
5. Schreibe einen übersichtlichen Bericht nach `plans/TEST_LOG.md` mit:
   - `TypeScript Check`: `PASS` / `FAIL`
   - `Live Health Check`: `PASS` / `FAIL`
   - `Live GraphQL Auth & Token Check`: `PASS` / `FAIL` (inkl. GitHub `viewer.login` falls erfolgreich)
   - `GESAMTSTATUS`: `PASS` oder `BLOCKED_NEEDS_USER_INPUT` (falls fehlerhaft/sinnlos weiterzumachen).
6. Aktualisiere `plans/EXECUTION_LOG.md` (`DONE` oder `BLOCKED_NEEDS_USER_INPUT`) und hake bei Erfolg Stufe 0.5a in `plans/STATE.md` ab.
```

---

## STUFE 0.5b: Backup & Monorepo-Merger (Merger-Agent / `#flash`)

```markdown
# Aufgabe: Stufe 0.5b – Backup `_v1_backup/` & Monorepo-Aufbau (`#flash`)

Beachte strikt das `/flash`-Protokoll (Single-Action Protocol, kein `&&` oder `;`).
Voraussetzung: `GESAMTSTATUS: PASS` in `plans/TEST_LOG.md`. Falls dort `BLOCKED_NEEDS_USER_INPUT` steht, brich sofort ab!

## Schritte
1. Trage in `plans/EXECUTION_LOG.md` einen `START`-Eintrag für `Stufe 0.5b (Merger-Agent)` ein.
2. Erstelle das Backup-Verzeichnis `_v1_backup/` und sichere dahinein:
   - `gemini-bridge.user.js`
   - `Gemini-to-GitHub-Bridge.info`
   - `gemini_prompt_instructions.txt`
   - Den Quellcode und die Konfiguration von `cf-gemini-git-bridge/` (`src/`, `package.json`, `tsconfig.json`, `wrangler.jsonc` – **ohne** `node_modules/`).
3. Erstelle `shared/types.ts` exakt nach der Spezifikation in `plans/AGENTS.md` (und ergänze Abwärtskompatibilitäts-Typen aus `cf-gemini-git-bridge/src/types.ts`, damit bestehende Aufrufe weiter funktionieren).
4. Richte `packages/edge-worker/` ein:
   - Übernimm den Worker-Namen `gemini-git-bridge` in `packages/edge-worker/wrangler.jsonc`, damit die bestehenden Cloudflare-Secrets (`GITHUB_TOKEN` / `GITHUB_PAT` und `BRIDGE_SECRET` / `WORKER_SECRET`) nahtlos funktionieren!
   - Portiere `cf-gemini-git-bridge/src/encoding.ts` -> `packages/edge-worker/src/utils/encoding.ts`.
   - Portiere `cf-gemini-git-bridge/src/github.ts` -> `packages/edge-worker/src/utils/github.ts` und ergänze dort bereits `commitSingleFileViaGraphQL` sowie `fetchMultipleFilesViaGraphQL` (Batch-Read via GraphQL Aliases).
   - Portiere `cf-gemini-git-bridge/src/patch.ts` -> `packages/edge-worker/src/modules/patcher.ts` (bewahre zwingend `validateNoPlaceholders`, `parseSearchReplaceBlocks` und `applySearchReplace`!).
5. Lege das Grundgerüst für `packages/userscript-hud/` an und hinterlege die extrahierten DOM-/Storage-Helfer aus `gemini-bridge.user.js` als Referenz.
6. Prüfe mit dem Test-Protokoll (`tsc --noEmit`), ob alle portierten Dateien fehlerfrei typisiert sind, dokumentiere das Ergebnis in `plans/TEST_LOG.md` und `plans/EXECUTION_LOG.md` und markiere Stufe 0.5b in `plans/STATE.md` als abgeschlossen.
```

---

## STUFE 1: Cloudflare Worker – Hauptorchestrator & Repo-Mixer (`#delegate #flash`)

- **Voraussetzung:** Stufe 0.5b & 0.6 abgeschlossen (`packages/edge-worker/src/utils/github.ts`, `shared/types.ts` und `.agents/rules/edge-worker-architecture.md` liegen bereit).
- **Pflicht-Lektüre vorab:** `agents.md` (Root) und `.agents/rules/edge-worker-architecture.md`.
- **Aufgabe:**
  1. Implementiere `packages/edge-worker/src/modules/mixer.ts`:
     - 1-Subrequest Tarball-Stream (`GET https://api.github.com/repos/{owner}/{repo}/tarball/{branch}`).
     - Extraktion der 40-stelligen `headOid` primär aus dem **PAX Global Extended Header** (`typeflag === 'g'`, `comment=<40-char-sha>`), Root-Ordnername als Fallback.
     - 512-Byte-TAR-Stream-Parser mit USTAR `prefix` und PAX `path=...` Unterstützung.
     - Header-Level RAM-Filter gemäß `.agents/rules/edge-worker-architecture.md` (überspringt `.git/`, `node_modules/`, `dist/`, `build/`, `_v1_backup/`, Lockfiles, Binärdateien und Dateien > 512 KB direkt im Stream ohne String-Allokation).
     - XML-Generierung (`<repository><file_tree>...<files><file path="..."><![CDATA[...]]></file></files></repository>`) mit sicherem `]]>`-Escaping und Token-Schätzung.
     - Optionale Persistierung via `commitSingleFileViaGraphQL` aus `src/utils/github.ts`.
  2. Verbinde in `packages/edge-worker/src/index.ts` die Route `POST /api/mix`, den Health-Check `GET /health` und die Auth-Prüfung (unterstützt sowohl `WORKER_SECRET` als auch `BRIDGE_SECRET` sowie `GITHUB_PAT` / `GITHUB_TOKEN`).
  3. Validiere mit `npx tsc --noEmit` (in `packages/edge-worker`) sowie `node scripts/patches_and_tests/worker-smoke.mjs`. Dokumentiere das Ergebnis in `plans/TEST_LOG.md` und den Checkpoint in `plans/EXECUTION_LOG.md`.

---

## STUFE 2: In-Memory Patcher & GraphQL Batch-Writer (`#delegate #solve #flash`)

- **Voraussetzung:** Stufe 1 abgeschlossen; `packages/edge-worker/src/modules/patcher.ts` enthält bereits die portierte Search/Replace-Logik und `validateNoPlaceholders` aus dem Bestandsprojekt.
- **Pflicht-Lektüre vorab:** `agents.md` (Root) und `.agents/rules/edge-worker-architecture.md`.
- **Aufgabe:**
  1. Erweitere `packages/edge-worker/src/modules/patcher.ts` um die vollständige `POST /api/patch`-Pipeline:
     - Nutzt `fetchMultipleFilesViaGraphQL` aus `src/utils/github.ts` (1-Subrequest Batch-Read via GraphQL Aliases).
     - Wendet `applySearchReplace` (Exakt -> CRLF/LF -> Trimmed Lines) und `validateNoPlaceholders` an.
     - **Kein Fail-Fast:** Sammelt fehlgeschlagene Search-Blöcke oder getriggerte Placeholder-Guardrails als strukturierte `LinterError`-Einträge (`stage: "SEARCH_REPLACE"` bzw. `"CUSTOM_RULE"`).
     - Prüft auf Idempotenz (`status: "NO_CHANGES_NEEDED"`) und fängt `expectedHeadOid`-Konflikte als `status: "GIT_CONFLICT"` ab.
  2. Stelle in `packages/edge-worker/src/index.ts` sicher, dass sowohl `POST /api/patch` (neues Protokoll) als auch die Bestands-Routen `POST /push` und `POST /commit` (V1-Kompatibilität) funktionieren.
  3. Validiere mit `npx tsc --noEmit` und `node scripts/patches_and_tests/worker-smoke.mjs`, dokumentiere das Resultat in `plans/TEST_LOG.md` und `plans/EXECUTION_LOG.md`.

---

## STUFE 3: Tampermonkey Shadow-DOM HUD (`#delegate #solve #flash` – Arbeitspaket 4 & 5)

- **Voraussetzung:** Stufe 1 & 2 geplant (`shared/types.ts` und `.agents/rules/userscript-shadow-hud.md` liegen bereit; durch disjunkte Pakete auch parallel zu Worker-Stufen ausführbar).
- **Pflicht-Lektüre vorab:** `agents.md` (Root) und `.agents/rules/userscript-shadow-hud.md`.
- **Arbeitspaket 4 (HUD Core, Storage, `GM_xmlhttpRequest` Client & Bundler | Complexity: `5/10` | `Model: 'flash'`):**
  1. Erweitere `packages/userscript-hud/package.json` & `packages/userscript-hud/tsconfig.json` sowie das deterministische Build-Skript `packages/userscript-hud/scripts/build-userscript.mjs` (erzeugt `packages/userscript-hud/dist/gemini-bridge.user.js` + Root-Kopie `gemini-bridge.user.js` inkl. vollständigem Tampermonkey-Header für `https://gemini.google.com/*` und `https://aistudio.google.com/*`).
  2. Implementiere `packages/userscript-hud/src/types.ts` (Re-Export aus `../../../shared/types` + `HudConfig`, `HudState`, `HarvestedPatchBlock`).
  3. Implementiere `packages/userscript-hud/src/services/storage.ts` (`GM_getValue`/`GM_setValue` mit `localStorage`-Fallback, V1-Default-Migration `owner_repo`/`branch` sowie striktem `sanitizeNoGithubPat`-Guardrail: niemals `GITHUB_PAT` im Browser speichern!).
  4. Implementiere `packages/userscript-hud/src/services/workerClient.ts` (CSP-Bypass ausschließlich über `GM_xmlhttpRequest` mit `Authorization: Bearer <secret>` + `x-bridge-secret` für `GET /health`, `POST /api/mix`, `POST /api/patch` und Legacy-Fallback `POST /push`).
- **Arbeitspaket 5 (Trusted-Types Shadow-DOM UI, DOM-Injector & DOM-Harvester | Complexity: `6/10` | `Model: 'flash'`):**
  1. Implementiere `packages/userscript-hud/src/dom/injector.ts`:
     - Synthetischer File-Paste von `repo-mix.xml` via `new File([xmlContent], 'repo-mix.xml', { type: 'text/xml' })` + `DataTransfer` + `ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })` auf dem aktiven Prompt-Editor von Gemini / AI Studio.
     - Prompt-Text-Injektion via `execCommand('insertText')` / `InputEvent` + optionalem Auto-Submit.
  2. Implementiere `packages/userscript-hud/src/dom/harvester.ts`:
     - `MutationObserver` für abgeschlossene Codeblöcke; erkennt sowohl V2 `GeminiPatchPayload`-JSON als auch V1 `<<<<<<< SEARCH ... >>>>>>> REPLACE`-Blöcke (automatische Konvertierung in `GeminiPatchPayload`).
  3. Implementiere `packages/userscript-hud/src/ui/shadowHud.ts` & `packages/userscript-hud/src/index.ts`:
     - Kapselt die gesamte UI in `#gemini-edge-hud-root` -> `attachShadow({ mode: 'open' })` **100 % Trusted-Types-konform** (keine ungeschützten `innerHTML`-Zuweisungen!).
     - Baut `gemini-bridge.user.js` und verifiziert den Build über `worker-smoke.mjs`.

---

## STUFE 4: Pre-Flight Linter (`linter.ts`) & Self-Healing Loop (`#delegate #solve #flash` – Arbeitspaket 6 & 7)

- **Voraussetzung:** Stufe 2 (`PreflightLinterHook` in `patcher.ts`) und Stufe 3 (`userscript-hud`) geplant/bereit.
- **Pflicht-Lektüre vorab:** `agents.md` (Root), `.agents/rules/edge-worker-architecture.md` und `.agents/rules/userscript-shadow-hud.md`.
- **Arbeitspaket 6 (Untertool C `linter.ts` – AST/Syntax-Prüfung & Custom Rules ohne Fail-Fast | Complexity: `6/10` | `Model: 'flash'`):**
  1. Implementiere `packages/edge-worker/src/modules/linter.ts`:
     - Exportiert `runPreflightLinter(files, preflight)` kompatibel zu `PreflightLinterHook`.
     - **AST-/Syntax-Check (`stage: "OXC_SYNTAX"`):** Prüft alle geänderten `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`-Dateien im RAM (unterstützt `oxc-parser` WASM + deterministischen Worker-AST/Delimiter/String/JSON-Syntax-Verifier mit exakter `line`, `column` und `codeSnippet`).
     - **Custom Rules (`stage: "CUSTOM_RULE"`):** Prüft `validateNoPlaceholders`, `preflight.forbidPatterns` (RegExp mit Zeilen-/Spaltenberechnung) und `preflight.requireExports` (Symbol-Export-Nachweis).
     - **Non-Fail-Fast (`P1` Komponente 4):** Sammelt sämtliche Fehler über alle geänderten Dateien hinweg im Array `errors: LinterError[]` und bindet `runPreflightLinter` als Standard-Hook in `patcher.ts` (`handlePatchRequest`) ein.
- **Arbeitspaket 7 (Self-Healing Auto-Retry Loop im HUD & End-to-End Smoke-Probes 8–9 | Complexity: `4/10` | `Model: 'flash'`):**
  1. Implementiere `packages/userscript-hud/src/services/selfHealing.ts` und binde es in `shadowHud.ts` ein:
     - Erzeugt bei `status === "PREFLIGHT_FAILED"` aus `errors: LinterError[]` einen kompakten `#solve`-Korrektur-Prompt mit Datei, Zeile, Spalte, Fehlermeldung und Snippet.
     - Führt bei aktiviertem Auto-Pilot bis zu `retryCount < 3` automatische Korrektur-Turns aus und setzt `retryCount = 0` bei `status === "COMMITTED"` zurück.
  2. Erweitere `scripts/patches_and_tests/worker-smoke.mjs` um **Probe 8 (`linter.ts` Syntax & Custom Rules Aggregation)** und **Probe 9 (`userscript-hud` Bundle, Trusted-Types Shadow-DOM & Self-Healing Loop)** und führe den vollständigen End-to-End-Verifikationslauf (`tsc --noEmit` + `worker-smoke.mjs` `9/9 PASS`) durch.


