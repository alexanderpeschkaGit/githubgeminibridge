import type {
  HudState,
  HarvestedPatch,
} from '../types';
import {
  loadHudConfig,
} from '../services/storage';
import { getRunningScriptVersion } from '../services/runtimeInfo';
import {
  clearPatchOidState,
  clearTargetOidState,
  loadPatchOidState,
} from '../services/patchOidStore';
import {
  enqueueHarvestedPatch,
  isDuplicatePatch,
  runPatchQueue,
} from '../services/patchQueue';
import { HUD_STYLES, HUD_SHADOW_STYLES, createHudElement, type HudDomElements } from './hudStylesAndDom';
import { buildHudDomTree } from './hudDomTree';
import { initHudUpdateBanner } from './updateBanner';
import { bindHudConfigInputs, setRepoHistorySelectRefresher } from './hudConfigBindings';
import { bindRepoHistoryDropdown } from './hudRepoHistoryDropdown';
import { bindAccountSwitch, refreshAccountHint } from './hudAccountSwitch';
import { renderHudState } from './hudRender';
import { bindMixAction } from './hudMixAction';
import { applyHudPatch, runHolisticQueuePatch } from './hudApplyPatch';

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
    continuationQueue: [],
  };

  const dom = buildHudDomTree(config, state);

  // Surfaces the actually executing script version: a stale Tampermonkey install is
  // otherwise indistinguishable from a logic bug when diagnosing HUD behaviour.
  const runningVersion = getRunningScriptVersion();
  if (runningVersion && dom.title) {
    dom.title.textContent = `⚡ Cloudflare Edge HUD v${runningVersion}`;
  }
  initHudUpdateBanner(dom);

  function updateState(partial: Partial<HudState>) {
    Object.assign(state, partial);
    renderState();
  }

  let supersededPatchIds = new Set<string>();

  /** Config changes invalidate every snapshot OID: they are repo+branch bound. */
  function resetPatchOidState(reason: string) {
    clearPatchOidState(state);
    supersededPatchIds.clear();
    state.continuationQueue = [];
    updateState({
      status: 'IDLE',
      statusMessage: `🔄 ${reason} Snapshot OID reset — click "Load Repo Mix" before applying patches.`,
      retryCount: 0,
      lastErrors: [],
      continuationQueue: [],
    });
  }

  // Helper to re-render UI state
  function renderState() {
    renderHudState({
      dom,
      state,
      config,
      updateState: (partial) => updateState(partial),
      onApplyPatch: (patch) => { void handleApplyPatch(patch); },
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

  const refreshRepoHistoryDropdown = bindRepoHistoryDropdown({
    dom,
    config,
    state,
    resetPatchOidState,
    clearTargetOidState,
    refreshAccountHint,
    renderState,
  });

  bindHudConfigInputs({
    dom,
    config,
    state,
    resetPatchOidState,
    clearTargetOidState,
    renderState,
  });

  setRepoHistorySelectRefresher(refreshRepoHistoryDropdown);

  const applyAccountSwitch = bindAccountSwitch({ dom, config, state, resetPatchOidState, renderState });
  applyAccountSwitch();

  bindMixAction({
    dom,
    config,
    state,
    updateState: (partial) => updateState(partial),
  });

  const handleApplyPatch = (patch: HarvestedPatch): Promise<boolean> =>
    applyHudPatch(patch, {
      config,
      state,
      openPanel,
      updateState: (partial) => updateState(partial),
      onApplyPatchCustom,
    });

  dom.clearQueueBtn.onclick = () => {
    state.harvestedPatches = [];
    supersededPatchIds.clear();
    renderState();
  };

  dom.checkAllBtn.onclick = async () => {
    if (state.harvestedPatches.length === 0 || state.status === 'PATCHING' || state.status === 'MIXING') return;
    await runHolisticQueuePatch({
      config,
      state,
      openPanel,
      updateState: (partial) => updateState(partial),
      dryRun: true,
      onMarkQueueSuperseded: (ids) => {
        supersededPatchIds = new Set(ids);
      },
    });
  };

  dom.applyAllBtn.onclick = async () => {
    if (state.harvestedPatches.length === 0 || state.status === 'PATCHING' || state.status === 'MIXING') return;

    if (onApplyPatchCustom) {
      const { applied, total } = await runPatchQueue(
        state.harvestedPatches,
        handleApplyPatch,
        (patch, index, totalCount) => {
          updateState({
            status: 'PATCHING',
            statusMessage: `⏳ [${index + 1}/${totalCount}] Applying patch: "${patch.commitMessage}"...`,
          });
        }
      );
      if (applied === total) {
        updateState({
          status: 'COMMITTED',
          statusMessage: `🎉 All ${applied} patches successfully applied and committed!`,
        });
      }
      return;
    }

    await runHolisticQueuePatch({
      config,
      state,
      openPanel,
      updateState: (partial) => updateState(partial),
      dryRun: false,
      onMarkQueueSuperseded: (ids) => {
        supersededPatchIds = new Set(ids);
      },
    });
  };

  const controller: ShadowHudController = {
    getState: () => ({ ...state }),
    updateState: (partial: Partial<HudState>) => {
      updateState(partial);
    },
    openPanel,
    closePanel,
    handleApplyPatch,
    addHarvestedPatch: (patch: HarvestedPatch) => {
      if (isDuplicatePatch(state.harvestedPatches, patch)) return;
      if (supersededPatchIds.size > 0) {
        state.harvestedPatches = state.harvestedPatches.filter((p) => !supersededPatchIds.has(p.id));
        supersededPatchIds.clear();
      }
      const next = enqueueHarvestedPatch(state.harvestedPatches, patch);
      if (next === state.harvestedPatches) return;
      state.harvestedPatches = next;
      renderState();
    },
  };

  renderState();
  return controller;
}
