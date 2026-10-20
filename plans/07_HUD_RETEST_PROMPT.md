# Retest-Prompt (zum Einfügen in einen neuen Chat)

> Kopiere den folgenden Block unverändert als erste Nachricht in den neuen Chat.

---

Du übernimmst den E2E-Retest der Gemini Git Bridge nach dem HUD-OID-Scope-Fix.

**Projekt:** `y:\projekte2026\website\gitTrans\githubgeminibridge` (Monorepo: `packages/edge-worker/`, `packages/userscript-hud/`, `shared/`). Lies zuerst [plans/06_HUD_SCOPE_FIX_RETEST_PLAN.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/06_HUD_SCOPE_FIX_RETEST_PLAN.md), [plans/STATE.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/STATE.md) sowie die letzten 25 Zeilen von [plans/EXECUTION_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/EXECUTION_LOG.md) und [plans/TEST_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/TEST_LOG.md).

**Hintergrund (bereits verifiziert):**
- Userscript-Fix **2.0.3** (Commit `5332531`) scopt `head_oid` an `repo#branch`; nach Repo-/Branch-Wechsel wird die Snapshot-OID automatisch resettet.
- Zieldatei `src/hooks/feed/useModalCloseHandler.ts` existiert **nur auf `preview`** von `alexanderpeschkaGit/sikanda_projectinart_11-on-main` (auf `main` → 404).
- Der letzte Fehllauf sendete noch `expectedHeadOid = 639fb9e…` (alter Mix von `sikanda_projectinart_11@main`). Das heißt: **entweder** lief noch das 2.0.2-Userscript, **oder** nach dem Config-Wechsel wurde kein frischer Mix geladen.

**Korrigierte Ziel-Konfiguration:**
- Repo: `alexanderpeschkaGit/sikanda_projectinart_11-on-main`
- Branch (Quelle / Mix-Basis): `preview`
- Target Branch: `bridge` (existiert noch nicht → wird vom Worker aus `preview`@HEAD erzeugt)

**Ablauf:**
1. Prüfe im Tampermonkey-Dashboard, dass `gemini-bridge.user.js` die `@version 2.0.3` trägt. Falls 2.0.2 aktiv ist → erst updaten (Hard Stop, nicht weiter).
2. HUD öffnen und obige Config setzen. Der Repo-/Branch-Wechsel MUSS `🔄 … Snapshot OID reset — click "Load Repo Mix" …` anzeigen.
3. **„Load Repo Mix“ klicken.** Erwarteter Head: `65dbd851cd2f30f3d3e417809a2eddabc5eaf50a` (aktueller `preview`-HEAD). Erst wenn der Badge diese OID zeigt, weiter.
4. Patch für `src/hooks/feed/useModalCloseHandler.ts` aus dem Gemini-Chat über den Inline-`⚡`-Button in die Queue legen, dann `⚡ Apply All`.
5. Ergebnis interpretieren und read-only mit `gh api` verifizieren:
   - `COMMITTED` → neuer Commit auf `bridge`; `files[]` enthält **nur** `src/hooks/feed/useModalCloseHandler.ts`.
   - `main` von `…-on-main` bleibt unverändert auf `7151026`; Repo `sikanda_projectinart_11` erhält **keinen** Commit.
   - `NO_CHANGES_NEEDED` → Patch ist durch `28b5948`/`65dbd85` bereits enthalten; dokumentieren.
   - `GIT_CONFLICT` → nur noch echter Befund, und zwar genau dann, wenn die Meldung `[validated alexanderpeschkaGit/sikanda_projectinart_11-on-main@preview]` nennt.
6. Ergebnis in `plans/EXECUTION_LOG.md`, `plans/TEST_LOG.md`, `plans/STATE.md` dokumentieren; lokaler Checkpoint-Commit (nur diese 3 Dateien, pfad-spezifisch gestaged).

**Invarianten (deterministisch prüfbar):** kein Commit ohne frischen Mix; kein `/push`-Fallback (Meldung „No repo mix snapshot … Load Repo Mix first“ statt Commit); Idempotenz (zweites `Apply All` ⇒ `NO_CHANGES_NEEDED`). **Kein `git push`, kein `wrangler deploy`.**
