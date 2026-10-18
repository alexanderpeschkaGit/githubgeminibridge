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
| `/` oder `/health` | `GET` | Public | V1 + V2 | `index.ts` | Gibt `{ status: "ok", service: "gemini-git-bridge", version: "2.0.0", hasBridgeSecret: boolean, hasGithubToken: boolean }` zurück ( niemals Klartext-Secrets!). |
| `/api/mix` | `POST` | Bearer / `x-bridge-secret` | **V2 (Stufe 1)** | `modules/mixer.ts` | Body: `MixRequest` (`repo`, `branch`, `includePaths?`, `persistToGitHub?`). Streamt GitHub-Tarball (1 Subrequest), filtert im RAM und liefert `MixResponse` (`headOid`, `xmlContent`, `stats`). |
| `/api/patch` | `POST` | Bearer / `x-bridge-secret` | **V2 (Stufe 2 & 4)** | `modules/patcher.ts` + `modules/linter.ts` | Body: `WorkerPatchRequest` (`repo`, `branch`, `expectedHeadOid`, `payload: GeminiPatchPayload`). Führt Batch-Read, Search/Replace, Placeholder-Guardrail & `oxc-parser` WASM-Check aus. Liefert `WorkerPatchResponse` (`COMMITTED`, `PREFLIGHT_FAILED`, `GIT_CONFLICT`, `NO_CHANGES_NEEDED`, `ERROR`). |
| `/push`, `/commit`, `/api/commit`, `/` | `POST` | Bearer / `x-bridge-secret` | **V1 Legacy** | `modules/patcher.ts` (`handleCommitRequest`) | Body: `CommitRequestPayload` (`repo`, `targetBranch`, `commitMessage`, `changes[]`, `deletions[]`, `expectedHeadOid?`). Muss zu 100 % abwärtskompatibel für bestehende V1-Clients bleiben! |
| `/graphql` | `POST` | Bearer / `x-bridge-secret` | **V1 + V2** | `index.ts` (`handleGraphQLProxy`) | Body: `{ query: string, variables?: Record<string, unknown> }`. Authentifizierter Proxy zur GitHub GraphQL API v4. |
| `/api/webhook/github` | `POST` | HMAC-SHA256 (`x-hub-signature-256`) | **V2 (Stufe 5)** | `modules/webhookHandler.ts` | Body: GitHub Webhook JSON. Validiert HMAC per Web Crypto API, filtert `@gemini`-Trigger, liefert sofort `202 Accepted` und führt `executeWorkerWorkflow` (Mixer + Gemini REST + Patcher + PR/Issue Comment) asynchron via `ctx.waitUntil` aus. |

---

## 3. Technische Modul-Gesetze (Stufe 1, 2 & 4)

### A. Untertool A: `src/modules/mixer.ts` (1-Subrequest Tarball-Stream + Repomix-Filterlogik)
1. **1-Subrequest Tarball Streaming (`uithub`-Pattern):**
   - Lade das Repository in einem einzigen HTTP-Subrequest via `GET https://api.github.com/repos/{owner}/{repo}/tarball/{branch}` und dekomprimiere es on-the-fly mit `response.body.pipeThrough(new DecompressionStream('gzip'))`.
   - **Verboten:** Einzelabrufe über die GitHub Contents API in einer Schleife (sprengt das Limit von 50 Subrequests auf Cloudflare Workers).
2. **Exakte 40-stellige `headOid` Extraktion & Persist-Synchronisation:**
   - Lies im ersten 512-Byte-Block des TAR-Streams (`typeflag === 'g'`, PAX Global Extended Header) das Kommentarfeld `comment=<40-char-sha>` aus. Nutze das Hash-Suffix des Root-Ordnernamens als sekundären Pfad und führe bei verkürztem SHA (< 40 Zeichen) automatisch `getBranchHeadOid` als Fallback aus, damit `headOid` garantiert immer 40-stellig ist.
   - Wird `persistToGitHub === true` genutzt (`commitSingleFileViaGraphQL` nach `_context/repo-mix.xml`), wird `headOid` in der `MixResponse` auf die neue `persistedCommitOid` aktualisiert, damit nachfolgende `/api/patch`-Aufrufe keinen `GIT_CONFLICT` auslösen.
