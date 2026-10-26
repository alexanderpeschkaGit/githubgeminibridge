# 11 — Hardening Precision Plan (reviewed & adjusted)

```text
PLAN_ID:      plan-20261026173200-rv11
STATUS:       REVIEWED / READY FOR #exec
BASE_SHA:     8f31a98
TIER:         FLASH (with two MED-HIGH sub-steps)
SCOPE:        edge-worker, userscript-hud, local-cli, scripts, .agents docs
REVIEWED_AT:  2026-10-26
```

Dieses Dokument ist die **korrigierte Fassung** des eingereichten 4-Batch-Plans. Es übernimmt alle
sinnvollen Punkte, korrigiert aber die Stellen, an denen der Plan vom Ist-Code abweicht oder eine
Änderung als „Präzisierung" deklariert, die tatsächlich ein Verhaltenswechsel ist.

---

## 0. Review-Ergebnis gegen den Ist-Code

| # | Plan-Aussage | Ist-Code | Bewertung / Anpassung |
| :-- | :--- | :--- | :--- |
| 1 | Webhook-Auth fail-closed „nur blockieren, wenn `author_association` vorhanden und nicht in {OWNER,MEMBER,COLLABORATOR}" | `packages/edge-worker/src/modules/webhookHandler.ts:317-328` implementiert exakt das (`if (authorAssociation) { ... }`). | **Kein Code-Change nötig.** Nur die im Plan geforderten 5 Testfälle fehlen (`scripts/patches_and_tests/test-webhook-worker.mjs`, aktuell 10 Tests, 196 Zeilen). |
| 2 | `contextText` aus allen `mixResult.parts` | `webhookHandler.ts:172-174` fällt bereits auf `parts[].xmlContent` zurück, bevorzugt aber `xmlContent`. | **Optional.** Empfehlung: `parts.length > 0 ? join(parts) : xmlContent`, damit Chunking deterministisch Vorrang hat. Kein Risiko, aber testbar nur über Refactor (Funktion exportieren). |
| 3 | V1 `/push` + `/commit` geben bei Client-Validierungsfehlern 400 statt 500 | `packages/edge-worker/src/index.ts:255-259` fängt **jeden** Fehler und gibt 500 zurück; auch `throw new Error('Malformed JSON payload')` (`index.ts:126-128`) und `findRepoPathIssue`/`resolveFileContent` (`index.ts:169-197`) landen dort. | **Echter Verhaltenswechsel, höchste Priorität in Batch 1.** Explizite `ClientValidationError`-Klasse einführen und getrennt behandeln. |
| 4 | `skippedFiles` nur für Ausnahmen (`too_large`, `over_hard_limit`, `would_exceed_parts`) | `mixerTarScan.ts:300-309` pusht `'ignored'` für `GENERATED_BUNDLE`, `IGNORED_PATH`, `DIR_OR_NON_FILE`, `NOT_INCLUDED`. `mixChunker.ts:191-206` pusht `over_hard_limit` und **wirft danach**; `would_exceed_parts` (`mixChunker.ts:92,175`) wird **nie** gepusht — Part-Overflow wirft (`mixChunker.ts:368-374`). | **Präzisieren:** Routine-Filter-Pushes entfernen. Für `over_hard_limit`/`would_exceed_parts` entscheiden: entweder aus der Union streichen (weil sie nur als Throw existieren) **oder** in die `ERROR`-Antwort heben. Nicht beides halb. |
| 5 | `search: ""` ablehnen + mehrere `modify`-Ops derselben Datei sequenziell verketten | `patchInMemory.ts:197-281`: kein Leer-Check; jede `modify`-Op liest `existingFiles[op.path]` (`:215`) und schreibt nie in einen gemeinsamen Puffer; `additions` kann pro Pfad mehrfach entstehen. | **Korrekt und notwendig.** `workingFiles`-Map + Guard vor `isInsertStyleBlockApplied` + genau **ein** `additions`-Eintrag pro Pfad am Ende. |
| 6 | JSX-Scanner: `>` und `\n` aus `regexPreceders` entfernen; Kontraktionen auf `[A-Za-z0-9]` | `syntaxScanner.ts:234`: `regexPreceders = '=([{:;,?!&|+-*^~<>%\n'` enthält **beides**. Kontraktion prüft `:246` nur `[A-Za-z]` links/rechts → `1990's` schlägt fehl. | **Korrekt.** `>` und `\n` entfernen, Kontraktion beidseitig auf `[A-Za-z0-9]` erweitern; `</tag`-Vorrang (`:231-233`) bleibt. Test um `1990's` und Regex nach `>` erweitern. |
| 7 | `workerClient.ts` löst V2-Fehlerobjekte auch bei HTTP 400 auf | `workerClient.ts:49-51, 84, 110` verwerfen den Body und werfen `new Error(msg)` in allen drei Transports (GM_xmlhttpRequest, GM.xmlHttpRequest, fetch). | **Korrekt, aber Transport-spezifisch:** alle drei Pfade angleichen, nur bei erkannter V2-Struktur (`status`/`errors`/`errorMessage`) auflösen, sonst weiter werfen. |
| 8 | `hudApplyPatch.ts`: Foreign-Owner-Guard vor `resolvePatchPaths` + `PATCHING` | `hudApplyPatch.ts:47-71` promptet und setzt `PATCHING`, Guard erst `:73-82`. | **Bestätigt.** Guard + `classifyRepoOwner` + ggf. `loadHudConfig` vor Zeile 47 ziehen. |
| 9 | `hudConfigBindings.ts` normalisiert `config.repo` über `sanitizeRepo` | `hudConfigBindings.ts:21-24` nutzt `sanitizeNoGithubPat(..., 'repo')`; `sanitizeRepo` existiert (`services/storage.ts:45`) und wird beim Laden gesetzt (`storage.ts:166`). | **Teilweise korrekt.** Beim `onchange` zusätzlich `sanitizeRepo` anwenden; kein neuer Helper nötig. |
| 10 | Probe 10 normalisiert „In-Memory-esbuild-Build" und `dist/*.mjs` gegen CRLF | `worker-smoke.mjs:381-397` vergleicht **`packages/userscript-hud/dist/gemini-bridge.user.js`** mit Root-`gemini-bridge.user.js` per `Buffer.equals`. Es gibt in Probe 10 **keinen** esbuild-Build und **kein** `dist/*.mjs`. | **Faktisch falsch im Plan.** CRLF-Fix gehört auf den HUD-Bundle-Vergleich: beide Dateien als UTF-8 lesen, `\r\n → \n`, dann String-Vergleich. Byte-Identität wird dadurch bewusst aufgegeben (Kommentar im Probe-Text). |
| 11 | Registry-Umzug nach `.tmp/plan-registry.json`, `.tmp/` sei bereits ignoriert | `scripts/plan-registry.mjs:9` nutzt `plans/PLAN_REGISTRY.json`; `plans/PLAN_REGISTRY.json` ist **getrackt** (`git ls-files` bestätigt, Inhalt `{}`); `.gitignore:60` ist `*.tmp` und matcht das Verzeichnis (via `git check-ignore` bestätigt). | **Korrekt, aber `.tmp/` explizit ergänzen** (klarer als der `*.tmp`-Zufallstreffer). |
| 12 | `localRunner.ts` gehört zu Batch 4 | `packages/local-cli/src/localRunner.ts` enthält **keine** Registry-Referenz. | **Aus dem Inventar streichen**, außer es gibt einen konkreten Grund (dann im Plan benennen). |
| 13 | Skill-/Regel-Sync für `plan`, `exec`, `exec-wave`, `delegate`, `solve`, `edge-worker-architecture.md`, `agents.md` | Registry-Referenzen existieren nur in `plan/SKILL.md:13`, `exec/SKILL.md:10,44`, `exec-wave/SKILL.md:18`. `delegate`, `solve`, `edge-worker-architecture.md`, `agents.md` enthalten keine. | **Reduzieren auf die 3 Skills mit echten Referenzen.** Doku in `edge-worker-architecture.md`/`agents.md` nur anpassen, wenn Batch 1/2-Verhalten dort beschrieben ist. |
| 14 | Verifikationsschritt `npm --prefix packages/userscript-hud run release:patch` | Script existiert, **bumpt aber die HUD-Version** und schreibt `package.json` + beide Bundles. | **Für reine Verifikation `run build` verwenden.** `release:patch` nur, wenn der Versionsbump Teil des Vorhabens ist. |
| 15 | `worker-smoke.mjs` als Schritt 8 | Läuft `run-regressions` bereits optional via `--include-smoke`; Probe 5 fragt den **Live-Worker** `/health` ab. | Netzwerkabhängigkeit im Plan kennzeichnen; offline nur `run-regressions` (Batch-Suiten) ausführen. |

