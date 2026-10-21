import type { HudConfig, HudState } from '../types';
import { getActiveProfileId } from '../services/storage';
import type { AccountProfileId } from '../services/storage';
import {
  ACCOUNT_PROFILES,
  classifyRepoOwner,
  isProfileConfigured,
  ownerOfRepo,
  switchAccountProfile,
  switchAccountProfileWithRepo,
} from '../services/accountProfiles';
import { createHudElement, type HudDomElements } from './hudStylesAndDom';

export interface AccountSwitchDeps {
  dom: HudDomElements;
  config: HudConfig;
  state: Pick<HudState, 'harvestedPatches'>;
  resetPatchOidState: (reason: string) => void;
  renderState: () => void;
}

let activeDeps: AccountSwitchDeps | null = null;

function profileInfo(id: AccountProfileId): { id: AccountProfileId; label: string; workerName: string } {
  return ACCOUNT_PROFILES.find((p) => p.id === id) ?? ACCOUNT_PROFILES[0];
}

function updateAccountButtons(): void {
  if (!activeDeps) return;
  const active = getActiveProfileId();
  const setBtn = (btn: HTMLButtonElement, id: AccountProfileId) => {
    if (id === active) {
      btn.className = 'hud-btn hud-btn-primary';
      btn.setAttribute('aria-pressed', 'true');
    } else {
      btn.className = 'hud-btn hud-btn-secondary';
      btn.setAttribute('aria-pressed', 'false');
    }
  };
  setBtn(activeDeps.dom.accountBtn1, 'account1');
  setBtn(activeDeps.dom.accountBtn2, 'account2');
}

/** Re-computes the owner classification hint; exported for reuse by config bindings. */
export function refreshAccountHint(): void {
  if (!activeDeps) return;
  const { dom, config } = activeDeps;
  const hint = dom.ownerHintEl;
  const match = classifyRepoOwner(config);

  if (match === 'active' || match === 'empty') {
    hint.textContent = '';
    hint.className = 'hud-account-hint';
    hint.style.display = 'none';
    return;
  }

  hint.textContent = '';
  hint.className = match === 'foreign' ? 'hud-account-hint foreign' : 'hud-account-hint';
  hint.style.display = 'block';

  if (match === 'foreign') {
    hint.textContent = `⚠️ Owner "${ownerOfRepo(config.repo)}" ist keiner der registrierten GitHub-Accounts. Öffentliche Repos können weiterhin gemischt werden; Patches sind blockiert (kein PAT für diesen Owner). Private Fremd-Repos scheitern auch beim Mix.`;
    return;
  }

  const info = profileInfo(match);
  const text = createHudElement('span', undefined, `⚠️ Dieses Repo gehört zu ${info.label} (${info.workerName}).`);
  const switchBtn = createHudElement('button', 'hud-btn hud-btn-secondary', `🔁 Zu ${info.label} wechseln`);
  switchBtn.type = 'button';
  switchBtn.onclick = () => switchViaHint(match);
  hint.appendChild(text);
  hint.appendChild(switchBtn);
}

function confirmSwitchDiscard(target: AccountProfileId): boolean {
  if (!activeDeps) return false;
  const count = activeDeps.state.harvestedPatches.length;
  if (count === 0) return true;
  const info = profileInfo(target);
  return window.confirm(
    `${count} geerntete Patches gehören zum aktiven Account und werden beim Wechsel zu ${info.label} verworfen. Trotzdem wechseln?`
  );
}

function switchViaHint(target: AccountProfileId): void {
  if (!activeDeps) return;
  if (!confirmSwitchDiscard(target)) return;
  applySwitched(switchAccountProfileWithRepo(target, activeDeps.dom.repoInput.value), target);
}

function applySwitched(next: HudConfig, target: AccountProfileId): void {
  if (!activeDeps) return;
  const { dom, config, state, resetPatchOidState, renderState } = activeDeps;
  const info = profileInfo(target);

  Object.assign(config, next);
  dom.ownerInput.value = next.owner;
  dom.workerUrlInput.value = next.workerUrl;
  dom.secretInput.value = next.workerSecret;
  dom.repoInput.value = next.repo;
  dom.branchInput.value = next.branch;
  dom.targetBranchInput.value = next.targetBranch || '';
  state.harvestedPatches = [];

  if (!isProfileConfigured(next)) {
    resetPatchOidState(
      `⚠️ ${info.label} ist noch nicht konfiguriert — Worker URL, Secret, Owner und Repo eintragen (Felder speichern beim Verlassen).`
    );
  } else {
    resetPatchOidState(`Account gewechselt zu ${info.label} (${info.workerName}) — Snapshot-OIDs zurückgesetzt.`);
  }

  updateAccountButtons();
  refreshAccountHint();
  renderState();
}

export function bindAccountSwitch(deps: AccountSwitchDeps): () => void {
  activeDeps = deps;
  const { dom } = deps;

  dom.accountBtn1.onclick = () => {
    if (!confirmSwitchDiscard('account1')) return;
    applySwitched(switchAccountProfile('account1'), 'account1');
  };
  dom.accountBtn2.onclick = () => {
    if (!confirmSwitchDiscard('account2')) return;
    applySwitched(switchAccountProfile('account2'), 'account2');
  };

  // Additional listeners (no conflict with the existing onchange handlers).
  dom.repoInput.addEventListener('change', refreshAccountHint);
  dom.ownerInput.addEventListener('change', refreshAccountHint);

  return () => {
    updateAccountButtons();
    refreshAccountHint();
  };
}
