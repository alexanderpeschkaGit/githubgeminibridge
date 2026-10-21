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
  .hud-header-icon {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 7px;
    border-radius: 6px;
  }
  .hud-header-icon:hover:not(:disabled) {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.1);
  }
  .hud-header-icon:disabled {
    opacity: 0.45;
    cursor: progress;
  }
  .hud-update-banner {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.4;
    border: 1px solid transparent;
  }
  .hud-update-banner.update { background: #422006; color: #fcd34d; border-color: #d97706; }
  .hud-update-banner.ok { background: #064e3b; color: #6ee7b7; border-color: #059669; }
  .hud-update-banner.error { background: #7f1d1d; color: #fca5a5; border-color: #dc2626; }
  .hud-update-banner .hud-btn {
    flex: 0 0 auto;
    padding: 4px 10px;
    font-size: 11px;
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
  .hud-form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 12px;
    align-items: start;
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
  .hud-btn-primary:hover:not(:disabled) {
    background: #0284c7;
    box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
  }
  .hud-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    box-shadow: none;
  }
  .hud-btn-primary:disabled {
    background: #334155;
    border-color: #475569;
    color: #94a3b8;
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
    min-height: 76px;
    max-height: 280px;
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
    min-width: 0;
  }
  .hud-patch-item-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    flex: 1;
    min-width: 0;
  }
  .hud-patch-item-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: #94a3b8;
  }
`;

export const HUD_SHADOW_STYLES = HUD_STYLES;

export interface HudDomElements {
  host: HTMLDivElement;
  shadowRoot: ShadowRoot;
  trigger: HTMLDivElement;
  triggerBadge: HTMLSpanElement;
  panel: HTMLDivElement;
  title: HTMLDivElement;
  closeBtn: HTMLButtonElement;
  updateCheckBtn: HTMLButtonElement;
  updateBanner: HTMLDivElement;
  updateBannerText: HTMLSpanElement;
  updateBannerBtn: HTMLButtonElement;
  repoInput: HTMLInputElement;
  branchInput: HTMLInputElement;
  targetBranchInput: HTMLInputElement;
  secretInput: HTMLInputElement;
  includePathsInput: HTMLInputElement;
  maxChunkCharsInput: HTMLInputElement;
  oidBadge: HTMLDivElement;
  mixBtn: HTMLButtonElement;
  autoPilotCheck: HTMLInputElement;
  recentCommitsCheck: HTMLInputElement;
  retryIndicator: HTMLSpanElement;
  applyAllBtn: HTMLButtonElement;
  clearQueueBtn: HTMLButtonElement;
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
