import type {
  HudState,
  HarvestedPatch,
} from '../types';
import {
  loadHudConfig,
  saveHudConfig,
  sanitizeRepo,
} from '../services/storage';
import { getRunningScriptVersion } from '../services/runtimeInfo';
import {
  clearPatchOidState,
  clearTargetOidState,
  loadPatchOidState,
} from '../services/patchOidStore';
import {
  coalescePatchesIntoBatch,
  enqueueHarvestedPatch,
  runPatchQueue,
} from '../services/patchQueue';
import { HUD_STYLES, HUD_SHADOW_STYLES, createHudElement, type HudDomElements } from './hudStylesAndDom';
import { buildHudDomTree } from './hudDomTree';
import { initHudUpdateBanner } from './updateBanner';
import { bindHudConfigInputs, setRepoHistorySelectRefresher } from './hudConfigBindings';
import { loadRepoHistory, recordFromConfig } from '../services/repoHistory';
import { bindAccountSwitch, refreshAccountHint } from './hudAccountSwitch';
import { renderHudState } from './hudRender';
import { bindMixAction } from './hudMixAction';
import { applyHudPatch } from './hudApplyPatch';

export {
  HUD_STYLES,
  HUD_SHADOW_STYLES,
  createHudElement,
  buildHudDomTree,
  type HudDomElements
};

export interface ShadowHudController {
  getState: () => HudState;
  updateState: (partial: Partial<HudState>) => void;
  openPanel: () => void;
  closePanel: () => void;
  handleApplyPatch: (patch: HarvestedPatch) => Promise<boolean>;
  addHarvestedPatch: (patch: HarvestedPatch) => void;
}

