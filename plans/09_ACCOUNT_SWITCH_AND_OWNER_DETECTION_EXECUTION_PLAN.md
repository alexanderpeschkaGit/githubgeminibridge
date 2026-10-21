# Plan 09 — HUD Account-Switch & Owner-Erkennung (Execution Artifact)

> Fixierter Plan aus der `#grillme`-Runde (Komplexität 7/10 → `pro`/`inherit`).
> Ziel: Ein-Klick-Wechsel zwischen den beiden GitHub-Accounts im HUD **plus** Owner-Erkennung aus dem Repo-Feld. Fremde Owner werden gewarnt, öffentliche Fremd-Repos bleiben mix-bar, Patches auf Fremd-Owner werden im HUD vor dem Senden blockiert.

## Entscheidungen (fixiert)

| Frage | Entscheidung |
|---|---|
| Owner-Quelle | Eigenes „GitHub Owner"-Feld pro Profil (nicht aus repo-Feld ableiten) |
| Repo gehört dem anderen Profil | Inline-Hinweis + Button „🔁 Zu Account N wechseln" (kein Auto-Switch) |
| Repo-Wechsel via Hinweis | `typed_wins`: das getippte Repo wird ins Zielprofil übernommen |
| Fremd-Owner | Mix erlaubt, Patch im HUD blockiert (kein Netzwerk-Call) |
| Warnung-Platzierung | Statusbox + Inline-Hinweis am Repo-Feld, nicht-blockierend |
| Manuelle Buttons | Bleiben zusätzlich bestehen (`👤 Account 1` / `👤 Account 2`) |
| Default-Owner | Account 1 = `alexanderpeschkaGit` (aus migriertem `owner_repo` geseedet), Account 2 = `vijaysikanda` |

## Harte Constraints (P1)

1. **Niemals GITHUB_PAT im Browser** — `sanitizeNoGithubPat` gilt für alle neuen Speicherpfade (läuft automatisch in `setStoredValue`).
2. **`< 500 Zeilen pro TS-Datei`** (Probe 10). `shadowHud.ts` hat aktuell ~471 Zeilen → neue Logik in Module, nicht inline.
3. **OID-/Queue-Sicherheit:** Account-Wechsel ⇒ `resetPatchOidState()` + Queue leeren (Patches sind konto-gebunden).
4. **Kein Import-Zyklus:** `accountProfiles.ts` (services) darf nichts aus `ui/` importieren.
5. **Kein Account-2-Fallback auf Account-1-Werte:** Bei leerem Profil `account2` muss `loadHudConfig()` leere/Default-Werte liefern — nie die `account1`-Werte erben.
6. **Nicht anfassen:** Edge-Worker, `wrangler.jsonc`, Secrets, Deployments. Kein `git push`, kein `wrangler deploy`.

## Referenz-Callsites (aktueller Stand)

- `HudConfig`-Konstruktion nur an 2 Stellen: `DEFAULT_HUD_CONFIG` + `loadHudConfig()` in `packages/userscript-hud/src/services/storage.ts`.
- Patch-Request: `requestWorkerPatch(config, patchReq)` in `packages/userscript-hud/src/ui/shadowHud.ts` (~Zeile 345, im `if (state.headOid)`-Block).
- `bindHudConfigInputs({...})`-Aufruf in `shadowHud.ts` (~Zeile 215); `const controller` wird erst am Datei-Ende deklariert → **keine Controller-Referenz in `bindAccountSwitch` verwenden** (TDZ); Feedback über `resetPatchOidState(message)`.
- Storage-Keys aktuell: `worker_url`, `worker_secret`, `owner_repo`, `branch`, `target_branch`, `active_profile` (neu).
- Test-Muster: `scripts/patches_and_tests/test-recent-commits-opt-in.mjs` (esbuild-Bundle + GM-Shim + `node:assert`).

## Schritt 1 — `types.ts`: `owner` ergänzen

`packages/userscript-hud/src/types.ts` → `HudConfig` nach `workerSecret` einfügen:

```ts
owner: string;
```

## Schritt 2 — `storage.ts`: Profil-Keys, Migration, profil-first Load

`packages/userscript-hud/src/services/storage.ts`:

1. Exporte ergänzen:

```ts
export type AccountProfileId = 'account1' | 'account2';
const PROFILE_FIELDS = ['worker_url', 'worker_secret', 'owner', 'owner_repo', 'branch', 'target_branch'] as const;
const PROFILE_MIGRATION_KEY = 'account_profiles_migration_v1';

export function getActiveProfileId(): AccountProfileId {
  return getStoredValue('active_profile', 'account1') === 'account2' ? 'account2' : 'account1';
}
```

