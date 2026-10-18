import type {
  HudConfig,
  HudState,
  HarvestedPatch,
  WorkerPatchRequest,
} from '../types';
import {
  loadHudConfig,
  saveHudConfig,
  sanitizeNoGithubPat,
  getStoredValue,
  setStoredValue
} from '../services/storage';
import {
  requestRepoMix,
  requestWorkerPatch,
  requestLegacyCommit
} from '../services/workerClient';
import { injectRepoMixFile, injectRepoMixParts, injectPromptText } from '../dom/injector';
import {
  executeSelfHealingTurn,
  buildSelfHealingPrompt,
  MAX_SELF_HEALING_RETRIES,
} from '../services/selfHealing';
import {
  HUD_STYLES,
  HUD_SHADOW_STYLES,
  createHudElement,
  buildHudDomTree,
  type HudDomElements
} from './hudStylesAndDom';

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
  handleApplyPatch: (patch: HarvestedPatch) => Promise<void>;
  addHarvestedPatch: (patch: HarvestedPatch) => void;
}

export function mountShadowHud(onApplyPatchCustom?: (patch: HarvestedPatch) => Promise<void>): ShadowHudController {
  if (typeof document === 'undefined') {
    throw new Error('mountShadowHud requires a DOM environment');
  }

  const config = loadHudConfig();
  const state: HudState = {
    headOid: getStoredValue('head_oid', ''),
    lastMixStats: null,
    status: 'IDLE',
    statusMessage: 'Ready. Load Repo Mix or commit patches.',
    retryCount: 0,
    lastErrors: [],
    harvestedPatches: [],
  };

  const dom = buildHudDomTree(config, state);

  // Helper to re-render UI state
  function renderState() {
    dom.triggerBadge.className = `hud-trigger-badge ${state.status.toLowerCase()}`;
    dom.triggerBadge.textContent = state.status;

    if (state.headOid) {
      dom.oidBadge.textContent = state.headOid;
      dom.oidBadge.style.color = '#6ee7b7';
    } else {
      dom.oidBadge.textContent = '(Not mixed yet)';
      dom.oidBadge.style.color = '#94a3b8';
    }

    dom.retryIndicator.textContent = `Retries: ${state.retryCount}/3`;

    dom.statusBox.className = `hud-status-box ${
      state.status === 'ERROR' || state.status === 'PREFLIGHT_FAILED' || state.status === 'GIT_CONFLICT'
        ? 'error'
        : state.status === 'COMMITTED'
        ? 'success'
        : state.status === 'MIXING' || state.status === 'PATCHING'
        ? 'info'
        : 'idle'
    }`;

    // Render status and any linter errors cleanly without innerHTML
    dom.statusBox.textContent = '';
    const mainMsg = createHudElement('div', undefined, state.statusMessage);
    dom.statusBox.appendChild(mainMsg);

    if (state.lastErrors && state.lastErrors.length > 0) {
      const errList = createHudElement('ul');
      errList.style.cssText = 'margin: 6px 0 0 16px; padding: 0; font-size: 11px;';
      state.lastErrors.forEach((err) => {
        const li = createHudElement('li', undefined, `[${err.stage}] ${err.file}: ${err.message}`);
        errList.appendChild(li);
      });
      dom.statusBox.appendChild(errList);

      const healBtn = createHudElement('button', 'hud-btn hud-btn-secondary', '🔧 Send Self-Healing Prompt to Chat');
      healBtn.style.cssText =
        'margin-top: 8px; width: 100%; font-size: 11px; padding: 5px 8px; border-color: #38bdf8; color: #38bdf8;';
      healBtn.onclick = () => {
        const nextRetry = (state.retryCount || 0) + 1;
        const prompt = buildSelfHealingPrompt(
          state.lastErrors,
          config.repo,
          config.branch,
          state.headOid,
          nextRetry
        );
        injectPromptText(prompt, false);
        controller.updateState({
          retryCount: nextRetry,
          statusMessage: `🔧 Injected self-healing prompt (Turn ${nextRetry}/${MAX_SELF_HEALING_RETRIES}) into chat.`,
        });
      };
      dom.statusBox.appendChild(healBtn);
    }

    // Render Patch Queue
    dom.patchQueueEl.textContent = '';
    if (state.harvestedPatches.length === 0) {
      dom.patchQueueEl.appendChild(dom.emptyQueueMsg);
    } else {
      state.harvestedPatches.forEach((patch) => {
        const item = createHudElement('div', 'hud-patch-item');
        const itemTitle = createHudElement(
          'div',
          'hud-patch-item-title',
          `${patch.mode === 'v2_json' ? '⚡' : '📝'} ${patch.commitMessage}`
        );
        itemTitle.title = patch.commitMessage;

        const applyBtn = createHudElement('button', 'hud-btn hud-btn-primary', 'Apply');
        applyBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';
        applyBtn.onclick = () => {
          controller.handleApplyPatch(patch);
        };

        item.appendChild(itemTitle);
        item.appendChild(applyBtn);
        dom.patchQueueEl.appendChild(item);
      });
    }
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

  // Input persistence
  dom.repoInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(dom.repoInput.value.trim(), 'repo');
      config.repo = sanitized;
      saveHudConfig({ repo: sanitized });
    } catch (e: any) {
      alert(e.message);
      dom.repoInput.value = config.repo;
    }
  };

  dom.branchInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(dom.branchInput.value.trim(), 'branch');
      config.branch = sanitized;
      saveHudConfig({ branch: sanitized });
    } catch (e: any) {
      alert(e.message);
      dom.branchInput.value = config.branch;
    }
  };

  dom.includePathsInput.onchange = () => {
    try {
      const raw = dom.includePathsInput.value.trim();
      const paths = raw.split(',').map((s) => s.trim()).filter(Boolean);
      config.includePaths = paths;
      saveHudConfig({ includePaths: paths });
    } catch (e: any) {
      alert(e.message);
      dom.includePathsInput.value = (config.includePaths || []).join(', ');
    }
  };

  dom.maxChunkCharsInput.onchange = () => {
    try {
      const val = parseInt(dom.maxChunkCharsInput.value, 10);
      const safe = Math.max(10000, Math.min(95000, Number.isFinite(val) ? val : 85000));
      config.maxChunkChars = safe;
      dom.maxChunkCharsInput.value = String(safe);
      saveHudConfig({ maxChunkChars: safe });
    } catch (e: any) {
      alert(e.message);
      dom.maxChunkCharsInput.value = String(config.maxChunkChars || 85000);
    }
  };

  dom.secretInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(dom.secretInput.value.trim(), 'workerSecret');
      config.workerSecret = sanitized;
      saveHudConfig({ workerSecret: sanitized });
    } catch (e: any) {
      alert(e.message);
      dom.secretInput.value = config.workerSecret;
    }
  };

  dom.autoPilotCheck.onchange = () => {
    config.autoPilot = dom.autoPilotCheck.checked;
    saveHudConfig({ autoPilot: config.autoPilot });
  };

  // Mix Repo Action
  dom.mixBtn.onclick = async () => {
    try {
      dom.mixBtn.disabled = true;
      dom.mixBtn.style.opacity = '0.6';
      controller.updateState({
        status: 'MIXING',
        statusMessage: `⏳ Streaming repo mix for ${config.repo} (${config.branch})...`,
      });

      const res = await requestRepoMix(config);
      if (res.status === 'OK' && (res.parts?.length || res.xmlContent)) {
        state.headOid = res.headOid;
        state.lastMixStats = res.stats;
        setStoredValue('head_oid', res.headOid);

        let injected = false;
        if (res.parts && res.parts.length > 1) {
          const partBreakdown = res.parts
            .map((p) => `P${p.partIndex}: ${(p.stats.charCount ?? p.xmlContent.length).toLocaleString()} chars`)
            .join(', ');
          injected = injectRepoMixParts(
            res.parts.map((p) => ({ fileName: p.fileName, xmlContent: p.xmlContent }))
          );
          controller.updateState({
            status: 'IDLE',
            statusMessage: `✅ Loaded ${res.parts.length} parts (${res.stats.fileCount} files, ~${res.stats.estimatedTokens} tokens) [${partBreakdown}]. Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}`,
          });
        } else {
          injected = injectRepoMixFile(res.xmlContent);
          const charLen = res.stats.charCount ?? res.xmlContent.length;
          controller.updateState({
            status: 'IDLE',
            statusMessage: `✅ Loaded ${res.stats.fileCount} files (${charLen.toLocaleString()} chars, ~${res.stats.estimatedTokens} tokens). Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}`,
          });
        }
      } else {
        controller.updateState({
          status: 'ERROR',
          statusMessage: `❌ Mix error: ${res.errorMessage || 'Unknown error'}`,
        });
      }
    } catch (err: any) {
      controller.updateState({
        status: 'ERROR',
        statusMessage: `❌ Mix error: ${err.message || String(err)}`,
      });
    } finally {
      dom.mixBtn.disabled = false;
      dom.mixBtn.style.opacity = '1';
    }
  };

  // Apply Patch Action
  const handleApplyPatch = async (patch: HarvestedPatch): Promise<void> => {
    if (onApplyPatchCustom) {
      return onApplyPatchCustom(patch);
    }

    controller.openPanel();
    controller.updateState({
      status: 'PATCHING',
      statusMessage: `⏳ Applying patch: "${patch.commitMessage}"...`,
    });

    try {
      if (state.headOid) {
        const patchReq: WorkerPatchRequest = {
          repo: config.repo,
          branch: config.branch,
          expectedHeadOid: state.headOid,
          payload: patch.payload,
        };

        const res = await requestWorkerPatch(config, patchReq);
        if (res.status === 'COMMITTED') {
          if (res.newHeadOid) {
            state.headOid = res.newHeadOid;
            setStoredValue('head_oid', res.newHeadOid);
          }
          controller.updateState({
            status: 'COMMITTED',
            statusMessage: `✅ Committed: ${res.newHeadOid ? res.newHeadOid.slice(0, 7) : ''} (${patch.commitMessage})`,
            retryCount: 0,
            lastErrors: [],
          });
          return;
        }

        if (res.status === 'PREFLIGHT_FAILED') {
          const selfHealingResult = executeSelfHealingTurn(res, config, state, true);
          if (selfHealingResult.triggered) {
            controller.updateState({
              status: 'PREFLIGHT_FAILED',
              statusMessage: `⚠️ Preflight failed. 🤖 Auto-Pilot self-healing prompt injected (Turn ${selfHealingResult.nextRetryCount}/${MAX_SELF_HEALING_RETRIES}).`,
              retryCount: selfHealingResult.nextRetryCount,
              lastErrors: res.errors || [],
            });
          } else {
            const reasonMsg =
              selfHealingResult.reason === 'MAX_RETRIES_EXCEEDED'
                ? `Max retries (${MAX_SELF_HEALING_RETRIES}) reached.`
                : 'Auto-pilot disabled.';
            controller.updateState({
              status: 'PREFLIGHT_FAILED',
              statusMessage: `❌ Preflight failed. ${reasonMsg} Review errors below or trigger manual retry.`,
              retryCount: selfHealingResult.nextRetryCount,
              lastErrors: res.errors || [],
            });
          }
          return;
        }

        if (res.status === 'GIT_CONFLICT' || res.status === 'ERROR') {
          controller.updateState({
            status: res.status,
            statusMessage: `❌ ${res.status}: ${res.errorMessage || 'Preflight / Concurrency check failed'}`,
            lastErrors: res.errors || [],
          });
          return;
        }

        if (res.status === 'NO_CHANGES_NEEDED') {
          controller.updateState({
            status: 'IDLE',
            statusMessage: `ℹ️ No changes needed (idempotent patch).`,
          });
          return;
        }
      }

      if (patch.legacyPayload) {
        controller.updateState({
          status: 'PATCHING',
          statusMessage: `⏳ Submitting legacy commit to /push...`,
        });
        const [owner, repoName] = config.repo.split('/');
        const legacyReq = {
          ...patch.legacyPayload,
          owner: owner || undefined,
          repo: repoName || config.repo,
          branch: config.branch,
        };
        const res = await requestLegacyCommit(config, legacyReq);
        controller.updateState({
          status: 'COMMITTED',
          statusMessage: `✅ Committed via legacy bridge: ${res?.commit?.oid ? res.commit.oid.slice(0, 7) : 'OK'}`,
          retryCount: 0,
          lastErrors: [],
        });
        return;
      }

      throw new Error('No headOid set and no legacy payload available. Please click "Load Repo Mix" first.');
    } catch (err: any) {
      controller.updateState({
        status: 'ERROR',
        statusMessage: `❌ Patch error: ${err.message || String(err)}`,
      });
    }
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
      if (!state.harvestedPatches.some((p) => p.id === patch.id)) {
        state.harvestedPatches.unshift(patch);
        if (state.harvestedPatches.length > 20) {
          state.harvestedPatches.pop();
        }
        renderState();
      }
    },
  };

  renderState();
  return controller;
}
