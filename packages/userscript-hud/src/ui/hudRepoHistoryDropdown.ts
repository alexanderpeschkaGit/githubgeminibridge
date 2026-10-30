import type { HudConfig, HudState } from '../types';
import { createHudElement, type HudDomElements } from './hudStylesAndDom';
import { loadRepoHistory, recordFromConfig, type RepoHistoryEntry } from '../services/repoHistory';
import { sanitizeRepo, saveHudConfig } from '../services/storage';

export interface RepoHistoryDropdownDeps {
  dom: HudDomElements;
  config: HudConfig;
  state: HudState;
  resetPatchOidState: (reason: string) => void;
  clearTargetOidState: (state: HudState) => void;
  refreshAccountHint: () => void;
  renderState: () => void;
}

export type RepoHistoryDropdownRefresher = (() => void) & {
  refresh: () => void;
  closeMenu: () => void;
};

let activeDocumentClickHandler: ((event: Event) => void) | null = null;
let activeDocumentKeydownHandler: ((event: Event) => void) | null = null;

function formatRepoHistoryLabel(entry: RepoHistoryEntry): string {
  const repoLabel = entry.repo.includes('/') ? entry.repo : `${entry.owner}/${entry.repo}`;
  const target = entry.targetBranch ? ` -> ${entry.targetBranch}` : '';
  return `${repoLabel} @ ${entry.branch}${target}`;
}

export function bindRepoHistoryDropdown(deps: RepoHistoryDropdownDeps): RepoHistoryDropdownRefresher {
  const { dom, config, state, resetPatchOidState, clearTargetOidState, refreshAccountHint, renderState } = deps;

  if (activeDocumentClickHandler) {
    document.removeEventListener('click', activeDocumentClickHandler);
    activeDocumentClickHandler = null;
  }
  if (activeDocumentKeydownHandler) {
    document.removeEventListener('keydown', activeDocumentKeydownHandler);
    activeDocumentKeydownHandler = null;
  }

  const closeMenu = () => {
    dom.repoHistoryMenu.style.display = 'none';
    dom.repoHistoryBtn.setAttribute('aria-expanded', 'false');
  };

  const openMenu = () => {
    dom.repoHistoryMenu.style.display = 'flex';
    dom.repoHistoryBtn.setAttribute('aria-expanded', 'true');
  };

  const onSelectEntry = (entry: RepoHistoryEntry) => {
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
    refresh();
    closeMenu();
    refreshAccountHint();
    renderState();
  };

  const refresh = () => {
    const entries = loadRepoHistory();
    dom.repoHistoryMenu.textContent = '';

    if (entries.length === 0) {
      dom.repoHistoryBtn.disabled = true;
      dom.repoHistoryBtn.title = 'No recent repositories';
      closeMenu();
      return;
    }

    dom.repoHistoryBtn.disabled = false;
    dom.repoHistoryBtn.title = 'Recent Repositories';

    entries.forEach((entry) => {
      const label = formatRepoHistoryLabel(entry);
      const btn = createHudElement('button', 'hud-repo-menu-item', label);
      btn.type = 'button';
      btn.title = label;
      btn.onclick = (e) => {
        e.stopPropagation();
        onSelectEntry(entry);
      };
      dom.repoHistoryMenu.appendChild(btn);
    });
  };

  dom.repoHistoryMenu.onclick = (e) => e.stopPropagation();

  dom.repoHistoryBtn.onclick = (e) => {
    e.stopPropagation();
    if (dom.repoHistoryMenu.style.display === 'none') {
      refresh();
      const entries = loadRepoHistory();
      if (entries.length > 0) {
        openMenu();
      }
    } else {
      closeMenu();
    }
  };

  const handleOutsideClick = (event: Event) => {
    if (dom.repoHistoryMenu.style.display === 'none') return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.includes(dom.repoHistoryBtn) || path.includes(dom.repoHistoryMenu)) {
      return;
    }
    const target = event.target as Node | null;
    if (target) {
      if (dom.repoHistoryBtn.contains(target) || dom.repoHistoryMenu.contains(target)) {
        return;
      }
    }
    closeMenu();
  };

  dom.shadowRoot.addEventListener('click', handleOutsideClick);
  activeDocumentClickHandler = handleOutsideClick;
  document.addEventListener('click', handleOutsideClick);

  const handleKeydown = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape' && dom.repoHistoryMenu.style.display !== 'none') {
      closeMenu();
    }
  };

  dom.shadowRoot.addEventListener('keydown', handleKeydown);
  activeDocumentKeydownHandler = handleKeydown;
  document.addEventListener('keydown', handleKeydown);

  refresh();

  const refresher: RepoHistoryDropdownRefresher = Object.assign(
    () => {
      refresh();
    },
    {
      refresh: () => {
        refresh();
      },
      closeMenu: () => {
        closeMenu();
      },
    }
  );

  return refresher;
}
