# Live-Deployment & Browser-E2E-Verifikationsplan (`02_LIVE_DEPLOYMENT_AND_E2E_PLAN.md`)

> **Status:** Als ausführungsfertiger Plan gespeichert (`PLAN_DONE`). Wird nach erfolgreichem Abschluss des 3-Punkte-Reviews ([plans/01_PROJECT_REVIEW_AND_HANDOFF.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/01_PROJECT_REVIEW_AND_HANDOFF.md)) und expliziter User-Freigabe für den Hard-Stop-Befehl `npx wrangler deploy` ausgeführt.

## Execution Metadata
- **Recommended Execution Model:** FLASH (`Model: 'flash'` für die deterministischen Build-/Deploy-/Smoke-Einzelbefehle mit `Complexity: 4/10 < 6`, gesteuert durch den Master-Orchestrator auf **Argon Medium**).
- **Complexity Assessment:** Isolierte Deployment- und Live-Endpunkt-Verifikationsschritte (`GET /health`, `POST /api/mix`, `POST /api/patch` Preflight/Idempotenz-Dry-Run) auf dem bereits vollständig getesteten Stand (`10/10 PASS`).

---

### 1. Architektur & Logik (5-Schritte Live-Rollout & E2E-Test)

1. **Schritt 1 – Pre-Deploy Gate & Userscript-Bundle-Check (Quiet Zone):**
   - Einzelne Ausführung von `node scripts/patches_and_tests/worker-smoke.mjs` (`10/10 PASS` Pflicht) und Prüfung von `git status --short`.
2. **Schritt 2 – Cloudflare Worker V2 Live-Deployment (Hard Stop – erfordert explizite User-Freigabe):**
   - Ausführung von `npx wrangler deploy` im Arbeitsverzeichnis `packages/edge-worker`.
   - Da `packages/edge-worker/wrangler.jsonc` den identischen Worker-Namen `"name": "gemini-git-bridge"` trägt, bleiben die auf Cloudflare gesetzten Secrets (`GITHUB_TOKEN` / `GITHUB_PAT` und `BRIDGE_SECRET` / `WORKER_SECRET`) nahtlos erhalten.
3. **Schritt 3 – Automatisierter Live-V2-Endpunkt-Test (`worker-smoke.mjs` Live-Probes):**
   - Prüfung von `GET https://gemini-git-bridge.sikanda.workers.dev/health` (erwartet `version: "2.0.0"`, `hasBridgeSecret: true`, `hasGithubToken: true`).
   - Lesender Live-Test von `POST https://gemini-git-bridge.sikanda.workers.dev/api/mix` (`persistToGitHub: false`) gegen das Ziel-Repository: verifiziert, dass der 1-Subrequest Tarball-Stream live eine 40-stellige `headOid`, valides `<repository>`-XML und `stats` liefert.
   - Nicht-destruktiver Live-Test von `POST https://gemini-git-bridge.sikanda.workers.dev/api/patch`:
     - Test A (Pre-Flight Linter Guardrail Live): Sendet einen absichtlich fehlerhaften Payload im Dry-Run (mit `// ... existing code ...` Platzhalter) und verifiziert, dass der Live-Worker ohne Commit sofort `status: "PREFLIGHT_FAILED"` mit `errors: LinterError[]` zurückgibt.
4. **Schritt 4 – Tampermonkey Userscript Installation & Browser-HUD-Test:**
   - Übernahme der Root-Datei [gemini-bridge.user.js](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/gemini-bridge.user.js) in Tampermonkey.
   - Öffnen von `https://gemini.google.com` bzw. `https://aistudio.google.com`:
     - Prüfung der Shadow-DOM-Pill (`⚡ Gemini Edge HUD`, `#gemini-edge-hud-root`).
     - Klick auf `📦 Load Repo Mix (/api/mix)` -> verifiziert das automatische Einfügen von `repo-mix.xml` in das Prompt-Feld und die Anzeige der 40-stelligen `headOid`.
5. **Schritt 5 – Abschluss-Dokumentation & Optionaler Git-Push:**
   - Protokollierung der Live-Testergebnisse in [plans/TEST_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/TEST_LOG.md), [plans/EXECUTION_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/EXECUTION_LOG.md) und [plans/STATE.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/STATE.md).
   - Lokaler Git-Commit des finalen Testprotokolls (und optional `git push` nach expliziter User-Freigabe).

---

### 2. Datei-Inventar

- [packages/edge-worker/wrangler.jsonc](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/packages/edge-worker/wrangler.jsonc) & [packages/edge-worker/src/index.ts](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/packages/edge-worker/src/index.ts) *(Bereits fertiggestellt – Deployment-Quelle)*
- [gemini-bridge.user.js](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/gemini-bridge.user.js) *(Bereits fertiggestellt & synchronisiert – Userscript-Release)*
- [scripts/patches_and_tests/worker-smoke.mjs](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/scripts/patches_and_tests/worker-smoke.mjs) *(Optional erweiterbar um Live-`/api/mix` & `/api/patch`-Dry-Run-Probe nach Deployment)*
- [plans/TEST_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/TEST_LOG.md), [plans/EXECUTION_LOG.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/EXECUTION_LOG.md), [plans/STATE.md](file:///y:/projekte2026/website/gitTrans/githubgeminibridge/plans/STATE.md) *(Live-Verifikations-Logging)*

---

### 3. Risiko- & Komplexitäts-Check

| Teilschritt | Komplexität (`1–10`) | Risiko & Absicherung | Ausführungs-Modell |
| :--- | :---: | :--- | :--- |
| **1. Pre-Deploy Smoke & Wrangler Deploy** | **`3 / 10`** | Bestehende Cloudflare-Secrets bleiben durch identischen Worker-Namen `gemini-git-bridge` erhalten; Rollback jederzeit über `_v1_backup/cf-gemini-git-bridge` möglich. | **Flash (`Model: 'flash'`)** nach User-Freigabe |
| **2. Live `/api/mix` & `/api/patch` Dry-Run** | **`4 / 10`** | Rein lesender `/api/mix`-Test (`persistToGitHub: false`) und absichtlicher `PREFLIGHT_FAILED`-Dry-Run erzeugen **keine** Commits auf GitHub. | **Flash (`Model: 'flash'`)** |
| **Gesamtausführung Deployment-Plan** | **`4 / 10`** | Unterhalb `Complexity < 6` -> vollständig über `/flash` Single-Action Protocol ausführbar. | **Flash (`Model: 'flash'`)** |

---

### 4. Optimierungshinweis

- Da die Gesamt-Komplexität bei **`4/10` (`< 6`)** liegt, können die Schritte 1 bis 3 nach deiner Freigabe für `npx wrangler deploy` in einem einzigen delegierten **Flash-Subagenten-Lauf (`Model: 'flash'`)** strikt nach dem Single-Action Protocol ausgeführt werden.

---

### 5. Git- & Checkpoint-Leitfaden

- **Pre-Commit Verification:** `node scripts/patches_and_tests/worker-smoke.mjs` muss `PASS` melden.
- **Path-Specific Staging:** `git add plans/STATE.md plans/EXECUTION_LOG.md plans/TEST_LOG.md scripts/patches_and_tests/worker-smoke.mjs`.
- **Commit Format:** `chore(release): verify live v2 edge worker deployment and e2e probes`.
- **Remote Safety:** `npx wrangler deploy` und `git push` erfolgen ausschließlich auf explizite Anweisung des Users.
