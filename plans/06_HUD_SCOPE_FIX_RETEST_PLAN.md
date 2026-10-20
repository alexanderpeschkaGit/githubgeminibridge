## Execution Metadata

- **Recommended Workflow:** `#exec all`
- **Recommended Execution Model:** HYBRID (FLASH für Schritte 1–4 & 6, PRO nur falls Schritt 5 einen Ziel-Repo-Build/Typecheck erfordert)
- **Flash-Only Viability:** YES (Micro-Batched <= 6) — keine Bridge-Code-Änderung, alle Schritte sind Verifikations-/Bedienhandlungen <= Score 4; Schritt 5 eskaliert nur dann auf PRO, wenn im Ziel-Repo ein vollständiger `tsc`/Build-Lauf nötig wird.
- **Complexity Assessment:** Reiner Retest-/Verifikationsplan nach dem HUD-OID-Scope-Fix. Kein Blast-Radius im Bridge-Code (`packages/**` bleibt unverändert), Risiko liegt ausschließlich in Konfiguration (Repo/Branch) und Patch-Frische.

---

# Plan: Retest nach HUD-Scope-Fix (`useModalCloseHandler.ts` @ `sikanda_projectinart_11-on-main#preview`)

## 0. Ausgangslage & verifizierte Fakten (Preflight, 2026-10-20)

| Frage | Verifiziertes Ergebnis (GitHub-API) |
| :--- | :--- |
| Ursache des `GIT_CONFLICT` | `head_oid` lag repo-agnostisch im HUD-Storage. `639fb9e` = `main` von `alexanderpeschkaGit/sikanda_projectinart_11` (Mix-Snapshot), `7151026` = `main` von `alexanderpeschkaGit/sikanda_projectinart_11-on-main` (validierter Branch-HEAD). |
| Ist die Frische-Prüfung korrekt? | Ja. Sie hat einen Commit in ein Repo/Branch verhindert, in dem die Zieldatei **nicht existiert**. |
| Existiert `src/hooks/feed/useModalCloseHandler.ts`? | **Ja, aber ausschließlich auf `preview`.** Auf `main` → `404`. |
| Ist bereits etwas aus dem Fehllauf eingecheckt? | Nein. `preview`-HEAD steht seit `2026-10-20T16:05:01Z` unverändert auf `65dbd85` (`feat(config): parameterize SITE_CONFIG env fallbacks, modal polish and format compliance`). |
| Letzte Änderung an der Datei | `8679ea1` (2026-10-20T15:58:27Z, „decompose App.tsx … ProjectFeed (Batch 04)“) — die Datei entstand/wurde dort angefasst. |
| Bridge-Fix vorhanden? | Ja, Userscript `2.0.3` (Commit `5332531`), `head_oid_scope` = `repo#branch`, OID-Reset bei Config-Wechsel, kein stiller `/push`-Fallback. |

**Antwort auf „ist das noch relevant?“:** Ja — die Datei ist aktiver Bestandteil der `preview`-Architektur (`useModalCloseHandler` wird vom Feed-Modal genutzt) und seit dem Fehllauf unverändert. Der Patch ist also **nicht** durch einen fremden Commit obsolet geworden. Einzige offene Unbekannte: ob der Gemini-Patch inhaltlich noch zum Stand `65dbd85` passt (die Commits `28b5948` „guard modal actions“ und `65dbd85` „modal polish“ haben dieselbe Region bereits berührt). Das entscheidet der Preflight-Linter deterministisch: `SEARCH_REPLACE`-Fehler ⇒ Patch gegen frischen Mix neu erzeugen; `NO_CHANGES_NEEDED` ⇒ Änderung ist bereits drin.

---

## 1. Architektur & Logik des Retests

### Schritt 1 — HUD-Version & Scope-Reset verifizieren `[Score: 2/10 | Tier: FLASH_LITE]`
- Tampermonkey-Dashboard öffnen, `Gemini Git Bridge & Shadow-DOM HUD` prüfen: `@version 2.0.3`.
- HUD auf `gemini.google.com` öffnen, Panel aufklappen. Erwartung nach dem Upgrade:
  - OID-Badge zeigt `(Not mixed yet)`, **nicht** die alte `639fb9e…` (Scope-Mismatch wird beim Laden verworfen).
  - Falls noch `639fb9e…` sichtbar ist: Userscript-Version veraltet (Cache/Alte Installation) → neu installieren, dann erneut prüfen.
