---
trigger: model_decision
description: "Apply this rule whenever working on packages/edge-worker/, shared/types.ts, wrangler.jsonc, GitHub GraphQL/Tarball integration, or V1/V2 API endpoints."
---

# Cloudflare Edge-Worker Architecture (`packages/edge-worker/`)

> **Historischer Kontext:** Diese Domänen-Regel bündelt die ursprünglichen V1-Worker-Spezifikationen (`cf-gemini-git-bridge/` aus der früheren Root-`agents.md`) mit der neuen V2-Orchestrator-Architektur (`mixer.ts`, `patcher.ts`, `linter.ts`).
> **WICHTIG:** Der aktive Quellcode liegt ausschließlich in `packages/edge-worker/`. Das Verzeichnis `cf-gemini-git-bridge/` im Projekt-Root und `_v1_backup/` sind **Read-Only Legacy-Bestand** und dürfen nicht bearbeitet werden.

---

## 1. Runtime & Deployment Constraints

- **Worker Name & Wrangler Config:**
  - `packages/edge-worker/wrangler.jsonc` behält zwingend `"name": "gemini-git-bridge"` und `"compatibility_date": "2026-08-04"` (oder neuer), damit bestehende Cloudflare-Deployments und Secrets ohne Re-Provisionierung weiterlaufen.
- **Zero Local State & Pure Web Standards:**
  - Der Worker läuft zustandslos an der Cloudflare Edge. Keine Node.js-Dateisystem-Zugriffe (`fs`), keine SQLite-Datenbanken, kein persistenter In-Memory-State zwischen Requests.
  - Nutze native Web-Standard-APIs (`fetch`, `Request`, `Response`, `Headers`, `ReadableStream`, `DecompressionStream('gzip')`, `TextDecoder`, `TextEncoder`).
- **Dual Secret & Header Support (V1 + V2 Abwärtskompatibilität):**
  - **GitHub Token:** Unterstütze `env.GITHUB_PAT || env.GITHUB_TOKEN`.
  - **Worker Secret:** Unterstütze `env.WORKER_SECRET || env.BRIDGE_SECRET`.
  - **Request Auth-Header:** Akzeptiere sowohl `Authorization: Bearer <SECRET>` als auch den Legacy-Header `x-bridge-secret: <SECRET>`.

---

## 2. API Route & Synchronization Table (V1 Legacy + V2 Orchestrator)

Alle Routen in `packages/edge-worker/src/index.ts` müssen CORS-Header (`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type, Authorization, x-bridge-secret`) unterstützen und folgende Verträge strikt einhalten:

| Endpoint | Method | Auth | Ursprung | Modul / Handler | Request / Response Vertrag |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/` oder `/health` | `GET` | Public | V1 + V2 | `index.ts` | Gibt `{ status: "ok", service: "gemini-git-bridge", version: "2.0.9", hasBridgeSecret: boolean, hasGithubToken: boolean }` zurück (niemals Klartext-Secrets!). |
| `/api/mix` | `POST` | Bearer / `x-bridge-secret` | **V2 (Stufe 1, 6–6.2)** | `modules/mixer.ts` + `modules/mixChunker.ts` | Body: `MixRequest` (`repo`, `branch`, `includePaths?`, `persistToGitHub?`, `maxChunkChars?`, `maxChunkBytes?`, `maxChunkTokens?`, `splitOutput?`, `includeRecentCommits?`, `recentCommitsCount?`). Streamt GitHub-Tarball (1 Subrequest), filtert im RAM und liefert `MixResponse` (`headOid`, `xmlContent`, `parts?: MixPart[]` als `.txt` / `text/plain`, `isChunked?`, `stats` (mit `stats.totalFileCount` vs. `stats.fileCount`), `truncation?: MixTruncation`, `skippedFiles?: SkippedFile[]` mit Gründen `too_large`|`ignored`|`over_hard_limit`|`would_exceed_parts`, Bytes/Chars angegeben wo bekannt). Recent-Commit-Metadaten werden nur bei `includeRecentCommits === true` geladen. |
| `/api/patch` | `POST` | Bearer / `x-bridge-secret` | **V2 (Stufe 2, 4 & 7)** | `modules/patcher.ts` + `modules/linter.ts` | Body: `WorkerPatchRequest` (`repo`, `branch`, `expectedHeadOid`, `payload: GeminiPatchPayload`, `targetBranch?`, `expectedTargetHeadOid?`, `createBranchIfNeeded?`). Führt den Source-Frische-Check auf `branch` aus, löst einen vorhandenen `targetBranch` auf und liest/committet gegen dessen Snapshot-OID; nur ein eindeutiges Branch-Not-Found erzeugt via `createBranchRef` einen Ref am validierten `expectedHeadOid`. Prüft Search/Replace, Placeholder & AST/Syntax und committet atomar. Liefert `WorkerPatchResponse` (`COMMITTED` inkl. `targetBranch`, `createdBranch`, `pullRequestUrl`, `PREFLIGHT_FAILED`, `GIT_CONFLICT`, `NO_CHANGES_NEEDED`, `ERROR`). |
| `/push`, `/commit`, `/api/commit`, `/` | `POST` | Bearer / `x-bridge-secret` | **V1 Legacy** | `modules/patcher.ts` (`handleCommitRequest`) | Body: `CommitRequestPayload` (`repo`, `targetBranch`, `commitMessage`, `changes[]`, `deletions[]`, `expectedHeadOid?`). Muss zu 100 % abwärtskompatibel für bestehende V1-Clients bleiben! |
| `/graphql` | `POST` | Bearer / `x-bridge-secret` | **V1 + V2** | `index.ts` (`handleGraphQLProxy`) | Body: `{ query: string, variables?: Record<string, unknown> }`. Authentifizierter Proxy zur GitHub GraphQL API v4. |
| `/api/webhook/github` | `POST` | HMAC-SHA256 (`x-hub-signature-256`) | **V2 (Stufe 5)** | `modules/webhookHandler.ts` | Body: GitHub Webhook JSON. Validiert HMAC per Web Crypto API, filtert `@gemini`-Trigger, liefert sofort `202 Accepted` und führt `executeWorkerWorkflow` (Mixer + Gemini REST + Patcher + PR/Issue Comment) asynchron via `ctx.waitUntil` aus. |

**Target-Branch-Concurrency:** `/api/patch` behält `expectedHeadOid` als Source-Frischetoken und akzeptiert zusätzlich `expectedTargetHeadOid?`. Existierende Target-Dateien werden vom erfassten Target-Commit-OID gelesen; `createCommitOnBranch` verwendet denselben OID. Commit- und No-op-Antworten liefern den effektiven Target-HEAD und Branch.

---

## 3. Technische Modul-Gesetze (Stufe 1, 2, 4, 5 & 6)

### A. Untertool A: `src/modules/mixer.ts` & `src/modules/mixerTarScan.ts` (1-Subrequest Tarball-Stream + Repomix-Filterlogik)
1. **1-Subrequest Tarball Streaming (`uithub`-Pattern):**
   - Lade das Repository in einem einzigen HTTP-Subrequest via `GET https://api.github.com/repos/{owner}/{repo}/tarball/{branch}` und dekomprimiere es on-the-fly mit `response.body.pipeThrough(new DecompressionStream('gzip'))`.
   - **Verboten:** Einzelabrufe über die GitHub Contents API in einer Schleife (sprengt das Limit von 50 Subrequests auf Cloudflare Workers).
2. **Exakte 40-stellige `headOid` Extraktion & Persist-Synchronisation:**
   - Lies im ersten 512-Byte-Block des TAR-Streams (`typeflag === 'g'`, PAX Global Extended Header) das Kommentarfeld `comment=<40-char-sha>` aus. Nutze das Hash-Suffix des Root-Ordnernamens als sekundären Pfad und führe bei verkürztem SHA (< 40 Zeichen) automatisch `getBranchHeadOid` als Fallback aus, damit `headOid` garantiert immer 40-stellig ist.
   - Wird `persistToGitHub === true` genutzt (`commitSingleFileViaGraphQL` nach `_context/repo-mix.xml`), wird `headOid` in der `MixResponse` auf die neue `persistedCommitOid` aktualisiert, damit nachfolgende `/api/patch`-Aufrufe keinen `GIT_CONFLICT` auslösen.
3. **USTAR & PAX Extended Path Support:**
   - Unterstütze Dateipfade > 100 Zeichen verlustfrei über das USTAR-`prefix`-Feld (Offset 345, Länge 155) sowie PAX Extended Header (`typeflag === 'x'`, `path=...`).