---

## 1. Adjustierte Batches

### Batch 1 — Webhook-Tests + V1-Fehlerklassifikation (Komplexität 4/10, FLASH)

**1.1 Testabdeckung `author_association` (kein Produktionscode)**
Datei: `scripts/patches_and_tests/test-webhook-worker.mjs`

- Signierten Payload-Helper extrahieren, damit 5 Fälle kurz bleiben.
- Fälle:
  - `comment.author_association` **fehlt** → `200` + `IGNORED`? Nein: fehlt = **durchlassen** → `202` (bzw. `200`, wenn kein `@gemini`). Mit `@gemini` und ohne `ctx.waitUntil` → `202`, Hintergrund-Promise via `.catch(() => {})` entschärfen.
  - `'NONE'`, `'FIRST_TIMER'`, `'CONTRIBUTOR'` → `200` + `status: 'IGNORED'` + `message` enthält `association`.
  - `'OWNER'` → `202` + `ACCEPTED`.
- **Wichtig:** die Background-Workflow-Promises nicht unhandled lassen (`executeWorkerWorkflow` ruft echtes GitHub/Gemini-Fetch). Im Test entweder `ctx.waitUntil(p => p.catch(() => {}))` oder `GITHUB_TOKEN` leer lassen, damit der Workflow sofort mit `ERROR` zurückkehrt.