- Abbruchkriterium: Version < 2.0.3 ⇒ Plan hier stoppen, erst Userscript aktualisieren.

### Schritt 2 — Ziel-Konfiguration setzen & frischen Mix ziehen `[Score: 2/10 | Tier: FLASH_LITE]`
- HUD-Felder setzen:
  - `Repo`: `alexanderpeschkaGit/sikanda_projectinart_11-on-main`
  - `Branch`: `preview`
  - `Target Branch`: **leer** (kein PR-Zweig für diesen Retest)
  - `Include Paths` (optional, empfohlen für kleinen Mix): `src/hooks/feed,src/store,src/components/modal`
  - `🕒 Volatile Dateien & Letzte Commits`: aus
- Nach dem Ändern von Repo/Branch muss die Statuszeile `🔄 … Snapshot OID reset — click "Load Repo Mix" …` zeigen. Fehlt sie, ist die alte Userscript-Version aktiv.
- `Load Repo Mix` klicken. Erwartung: Statuszeile nennt `Head: 65dbd85` (bzw. den dann aktuellen `preview`-HEAD), Chunks werden als Datei-Chips injiziert.
- Danach Badge gegenprüfen (siehe Schritt 5.1).

### Schritt 3 — Patch neu ernten `[Score: 3/10 | Tier: FLASH_LITE]`
- Im Gemini-Chat die Antwort mit dem Patch für `src/hooks/feed/useModalCloseHandler.ts` aufrufen.
- Über den Inline-Button `⚡` (Harvester) in die Queue legen — **kein** erneutes Generieren nötig, solange der Patch-Block noch im Chatverlauf steht.
- Prüfen: Queue-Eintrag zeigt als Titel `src/hooks/feed/useModalCloseHandler.ts` und genau **einen** Eintrag (Content-Signature-Dedupe).
- Falls der Chat den Block nicht mehr enthält: V2-Payload erneut von Gemini erzeugen lassen — dann mit dem frischen Mix aus Schritt 2, damit die `search`-Blöcke auf `65dbd85` passen.

### Schritt 4 — Anwenden & Status interpretieren `[Score: 4/10 | Tier: FLASH]`
- `⚡ Apply All (1)` klicken. Erwartete Ergebnisse:
  - **`COMMITTED`** → weiter mit Schritt 5.
  - **`NO_CHANGES_NEEDED`** → die Änderung ist durch `28b5948`/`65dbd85` bereits enthalten. Ergebnis dokumentieren, kein weiterer Commit nötig; Plan endet mit „Patch obsolet“.
  - **`PREFLIGHT_FAILED`** (`SEARCH_REPLACE`/`CUSTOM_RULE`/`OXC_SYNTAX`) → Meldung + Datei-/Zeilenbezug notieren. Bei `SEARCH_REPLACE` gegen den frischen Mix neu erzeugen (Schritt 3) oder Auto-Pilot-Self-Healing einmal zulassen (`retryCount < 3`).
  - **`GIT_CONFLICT`** → jetzt ein echter Befund: Branch wurde zwischen Mix und Patch bewegt. Meldung enthält `[validated <repo>@<branch>]`; wenn dort **nicht** `…-on-main@preview` steht, war die Konfiguration falsch → zurück zu Schritt 2.

### Schritt 5 — Ergebnis gegen GitHub verifizieren `[Score: 4/10 | Tier: FLASH]`
- 5.1 Commit prüfen (read-only):
  - `gh api repos/alexanderpeschkaGit/sikanda_projectinart_11-on-main/commits?sha=preview&per_page=3` → neuer HEAD mit Bridge-Commit-Message.
  - `gh api repos/alexanderpeschkaGit/sikanda_projectinart_11-on-main/commits/<newHead>` → `files[]` darf **ausschließlich** `src/hooks/feed/useModalCloseHandler.ts` enthalten.
