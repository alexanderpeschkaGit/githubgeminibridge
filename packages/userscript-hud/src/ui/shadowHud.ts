import type {
  HudConfig,
  HudState,
  HarvestedPatch,
  WorkerPatchRequest,
  LinterError,
} from '../types';
import { loadHudConfig, saveHudConfig, sanitizeNoGithubPat, getStoredValue, setStoredValue } from '../services/storage';
import { requestRepoMix, requestWorkerPatch, requestLegacyCommit } from '../services/workerClient';
import { injectRepoMixFile, injectPromptText } from '../dom/injector';
import {
  executeSelfHealingTurn,
  buildSelfHealingPrompt,
  shouldTriggerSelfHealing,
  MAX_SELF_HEALING_RETRIES,
} from '../services/selfHealing';

const HUD_STYLES = `
  :host {
    all: initial;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * {
    box-sizing: border-box;
  }
  .hud-trigger {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    background: linear-gradient(135deg, #0f172a, #1e293b);
    color: #38bdf8;
    border: 1px solid rgba(56, 189, 248, 0.5);
    border-radius: 28px;
    padding: 10px 18px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
  }
  .hud-trigger:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 28px rgba(56, 189, 248, 0.4);
    background: #0284c7;
    color: #ffffff;
  }
  .hud-trigger-badge {
    padding: 2px 7px;
    border-radius: 12px;
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    background: rgba(56, 189, 248, 0.2);
    color: #38bdf8;
  }
  .hud-trigger-badge.idle { background: #334155; color: #94a3b8; }
  .hud-trigger-badge.mixing { background: #0284c7; color: #ffffff; }
  .hud-trigger-badge.patching { background: #d97706; color: #ffffff; }
  .hud-trigger-badge.committed { background: #059669; color: #ffffff; }
  .hud-trigger-badge.error { background: #dc2626; color: #ffffff; }

  .hud-panel {
    position: fixed;
    bottom: 80px;
    right: 24px;
    width: 440px;
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 120px);
    background: #0f172a;
    border: 1px solid rgba(56, 189, 248, 0.35);
    border-radius: 16px;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.75);
    color: #f1f5f9;
    z-index: 2147483647;
    display: none;
    flex-direction: column;
    overflow: hidden;
    animation: hudFadeIn 0.2s ease-out;
  }
  .hud-panel.open {
    display: flex;
  }
  @keyframes hudFadeIn {
    from { opacity: 0; transform: translateY(10px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .hud-header {
    padding: 14px 18px;
    background: #1e293b;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .hud-title {
    font-size: 14px;
    font-weight: 700;
    color: #38bdf8;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hud-close-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 6px;
  }
  .hud-close-btn:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.1);
  }
  .hud-body {
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .hud-form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hud-label {
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .hud-input {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 7px 10px;
    color: #f8fafc;
    font-size: 12px;
    font-family: monospace;
    outline: none;
    transition: border-color 0.2s;
  }
  .hud-input:focus {
    border-color: #38bdf8;
    box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
  }
  .hud-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.2s;
    user-select: none;
  }
  .hud-btn-primary {
    background: linear-gradient(135deg, #0284c7, #0369a1);
    color: #ffffff;
    border-color: #38bdf8;
  }
  .hud-btn-primary:hover {
    background: #0284c7;
    box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
  }
  .hud-btn-secondary {
    background: #1e293b;
    color: #cbd5e1;
    border-color: #334155;
  }
  .hud-btn-secondary:hover {
    background: #334155;
    color: #ffffff;
  }
  .hud-badge-oid {
    background: #022c22;
    border: 1px solid #059669;
    color: #6ee7b7;
    font-family: monospace;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 6px;
    word-break: break-all;
    display: inline-block;
  }
  .hud-status-box {
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.4;
    border: 1px solid transparent;
    word-break: break-word;
  }
  .hud-status-box.info { background: #0c4a6e; color: #7dd3fc; border-color: #0284c7; }
  .hud-status-box.success { background: #064e3b; color: #6ee7b7; border-color: #059669; }
  .hud-status-box.error { background: #7f1d1d; color: #fca5a5; border-color: #dc2626; }
  .hud-status-box.idle { background: #1e293b; color: #94a3b8; border-color: #334155; }

  .hud-toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: #cbd5e1;
  }
  .hud-patch-queue {
    border: 1px solid #334155;
    border-radius: 8px;
    background: #182234;
    padding: 8px;
    max-height: 150px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hud-patch-item {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 6px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    gap: 8px;
  }
  .hud-patch-item-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #e2e8f0;
    flex: 1;
  }
`;

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

  // Remove existing host container if present
  const existing = document.getElementById('gemini-edge-hud-root');
  if (existing) {
    existing.remove();
  }

  const host = document.createElement('div');
  host.id = 'gemini-edge-hud-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  document.body.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: 'open' });

  // Stylesheet
  const styleEl = document.createElement('style');
  styleEl.textContent = HUD_STYLES;
  shadowRoot.appendChild(styleEl);

  // Initial config and state
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

  // Build UI Elements purely with DOM APIs (Zero innerHTML for Trusted Types!)
  const trigger = document.createElement('div');
  trigger.className = 'hud-trigger';
  
  const triggerIcon = document.createElement('span');
  triggerIcon.textContent = '⚡';
  const triggerLabel = document.createElement('span');
  triggerLabel.textContent = 'Gemini Edge HUD';
  const triggerBadge = document.createElement('span');
  triggerBadge.className = 'hud-trigger-badge idle';
  triggerBadge.textContent = 'IDLE';

  trigger.appendChild(triggerIcon);
  trigger.appendChild(triggerLabel);
  trigger.appendChild(triggerBadge);
  shadowRoot.appendChild(trigger);

  // Drawer Panel
  const panel = document.createElement('div');
  panel.className = 'hud-panel';

  // Panel Header
  const header = document.createElement('div');
  header.className = 'hud-header';

  const title = document.createElement('div');
  title.className = 'hud-title';
  title.textContent = '⚡ Cloudflare Edge HUD (Stage 3)';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'hud-close-btn';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close Panel';

  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Panel Body
  const body = document.createElement('div');
  body.className = 'hud-body';

  // Repo row
  const repoRow = document.createElement('div');
  repoRow.className = 'hud-form-row';
  const repoLabel = document.createElement('span');
  repoLabel.className = 'hud-label';
  repoLabel.textContent = 'GitHub Repository (owner/repo)';
  const repoInput = document.createElement('input');
  repoInput.className = 'hud-input';
  repoInput.value = config.repo;
  repoRow.appendChild(repoLabel);
  repoRow.appendChild(repoInput);
  body.appendChild(repoRow);

  // Branch row
  const branchRow = document.createElement('div');
  branchRow.className = 'hud-form-row';
  const branchLabel = document.createElement('span');
  branchLabel.className = 'hud-label';
  branchLabel.textContent = 'Branch';
  const branchInput = document.createElement('input');
  branchInput.className = 'hud-input';
  branchInput.value = config.branch;
  branchRow.appendChild(branchLabel);
  branchRow.appendChild(branchInput);
  body.appendChild(branchRow);

  // Worker Secret row (Protected by sanitizeNoGithubPat)
  const secretRow = document.createElement('div');
  secretRow.className = 'hud-form-row';
  const secretLabel = document.createElement('span');
  secretLabel.className = 'hud-label';
  secretLabel.textContent = 'Worker Secret (WORKER_SECRET)';
  const secretInput = document.createElement('input');
  secretInput.type = 'password';
  secretInput.className = 'hud-input';
  secretInput.value = config.workerSecret;
  secretRow.appendChild(secretLabel);
  secretRow.appendChild(secretInput);
  body.appendChild(secretRow);

  // Head OID badge row
  const oidRow = document.createElement('div');
  oidRow.className = 'hud-form-row';
  const oidLabel = document.createElement('span');
  oidLabel.className = 'hud-label';
  oidLabel.textContent = 'Head OID (Optimistic Concurrency)';
  const oidBadge = document.createElement('div');
  oidBadge.className = 'hud-badge-oid';
  oidBadge.textContent = state.headOid || '(Not mixed yet)';
  oidRow.appendChild(oidLabel);
  oidRow.appendChild(oidBadge);
  body.appendChild(oidRow);

  // Action Buttons row: Mix Repo
  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'display: flex; gap: 8px;';

  const mixBtn = document.createElement('button');
  mixBtn.className = 'hud-btn hud-btn-primary';
  mixBtn.style.flex = '1';
  mixBtn.textContent = '📦 Load Repo Mix (/api/mix)';

  actionRow.appendChild(mixBtn);
  body.appendChild(actionRow);

  // Options row: Auto-Pilot toggle
  const optRow = document.createElement('div');
  optRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between;';

  const autoPilotLabel = document.createElement('label');
  autoPilotLabel.className = 'hud-toggle-label';
  const autoPilotCheck = document.createElement('input');
  autoPilotCheck.type = 'checkbox';
  autoPilotCheck.checked = config.autoPilot;
  const autoPilotText = document.createElement('span');
  autoPilotText.textContent = '🤖 Auto-Pilot Self-Healing';
  autoPilotLabel.appendChild(autoPilotCheck);
  autoPilotLabel.appendChild(autoPilotText);

  const retryIndicator = document.createElement('span');
  retryIndicator.style.cssText = 'font-size: 11px; color: #94a3b8;';
  retryIndicator.textContent = `Retries: ${state.retryCount}/3`;

  optRow.appendChild(autoPilotLabel);
  optRow.appendChild(retryIndicator);
  body.appendChild(optRow);

  // Patch Queue Container
  const queueLabel = document.createElement('span');
  queueLabel.className = 'hud-label';
  queueLabel.textContent = 'Harvested Patches';
  body.appendChild(queueLabel);

  const patchQueueEl = document.createElement('div');
  patchQueueEl.className = 'hud-patch-queue';
  const emptyQueueMsg = document.createElement('div');
  emptyQueueMsg.style.cssText = 'color: #64748b; font-size: 11px; text-align: center; padding: 6px;';
  emptyQueueMsg.textContent = 'No patches harvested from chat yet.';
  patchQueueEl.appendChild(emptyQueueMsg);
  body.appendChild(patchQueueEl);

  // Status & Error Box
  const statusBox = document.createElement('div');
  statusBox.className = 'hud-status-box idle';
  statusBox.textContent = state.statusMessage;
  body.appendChild(statusBox);

  panel.appendChild(body);
  shadowRoot.appendChild(panel);

  // Helper to re-render UI state
  function renderState() {
    triggerBadge.className = `hud-trigger-badge ${state.status.toLowerCase()}`;
    triggerBadge.textContent = state.status;

    if (state.headOid) {
      oidBadge.textContent = state.headOid;
      oidBadge.style.color = '#6ee7b7';
    } else {
      oidBadge.textContent = '(Not mixed yet)';
      oidBadge.style.color = '#94a3b8';
    }

    retryIndicator.textContent = `Retries: ${state.retryCount}/3`;

    statusBox.className = `hud-status-box ${
      state.status === 'ERROR' || state.status === 'PREFLIGHT_FAILED' || state.status === 'GIT_CONFLICT'
        ? 'error'
        : state.status === 'COMMITTED'
        ? 'success'
        : state.status === 'MIXING' || state.status === 'PATCHING'
        ? 'info'
        : 'idle'
    }`;

    // Render status and any linter errors cleanly without innerHTML
    statusBox.textContent = '';
    const mainMsg = document.createElement('div');
    mainMsg.textContent = state.statusMessage;
    statusBox.appendChild(mainMsg);

    if (state.lastErrors && state.lastErrors.length > 0) {
      const errList = document.createElement('ul');
      errList.style.cssText = 'margin: 6px 0 0 16px; padding: 0; font-size: 11px;';
      state.lastErrors.forEach((err) => {
        const li = document.createElement('li');
        li.textContent = `[${err.stage}] ${err.file}: ${err.message}`;
        errList.appendChild(li);
      });
      statusBox.appendChild(errList);

      const healBtn = document.createElement('button');
      healBtn.className = 'hud-btn hud-btn-secondary';
      healBtn.style.cssText =
        'margin-top: 8px; width: 100%; font-size: 11px; padding: 5px 8px; border-color: #38bdf8; color: #38bdf8;';
      healBtn.textContent = '🔧 Send Self-Healing Prompt to Chat';
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
      statusBox.appendChild(healBtn);
    }

    // Render Patch Queue
    patchQueueEl.textContent = '';
    if (state.harvestedPatches.length === 0) {
      patchQueueEl.appendChild(emptyQueueMsg);
    } else {
      state.harvestedPatches.forEach((patch) => {
        const item = document.createElement('div');
        item.className = 'hud-patch-item';

        const itemTitle = document.createElement('div');
        itemTitle.className = 'hud-patch-item-title';
        itemTitle.textContent = `${patch.mode === 'v2_json' ? '⚡' : '📝'} ${patch.commitMessage}`;
        itemTitle.title = patch.commitMessage;

        const applyBtn = document.createElement('button');
        applyBtn.className = 'hud-btn hud-btn-primary';
        applyBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';
        applyBtn.textContent = 'Apply';
        applyBtn.onclick = () => {
          controller.handleApplyPatch(patch);
        };

        item.appendChild(itemTitle);
        item.appendChild(applyBtn);
        patchQueueEl.appendChild(item);
      });
    }
  }

  // Toggle Panel
  const openPanel = () => {
    panel.classList.add('open');
  };
  const closePanel = () => {
    panel.classList.remove('open');
  };

  trigger.onclick = () => {
    if (panel.classList.contains('open')) {
      closePanel();
    } else {
      openPanel();
    }
  };
  closeBtn.onclick = closePanel;

  // Input persistence
  repoInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(repoInput.value.trim(), 'repo');
      config.repo = sanitized;
      saveHudConfig({ repo: sanitized });
    } catch (e: any) {
      alert(e.message);
      repoInput.value = config.repo;
    }
  };

  branchInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(branchInput.value.trim(), 'branch');
      config.branch = sanitized;
      saveHudConfig({ branch: sanitized });
    } catch (e: any) {
      alert(e.message);
      branchInput.value = config.branch;
    }
  };

  secretInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(secretInput.value.trim(), 'workerSecret');
      config.workerSecret = sanitized;
      saveHudConfig({ workerSecret: sanitized });
    } catch (e: any) {
      alert(e.message);
      secretInput.value = config.workerSecret;
    }
  };

  autoPilotCheck.onchange = () => {
    config.autoPilot = autoPilotCheck.checked;
    saveHudConfig({ autoPilot: config.autoPilot });
  };

  // Mix Repo Action
  mixBtn.onclick = async () => {
    try {
      mixBtn.disabled = true;
      mixBtn.style.opacity = '0.6';
      controller.updateState({
        status: 'MIXING',
        statusMessage: `⏳ Streaming repo mix for ${config.repo} (${config.branch})...`,
      });

      const res = await requestRepoMix(config);
      if (res.status === 'OK' && res.xmlContent) {
        state.headOid = res.headOid;
        state.lastMixStats = res.stats;
        setStoredValue('head_oid', res.headOid);

        // Inject file into prompt
        const injected = injectRepoMixFile(res.xmlContent);

        controller.updateState({
          status: 'IDLE',
          statusMessage: `✅ Loaded ${res.stats.fileCount} files (~${res.stats.estimatedTokens} tokens). Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}`,
        });
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
      mixBtn.disabled = false;
      mixBtn.style.opacity = '1';
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
      // V2 Patch flow if expectedHeadOid is present
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

      // Fallback: If no headOid or legacy mode, try legacy /push
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
      // Avoid duplicate patch IDs
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