**1.2 `contextText`-Vorrang (optional, empfohlen)**
Datei: `packages/edge-worker/src/modules/webhookHandler.ts:172-174`

```ts
const contextText =
  Array.isArray(mixResult.parts) && mixResult.parts.length > 0
    ? mixResult.parts.map((p) => p.xmlContent || '').join('\n\n')
    : (mixResult.xmlContent || '');
```

**1.3 V1-Statuscodes (Kernänderung)**
Datei: `packages/edge-worker/src/index.ts`

- Lokale Klasse `ClientValidationError extends Error` (nicht exportieren, kein Shared-Change).
- Als Client-Fehler (→ `400`) werfen:
  - Malformed JSON in `/push`/`/commit` (`index.ts:126-128`)
  - `parseRepoOwner`-Fehler (`:132-138`)
  - fehlende `commitMessage` (`:140-143`)
  - leere `changes`/`deletions` (`:149-151`)
  - `findRepoPathIssue` bei Changes und Deletions (`:170-172`, `:192-194`)
  - `resolveFileContent`-Validierungsfehler (nur bekannte Validierung, nicht GitHub-IO)
- Alles andere (GraphQL/Netzwerk/Commit) bleibt `500` mit `console.error`.
- Struktur: inneren `try { ... } catch (err) { if (err instanceof ClientValidationError) return errorResponse(err.message, 400); throw err; }` oder den äußeren Catch um eine `instanceof`-Verzweigung ergänzen.
- Kein `shared/hybridTypes.ts`-Change nötig (der Plan listet die Datei, es gibt dort aber keine Statuscode-Typen).

