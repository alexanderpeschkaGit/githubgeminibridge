import type { HudConfig, HudState } from '../types';

export const HUD_STYLES = `
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

export const HUD_SHADOW_STYLES = HUD_STYLES;

export interface HudDomElements {
  host: HTMLDivElement;
  shadowRoot: ShadowRoot;
  trigger: HTMLDivElement;
  triggerBadge: HTMLSpanElement;
  panel: HTMLDivElement;
  closeBtn: HTMLButtonElement;
  repoInput: HTMLInputElement;
  branchInput: HTMLInputElement;
  secretInput: HTMLInputElement;
  oidBadge: HTMLDivElement;
  mixBtn: HTMLButtonElement;
  autoPilotCheck: HTMLInputElement;
  retryIndicator: HTMLSpanElement;
  patchQueueEl: HTMLDivElement;
  emptyQueueMsg: HTMLDivElement;
  statusBox: HTMLDivElement;
}

export function createHudElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  textContent?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (textContent !== undefined) el.textContent = textContent;
  return el;
}

export function buildHudDomTree(config: HudConfig, state: HudState): HudDomElements {
  const existing = document.getElementById('gemini-edge-hud-root');
  if (existing) {
    existing.remove();
  }

  const host = createHudElement('div');
  host.id = 'gemini-edge-hud-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  document.body.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: 'open' });

  const styleEl = createHudElement('style');
  styleEl.textContent = HUD_STYLES;
  shadowRoot.appendChild(styleEl);

  // Trigger button
  const trigger = createHudElement('div', 'hud-trigger');
  const triggerIcon = createHudElement('span', undefined, '⚡');
  const triggerLabel = createHudElement('span', undefined, 'Gemini Edge HUD');
  const triggerBadge = createHudElement('span', 'hud-trigger-badge idle', 'IDLE');
  trigger.appendChild(triggerIcon);
  trigger.appendChild(triggerLabel);
  trigger.appendChild(triggerBadge);
  shadowRoot.appendChild(trigger);

  // Drawer Panel
  const panel = createHudElement('div', 'hud-panel');
  const header = createHudElement('div', 'hud-header');
  const title = createHudElement('div', 'hud-title', '⚡ Cloudflare Edge HUD (Stage 3)');
  const closeBtn = createHudElement('button', 'hud-close-btn', '×');
  closeBtn.title = 'Close Panel';
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Body
  const body = createHudElement('div', 'hud-body');

  // Repo Row
  const repoRow = createHudElement('div', 'hud-form-row');
  const repoLabel = createHudElement('span', 'hud-label', 'GitHub Repository (owner/repo)');
  const repoInput = createHudElement('input', 'hud-input');
  repoInput.value = config.repo;
  repoRow.appendChild(repoLabel);
  repoRow.appendChild(repoInput);
  body.appendChild(repoRow);

  // Branch Row
  const branchRow = createHudElement('div', 'hud-form-row');
  const branchLabel = createHudElement('span', 'hud-label', 'Branch');
  const branchInput = createHudElement('input', 'hud-input');
  branchInput.value = config.branch;
  branchRow.appendChild(branchLabel);
  branchRow.appendChild(branchInput);
  body.appendChild(branchRow);

  // Worker Secret Row
  const secretRow = createHudElement('div', 'hud-form-row');
  const secretLabel = createHudElement('span', 'hud-label', 'Worker Secret (WORKER_SECRET)');
  const secretInput = createHudElement('input', 'hud-input');
  secretInput.type = 'password';
  secretInput.value = config.workerSecret;
  secretRow.appendChild(secretLabel);
  secretRow.appendChild(secretInput);
  body.appendChild(secretRow);

  // Head OID Badge Row
  const oidRow = createHudElement('div', 'hud-form-row');
  const oidLabel = createHudElement('span', 'hud-label', 'Head OID (Optimistic Concurrency)');
  const oidBadge = createHudElement('div', 'hud-badge-oid', state.headOid || '(Not mixed yet)');
  oidRow.appendChild(oidLabel);
  oidRow.appendChild(oidBadge);
  body.appendChild(oidRow);

  // Action Buttons Row: Mix Repo
  const actionRow = createHudElement('div');
  actionRow.style.cssText = 'display: flex; gap: 8px;';
  const mixBtn = createHudElement('button', 'hud-btn hud-btn-primary', '📦 Load Repo Mix (/api/mix)');
  mixBtn.style.flex = '1';
  actionRow.appendChild(mixBtn);
  body.appendChild(actionRow);

  // Options Row: Auto-Pilot toggle
  const optRow = createHudElement('div');
  optRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between;';
  const autoPilotLabel = createHudElement('label', 'hud-toggle-label');
  const autoPilotCheck = createHudElement('input');
  autoPilotCheck.type = 'checkbox';
  autoPilotCheck.checked = config.autoPilot;
  const autoPilotText = createHudElement('span', undefined, '🤖 Auto-Pilot Self-Healing');
  autoPilotLabel.appendChild(autoPilotCheck);
  autoPilotLabel.appendChild(autoPilotText);

  const retryIndicator = createHudElement('span', undefined, `Retries: ${state.retryCount}/3`);
  retryIndicator.style.cssText = 'font-size: 11px; color: #94a3b8;';
  optRow.appendChild(autoPilotLabel);
  optRow.appendChild(retryIndicator);
  body.appendChild(optRow);

  // Patch Queue Container
  const queueLabel = createHudElement('span', 'hud-label', 'Harvested Patches');
  body.appendChild(queueLabel);

  const patchQueueEl = createHudElement('div', 'hud-patch-queue');
  const emptyQueueMsg = createHudElement('div', undefined, 'No patches harvested from chat yet.');
  emptyQueueMsg.style.cssText = 'color: #64748b; font-size: 11px; text-align: center; padding: 6px;';
  patchQueueEl.appendChild(emptyQueueMsg);
  body.appendChild(patchQueueEl);

  // Status & Error Box
  const statusBox = createHudElement('div', 'hud-status-box idle', state.statusMessage);
  body.appendChild(statusBox);

  panel.appendChild(body);
  shadowRoot.appendChild(panel);

  return {
    host,
    shadowRoot,
    trigger,
    triggerBadge,
    panel,
    closeBtn,
    repoInput,
    branchInput,
    secretInput,
    oidBadge,
    mixBtn,
    autoPilotCheck,
    retryIndicator,
    patchQueueEl,
    emptyQueueMsg,
    statusBox
  };
}