2. Migration (einmalig; Seeds aus Legacy-Flat-Keys):

```ts
function migrateAccountProfiles(): void {
  if (getStoredValue(PROFILE_MIGRATION_KEY, '') === 'true') return;
  for (const key of PROFILE_FIELDS) {
    const legacy = getStoredValue(key, '');
    if (legacy) setStoredValue(`account1_${key}`, legacy);
  }
  if (!getStoredValue('account1_owner', '')) {
    const legacyRepo = sanitizeRepo(getStoredValue('owner_repo', ''));
    const ownerFromRepo = legacyRepo.split('/')[0].trim();
    setStoredValue('account1_owner', ownerFromRepo || 'alexanderpeschkaGit');
  }
  if (!getStoredValue('account2_owner', '')) {
    setStoredValue('account2_owner', 'vijaysikanda');
  }
  setStoredValue(PROFILE_MIGRATION_KEY, 'true');
}
```

3. `DEFAULT_HUD_CONFIG`: `owner: 'alexanderpeschkaGit'` ergänzen.

4. `loadHudConfig()`: ganz oben `migrateAccountProfiles();` aufrufen, dann:

```ts
const profile = getActiveProfileId();
const readProfile = (key: string, fallback: string) => {
  const stored = getStoredValue(`${profile}_${key}`, '');
  if (stored) return stored;
  if (profile === 'account1') return getStoredValue(key, fallback);
  return fallback; // account2: KEIN Legacy-Fallback → keine Account-1-Werte!
};
```

Alle 6 Profilfelder umstellen (Fallbacks wie bisher aus `DEFAULT_HUD_CONFIG`, **außer für `account2`, dort `''`** — auch `workerUrl` und `repo`!):

```ts
const a2 = profile === 'account2';
const workerUrl = readProfile('worker_url', a2 ? '' : DEFAULT_HUD_CONFIG.workerUrl);
const workerSecret = readProfile('worker_secret', a2 ? '' : DEFAULT_HUD_CONFIG.workerSecret);
const owner = readProfile('owner', a2 ? '' : DEFAULT_HUD_CONFIG.owner);
const repo = sanitizeRepo(readProfile('owner_repo', a2 ? '' : DEFAULT_HUD_CONFIG.repo));
const branch = readProfile('branch', a2 ? '' : DEFAULT_HUD_CONFIG.branch);
const targetBranch = readProfile('target_branch', a2 ? '' : DEFAULT_HUD_CONFIG.targetBranch);
```

Nicht-Profilfelder (`include_paths`, `auto_pilot`, `persist_to_github`, `max_chunk_chars`, `include_recent_commits`) bleiben global/flat. Rückgabe-Objekt enthält zusätzlich `owner`.

5. `saveHudConfig()`: bestehende Flat-Writes **unverändert lassen** (Legacy-Spiegel) und in jedem der 6 Profilfeld-Blöcke zusätzlich den Profil-Key schreiben:

```ts
const profile = getActiveProfileId();
// Bsp. im workerUrl-Block:
setStoredValue(`${profile}_worker_url`, sanitizeNoGithubPat(updated.workerUrl, 'workerUrl'));
```

Zuordnung: `workerUrl→worker_url`, `workerSecret→worker_secret`, `owner→owner`, `repo→owner_repo`, `branch→branch`, `targetBranch→target_branch`.

## Schritt 3 — NEU `services/accountProfiles.ts`

Neue Datei `packages/userscript-hud/src/services/accountProfiles.ts` (~90 Zeilen). Nur Imports aus `../types` und `./storage`. Kein DOM.