**Akzeptanz:** bestehende 10 Webhook-Tests grün + 5 neue; `/push` mit kaputtem Repo-Pfad liefert 400, unbekannter Commit-Fehler weiter 500.

---

### Batch 2 — RepoMix-Skip-Präzision, Patch-Verkettung, JSX-Scanner (Komplexität 7/10, FLASH)

**2.1 `skippedFiles`-Präzision**
Dateien: `packages/edge-worker/src/modules/mixerTarScan.ts`, `packages/edge-worker/src/modules/mixChunker.ts`, `shared/types.ts`

- `mixerTarScan.ts:303-309`: die drei `'ignored'`-Pushes entfernen (GENERATED_BUNDLE, IGNORED_PATH/DIR_OR_NON_FILE, NOT_INCLUDED). `too_large` (`:300-302`) bleibt.
- `mixChunker.ts:175,191-195`: **Entscheidung nötig** (siehe Offene Entscheidungen A). Empfehlung: `over_hard_limit`/`would_exceed_parts` aus der Union entfernen und die bestehenden Throws als Fehlerantwort belassen — dann ist `SkippedFile.reason` ehrlich `'too_large'` (plus ggf. künftige echte Ausnahmen).
- `shared/types.ts:41-46`: Union entsprechend verengen; `packages/userscript-hud/src/services/workerClient.ts:10` re-exportiert nur, HUD-Anzeige (`hudMixAction.ts:35-38,60-63`) bleibt funktionsfähig (sie zählt nur).
- `mixer.ts:168-193` aggregiert weiterhin `scan.skippedFiles` + `mixResult.skippedFiles` — nach der Änderung enthält das nur noch echte Ausnahmen.

**2.2 `patchInMemory.ts` — Guardrails + Verkettung**
Datei: `packages/edge-worker/src/modules/patchInMemory.ts`

- `workingFiles: Record<string, string | null> = { ...existingFiles }` am Funktionsanfang.
- `modify`/`delete`/`create` lesen und schreiben **nur** `workingFiles`.
- Leerer/invalider `search`:
  - `block.search` muss `typeof 'string'` sein und nach `trim()` nicht leer → sonst `SEARCH_REPLACE`-Fehler, **vor** `isInsertStyleBlockApplied`.
  - `block.replace` muss String sein (kein `undefined`).
- Pro Datei maximal **ein** `additions`-Eintrag: Zwischenpuffer sammeln (`pendingAdditions: Map<path, content>`), am Ende gegen `existingFiles[path]` vergleichen.
- `resultingFiles` ebenfalls pro Pfad deduplizieren (Map), damit der Preflight-Hook jede Datei genau einmal sieht.
- Platzhalter-/Final-Check auf dem **finalen** Puffer.
- `hasEffectiveChanges` nur setzen, wenn finaler Puffer ≠ Basis.
- `create` auf existierender Datei: aktuell Overwrite ohne Fehler; Verhalten beibehalten (kein Scope-Creep), aber `workingFiles` aktualisieren.

**2.3 `test-patch-idempotence.mjs`**
Datei: `scripts/patches_and_tests/test-patch-idempotence.mjs`

- Neuer Fall: zwei `modify`-Ops auf derselben Datei in einem `applyPatchesInMemory`-Aufruf, zweiter Block ankert auf Text, den der erste erzeugt.
- Neuer Fall: `search: ''` → `errors.length > 0`, `hasEffectiveChanges === false`.
- Neuer Fall: drei Ops auf derselben Datei → `additions.length === 1`, Inhalt enthält alle drei Änderungen.
- Bestehende Idempotenz-Fälle unverändert grün.

**2.4 JSX-Scanner**
Datei: `packages/edge-worker/src/modules/syntaxScanner.ts:234-249`