export function mountShadowHud(onApplyPatchCustom?: (patch: HarvestedPatch) => Promise<boolean>): ShadowHudController {
  if (typeof document === 'undefined') {
    throw new Error('mountShadowHud requires a DOM environment');
  }

  const config = loadHudConfig();
  const state: HudState = {
    ...loadPatchOidState(config),
    lastMixStats: null,
    status: 'IDLE',
    statusMessage: config.workerSecret
      ? 'Ready. Load Repo Mix or commit patches.'
      : 'Set your Worker Secret (WORKER_SECRET) in the panel before using the bridge.',
    retryCount: 0,
    lastErrors: [],
    harvestedPatches: [],
  };

  const dom = buildHudDomTree(config, state);

  // Surfaces the actually executing script version: a stale Tampermonkey install is
  // otherwise indistinguishable from a logic bug when diagnosing HUD behaviour.
  const runningVersion = getRunningScriptVersion();
  if (runningVersion && dom.title) {
    dom.title.textContent = `⚡ Cloudflare Edge HUD v${runningVersion}`;
  }
  initHudUpdateBanner(dom);

  /** Config changes invalidate every snapshot OID: they are repo+branch bound. */
  function resetPatchOidState(reason: string) {
    clearPatchOidState(state);
    controller.updateState({
      status: 'IDLE',
      statusMessage: `🔄 ${reason} Snapshot OID reset — click "Load Repo Mix" before applying patches.`,
      retryCount: 0,
      lastErrors: [],
    });
  }

  // Helper to re-render UI state
  function renderState() {
    renderHudState({
      dom,
      state,
      config,
      updateState: (partial) => controller.updateState(partial),
      onApplyPatch: (patch) => { controller.handleApplyPatch(patch); },
    });
  }

  // Toggle Panel
  const openPanel = () => {
    dom.panel.classList.add('open');
  };
  const closePanel = () => {
    dom.panel.classList.remove('open');
  };

  dom.trigger.onclick = () => {
    if (dom.panel.classList.contains('open')) {
      closePanel();
    } else {
      openPanel();
    }
  };
  dom.closeBtn.onclick = closePanel;

  const refreshRepoHistorySelectUI = () => {
    const select = dom.repoHistorySelect;
    if (!select) return;
    const previousIndex = select.value;
    const entries = loadRepoHistory();

    select.textContent = '';
    const placeholder = createHudElement('option', undefined, 'Select a previous repo...');
    (placeholder as HTMLOptionElement).value = '';
    select.appendChild(placeholder);

    entries.forEach((entry, index) => {
      const option = createHudElement('option', undefined);
      option.value = String(index);
      const repoLabel = entry.repo.includes('/') ? entry.repo : `${entry.owner}/${entry.repo}`;
      const target = entry.targetBranch ? ` -> ${entry.targetBranch}` : '';
      option.textContent = `${repoLabel} @ ${entry.branch}${target}`;
      select.appendChild(option);
    });

    select.disabled = entries.length === 0;
    select.value = previousIndex && entries[Number(previousIndex)] ? previousIndex : '';
  };

  const applyRepoHistorySelection = () => {
    const select = dom.repoHistorySelect;
    if (!select) return;
    const index = Number(select.value);
    const entries = loadRepoHistory();
    const entry = Number.isInteger(index) && index >= 0 ? entries[index] : undefined;
    if (!entry) {
      select.value = '';
      return;
    }

    const previousRepo = config.repo;
    const previousBranch = config.branch;
    const previousTarget = config.targetBranch || '';

    config.owner = entry.owner || config.owner;
    config.repo = sanitizeRepo(entry.repo || config.repo);
    config.branch = entry.branch || config.branch;
    config.targetBranch = entry.targetBranch || '';

    dom.ownerInput.value = config.owner;
    dom.repoInput.value = config.repo;
    dom.branchInput.value = config.branch;
    dom.targetBranchInput.value = config.targetBranch || '';

    saveHudConfig({
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      targetBranch: config.targetBranch,
    });

    const repoOrBranchChanged = config.repo !== previousRepo || config.branch !== previousBranch;
    if (repoOrBranchChanged) {
      resetPatchOidState(`Switched to "${config.repo} @ ${config.branch}".`);
    } else if ((config.targetBranch || '') !== previousTarget) {
      clearTargetOidState(state);
    }

    recordFromConfig(config);
    refreshRepoHistorySelectUI();
    select.value = '';
    refreshAccountHint();
    renderState();
  };

  bindHudConfigInputs({
    dom,
    config,
    state,
    resetPatchOidState,
    clearTargetOidState,
    renderState,
  });

  dom.repoHistorySelect.onchange = applyRepoHistorySelection;
  setRepoHistorySelectRefresher(refreshRepoHistorySelectUI);
  refreshRepoHistorySelectUI();

  const applyAccountSwitch = bindAccountSwitch({ dom, config, state, resetPatchOidState, renderState });
  applyAccountSwitch();

  bindMixAction({
    dom,
    config,
    state,
    updateState: (partial) => controller.updateState(partial),
  });

  const handleApplyPatch = (patch: HarvestedPatch): Promise<boolean> =>
    applyHudPatch(patch, {
      config,
      state,
      openPanel,
      updateState: (partial) => controller.updateState(partial),
      onApplyPatchCustom,
    });

  dom.clearQueueBtn.onclick = () => {
    state.harvestedPatches = [];
    renderState();
  };

  dom.applyAllBtn.onclick = async () => {
    if (state.harvestedPatches.length === 0 || state.status === 'PATCHING' || state.status === 'MIXING') return;

    // One atomic commit for the whole queue: all patches are linted together and
    // a preflight failure leaves the individual queue entries untouched.
    if (state.harvestedPatches.length > 1) {
      const batch = coalescePatchesIntoBatch(state.harvestedPatches);
      if (batch) {
        const total = state.harvestedPatches.length;
        const fileCount = new Set(batch.payload.patches.map((entry) => entry.path)).size;
        controller.updateState({
          status: 'PATCHING',
          statusMessage: `⏳ Applying atomic batch of ${total} patches across ${fileCount} file(s) in 1 commit...`,
        });

        const committed = await handleApplyPatch(batch);
        if (committed) {
          state.harvestedPatches = [];
          controller.updateState({
            status: 'COMMITTED',
            statusMessage: `🎉 Atomic batch (${total} patches across ${fileCount} files) committed in 1 commit!`,
          });
        }
        return;
      }
    }

    const { applied, total } = await runPatchQueue(
      state.harvestedPatches,
      handleApplyPatch,
      (patch, index, totalCount) => {
        controller.updateState({
          status: 'PATCHING',
          statusMessage: `⏳ [${index + 1}/${totalCount}] Applying patch: "${patch.commitMessage}"...`,
        });
      }
    );

    // Fail-fast: the failing patch already published its own error status.
    if (applied < total) return;

    controller.updateState({
      status: 'COMMITTED',
      statusMessage: `🎉 All ${applied} patches successfully applied and committed!`,
    });
  };

  const controller: ShadowHudController = {
    getState: () => ({ ...state }),
    updateState: (partial: Partial<HudState>) => {
      Object.assign(state, partial);
      renderState();
    },
    openPanel,
    closePanel,
    handleApplyPatch,
    addHarvestedPatch: (patch: HarvestedPatch) => {
      const next = enqueueHarvestedPatch(state.harvestedPatches, patch);
      if (next === state.harvestedPatches) return;
      state.harvestedPatches = next;
      renderState();
    },
  };

  renderState();
  return controller;
}