```ts
import type { HudConfig } from '../types';
import { getActiveProfileId, getStoredValue, loadHudConfig, sanitizeRepo, setStoredValue, type AccountProfileId } from './storage';

export const ACCOUNT_PROFILES = [
  { id: 'account1' as const, label: 'Account 1', workerName: 'gemini-git-bridge' },
  { id: 'account2' as const, label: 'Account 2', workerName: 'gemini-git-bridge-account2' },
];

export function isProfileConfigured(cfg: HudConfig): boolean {
  return Boolean(cfg.workerUrl && cfg.workerSecret);
}

export function switchAccountProfile(target: AccountProfileId): HudConfig {
  setStoredValue('active_profile', target);
  return loadHudConfig();
}

/** typed_wins: getipptes Repo wird vor dem Wechsel ins Zielprofil übernommen. */
export function switchAccountProfileWithRepo(target: AccountProfileId, repo: string): HudConfig {
  const cleaned = sanitizeRepo(repo);
  if (cleaned) setStoredValue(`${target}_owner_repo`, cleaned);
  setStoredValue('active_profile', target);
  return loadHudConfig();
}

export function ownerOfRepo(repo: string): string {
  const cleaned = (repo || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '');
  return cleaned.split('/')[0].trim().toLowerCase();
}

export type RepoOwnerMatch = 'active' | 'account1' | 'account2' | 'foreign' | 'empty';

export function classifyRepoOwner(cfg: HudConfig): RepoOwnerMatch {
  const owner = ownerOfRepo(cfg.repo);
  if (!owner) return 'empty';
  if (owner === (cfg.owner || '').trim().toLowerCase()) return 'active';
  const active = getActiveProfileId();
  const other = active === 'account1' ? 'account2' : 'account1';
  const otherOwner = getStoredValue(`${other}_owner`, '').trim().toLowerCase();
  if (otherOwner && owner === otherOwner) return other;
  return 'foreign';
}
```

## Schritt 4 — NEU `ui/hudAccountSwitch.ts`

Neue Datei `packages/userscript-hud/src/ui/hudAccountSwitch.ts` (~110 Zeilen). Kein Import von `shadowHud`. Signatur:

```ts
export interface AccountSwitchDeps {
  dom: HudDomElements;
  config: HudConfig;
  state: Pick<HudState, 'harvestedPatches'>;
  resetPatchOidState: (reason: string) => void;
  renderState: () => void;
}

export function bindAccountSwitch(deps: AccountSwitchDeps): () => void
```

Verhalten:

1. **Initial-Call** (Rückgabe-Funktion) zeichnet Button-Zustand (`getActiveProfileId()` → aktiver Button `hud-btn-primary` + `aria-pressed="true"`, anderer `hud-btn-secondary`) und ruft `refreshAccountHint()`.
2. **`refreshAccountHint()`** (exportiert, auch von `hudConfigBindings` aufrufbar):
   - `const match = classifyRepoOwner(config)`.
   - `match === 'active' || 'empty'` → `dom.ownerHintEl` verstecken (`display:none`, `textContent=''`).
   - `match === 'account1' || 'account2'` → Hint zeigen: Text `⚠️ Dieses Repo gehört zu Account N (workerName).` + Button `🔁 Zu Account N wechseln` (Klasse `hud-btn hud-btn-secondary`, kleine Schrift). Button-Click = `switchViaHint(match)`.
   - `match === 'foreign'` → Hint zeigen (Warnfarbe): Text `⚠️ Owner "X" ist keiner der registrierten GitHub-Accounts. Öffentliche Repos können weiterhin gemischt werden; Patches sind blockiert (kein PAT für diesen Owner). Private Fremd-Repos scheitern auch beim Mix.` — kein Button.
   - Hint-Text **nur via `textContent`** setzen (kein innerHTML).
3. **`switchViaHint(target)`:** Falls `state.harvestedPatches.length > 0` → `confirm('… N geerntete Patches gehören zum aktiven Account und werden verworfen. Trotzdem wechseln?')`; bei Abbruch return. Dann `applySwitched(switchAccountProfileWithRepo(target, dom.repoInput.value), target)`.
4. **Manuelle Buttons:** `dom.accountBtn1/2.onclick` → gleicher Confirm-Guard, dann `applySwitched(switchAccountProfile(target), target)` (ohne Repo-Override).
5. **`applySwitched(next: HudConfig, target: AccountProfileId)`:** `Object.assign(config, next)`; DOM-Felder synchronisieren: `ownerInput, workerUrlInput, secretInput, repoInput, branchInput, targetBranchInput` aus `next`; `state.harvestedPatches = []`; `resetPatchOidState(\`Account gewechselt zu ${label} (${workerName}) — Snapshot-OIDs zurückgesetzt.\`)`; bei `!isProfileConfigured(next)` stattdessen `resetPatchOidState(\`⚠️ ${label} ist noch nicht konfiguriert — Worker URL, Secret, Owner und Repo eintragen (Felder speichern beim Verlassen).\`)`; danach `refreshAccountHint()` + `renderState()`.
6. **`dom.repoInput`-Listener:** zusätzlich `addEventListener('change', refreshAccountHint)` registrieren (nach dem bestehenden `onchange`-Handler; kein Konflikt).

