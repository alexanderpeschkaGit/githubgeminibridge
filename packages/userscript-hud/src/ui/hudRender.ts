import type { HarvestedPatch, HudConfig, HudState } from '../types';
import { injectPromptText } from '../dom/injector';
import { buildSelfHealingPrompt, MAX_SELF_HEALING_RETRIES } from '../services/selfHealing';
import { createHudElement, type HudDomElements } from './hudStylesAndDom';

export interface HudRenderDeps {
  dom: HudDomElements;
  state: HudState;
  config: HudConfig;
  updateState: (partial: Partial<HudState>) => void;
  onApplyPatch: (patch: HarvestedPatch) => void;
}

/** Renders the HUD status, linter errors and patch queue from the current state. */
export function renderHudState({ dom, state, config, updateState, onApplyPatch }: HudRenderDeps): void {
  dom.triggerBadge.className = `hud-trigger-badge ${state.status.toLowerCase()}`;
  dom.triggerBadge.textContent = state.status;

  if (state.headOid) {
    dom.oidBadge.textContent = state.headOid;
    dom.oidBadge.style.color = '#6ee7b7';
  } else {
    dom.oidBadge.textContent = '(Not mixed yet)';
    dom.oidBadge.style.color = '#94a3b8';
  }

  dom.retryIndicator.textContent = `(${state.retryCount}/3)`;
  dom.retryIndicator.title = `Self-Healing Retries: ${state.retryCount}/3`;

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
      const targetFiles: string[] = [];
      for (const p of state.harvestedPatches) {
        for (const op of p.payload?.patches || []) {
          if (op.path && !targetFiles.includes(op.path)) targetFiles.push(op.path);
        }
      }
      const prompt = buildSelfHealingPrompt(
        state.lastErrors,
        config.repo,
        config.branch,
        state.headOid,
        nextRetry,
        {
          targetFiles,
          targetBranch: config.targetBranch?.trim() || undefined
        }
      );
      injectPromptText(prompt, false);
      updateState({
        retryCount: nextRetry,
        statusMessage: `🔧 Injected self-healing prompt (Turn ${nextRetry}/${MAX_SELF_HEALING_RETRIES}) into chat.`,
      });
    };
    dom.statusBox.appendChild(healBtn);
  }

  const patchCount = state.harvestedPatches.length;
  const isBusy = state.status === 'PATCHING' || state.status === 'MIXING';

  if (state.continuationQueue && state.continuationQueue.length > 0) {
    const nextBatch = state.continuationQueue.slice(0, 10);
    const first = nextBatch[0]?.partIndex ?? 11;
    const last = nextBatch[nextBatch.length - 1]?.partIndex ?? first;
    const fileCount = nextBatch.reduce((sum, p) => sum + (p.stats?.fileCount ?? 0), 0);
    const totalRemaining = state.continuationQueue.length;

    dom.continueMixBtn.style.display = 'inline-flex';
    dom.continueMixBtn.disabled = isBusy;
    dom.continueMixBtn.textContent = `⏭️ Parts ${first}–${last}`;
    dom.continueMixBtn.title = `Inject Parts ${first}–${last} (${fileCount} files, ${totalRemaining} part(s) remaining in queue)`;
  } else {
    dom.continueMixBtn.style.display = 'none';
  }

  dom.checkAllBtn.disabled = patchCount === 0 || isBusy;
  dom.checkAllBtn.textContent = patchCount > 0 ? `🔍 Check (${patchCount})` : '🔍 Check All';
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
        onApplyPatch(patch);
      };

      meta.appendChild(itemTitle);
      meta.appendChild(itemSub);
      item.appendChild(meta);
      item.appendChild(applyBtn);
      dom.patchQueueEl.appendChild(item);
    });
  }
}