3. **USTAR & PAX Extended Path Support:**
   - Unterstütze Dateipfade > 100 Zeichen verlustfrei über das USTAR-`prefix`-Feld (Offset 345, Länge 155) sowie PAX Extended Header (`typeflag === 'x'`, `path=...`).
4. **128 MB RAM-Überlaufschutz & Repomix-inspirierte Ignore-Filter (Header-Level Stream-Skip):**
   - Überspringe folgende Pfade und Dateitypen **bereits anhand des 512-Byte-TAR-Headers** direkt im Stream (ohne Buffer-/String-Allokation) über `shouldSkipTarEntry`:
     - **Verzeichnisse:** `.git/`, `node_modules/`, `dist/`, `build/`, `.wrangler/`, `.turbo/`, `.next/`, `coverage/`, `_v1_backup/`, `repomix_*/`, `backup_unused/`.
     - **Lockfiles & Bundles:** `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `*.bundle`, `repomix-output*`, `*-bundle*.txt`.
     - **Binär- & Medien-Endungen:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.ico`, `.svg`, `.mp4`, `.webm`, `.mov`, `.mp3`, `.wav`, `.ogg`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.pdf`, `.zip`, `.tar`, `.gz`, `.7z`, `.wasm`, `.exe`, `.dll`, `.so`, `.dylib`, `.pyc`.
     - **Größen-Limit:** Einzeldateien `> 512 KB` (`524288` Bytes) werden im Stream übersprungen (und im `<file_tree>` mit `[SKIPPED: >512KB]` vermerkt).
5. **Strukturierter XML-Output (Repomix-kompatibel):**
   - Erzeuge valides XML im Format `<repository repo="..." branch="..." headOid="..."><file_tree>...</file_tree><files><file path="..."><![CDATA[...]]></file></files></repository>`.
   - Escape vorhandene `]]>`-Sequenzen im Dateiinhalt sicher als `]]]]><![CDATA[>` (`escapeCdata`), damit CDATA-Blöcke niemals aufbrechen.

### B. Untertool B: `src/modules/patcher.ts` & `src/modules/patchInMemory.ts` & `src/utils/github.ts` (Stufe 2)
1. **1-Subrequest GraphQL Batch-Read:**
   - Nutze `fetchMultipleFilesViaGraphQL` in `src/utils/github.ts`, um alle zu patchenden Dateien über dynamische GraphQL-Aliases (`f0: object(expression: $exp_0) { ... on Blob { text isTruncated } }`) in **einem einzigen** Subrequest zu laden.
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
   - Die in-Memory-Verarbeitung und Preflight-Auswertung ist in `src/modules/patchInMemory.ts` gekapselt und bleibt über `patcher.ts` zu 100 % re-exportiert.
   - Ergibt das Patchen exakt denselben Inhalt wie auf GitHub (`additions.length === 0 && deletions.length === 0`), gib `status: "NO_CHANGES_NEEDED"` zurück.

### C. Untertool C: `src/modules/linter.ts` & `src/modules/syntaxScanner.ts` (Stufe 4)
1. **Kein Fail-Fast (Fehler-Aggregation):**
   - Brich niemals beim ersten fehlgeschlagenen Search-Block oder Syntaxfehler ab. Sammle alle Fehler aus allen Dateien im Array `errors: LinterError[]` (`SEARCH_REPLACE`, `OXC_SYNTAX`, `CUSTOM_RULE`), damit Gemini alle Probleme in einem einzigen Korrektur-Turn beheben kann.
2. **Syntax- & AST-Prüfung (`validateSyntaxInWorker`):**
   - Deterministischer Lexer & Klammer-/Struktur-Verifier (< 5 ms Laufzeit im Worker-RAM) für `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` sowie `JSON.parse` für `.json` (gekapselt in `src/modules/syntaxScanner.ts`).
   - Erkennt nicht geschlossene Strings/Comments/Templates, Bracket-Mismatches und verbliebene Git-Merge-Conflict-Marker (`<<<<<<<`, `=======`, `>>>>>>>`).
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
- Jede Änderung an `packages/edge-worker/` erfordert zwingend `npx tsc --noEmit` (im Arbeitsverzeichnis `packages/edge-worker`) sowie einen erfolgreichen Lauf von `node scripts/patches_and_tests/worker-smoke.mjs` (inkl. aller 11 Probes mit harter `< 500`-Zeilen-Bedingung über alle aktiven TypeScript-Quelldateien).