4. **128 MB RAM-Überlaufschutz & Repomix-Filter (Header-Level Stream-Skip):**
   - Überspringe folgende Pfade und Dateitypen **bereits anhand des 512-Byte-TAR-Headers** direkt im Stream (ohne Buffer-/String-Allokation) über `shouldSkipTarEntry`:
     - **Verzeichnisse:** `.git/`, `node_modules/`, `dist/`, `build/`, `.wrangler/`, `.turbo/`, `.next/`, `coverage/`, `_v1_backup/`, `repomix_*/`, `backup_unused/`, `.venv/`, `venv/`, `env/`, `__pycache__/`, `.tmp/`, `out/`, `.output/`, `.nuxt/`, `.svelte-kit/`, `.astro/`, `.vercel/`, `.netlify/`, `.cache/`, `.parcel-cache/`, `storybook-static/`, `playwright-report/`, `test-results/`.
     - **Lockfiles & Bundles:** `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `bun.lock`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `composer.lock`, `Gemfile.lock`, `*.bundle`, `repomix-output*`, `*-bundle*.txt`, minifizierte Bundles `*.min.js`, `*.min.mjs`, `*.min.cjs`, `*.min.css`.
     - **Binär-, Medien- und Build-Endungen:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.ico`, `.svg`, `.mp4`, `.webm`, `.mov`, `.mp3`, `.wav`, `.ogg`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.pdf`, `.zip`, `.tar`, `.gz`, `.7z`, `.wasm`, `.exe`, `.dll`, `.so`, `.dylib`, `.pyc`, `.map`, `.tsbuildinfo`.
     - **Dynamische Ignore-Regeln:** Unterstütze `.repomixignore.cf` bzw. `.repomixignore` direkt aus dem TAR-Stream via `tarUtils.ts`.
     - **Größen-Limit:** Einzeldateien `> 512 KB` (`524288` Bytes) werden im Stream übersprungen (`skippedFiles` mit `reason: 'too_large'`).
5. **Format-Migration auf `.txt` (Repomix-kompatibel, MIME `text/plain`):**
   - Um XML-Parsing-Bugs und UI-Wrapping in Gemini / AI Studio zu verhindern, werden Chunks standardmäßig als `.txt`-Dateien mit MIME `text/plain` (`part-01.txt`, `part-02.txt` usw.) erzeugt.
   - Escape vorhandene `]]>`-Sequenzen im Dateiinhalt sicher als `]]]]><![CDATA[>` (`escapeCdata`), falls XML-Wrapping verwendet wird.
6. **RepoMix Atomic Chunking & Multi-Part Partitioning (`mixChunker.ts`) & Multi-Turn Continuation (`mixContinuation.ts`):**
   - Wird `splitOutput: true` übergeben oder überschreitet das Repository das Budget (`maxChunkChars` Standard 85.000 Zeichen unterhalb des 100k-Gemini-Limits), partitioniert `buildChunkedMixXml` die Dateien **atomar** in nummerierte Chunks (`part 1 von N`).
   - **Gemini Web UI 100k Cutoff-Schutz:** Jedes vollständige serialisierte `MixPart.xmlContent.length` bleibt strikt `<= 100_000` Zeichen (Target-Budget: `DEFAULT_MAX_CHUNK_CHARS = 85_000` Zeichen). `HARD_GEMINI_CHAR_LIMIT` ist eine **absolute Obergrenze**: ein vom Nutzer übergebenes `maxChunkChars`/`maxChunkBytes`/`maxChunkTokens` kann das Budget nur verschärfen, niemals über 100k anheben. Unveränderte Anfragen (kein `maxChunkChars` oder Default `85_000`) nutzen die Budget-Ladder `85k -> 95k -> 100k`, bevor Dateien ausgelassen werden. Einzeldateien, deren vollständige serialisierte XML-Repräsentation allein über dem Budget liegt, werden als `file_over_hard_limit` in `MixTruncation.omittedFiles` ausgewiesen und übersprungen.
   - **Part-1 FFD-Overflow Guard (`packFilesIntoBuckets`):** Große Einzeldateien (85k–95k) werden nicht bedingungslos in Part 1 gepackt, wenn Part 1 inklusive Master-Tree und Metadaten 100k überschreiten würde; sie weichen in Continuation-Parts aus, während kleinere Dateien Part 1 rückfüllen.
   - **10-Parts-Guardrail & Multi-Turn Continuation (`mixContinuation.ts`, Parts `11..30`):** Die reguläre Anzahl der Parts ist auf `MAX_GEMINI_PARTS = 10` begrenzt. Ist `enableContinuation: true` aktiviert (oder bei Großrepos), generiert `mixContinuation.ts` zusätzliche Continuation-Parts `11..30` (gedeckelt durch `MAX_CONTINUATION_PARTS = 20`), wobei `fitPartXml` in `mixSerializer.ts` eingesetzt wird und jedes Continuation-Part einen strikten `<= 100_000` Zeichen-Ceiling einhält.
   - **1-Query Tarball 404 Diagnose:** Schlägt der Tarball-Download mit 404 fehl, nutzt `describeTarballNotFound` das in `BranchNotFoundError.defaultBranch` bereits aufgelöste `defaultBranchRef` aus dem ersten GraphQL-Call und vermeidet redundante Folgeabfragen.
   - Part 1 enthält den `<file_tree>` der im Mix enthaltenen Dateien (bei Truncation nur der beibehaltenen Dateien, bis max. 14k Zeichen gedeckelt); Folgeparts `2..N` einen kompakten Teilbaum nur für die im jeweiligen Part enthaltenen Dateien.
   - **Invariante:** Einzelne Dateien werden **niemals** mitten im Quellcode zerschnitten. Jeder Part ist ein in sich geschlossenes Dokument mit Metadaten und Filetree.
   - Low-Level TAR-Header-Parsing (`concatBuffers`, `parseAsciiString`, `parseOctal`) ist in `src/utils/tarUtils.ts` ausgelagert; der gzip-/PAX-/Filter-Stream-Scan (`scanTarGzipStream`, `escapeCdata`, `shouldSkipTarEntry`, `extractHeadOidFromPaxHeader`, `TarScanError`) liegt in `src/modules/mixerTarScan.ts`. `mixer.ts` bleibt der HTTP-/Persistenz-Orchestrator (`handleMixRequest`), damit das `< 500`-Zeilen-Gesetz strikt eingehalten wird.
7. **Recent Commits & Volatile Files sind strikt Opt-In:**
   - `fetchRecentCommitsAndVolatileFiles` (`recentCommits.ts`) wird ausschließlich bei `req.includeRecentCommits === true` aufgerufen. Fehlende (`undefined`) und `false`-Werte lösen **keinen** GitHub-API-Aufruf aus und liefern keine `recentCommitsCount`/`volatileFilesCount`-Stats.
   - Bei Opt-In bleibt das bestehende Verhalten erhalten: Metadaten-XML landet in Part 1, `recentCommitsCount` (Default 3, max 5) steuert die Analysetiefe.
   - **Budget-Deckelung der Metadaten:** `recentCommitsText` wird via `capRecentCommitsText` (Konstante `MAX_RECENT_COMMITS_CHARS = 8_000`, zusätzlich auf das verbleibende Part-1-Budget begrenzt) **vor** der Partitionierung gedeckelt und endet bei Kürzung mit dem sichtbaren Marker `... [recent_commits truncated to preserve character budget]`. Der ungedeckelte Rohwert erreicht weder Single-Part-, Part-1-Overhead-, Upscale- noch `buildPartXml`-Pfade.
8. **Eingebettete RepoMix-Instruktionen (`DEFAULT_MIX_INSTRUCTIONS` in `mixChunker.ts`):**
   - Jeder Mix enthält in Part 1 am Dokumentanfang `<instructions>...</instructions>` mit dem Modus-Protokoll (Read-Only vs. Modification), dem V2-JSON-Beispiel, dem Platzhalter-Verbot und dem V1-Fallback. Dadurch entsteht **kein zusätzlicher Datei-Upload** im 10-Dateien-Limit von Gemini Web.
   - Der V1-Fallback verlangt explizit, dass die `// filepath:`-Zeile die **erste Zeile innerhalb** des Codeblocks ist (vor `<<<<<<< SEARCH`), dass der Dateiname **niemals außerhalb** des Blocks steht (keine Markdown-Überschrift, kein `3. \`src/datei.ts\``, keine Backtick-Zeile darüber) und dass jede Datei ihren eigenen Codeblock mit eigenem Header erhält.
   - Die Instruktionsliste bleibt ein `join('\n')`-String-Array **ohne** `<`/`&`-Zeichen, damit der XML-Block valide bleibt; `scripts/patches_and_tests/test-v2-prompt-contract.mjs` erzwingt beides. Standalone-Spiegel: `gemini_prompt_instructions.txt` und `REPOMIX_INSTRUCTIONS.md`.

### B. Untertool B: `src/modules/patcher.ts` & `src/modules/patchInMemory.ts` & `src/utils/github*.ts` (Stufe 2)
1. **1-Subrequest GraphQL Batch-Read:**
   - Nutze `fetchMultipleFilesViaGraphQL` in `src/utils/githubBatchRead.ts`, um alle zu patchenden Dateien über dynamische GraphQL-Aliases (`f0: object(expression: $exp_0) { ... on Blob { text isTruncated } }`) in **einem einzigen** Subrequest zu laden. `src/utils/github.ts` bleibt eine stabile Fassade; die Implementierung ist aufgeteilt in `githubRepo.ts` (`parseRepoOwner`), `githubGraphQL.ts` (`executeGraphQL`, `getBranchHeadOid`, `createBranchRef`, `fetchFileContent`, `BranchNotFoundError`), `githubBatchRead.ts` und `githubCommit.ts` (`createCommitOnBranch`, `commitSingleFileViaGraphQL`).
   - **Truncated Blobs (`isTruncated`) mit begrenzter Parallelität:** Große Dateien, die GraphQL abschneidet, werden über den REST-Fallback `fetchFileContent` nachgeladen. Die Fallbacks laufen über maximal `MAX_TRUNCATED_FETCH_CONCURRENCY = 6` gleichzeitige Worker (gemeinsamer Index-Cursor) statt sequenziell pro Datei; ein Repo mit vielen großen Dateien löst damit keinen API-Burst aus. Kleine Blobs und `null`-Treffer bleiben im selben Einzel-Subrequest.
   - **Same-Branch-Parallelisierung:** Ist `targetBranch` identisch mit `branch`, startet `handlePatchRequest` `getBranchHeadOid(baseBranch)` und `fetchMultipleFilesViaGraphQL(req.expectedHeadOid, allTargetPaths)` gemeinsam via `Promise.all`-Muster. Der Source-HEAD-Vergleich wird **vor** `applyPatchesInMemory`/`createCommitOnBranch` ausgewertet; bei Abweichung wird die Blob-Promise verworfen (`.catch(() => undefined)` gegen Unhandled Rejection) und `GIT_CONFLICT` zurückgegeben. Nur bei abweichendem Zielbranch bleibt die Reihenfolge Source-Check -> Target-Resolution -> Blob-Read.
   - **Pfad-Kanonisierung (`shared/repoPaths.ts`):** `object(expression: "<oid>:<path>")` ist strikt — `./src/a.ts`, `/src/a.ts` und `src\a.ts` lösen alle zu `null` auf und sehen wie „Datei existiert nicht“ aus. `handlePatchRequest` normalisiert daher jeden `patches[].path` via `normalizeRepoPath` (Trim, `\` → `/`, führende `./` bzw. `/` entfernen, doppelte und abschließende Slashes entfernen) **vor** Batch-Read und Commit; `fetchMultipleFilesViaGraphQL` und `createCommitOnBranch` normalisieren zusätzlich defensiv. Leere Pfade, `..`/`.`-Segmente und Drive-Pfade werden über `findRepoPathIssue` als `PREFLIGHT_FAILED` (`stage: "SEARCH_REPLACE"`) abgewiesen, **bevor** GitHub kontaktiert wird. Der Fehlertext nennt Basisrevision und `action: "create"` als Alternative.
2. **Multi-Strategy Search/Replace (`applySearchReplace`):**
   - Behalte die 3-stufige Matching-Kaskade aus V1 bei:
     1. Exakter Substring-Match,
     2. Zeilenenden-normalisierter Match (`\r\n` <-> `\n`),
     3. Whitespace-toleranter Zeilen-Match (`trimEnd()` / `trim()`).
3. **Hard Guardrail (`validateNoPlaceholders`) & Non-Fail-Fast Aggregation:**
   - Prüfe jeden `replace`-Block und jeden `fullContent`-Block gegen `LLM_PLACEHOLDER_PATTERNS`. Bei Treffern oder nicht auflösbaren `search`-Blöcken wird **nicht** beim ersten Fehler abgebrochen, sondern über alle Dateien und Blöcke hinweg im Array `errors: LinterError[]` (`stage: "SEARCH_REPLACE"` bzw. `"CUSTOM_RULE"`) gesammelt.
4. **Idempotenz, Concurrency & `PreflightLinterHook`:**
   - Prüfe vorab `expectedHeadOid` gegen `getBranchHeadOid`; weicht der Branch-HEAD ab, gib sofort `status: "GIT_CONFLICT"` zurück.
   - Biete in `handlePatchRequest` einen typisierten Hook (`PreflightLinterHook`) sowie Basis-Prüfungen für `preflight.forbidPatterns` / `preflight.requireExports`, in den sich Stufe 4 (`linter.ts`) ohne Refactoring von `patcher.ts` einklinkt.
   - Die In-Memory-Verarbeitung und Preflight-Auswertung ist in `src/modules/patchInMemory.ts` gekapselt und bleibt über `patcher.ts` zu 100 % re-exportiert.
   - **Working-Tree-Komposition (mehrere Ops pro Datei):** `applyPatchesInMemory` hält einen mutierbaren `workingFiles`-Snapshot (Start = `existingFiles`) und schreibt jede erfolgreiche `create`/`modify`/`delete`-Operation sofort zurück. Jede Folgeoperation liest diesen Puffer, nicht den unveränderlichen Basis-Snapshot. `additions`/`deletions` werden **einmal pro Pfad** durch Diff des finalen `workingFiles` gegen `existingFiles` erzeugt; zwei `modify`-Einträge für dieselbe Datei ergeben daher genau einen `additions`-Eintrag und keinen doppelten Pfad im Commit.
   - Ergibt das Patchen exakt denselben Inhalt wie auf GitHub (`additions.length === 0 && deletions.length === 0`), gib `status: "NO_CHANGES_NEEDED"` zurück.
   - **Idempotenz bei bereits angewendeten Search/Replace-Blöcken:** Ist der `replace`-Text bereits vollständig im aktuellen Dateiinhalt enthalten, wird der Block als No-op gewertet (kein `SEARCH_REPLACE`-Fehler, kein Self-Healing-Loop). Dadurch liefert das erneute Anwenden eines bereits committeten Patches `NO_CHANGES_NEEDED` statt `PREFLIGHT_FAILED`. **Marker-Untergrenze:** `isAlreadyAppliedReplacement` (`patchInMemory.ts`) akzeptiert nur einen `replace`-Text mit mindestens `MIN_ALREADY_APPLIED_REPLACE_CHARS = 8` Nicht-Whitespace-Zeichen als Beweis. Ein generisches Fragment (`x`, `}`, `return`), das zufällig irgendwo in der Datei steht, darf einen fehlgeschlagenen `search` **nicht** in `NO_CHANGES_NEEDED` verwandeln.
   - **Insert-Style-Blöcke (`search` ist Teilstring von `replace`):** Solche Blöcke matchen nach dem Commit weiterhin auf ihren Anker, `applySearchReplace` würde die ergänzten Zeilen also erneut einfügen und duplizieren. `isInsertStyleBlockApplied` (`patchInMemory.ts`) erkennt den angewendeten Zustand deshalb **vor** dem Patchen über `replace.includes(search) && currentContent.includes(replace)` und überspringt den Block. Reine Replace-Style-Blöcke behalten die bisherige `catch`-Idempotenz; ein zufällig anderswo vorhandener identischer `replace`-Text führt dort zu keiner Fehlklassifikation.

5. **Target Branch & Atomic Branch Creation (`createBranchRef`, Stufe 7):**
   - Unterstützt optionalen abweichenden `targetBranch` in `WorkerPatchRequest`.
   - `req.expectedHeadOid` bleibt der Source-Branch-Frischecheck; `expectedTargetHeadOid?` ist ein separater, optionaler 40-stelliger Target-Concurrency-Token.
   - Bei vorhandenem Zielbranch werden Dateien vom Target-Branch gelesen und Search/Replace darauf ausgeführt. Der Commit verwendet exakt denselben Target-HEAD; ein targetseitiger Race bis zum Commit liefert `GIT_CONFLICT`, nicht einen Patch auf einem späteren HEAD.
   - Ein fehlender Zielbranch wird ausschließlich anhand des dedizierten Branch-Not-Found-Ergebnisses erkannt. Bei `createBranchIfNeeded !== false` wird er atomar an `req.expectedHeadOid` erzeugt; der von `createBranchRef` gelieferte `{ refName, oid }` dient direkt als Target-Basis (`headOid = createdRef.oid || req.expectedHeadOid`, `resolvedBranch = normalizeBranch(effectiveTargetBranch)`), sodass **kein** redundanter zweiter `getBranchHeadOid`-Roundtrip nötig ist. Nur wenn eine parallele Branch-Erstellung gewinnt (Create wirft), wird die Ref erneut aufgelöst und ihr tatsächlicher Inhalt verwendet; andere Lookup-/API-Fehler werden nicht als „fehlt“ behandelt.
   - `WorkerPatchResponse.newHeadOid` enthält bei `COMMITTED` und `NO_CHANGES_NEEDED` den effektiven Target-HEAD sowie `targetBranch`, damit Clients Target-OID-Ketten fortsetzen können. Commit-Antworten enthalten zusätzlich `createdBranch` und optional `pullRequestUrl`.

### C. Untertool C: `src/modules/linter.ts` & `src/modules/syntaxScanner.ts` (Stufe 4)
1. **Kein Fail-Fast (Fehler-Aggregation):**
   - Brich niemals beim ersten fehlgeschlagenen Search-Block oder Syntaxfehler ab. Sammle alle Fehler aus allen Dateien im Array `errors: LinterError[]` (`SEARCH_REPLACE`, `OXC_SYNTAX`, `CUSTOM_RULE`), damit Gemini alle Probleme in einem einzigen Korrektur-Turn beheben kann.
2. **Syntax- & AST-Prüfung (`validateSyntaxInWorker`):**
   - Deterministischer Lexer & Klammer-/Struktur-Verifier (< 5 ms Laufzeit im Worker-RAM) für `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` sowie `JSON.parse` für `.json` (gekapselt in `src/modules/syntaxScanner.ts`).
   - Erkennt nicht geschlossene Strings/Comments/Templates, Bracket-Mismatches und verbliebene Git-Merge-Conflict-Marker (`<<<<<<<`, `=======`, `>>>>>>>`).
   - **JSX-Sicherheit (`.tsx`, `.jsx`, `.js`, `.mjs`, `.cjs`):** `</tag>` darf nicht als Regex-Start und eine Kontraktion im JSX-Text (`Don't`, `it's`) nicht als String-Delimiter gelten. Ohne diese beiden Ausnahmen meldete der Lexer für jede valide React-Datei `Unterminated regular expression literal` bzw. `Unterminated string literal` und blockierte damit jeden Patch an `.tsx`-Dateien.
   - Unterstützt optionalen pluggbaren `registerOxcWasmParser` Hook.
3. **Automatischer Hook (`runPreflightLinter`):**
   - Fungiert als Standard-`preflightHook` in `applyPatchesInMemory` und `handlePatchRequest`, aggregiert Syntax- und Custom-Rules (`validateNoPlaceholders`, `forbidPatterns`, `requireExports`) und dedupliziert identische Fehler-Einträge.

### D. Untertool D: `src/modules/webhookHandler.ts` (Stufe 5 Hybrid Routing & Webhook)
1. **Zero Node.js Imports:**
   - Strikt reine Web-Standard-APIs (`crypto.subtle`, `fetch`, `Request`, `Response`, `TextEncoder`). Absolutes Verbot von Node.js-Modulen (`fs`, `child_process`, `simple-git`, `path`) im Worker-Kontext.
2. **Pure Web Crypto HMAC-SHA256 Signatur-Verifikation:**
   - Validiert den GitHub-Header `x-hub-signature-256` über `crypto.subtle.importKey` und `crypto.subtle.verify` (Timing-Attack-sicher).
3. **Sofortiges 202 Accepted & Hintergrund-Verarbeitung (`ctx.waitUntil`):**
   - Um den strikten 10-Sekunden-Timeout von GitHub-Webhooks einzuhalten, antwortet der Worker sofort mit `202 Accepted` und delegiert `executeWorkerWorkflow` (Mixer -> Gemini REST -> Patcher -> PR/Issue-Feedback-Kommentar) an `ctx.waitUntil`.

### E. Validierung vor Abschluss:
- Jede Änderung an `packages/edge-worker/` erfordert zwingend `tsc --noEmit` sowie einen erfolgreichen Lauf von `node scripts/patches_and_tests/worker-smoke.mjs` (inkl. aller 14 Probes mit harter `< 500`-Zeilen-Bedingung über alle aktiven TypeScript-Quelldateien).
