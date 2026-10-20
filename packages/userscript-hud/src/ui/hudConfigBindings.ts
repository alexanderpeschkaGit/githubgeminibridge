import type { HudConfig, HudState } from '../types';
import { saveHudConfig, sanitizeNoGithubPat } from '../services/storage';
import type { HudDomElements } from './hudStylesAndDom';

export interface HudConfigBindingDeps {
  dom: HudDomElements;
  config: HudConfig;
  state: Pick<HudState, 'headOid' | 'targetHeadOid' | 'targetHeadBranch'>;
  /** Config changes invalidate every snapshot OID, so the caller owns the reset. */
  resetPatchOidState: (reason: string) => void;
  clearTargetOidState: (state: Pick<HudState, 'headOid' | 'targetHeadOid' | 'targetHeadBranch'>) => void;
  renderState: () => void;
}

/** Persists every config input of the HUD panel and keeps `config` in sync. */
export function bindHudConfigInputs(deps: HudConfigBindingDeps): void {
  const { dom, config, state, resetPatchOidState, clearTargetOidState, renderState } = deps;

  dom.repoInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(dom.repoInput.value.trim(), 'repo');
      const previousRepo = config.repo;
      config.repo = sanitized;
      saveHudConfig({ repo: sanitized });
      if (sanitized !== previousRepo) resetPatchOidState(`Repository changed to "${sanitized}".`);
    } catch (e: any) {
      alert(e.message);
      dom.repoInput.value = config.repo;
    }
  };

  dom.branchInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(dom.branchInput.value.trim(), 'branch');
      const previousBranch = config.branch;
      config.branch = sanitized;
      saveHudConfig({ branch: sanitized });
      if (sanitized !== previousBranch) resetPatchOidState(`Branch changed to "${sanitized}".`);
    } catch (e: any) {
      alert(e.message);
      dom.branchInput.value = config.branch;
    }
  };

  dom.targetBranchInput.onchange = () => {
    try {
      const sanitized = sanitizeNoGithubPat(dom.targetBranchInput.value.trim(), 'targetBranch');
      config.targetBranch = sanitized;
      clearTargetOidState(state);
      saveHudConfig({ targetBranch: sanitized });
      renderState();
    } catch (e: any) {
      alert(e.message);
      dom.targetBranchInput.value = config.targetBranch || '';
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
      const safe = Math.max(10000, Math.min(2000000, Number.isFinite(val) ? val : 85000));
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

  dom.recentCommitsCheck.onchange = () => {
    config.includeRecentCommits = dom.recentCommitsCheck.checked;
    saveHudConfig({ includeRecentCommits: config.includeRecentCommits });
  };
}