- `regexPreceders` ohne `>` und ohne `\n`: `'=([{:;,?!&|+-*^~%'`.
- Kontraktion: `/[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(nextCh)`.
- `scripts/patches_and_tests/test-jsx-syntax-scan.mjs` erweitern:
  - `export const A = () => <p>In the 1990's it's fine</p>;`
  - Regex nach `>`: `const ok = a > /x/.test(s);` (kein False-Positive)
  - `const r = /a\/b/;` bleibt fehlerfrei
  - Bestehende Defekt-Fälle bleiben rot.

**Akzeptanz:** `mixChunker.ts` bleibt < 460 Zeilen (aktuell 443), `patchInMemory.ts` < 500 (aktuell 318).

---

### Batch 3 — HUD-Fehlerobjekte, Guard-Reihenfolge, Repo-Kanonisierung (Komplexität 5/10, FLASH)

**3.1 `workerClient.ts` — strukturierte V2-Fehler**
Datei: `packages/userscript-hud/src/services/workerClient.ts`

- Helper `isV2ErrorPayload(data): boolean` → `data && typeof data === 'object' && (typeof data.status === 'string' || typeof data.errorMessage === 'string' || Array.isArray(data.errors))`.
- In allen drei Transports bei `status >= 400`:
  - JSON parsebar + `isV2ErrorPayload` → **resolve** `data as T` (Aufrufer prüft `status`).
  - sonst → `throw new Error(...)` wie bisher.
- Nur HTTP `400`? Empfehlung: auch `409` (`GIT_CONFLICT`) als V2 auflösen, da `hudApplyPatch` den Status auswertet; `401/403/404/500` bleiben Throws.
- `hudMixAction.ts:59-67` funktioniert danach ohne Änderung; `skippedFiles`-Anzeige erhält Daten.

**3.2 `hudApplyPatch.ts` — Reihenfolge**
Datei: `packages/userscript-hud/src/ui/hudApplyPatch.ts:43-82`

- Reihenfolge neu: `openPanel()` → **Foreign-Owner-Guard** (`classifyRepoOwner`) → `resolvePatchPaths`/Prompt → `PATCHING`.
- Guard-Fehler setzt `status: 'ERROR'` ohne Prompt und ohne Statuswechsel auf `PATCHING`.
- Keine Netzwerk-/OID-Auflösung vor dem Guard.

**3.3 `hudConfigBindings.ts` — Repo-Kanonisierung**
Datei: `packages/userscript-hud/src/ui/hudConfigBindings.ts:19-29`

```ts
const sanitized = sanitizeRepo(sanitizeNoGithubPat(dom.repoInput.value.trim(), 'repo'));
```
- Import aus `../services/storage`.
- Bei Fehler: `alert`, Input auf `config.repo` zurücksetzen (bestehendes Verhalten).

**Akzeptanz:** `npm --prefix packages/userscript-hud run typecheck`; manuell: fremder Owner → kein Prompt.

---

### Batch 4 — Ephemere Registry, Probe-10-CRLF, Doku-Sync (Komplexität 5/10, FLASH)

**4.1 `scripts/plan-registry.mjs`**

- `REGISTRY_PATH = join(process.cwd(), '.tmp', 'plan-registry.json')`.
- `LEGACY_PATH = join(process.cwd(), 'plans', 'PLAN_REGISTRY.json')`.
- `loadRegistry()`:
  1. `mkdirSync(dirname(REGISTRY_PATH), { recursive: true })`.
  2. Existiert `.tmp/plan-registry.json` → lesen.
  3. Sonst existiert Legacy und ist nicht leer/parsebar → einmalig übernehmen, sofort nach `.tmp` schreiben, `console.warn('[plan-registry] migrated legacy plans/PLAN_REGISTRY.json → .tmp/plan-registry.json')`.
  4. Sonst `{}` schreiben.
