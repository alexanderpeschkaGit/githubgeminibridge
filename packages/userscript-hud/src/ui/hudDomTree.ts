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

  // Repo & Owner Grid (Row 1: Repo + History Dropdown | Owner)
  const repoOwnerGrid = createHudElement('div', 'hud-repo-owner-grid');

  // Left: Repo Combo (Input + Dropdown Trigger + Menu)
  const repoComboWrap = createHudElement('div', 'hud-repo-combo-wrap');
  const repoLabel = createHudElement('span', 'hud-label', 'GitHub Repository');
  repoLabel.title = 'GitHub Repository (owner/repo)';

  const inputCombo = createHudElement('div', 'hud-input-combo');
  const repoInput = createHudElement('input', 'hud-input');
  repoInput.value = config.repo;

  const repoHistoryBtn = createHudElement('button', 'hud-combo-arrow', '▾');
  repoHistoryBtn.type = 'button';
  repoHistoryBtn.title = 'Recent Repositories';

  inputCombo.appendChild(repoInput);
  inputCombo.appendChild(repoHistoryBtn);

  const repoHistoryMenu = createHudElement('div', 'hud-repo-menu');
  repoHistoryMenu.style.display = 'none';

  repoComboWrap.appendChild(repoLabel);
  repoComboWrap.appendChild(inputCombo);
  repoComboWrap.appendChild(repoHistoryMenu);
  repoOwnerGrid.appendChild(repoComboWrap);

  // Right: Owner
  const ownerRow = createHudElement('div', 'hud-form-row');
  const ownerLabel = createHudElement('span', 'hud-label', 'GitHub Owner');
  ownerLabel.title = 'GitHub Owner (active account)';
  const ownerInput = createHudElement('input', 'hud-input');
  ownerInput.value = config.owner;
  ownerRow.appendChild(ownerLabel);
  ownerRow.appendChild(ownerInput);
  repoOwnerGrid.appendChild(ownerRow);

  body.appendChild(repoOwnerGrid);

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

  // Compact grid: Account | Worker URL
  const accountWorkerGrid = createHudElement('div', 'hud-account-worker-grid');

  const accountCol = createHudElement('div', 'hud-form-row');
  const accountLabel = createHudElement('span', 'hud-label', 'Account');
  accountLabel.title = 'GitHub Account Profile (active)';
  const accountBtnGroup = createHudElement('div', 'hud-account-btns');
  const accountBtn1 = createHudElement('button', 'hud-btn hud-btn-secondary', '👤 Acc 1');
  accountBtn1.type = 'button';
  accountBtn1.title = 'Switch to GitHub Account Profile 1';
  const accountBtn2 = createHudElement('button', 'hud-btn hud-btn-secondary', '👤 Acc 2');
  accountBtn2.type = 'button';
  accountBtn2.title = 'Switch to GitHub Account Profile 2';
  accountBtnGroup.appendChild(accountBtn1);
  accountBtnGroup.appendChild(accountBtn2);
  accountCol.appendChild(accountLabel);
  accountCol.appendChild(accountBtnGroup);

  const workerUrlCol = createHudElement('div', 'hud-form-row');
  const workerUrlLabel = createHudElement('span', 'hud-label', 'Worker URL');
  workerUrlLabel.title = 'Worker URL (Edge Worker Endpoint)';
  const workerUrlInput = createHudElement('input', 'hud-input');
  workerUrlInput.type = 'url';
  workerUrlInput.placeholder = 'https://<your-worker>.workers.dev';
  workerUrlInput.value = config.workerUrl;
  workerUrlInput.style.minWidth = '0';
  workerUrlCol.appendChild(workerUrlLabel);
  workerUrlCol.appendChild(workerUrlInput);

  accountWorkerGrid.appendChild(accountCol);
  accountWorkerGrid.appendChild(workerUrlCol);
  body.appendChild(accountWorkerGrid);

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

  const continueMixBtn = createHudElement('button', 'hud-btn hud-btn-secondary', '⏭️ Next Parts');
  continueMixBtn.type = 'button';
  continueMixBtn.style.display = 'none';
  actionRow.appendChild(continueMixBtn);

  const batchFormulaBtn = createHudElement('button', 'hud-btn hud-btn-secondary', '🧩 Batch Formula');
  batchFormulaBtn.title = 'Insert optimal V2 integratable batch prompt formula into chat';
  actionRow.appendChild(batchFormulaBtn);

  body.appendChild(actionRow);

  // Toggles Row: Auto-Pilot (left) & Recent Commits (right)
  const togglesRow = createHudElement('div', 'hud-toggles-row');

  const autoPilotGroup = createHudElement('div');
  autoPilotGroup.style.cssText = 'display: flex; align-items: center; gap: 6px;';

  const autoPilotLabel = createHudElement('label', 'hud-toggle-label');
  autoPilotLabel.title = 'Auto-Pilot Self-Healing (max 3 retries)';
  const autoPilotCheck = createHudElement('input');
  autoPilotCheck.type = 'checkbox';
  autoPilotCheck.checked = config.autoPilot;
  const autoPilotText = createHudElement('span', undefined, '🤖 Auto-Pilot');
  autoPilotLabel.appendChild(autoPilotCheck);
  autoPilotLabel.appendChild(autoPilotText);

  const retryIndicator = createHudElement('span', 'hud-retry-pill', '(' + state.retryCount + '/3)');

  autoPilotGroup.appendChild(autoPilotLabel);
  autoPilotGroup.appendChild(retryIndicator);

  const recentCommitsLabel = createHudElement('label', 'hud-toggle-label');
  recentCommitsLabel.title = 'Volatile Dateien & Letzte Commits in RepoMix einbeziehen';
  const recentCommitsCheck = createHudElement('input');
  recentCommitsCheck.type = 'checkbox';
  recentCommitsCheck.checked = config.includeRecentCommits === true;
  const recentCommitsText = createHudElement('span', undefined, '🕒 Letzte Commits');
  recentCommitsLabel.appendChild(recentCommitsCheck);
  recentCommitsLabel.appendChild(recentCommitsText);

  togglesRow.appendChild(autoPilotGroup);
  togglesRow.appendChild(recentCommitsLabel);
  body.appendChild(togglesRow);

  // Patch Queue Header Row
  const queueHeaderRow = createHudElement('div');
  queueHeaderRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 4px;';
  const queueLabel = createHudElement('span', 'hud-label', 'Harvested Patches');

  const queueActions = createHudElement('div');
  queueActions.style.cssText = 'display: flex; gap: 6px;';

  const checkAllBtn = createHudElement('button', 'hud-btn hud-btn-secondary', '🔍 Check All');
  checkAllBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';
  checkAllBtn.title = 'Dry-run preflight & syntax check across all harvested snippets without committing';

  const applyAllBtn = createHudElement('button', 'hud-btn hud-btn-primary', '⚡ Apply All');
  applyAllBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';

  const clearQueueBtn = createHudElement('button', 'hud-btn hud-btn-secondary', '🗑️ Clear');
  clearQueueBtn.style.cssText = 'padding: 3px 8px; font-size: 11px;';

  queueActions.appendChild(checkAllBtn);
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
    repoHistoryBtn,
    repoHistoryMenu,
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
    continueMixBtn,
    batchFormulaBtn,
    autoPilotCheck,
    recentCommitsCheck,
    retryIndicator,
    checkAllBtn,
    applyAllBtn,
    clearQueueBtn,
    patchQueueEl,
    emptyQueueMsg,
    statusBox
  };
}