- 5.2 Sicherheits-Gegenprobe (kein Schreibzugriff): `gh api repos/.../commits?sha=main&per_page=1` → muss weiterhin `7151026` sein, `main` bleibt unberührt.
- 5.3 Optional, nur bei Bedarf (Eskalation auf **PRO**): im Ziel-Repo lokal `npm run typecheck`/`npm run build` gegen `preview`.
- 5.4 HUD-Badge muss dem neuen `preview`-HEAD entsprechen (FIFO-OID-Fortschreibung nach `COMMITTED`).

### Schritt 6 — Regression des Fixes bestätigen (Gegenprobe) `[Score: 2/10 | Tier: FLASH_LITE]`
- Repo-Feld kurz auf `alexanderpeschkaGit/sikanda_projectinart_11` ändern → Statuszeile muss `🔄 Repository changed … Snapshot OID reset …` zeigen und der Badge auf `(Not mixed yet)` springen.
- Zurück auf `…-on-main` / `preview` setzen → Badge bleibt leer, **keine** Fremd-OID. Damit ist bewiesen: die `GIT_CONFLICT`-False-Positives sind weg.

### Schritt 7 — Dokumentation & Checkpoint `[Score: 2/10 | Tier: FLASH_LITE]`
- `plans/EXECUTION_LOG.md`: Retest-Ergebnis anhängen (Status, Commit-SHA, ob `COMMITTED`/`NO_CHANGES_NEEDED`/`PREFLIGHT_FAILED`).
- `plans/TEST_LOG.md`: Verifikationsnachweise aus Schritt 5 (Commit-SHA, `files[]`-Umfang, `main`-Unverändertheit).
- `plans/STATE.md`: „Offene Entscheidungen / Blocker“ aktualisieren (Patch-Status `useModalCloseHandler.ts`).
- Lokaler Checkpoint-Commit (nur die drei `plans/`-Dateien, Pfad-spezifisch gestaged).

---

## 2. Datei-Inventar

| Datei | Rolle im Plan |
| :--- | :--- |
| `gemini-bridge.user.js` (Root) / `packages/userscript-hud/dist/gemini-bridge.user.js` | **Nur lesen** — Versionsnachweis `2.0.3` (Schritt 1). Bleibt byte-identisch. |
| `packages/userscript-hud/src/services/patchOidState.ts` | **Nur lesen** — `buildOidScope`/`resolvePatchOidState` als Referenz für Schritt 6. |
| `packages/userscript-hud/src/services/patchOidStore.ts` | **Nur lesen** — `head_oid_scope`-Persistenz als Referenz für Schritt 1/6. |
| `packages/userscript-hud/src/ui/shadowHud.ts` | **Nur lesen** — Statusmeldungen (`🔄 … reset`, `[validated repo@branch]`) für Schritt 2/4. |
| `plans/EXECUTION_LOG.md` | Schreiben (Schritt 7) |
| `plans/TEST_LOG.md` | Schreiben (Schritt 7) |
| `plans/STATE.md` | Schreiben (Schritt 7) |
| Ziel-Repo `alexanderpeschkaGit/sikanda_projectinart_11-on-main` → `src/hooks/feed/useModalCloseHandler.ts` | Wird ausschließlich **über den Worker** (`/api/patch`) geändert, nie lokal im Bridge-Workspace. |

Keine Änderung in `packages/edge-worker/**`, `shared/**`, `scripts/**` → kein Smoke-/Regressionslauf zwingend nötig (optional als Sanity: `node scripts/patches_and_tests/run-regressions.mjs`).

---

## 3. Risiko- & Komplexitäts-Check

