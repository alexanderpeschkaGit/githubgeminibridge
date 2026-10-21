import type {
  HudConfig,
  HudState,
  HarvestedPatch,
} from '../types';
import {
  loadHudConfig,
} from '../services/storage';
import {
  requestRepoMix,
  requestBranchHead,
  requestWorkerPatch
} from '../services/workerClient';
import { injectRepoMixFile, injectRepoMixParts, injectPromptText } from '../dom/injector';
import {
  executeSelfHealingTurn,
  buildSelfHealingPrompt,
  MAX_SELF_HEALING_RETRIES,
} from '../services/selfHealing';
import {
  buildWorkerPatchRequest,
  isPatchSnapshotReady,
  patchSnapshotRequiredMessage,
  resolveConflictOidReset
} from '../services/patchOidState';
import { getRunningScriptVersion } from '../services/runtimeInfo';
import {
  applyPatchResponseOids,
  clearPatchOidState,
  clearTargetOidState,
  loadPatchOidState,
  setSourceHeadOid,
} from '../services/patchOidStore';
import {
  enqueueHarvestedPatch,
  removeHarvestedPatch,
  runPatchQueue,
} from '../services/patchQueue';
import { resolvePatchPaths } from '../services/patchPaths';
import { classifyRepoOwner, ownerOfRepo } from '../services/accountProfiles';
import { HUD_STYLES, HUD_SHADOW_STYLES, createHudElement, type HudDomElements } from './hudStylesAndDom';
import { buildHudDomTree } from './hudDomTree';
import { initHudUpdateBanner } from './updateBanner';
import { bindHudConfigInputs } from './hudConfigBindings';
import { bindAccountSwitch } from './hudAccountSwitch';

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

    const statusClasses: Record<string, string> = {
      ERROR: 'error', PREFLIGHT_FAILED: 'error', GIT_CONFLICT: 'error',
      COMMITTED: 'success', MIXING: 'info', PATCHING: 'info'
    };
    dom.statusBox.className = `hud-status-box ${statusClasses[state.status] || 'idle'}`;

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

    const patchCount = state.harvestedPatches.length;
    const isBusy = state.status === 'PATCHING' || state.status === 'MIXING';
    dom.applyAllBtn.disabled = patchCount === 0 || isBusy;
    dom.applyAllBtn.textContent = patchCount > 0 ? `⚡ Apply All (${patchCount})` : '⚡ Apply All';
    dom.clearQueueBtn.disabled = patchCount === 0 || isBusy;

    // Render Patch Queue
    dom.patchQueueEl.textContent = '';
    if (state.harvestedPatches.length === 0) {
      dom.patchQueueEl.appendChild(dom.emptyQueueMsg);
    } else {
      state.harvestedPatches.forEach((patch) => {
        const item = createHudElement('div', 'hud-patch-item');
        const meta = createHudElement('div', 'hud-patch-item-meta');
        const paths = (patch.payload.patches || []).map((p) => p.path);
        const pathLabel = paths.length > 0 ? paths.join(', ') : patch.commitMessage;
        const itemTitle = createHudElement(
          'div',
          'hud-patch-item-title',
          `${patch.mode === 'v2_json' ? '⚡' : '📝'} ${pathLabel}`
        );
        itemTitle.title = pathLabel;
        const itemSub = createHudElement('div', 'hud-patch-item-sub', patch.commitMessage);
        itemSub.title = patch.commitMessage;

        const applyBtn = createHudElement('button', 'hud-btn hud-btn-primary', 'Apply');
        applyBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';
        applyBtn.disabled = isBusy;
        applyBtn.onclick = () => {
          controller.handleApplyPatch(patch);
        };

        meta.appendChild(itemTitle);
        meta.appendChild(itemSub);
        item.appendChild(meta);
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

  bindHudConfigInputs({
    dom,
    config,
    state,
    resetPatchOidState,
    clearTargetOidState,
    renderState,
  });

  const applyAccountSwitch = bindAccountSwitch({ dom, config, state, resetPatchOidState, renderState });
  applyAccountSwitch();

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
        setSourceHeadOid(config, state, res.headOid);
        state.lastMixStats = res.stats;

        let injected = false;
        const metaCommits = res.stats.recentCommitsCount
          ? ` (incl. ${res.stats.recentCommitsCount} recent commits, ${res.stats.volatileFilesCount ?? 0} volatile files)`
          : '';

        if (res.parts && res.parts.length > 1) {
          const partBreakdown = res.parts
            .map((p) => `P${p.partIndex}: ${(p.stats.charCount ?? p.xmlContent.length).toLocaleString()} chars`)
            .join(', ');
          injected = injectRepoMixParts(
            res.parts.map((p) => ({ fileName: p.fileName, xmlContent: p.xmlContent }))
          );
          controller.updateState({
            status: 'IDLE',
            statusMessage: `✅ Loaded ${res.parts.length} parts (${res.stats.fileCount} files${metaCommits}, ~${res.stats.estimatedTokens} tokens) [${partBreakdown}]. Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}`,
          });
        } else {
          injected = injectRepoMixFile(res.xmlContent);
          const charLen = res.stats.charCount ?? res.xmlContent.length;
          controller.updateState({
            status: 'IDLE',
            statusMessage: `✅ Loaded ${res.stats.fileCount} files${metaCommits} (${charLen.toLocaleString()} chars, ~${res.stats.estimatedTokens} tokens). Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}`,
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

  const handleApplyPatch = async (patch: HarvestedPatch): Promise<boolean> => {
    if (onApplyPatchCustom) {
      return onApplyPatchCustom(patch);
    }

    controller.openPanel();

    // A patch without a detected path can never succeed. Ask once, keep the answer in
    // the queue entry so a retry/self-healing round does not prompt again.
    const resolvedPaths = resolvePatchPaths(patch.payload, (index, total) => {
      if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
        return null;
      }
      return window.prompt(
        `File path for patch ${index}/${total} (repo-relative, e.g. src/App.tsx):`,
        ''
      );
    });
    if (resolvedPaths.cancelled) {
      controller.updateState({
        status: 'ERROR',
        statusMessage: `❌ ${resolvedPaths.reason}`,
      });
      return false;
    }
    const effectivePayload = resolvedPaths.payload;
    state.harvestedPatches = state.harvestedPatches.map((entry) =>
      entry.id === patch.id ? { ...entry, payload: effectivePayload } : entry
    );

    controller.updateState({
      status: 'PATCHING',
      statusMessage: `⏳ Applying patch: "${patch.commitMessage}"...`,
    });

    // Foreign-owner guard: mixing public foreign repos stays allowed, but commits
    // need a PAT for that owner which no registered account provides.
    const ownerMatch = classifyRepoOwner(config);
    if (ownerMatch === 'foreign') {
      controller.updateState({
        status: 'ERROR',
        statusMessage: `❌ Patch blockiert: "${ownerOfRepo(config.repo)}" ist keiner der registrierten GitHub-Accounts. Öffentliche Repos können weiterhin gemischt werden, aber Commits brauchen einen PAT für diesen Owner.`,
      });
      return false;
    }

    try {
      // A missing snapshot (fresh install, cleared OID, repo switch, browser restart)
      // must not dead-end: resolve the branch's current HEAD through the worker and use
      // it as the concurrency token. The worker still validates it atomically on commit.
      if (!isPatchSnapshotReady(state)) {
        controller.updateState({
          status: 'PATCHING',
          statusMessage: `🔄 No snapshot OID — resolving current HEAD of ${config.repo}@${config.branch}...`,
        });
        try {
          const resolvedOid = await requestBranchHead(config, config.repo, config.branch);
          setSourceHeadOid(config, state, resolvedOid);
          controller.updateState({
            status: 'PATCHING',
            statusMessage: `🔄 Using current ${config.branch} HEAD ${resolvedOid.slice(0, 7)} as concurrency token (no repo mix snapshot).`,
          });
        } catch (resolveErr: any) {
          throw new Error(
            `${patchSnapshotRequiredMessage(config, patch.commitMessage)} (HEAD lookup failed: ${resolveErr.message || String(resolveErr)})`
          );
        }
      }

      if (state.headOid) {
        const patchReq = buildWorkerPatchRequest(config, state, effectivePayload);

        const res = await requestWorkerPatch(config, patchReq);
        if (res.status === 'COMMITTED') {
          state.harvestedPatches = removeHarvestedPatch(state.harvestedPatches, patch.id);
          applyPatchResponseOids(config, state, res);
          const branchLabel = res.targetBranch || config.branch;
          const prMsg = res.pullRequestUrl ? ` | 🔗 PR: ${res.pullRequestUrl}` : '';
          controller.updateState({
            status: 'COMMITTED',
            statusMessage: `✅ Committed to ${branchLabel}: ${res.newHeadOid ? res.newHeadOid.slice(0, 7) : 'OK'} (${patch.commitMessage})${prMsg}`,
            retryCount: 0,
            lastErrors: [],
          });
          return true;
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
          return false;
        }

        if (res.status === 'GIT_CONFLICT' || res.status === 'ERROR') {
          const scopeHint = res.status === 'GIT_CONFLICT'
            ? ` [validated ${config.repo}@${config.branch}]`
            : '';
          const resetScope = resolveConflictOidReset(res);
          if (resetScope === 'source') {
            clearPatchOidState(state);
          } else if (resetScope === 'target') {
            clearTargetOidState(state);
          }
          const recoveryHint = resetScope === 'source'
            ? ' Stale snapshot OID discarded — click "Load Repo Mix" to mix the current HEAD, then retry.'
            : resetScope === 'target'
              ? ` Target OID discarded — retry to commit on the current "${config.targetBranch}" HEAD.`
              : '';
          controller.updateState({
            status: res.status,
            statusMessage: `❌ ${res.status}: ${res.errorMessage || 'Preflight / Concurrency check failed'}${scopeHint}${recoveryHint}`,
            lastErrors: res.errors || [],
          });
          return false;
        }

        if (res.status === 'NO_CHANGES_NEEDED') {
          state.harvestedPatches = removeHarvestedPatch(state.harvestedPatches, patch.id);
          applyPatchResponseOids(config, state, res);
          controller.updateState({
            status: 'IDLE',
            statusMessage: `ℹ️ No changes needed (idempotent patch).`,
          });
          return true;
        }
      }

      // Without a mix snapshot there is no expectedHeadOid to validate against.
      // A silent V1 /push fallback would commit against an unknown revision.
      throw new Error(patchSnapshotRequiredMessage(config, patch.commitMessage));
    } catch (err: any) {
      controller.updateState({
        status: 'ERROR',
        statusMessage: `❌ Patch error: ${err.message || String(err)}`,
      });
      return false;
    }
  };

  dom.clearQueueBtn.onclick = () => {
    state.harvestedPatches = [];
    renderState();
  };

  dom.applyAllBtn.onclick = async () => {
    if (state.harvestedPatches.length === 0 || state.status === 'PATCHING' || state.status === 'MIXING') return;

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