## Schritt 5 — `hudDomTree.ts`: Owner-Feld, Account-Buttons, Hint

`packages/userscript-hud/src/ui/hudDomTree.ts`:

1. **Nach dem Repo-Row-Block** (~Zeile 62) einfügen:
   - Owner-Row: Label `GitHub Owner (active account)`, Input `hud-input`, `ownerInput.value = config.owner`.
   - Hint-Element: `const ownerHintEl = createHudElement('div', 'hud-account-hint'); ownerHintEl.style.display = 'none'; body.appendChild(ownerHintEl);`
2. **Nach dem Worker-URL-Row** (~Zeile 117) einfügen: Account-Row mit Label `GitHub Account`, Flex-Gruppe mit `accountBtn1` (`👤 Account 1`) und `accountBtn2` (`👤 Account 2`), beide `hud-btn hud-btn-secondary`, `type='button'`.
3. Rückgabe-Objekt erweitern: `ownerInput, accountBtn1, accountBtn2, ownerHintEl`.

## Schritt 6 — `hudStylesAndDom.ts`: Typ + CSS

1. `HudDomElements` ergänzen: `ownerInput: HTMLInputElement; accountBtn1: HTMLButtonElement; accountBtn2: HTMLButtonElement; ownerHintEl: HTMLDivElement;`
2. In `HUD_STYLES` (vor dem Template-Ende) kleines CSS ergänzen:

```css
.hud-account-hint {
  margin-top: 4px;
  padding: 5px 8px;
  font-size: 11px;
  border-left: 3px solid #38bdf8;
  background: rgba(56, 189, 248, 0.08);
  color: #e2e8f0;
}
.hud-account-hint.foreign { border-color: #fbbf24; background: rgba(251, 191, 36, 0.08); }
.hud-account-hint .hud-btn { margin-left: 6px; padding: 2px 6px; font-size: 10px; }
```

## Schritt 7 — `shadowHud.ts`: Binden + Patch-Guard

1. Nach dem `bindHudConfigInputs({...})`-Block:

```ts
const applyAccountSwitch = bindAccountSwitch({ dom, config, state, resetPatchOidState, renderState });
applyAccountSwitch();
```

(`state` ist das volle `HudState` — passt zu `Pick<HudState,'harvestedPatches'>`.)

2. Import ergänzen: `import { classifyRepoOwner, ownerOfRepo } from '../services/accountProfiles';` und `import { bindAccountSwitch } from './hudAccountSwitch';`
3. **Patch-Guard** in `handleApplyPatch` direkt vor dem `try {` (nach dem `PATCHING`-Update, vor der Snapshot-Auflösung):

```ts
const ownerMatch = classifyRepoOwner(config);
if (ownerMatch === 'foreign') {
  controller.updateState({
    status: 'ERROR',
    statusMessage: `❌ Patch blockiert: "${ownerOfRepo(config.repo)}" ist keiner der registrierten GitHub-Accounts. Öffentliche Repos können weiterhin gemischt werden, aber Commits brauchen einen PAT für diesen Owner.`,
  });
  return false;
}
```

Mix-Pfad (`dom.mixBtn.onclick`) bleibt **unverändert** — fremde öffentliche Repos mixen weiter.

## Schritt 8 — NEU `scripts/patches_and_tests/test-account-profiles.mjs`

Eigenständiges Node-Skript nach Muster `test-recent-commits-opt-in.mjs` (esbuild-Bundle von `services/storage.ts` + `services/accountProfiles.ts` als data-URL, GM-Shim, `node:assert`). Testfälle:

1. **Frischer Store** → `loadHudConfig()`: `getActiveProfileId()==='account1'`; `account1_worker_url` aus Legacy geseedet; `account1_owner==='alexanderpeschkaGit'` (aus Legacy-Repo-Owner); `account2_owner==='vijaysikanda'`; Marker `account_profiles_migration_v1==='true'`.
2. **Save spiegelt Profil:** bei aktivem `account1` setzt `saveHudConfig({workerSecret:'s1'})` sowohl `worker_secret` als auch `account1_worker_secret`.
3. **Kein Account-1-Leak:** `setStoredValue('active_profile','account2')`; `loadHudConfig()` → `repo===''`, `workerSecret===''`, `workerUrl===''` (nicht die Account-1-Werte).
4. **Round-Trip:** Account 2 konfigurieren (`workerUrl`, `workerSecret:'s2'`, `owner:'vijaysikanda'`, `repo:'vijaysikanda/xyz'`) → zu Account 1 → Werte von Account 1 intakt → zurück zu Account 2 → `s2`/`vijaysikanda/xyz` intakt.
5. **Klassifikation:** bei aktivem `account1` und `owner='alexanderpeschkaGit'`: Repo `alexanderpeschkaGit/x`→`active`; `vijaysikanda/x`→`account2`; `fremd/x`→`foreign`; `''`→`empty`.
6. **typed_wins:** `switchAccountProfileWithRepo('account2','vijaysikanda/neuesRepo')` → `loadHudConfig().repo==='vijaysikanda/neuesRepo'`.
7. **PAT-Guardrail:** `assert.throws(() => saveHudConfig({ workerSecret: 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }))`.