- `saveRegistry()` atomar: `writeFileSync(tmpFile)` + `renameSync(tmpFile, REGISTRY_PATH)`.
- Korruptes JSON: Fehler mit Pfad werfen (bestehendes Verhalten), aber `.tmp` nicht überschreiben.
- CLI-Usage-Text unverändert.

**4.2 `.gitignore`**
- Explizite Zeile `.tmp/` ergänzen (heute nur `*.tmp`, das zufällig matcht).
- `git rm plans/PLAN_REGISTRY.json` bleibt Ausführungsschritt (Datei ist getrackt, Inhalt `{}`).

**4.3 `worker-smoke.mjs` Probe 10 — CRLF**
Datei: `scripts/patches_and_tests/worker-smoke.mjs:381-397`

- Statt `Buffer.equals`:
  ```js
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const distText = norm(fs.readFileSync(distBundlePath, 'utf-8'));
  const rootText = norm(fs.readFileSync(rootBundlePath, 'utf-8'));
  bundleByteIdentical = distText.length > 0 && distText === rootText;
  bundleSize = rootText.length;
  ```
- Rückgabefeld ggf. in `bundleContentIdentical` umbenennen; Summary-Text in Probe 10 anpassen (kein Byte-Vergleich mehr).
- **Kein** esbuild-/`dist/*.mjs`-Vergleich einbauen — den gibt es in Probe 10 nicht (siehe Review #10).

**4.4 Doku-Sync (reduziert)**
- `.agents/skills/plan/SKILL.md:13`: `plans/PLAN_REGISTRY.json` → `.tmp/plan-registry.json`.
- `.agents/skills/exec/SKILL.md:10,44`: dito.
- `.agents/skills/exec-wave/SKILL.md:18`: dito.
- `AGENTS.md` (`agents.md` im Root): Pfad nur ergänzen, falls dort Registry/`.tmp` erwähnt wird — aktuell nicht.
- `delegate`/`solve`/`edge-worker-architecture.md`: **nur** anfassen, wenn Batch-1/2-Verhalten dort beschrieben ist; sonst aus dem Inventar streichen.
- **Nicht** `packages/local-cli/src/localRunner.ts` ändern (keine Registry-Nutzung).

---

## 2. Korrigiertes Datei-Inventar

| Batch | Dateien |
| :--- | :--- |
| 1 | `scripts/patches_and_tests/test-webhook-worker.mjs`, `packages/edge-worker/src/modules/webhookHandler.ts` (nur 1.2, optional), `packages/edge-worker/src/index.ts` |
| 2 | `packages/edge-worker/src/modules/mixerTarScan.ts`, `packages/edge-worker/src/modules/mixChunker.ts`, `packages/edge-worker/src/modules/mixer.ts` (nur falls Aggregation angepasst wird), `shared/types.ts`, `packages/edge-worker/src/modules/patchInMemory.ts`, `packages/edge-worker/src/modules/syntaxScanner.ts`, `scripts/patches_and_tests/test-patch-idempotence.mjs`, `scripts/patches_and_tests/test-jsx-syntax-scan.mjs` |
| 3 | `packages/userscript-hud/src/services/workerClient.ts`, `packages/userscript-hud/src/ui/hudApplyPatch.ts`, `packages/userscript-hud/src/ui/hudConfigBindings.ts` |
| 4 | `scripts/plan-registry.mjs`, `.gitignore`, `.agents/skills/plan/SKILL.md`, `.agents/skills/exec/SKILL.md`, `.agents/skills/exec-wave/SKILL.md`, `scripts/patches_and_tests/worker-smoke.mjs` (+ `git rm plans/PLAN_REGISTRY.json`) |

**Entfernt gegenüber Original:** `packages/local-cli/src/localRunner.ts`, `shared/hybridTypes.ts`, `.agents/skills/delegate/SKILL.md`, `.agents/skills/solve/SKILL.md`, `.agents/rules/edge-worker-architecture.md`, `agents.md` (jeweils ohne belegten Änderungsbedarf).
**Hinzu:** `shared/types.ts`, `scripts/patches_and_tests/test-jsx-syntax-scan.mjs`, `.gitignore`.

---

## 3. Risiko- & Komplexitäts-Check

| Batch | Komplexität | Tier | Hauptrisiko & Absicherung |
| :--- | :--- | :--- | :--- |
| 1 | 5/10 | FLASH | 400/500-Trennung: `instanceof ClientValidationError` + Test mit kaputtem Repo-Pfad (400) und simuliertem GraphQL-Fehler (500). Background-Promises in Webhook-Tests immer `.catch`. |
| 2 | 7/10 | FLASH | Verkettung ändert Auswertungsreihenfolge: `workingFiles`-Map, ein `additions`-Eintrag pro Pfad, Preflight auf finalem Puffer; 3 neue Idempotenz-Fälle. `mixChunker`-Skip-Union ehrlich halten. |
| 3 | 5/10 | FLASH | Nur echte V2-Strukturen auflösen; Transportfehler weiter werfen. Guard vor Prompt. |
| 4 | 5/10 | FLASH | Atomares Registry-Write + einmaliger Legacy-Fallback; CRLF-Normalisierung im HUD-Bundle-Vergleich (nicht esbuild). |
| **Gesamt** | **6/10** | **FLASH** | Flash-Only machbar; Batch 2 ist der einzige Batch mit echtem Logikrisiko. |

---

## 4. Verifikation & Git-Richtlinie

Einzelbefehle, sequenziell, keine Verkettung:

```powershell
npm --prefix packages/edge-worker run typecheck
npm --prefix packages/userscript-hud run typecheck
npm --prefix packages/local-cli run typecheck
npm --prefix packages/edge-worker run build
npm --prefix packages/local-cli run build
npm --prefix packages/userscript-hud run build
node scripts/patches_and_tests/run-regressions.mjs
git rm plans/PLAN_REGISTRY.json
git --no-pager diff --check
```

Optional (Netzwerk nötig, Live-Worker):

```powershell
node scripts/patches_and_tests/worker-smoke.mjs
```

Regeln:

- `run-regressions.mjs` deckt `test-webhook-worker`, `test-patch-idempotence`, `test-jsx-syntax-scan`, `test-path-normalization`, `test-local-cli` ab — keine separaten Einzelaufrufe nötig.
- `npm --prefix packages/userscript-hud run build` (nicht `release:patch`) für Verifikation; `release:patch` bumpt `package.json` und ist nur bei gewolltem Release zulässig.
- Staging ausschließlich über die Pfade des Inventars, kein `git add .`.
- Commit-Vorschlag:
  `fix(bridge): harden webhook tests, skip-reporting, patch chaining and bundle freshness (CRLF safe)`
- `git push`/`wrangler deploy` bleiben Hard Stops.

---

## 5. Offene Entscheidungen (vor `#exec` klären)

**A. `SkippedFile.reason`-Union**
- Option A1 (empfohlen): Union auf `'too_large'` reduzieren; `over_hard_limit`/`would_exceed_parts` bleiben Throws mit klarer Fehlermeldung (Status `ERROR`).
- Option A2: Overflow-Fälle zusätzlich in `skippedFiles` der `ERROR`-Antwort melden (erfordert Umbau von `mixChunker`-Throws in Rückgabewerte — größerer Eingriff).

**B. HUD-Bundle-Vergleich in Probe 10**
- Option B1 (empfohlen): CRLF-normalisierter String-Vergleich, Feldname `bundleContentIdentical`.
- Option B2: Byte-Vergleich behalten und CRLF bereits im Build (`build-userscript.mjs`) vereinheitlichen — größerer Scope, nicht Teil dieses Plans.

**C. `contextText`-Vorrang (`parts` vs. `xmlContent`)**
- Option C1 (empfohlen): `parts` bevorzugen.
- Option C2: Ist-Verhalten belassen (kein Code-Change, Plan-Punkt streichen).
