import type { HudConfig, HudState } from '../types';
import { HUD_STYLES, createHudElement, type HudDomElements } from './hudStylesAndDom';

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
  const title = createHudElement('div', 'hud-title', '⚡ Cloudflare Edge HUD');
  const updateCheckBtn = createHudElement('button', 'hud-header-icon', '⟳');
  updateCheckBtn.title = 'Check published userscript version';
  const closeBtn = createHudElement('button', 'hud-close-btn', '×');
  closeBtn.title = 'Close Panel';
  header.appendChild(title);
  header.appendChild(updateCheckBtn);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Body
  const body = createHudElement('div', 'hud-body');

  // Self-update banner (hidden until a newer published @version is detected)
  const updateBanner = createHudElement('div', 'hud-update-banner');
  const updateBannerText = createHudElement('span', undefined, '');
  const updateBannerBtn = createHudElement('button', 'hud-btn hud-btn-primary', '⬆ Update');
  updateBanner.appendChild(updateBannerText);
  updateBanner.appendChild(updateBannerBtn);
  body.appendChild(updateBanner);

  // Repo Row
  const repoRow = createHudElement('div', 'hud-form-row');
  const repoLabel = createHudElement('span', 'hud-label', 'GitHub Repository (owner/repo)');
  const repoInput = createHudElement('input', 'hud-input');
  repoInput.value = config.repo;
  repoRow.appendChild(repoLabel);
  repoRow.appendChild(repoInput);
  body.appendChild(repoRow);

  // Owner Row (per account profile; drives foreign-owner warnings)
  const ownerRow = createHudElement('div', 'hud-form-row');
  const ownerLabel = createHudElement('span', 'hud-label', 'GitHub Owner (active account)');
  const ownerInput = createHudElement('input', 'hud-input');
  ownerInput.value = config.owner;
  ownerRow.appendChild(ownerLabel);
  ownerRow.appendChild(ownerInput);
  body.appendChild(ownerRow);

  // Owner-Classification Hint (hidden unless repo belongs to another/foreign owner)
  const ownerHintEl = createHudElement('div', 'hud-account-hint');
  ownerHintEl.style.display = 'none';
  body.appendChild(ownerHintEl);

  // Compact grid: Branch | Target Branch
  const branchGrid = createHudElement('div', 'hud-form-grid');
  const branchRow = createHudElement('div', 'hud-form-row');
  const branchLabel = createHudElement('span', 'hud-label', 'Branch');
  const branchInput = createHudElement('input', 'hud-input');
  branchInput.value = config.branch;
  branchRow.appendChild(branchLabel);
  branchRow.appendChild(branchInput);

  // Target Branch Row (Optional, for writing to a different or new branch)
  const targetBranchRow = createHudElement('div', 'hud-form-row');
  const targetBranchLabel = createHudElement('span', 'hud-label', 'Target Branch (optional)');
  const targetBranchInput = createHudElement('input', 'hud-input');
  targetBranchInput.placeholder = 'Same as mix branch (or e.g. preview, feature/...)';
  targetBranchInput.value = config.targetBranch || '';
  targetBranchRow.appendChild(targetBranchLabel);
  targetBranchRow.appendChild(targetBranchInput);
  branchGrid.appendChild(branchRow);
  branchGrid.appendChild(targetBranchRow);
  body.appendChild(branchGrid);

  // Compact grid: Include Paths | Max Chunk Chars
  const scopeGrid = createHudElement('div', 'hud-form-grid');
  const pathsRow = createHudElement('div', 'hud-form-row');
  const pathsLabel = createHudElement('span', 'hud-label', 'Include Paths (comma-separated, optional)');
  const includePathsInput = createHudElement('input', 'hud-input');
  includePathsInput.placeholder = 'e.g. src/, packages/edge-worker/';
  includePathsInput.value = (config.includePaths || []).join(', ');
  pathsRow.appendChild(pathsLabel);
  pathsRow.appendChild(includePathsInput);

  const maxChunkRow = createHudElement('div', 'hud-form-row');
  const maxChunkLabel = createHudElement('span', 'hud-label', 'Max Chunk Chars (Default: 85000, Max 10 Parts)');
  const maxChunkCharsInput = createHudElement('input', 'hud-input');
  maxChunkCharsInput.type = 'number';
  maxChunkCharsInput.min = '10000';
  maxChunkCharsInput.max = '2000000';
  maxChunkCharsInput.value = String(config.maxChunkChars || 85000);
  maxChunkRow.appendChild(maxChunkLabel);
  maxChunkRow.appendChild(maxChunkCharsInput);
  scopeGrid.appendChild(pathsRow);
  scopeGrid.appendChild(maxChunkRow);
  body.appendChild(scopeGrid);

  // Worker URL Row (Edge Worker Endpoint; switch between account deployments)
  const workerUrlRow = createHudElement('div', 'hud-form-row');
  const workerUrlLabel = createHudElement('span', 'hud-label', 'Worker URL (Edge Worker Endpoint)');
  const workerUrlInput = createHudElement('input', 'hud-input');
  workerUrlInput.type = 'url';
  workerUrlInput.placeholder = 'https://<your-worker>.workers.dev';
  workerUrlInput.value = config.workerUrl;
  workerUrlRow.appendChild(workerUrlLabel);
  workerUrlRow.appendChild(workerUrlInput);
  body.appendChild(workerUrlRow);

  // Account Switch Row (one-click profile switching; manual buttons)
  const accountRow = createHudElement('div', 'hud-form-row');
  const accountLabel = createHudElement('span', 'hud-label', 'GitHub Account');
  const accountBtnGroup = createHudElement('div');
  accountBtnGroup.style.cssText = 'display: flex; gap: 6px;';
  const accountBtn1 = createHudElement('button', 'hud-btn hud-btn-secondary', '👤 Account 1');
  accountBtn1.type = 'button';
  const accountBtn2 = createHudElement('button', 'hud-btn hud-btn-secondary', '👤 Account 2');
  accountBtn2.type = 'button';
  accountBtnGroup.appendChild(accountBtn1);
  accountBtnGroup.appendChild(accountBtn2);
  accountRow.appendChild(accountLabel);
  accountRow.appendChild(accountBtnGroup);
  body.appendChild(accountRow);

  // Compact grid: Worker Secret | Head OID
  const secretGrid = createHudElement('div', 'hud-form-grid');
  const secretRow = createHudElement('div', 'hud-form-row');
  const secretLabel = createHudElement('span', 'hud-label', 'Worker Secret (WORKER_SECRET)');
  const secretInput = createHudElement('input', 'hud-input');
  secretInput.type = 'password';
  secretInput.value = config.workerSecret;
  secretRow.appendChild(secretLabel);
  secretRow.appendChild(secretInput);

  const oidRow = createHudElement('div', 'hud-form-row');
  const oidLabel = createHudElement('span', 'hud-label', 'Head OID (Optimistic Concurrency)');
  const oidBadge = createHudElement('div', 'hud-badge-oid', state.headOid || '(Not mixed yet)');
  oidRow.appendChild(oidLabel);
  oidRow.appendChild(oidBadge);
  secretGrid.appendChild(secretRow);
  secretGrid.appendChild(oidRow);
  body.appendChild(secretGrid);

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

  // Commits & Volatile Files Row
  const commitsRow = createHudElement('div');
  commitsRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 4px;';
  const recentCommitsLabel = createHudElement('label', 'hud-toggle-label');
  const recentCommitsCheck = createHudElement('input');
  recentCommitsCheck.type = 'checkbox';
  recentCommitsCheck.checked = config.includeRecentCommits === true;
  const recentCommitsText = createHudElement('span', undefined, '🕒 Volatile Dateien & Letzte Commits');
  recentCommitsLabel.appendChild(recentCommitsCheck);
  recentCommitsLabel.appendChild(recentCommitsText);
  commitsRow.appendChild(recentCommitsLabel);
  body.appendChild(commitsRow);

  // Patch Queue Header Row
  const queueHeaderRow = createHudElement('div');
  queueHeaderRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 4px;';
  const queueLabel = createHudElement('span', 'hud-label', 'Harvested Patches');

  const queueActions = createHudElement('div');
  queueActions.style.cssText = 'display: flex; gap: 6px;';

  const applyAllBtn = createHudElement('button', 'hud-btn hud-btn-primary', '⚡ Apply All');
  applyAllBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';

  const clearQueueBtn = createHudElement('button', 'hud-btn hud-btn-secondary', '🗑️ Clear');
  clearQueueBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';

  queueActions.appendChild(applyAllBtn);
  queueActions.appendChild(clearQueueBtn);
  queueHeaderRow.appendChild(queueLabel);
  queueHeaderRow.appendChild(queueActions);
  body.appendChild(queueHeaderRow);

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
    title,
    updateCheckBtn,
    updateBanner,
    updateBannerText,
    updateBannerBtn,
    closeBtn,
    repoInput,
    ownerInput,
    ownerHintEl,
    branchInput,
    targetBranchInput,
    workerUrlInput,
    accountBtn1,
    accountBtn2,
    secretInput,
    includePathsInput,
    maxChunkCharsInput,
    oidBadge,
    mixBtn,
    autoPilotCheck,
    recentCommitsCheck,
    retryIndicator,
    applyAllBtn,
    clearQueueBtn,
    patchQueueEl,
    emptyQueueMsg,
    statusBox
  };
}