Ende: `console.log('Account profiles & owner detection contract: PASS');` + `process.exit(0)` bei Erfolg.

## Schritt 9 — Regression-Registrierung

`scripts/patches_and_tests/run-regressions.mjs` → `LOCAL_SUITES` ergänzen:

```js
{
  id: 'account-profiles',
  script: 'test-account-profiles.mjs',
  finding: 'Profile-scoped storage, migration seeds, foreign-owner classification and typed-wins account switch',
},
```

## Schritt 10 — Build & Verifikation

Nur lokale Befehle (Quiet Zone), keine Secrets, kein Deploy:

```powershell
cd packages\userscript-hud
npm run typecheck
cd ..\..
node scripts/patches_and_tests/test-account-profiles.mjs
node scripts/patches_and_tests/run-regressions.mjs
node scripts/patches_and_tests/worker-smoke.mjs
```

- Probe 10 (Datei-Size-Audit `< 500 Zeilen`) muss mit den 2 neuen Dateien grün sein.
- `worker-smoke.mjs` schreibt `worker-baseline.json` neu (Snapshot) — Diff danach prüfen: nur additive/erwartete Änderungen (neue Dateien, ggf. Zeilenzahl-Drift der editierten Dateien), nichts Inhaltliches.
- Fix-Loop: bei Fehlern beheben und nur die betroffenen Befehle erneut fahren, bis alles grün.

## Schritt 11 — Release + Doku + Commit

1. `cd packages\userscript-hud` → `npm run release:patch` (→ 2.0.13, sync des Root-`gemini-bridge.user.js`; `@version 2.0.13` im Banner verifizieren).
2. Doku anpassen (kurz halten):
   - `.agents/rules/userscript-shadow-hud.md`: neue Module `accountProfiles.ts`/`hudAccountSwitch.ts`, neue Storage-Keys (`active_profile`, `account1_*`, `account2_*`, Owner-Feld), Account-Switch- & Owner-Erkennungs-Verhalten (Mix erlaubt / Patch geblockt bei Fremd-Owner).
   - `agents.md`: P1-Zeile „Browser Shadow-DOM HUD" um Account-Switch + Owner-Erkennung ergänzen.
   - `plans/08_TWO_GITHUB_ACCOUNTS_PLAN.md`: Abschnitt „Step 7b — Account-Switch-Button & Owner-Erkennung" (Kurzfassung dieses Plans).
3. Logging-Pflicht (`orchestrator-protocol.md`): `PLAN_START`/`PLAN_DONE` + `START`/`DONE` je Schritt in `plans/EXECUTION_LOG.md`; `plans/STATE.md` auf „Plan 09 abgeschlossen" setzen.
4. Git-Checkpoint-Commit (Quiet Zone erlaubt; **kein push**):

```
feat(hud): account switch buttons + owner detection with foreign-owner patch guard

- profile-scoped storage (account1_*/account2_*) with one-time migration
- Account 1/2 switch buttons, owner field per profile, typed-repo-wins hint switch
- foreign-owner warning: mix allowed, patches blocked client-side
- test-account-profiles.mjs + regression suite entry

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Abnahmekriterien

- [ ] `typecheck`, `run-regressions.mjs`, `worker-smoke.mjs` grün (inkl. Probe 10 `< 500` Zeilen)
- [ ] Root-`gemini-bridge.user.js` = 2.0.13, enthält Account-Buttons + Owner-Feld
- [ ] Kein einziger `github_pat_…`-String in HUD-Quellen (grep-Gegenprobe)
- [ ] Kein Import von `ui/` in `services/accountProfiles.ts`
- [ ] Edge-Worker/Wrangler/Secrets unverändert (`git status`-Review)
- [ ] Doku + Logs aktualisiert, lokaler Commit gesetzt