| Risiko | Bewertung | Gegenmaßnahme |
| :--- | :--- | :--- |
| Alte Userscript-Version aktiv (Tampermonkey zeigt noch 2.0.2) | mittel | Schritt 1 als hartes Gate |
| Patch passt nicht mehr zu `65dbd85` (Modal-Region wurde in `28b5948`/`65dbd85` angefasst) | mittel | `NO_CHANGES_NEEDED` bzw. `SEARCH_REPLACE`-Fehler sind die deterministischen Signale (Schritt 4) |
| Erneuter Repo-Verwechsler (`…_11` vs `…_11-on-main`) | niedrig (nach Fix), aber hoher Schaden | Scope-Reset (Schritt 2/6) + `[validated …]`-Hinweis in der Fehlermeldung |
| Datei existiert auf `main` nicht | hoch (wenn Branch falsch) | Branch in Schritt 2 fest auf `preview`; `main` bleibt in Schritt 5.2 als Gegenprobe unverändert |
| Mix zu groß / Kontext-Budget | niedrig | optionaler `Include Paths`-Filter in Schritt 2 |

- Einzelkomplexität: max. **4/10** (Schritt 4/5), alles andere ≤ 3.
- Gesamtkomplexität: **4/10**.
- **Flash-Only Viability: YES** — Eskalation auf `PRO` nur, wenn Schritt 5.3 (Build/Typecheck im Ziel-Repo) nötig wird.

---

## 4. Optimierungshinweis

- Schritte 1–2 in einem Durchgang erledigen (beide nur HUD-Bedienung, Score zusammen ≤ 4).
- Schritte 5.1/5.2 sind reine `gh api`-Reads → in einem Kommando-Block bündeln.
- Schritte 6 + 7 können am Ende zusammengefasst werden (Nachweis + Logging).
- Linearer Ablauf mit enger Kopplung (jeder Schritt hängt am Zustand des vorherigen) ⇒ **`#exec all`**, **keine** Wave-/Scatter-Gather-Aufteilung nötig (keine disjunkten Dateisets).

---

## 5. Git- & Checkpoint-Leitfaden

- **Pre-Commit-Verifikation:** Bridge-Code wird nicht geändert; falls doch, `node packages/edge-worker/node_modules/typescript/bin/tsc --noEmit -p packages/userscript-hud/tsconfig.json` + `node scripts/patches_and_tests/run-regressions.mjs`.
- **Branch-Check:** Bridge-Repo bleibt auf `main` (kein Remote konfiguriert); Ziel-Repo-Commits landen ausschließlich auf `preview` über den Worker.
- **Scope-Inspection:** `git status --short` — bekannte Fremdänderungen (`.gitignore`, `.env.example`, `.vscode/`) **nicht** stagen.
- **Path-Specific Staging:** nur `plans/EXECUTION_LOG.md plans/TEST_LOG.md plans/STATE.md`.
- **Commit-Format:** Conventional Commits + kurze Begründung im Body; Trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- **Remote Safety:** `git push` und `npx wrangler deploy` bleiben **Hard Stops** (nur auf explizite Anweisung).

---

## 6. Acceptance & Invarianten (deterministisch prüfbar)

1. **Scope-Invariante:** Nach dem Laden des HUD ist `GM`-Storage `head_oid_scope` exakt `alexanderpeschkagit/sikanda_projectinart_11-on-main#preview` (lowercase) — und `head_oid` entspricht dem `preview`-HEAD aus `gh api …/branches`.
2. **Kein Fremd-Repo-Commit:** `gh api repos/alexanderpeschkaGit/sikanda_projectinart_11-on-main/commits/<newHead>` listet **nur** `src/hooks/feed/useModalCloseHandler.ts` in `files[]`.
3. **Isolation:** `main` von `…-on-main` steht nach dem Lauf weiterhin auf `7151026`; Repo `sikanda_projectinart_11` erhält **keinen** neuen Commit.
4. **Konflikt-Semantik:** Ein `GIT_CONFLICT` in diesem Lauf nennt in der Statuszeile `[validated alexanderpeschkaGit/sikanda_projectinart_11-on-main@preview]` — andernfalls gilt der Lauf als Konfigurationsfehler, nicht als Branch-Bewegung.
5. **Kein Fallback:** Tritt der Lauf ohne Mix auf, erscheint `No repo mix snapshot for … — Click "Load Repo Mix" first` und es wird **nichts** committet (kein `/push`).
6. **Idempotenz:** Ein zweites `⚡ Apply All` desselben Patches liefert `NO_CHANGES_NEEDED` und erzeugt keinen zweiten Commit.
