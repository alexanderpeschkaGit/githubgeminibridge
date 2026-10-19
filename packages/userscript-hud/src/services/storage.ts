import type { HudConfig } from '../types';

const PAT_REGEX = /(?:ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{30,}|gho_[a-zA-Z0-9]{20,}|ghs_[a-zA-Z0-9]{20,})/;

/**
 * Hard Guardrail (P1 Komponente 5):
 * Never allow storing a GitHub Personal Access Token in browser storage!
 */
export function sanitizeNoGithubPat(value: string, fieldName = 'value'): string {
  if (!value) return '';
  if (PAT_REGEX.test(value)) {
    throw new Error(
      `[Security Guardrail] Storing a GitHub Personal Access Token in browser storage (${fieldName}) is strictly forbidden!`
    );
  }
  return value.trim();
}

export function getStoredValue(key: string, defaultValue = ''): string {
  try {
    if (typeof GM_getValue === 'function') {
      const val = GM_getValue<string>(key);
      if (val !== undefined && val !== null && val !== '') {
        return sanitizeNoGithubPat(String(val), key);
      }
    }
  } catch (err) {
    console.warn(`[Gemini Bridge Storage] GM_getValue error for ${key}:`, err);
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const local = localStorage.getItem('gemini_bridge_' + key);
      if (local !== null && local !== undefined && local !== '') {
        return sanitizeNoGithubPat(local, key);
      }
    }
  } catch (err) {
    console.warn(`[Gemini Bridge Storage] localStorage.getItem error for ${key}:`, err);
  }

  return defaultValue;
}

export function sanitizeRepo(repoStr: string): string {
  let cleaned = (repoStr || '').trim();
  cleaned = cleaned.replace(/^https?:\/\/github\.com\//i, '');
  cleaned = cleaned.replace(/^git@github\.com:/i, '');
  cleaned = cleaned.replace(/https?:?$/i, '');
  cleaned = cleaned.replace(/\/+$/, '');
  return cleaned.trim();
}

export function setStoredValue(key: string, value: string): void {
  const safeVal = sanitizeNoGithubPat(value, key);
  try {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, safeVal);
    }
  } catch (err) {
    console.warn(`[Gemini Bridge Storage] GM_setValue error for ${key}:`, err);
  }

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('gemini_bridge_' + key, safeVal);
    }
  } catch (err) {
    console.warn(`[Gemini Bridge Storage] localStorage.setItem error for ${key}:`, err);
  }
}

export const DEFAULT_HUD_CONFIG: HudConfig = {
  workerUrl: 'https://gemini-git-bridge.sikanda.workers.dev',
  workerSecret: 'fc1bec3f781b59dee2e576650460f417269fd44d3b0e39d77ae18480c270524f',
  repo: 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0',
  branch: 'preview',
  includePaths: [],
  autoPilot: false,
  persistToGitHub: false,
  maxChunkChars: 85000,
};

export function loadHudConfig(): HudConfig {
  const workerUrl = getStoredValue('worker_url', DEFAULT_HUD_CONFIG.workerUrl);
  const workerSecret = getStoredValue('worker_secret', DEFAULT_HUD_CONFIG.workerSecret);
  const repo = sanitizeRepo(getStoredValue('owner_repo', DEFAULT_HUD_CONFIG.repo));
  const branch = getStoredValue('branch', DEFAULT_HUD_CONFIG.branch);
  const autoPilotStr = getStoredValue('auto_pilot', 'false');
  const persistStr = getStoredValue('persist_to_github', 'false');
  const includePathsStr = getStoredValue('include_paths', '');

  let includePaths: string[] = [];
  if (includePathsStr) {
    try {
      includePaths = JSON.parse(includePathsStr);
      if (!Array.isArray(includePaths)) includePaths = [];
    } catch {
      includePaths = includePathsStr.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  const maxChunkCharsStr = getStoredValue('max_chunk_chars', '85000');
  const parsedChars = parseInt(maxChunkCharsStr, 10);
  const maxChunkChars = Number.isFinite(parsedChars) && parsedChars >= 10000 && parsedChars <= 2000000 ? parsedChars : 85000;

  return {
    workerUrl: workerUrl.replace(/\/+$/, ''),
    workerSecret,
    repo,
    branch,
    includePaths,
    autoPilot: autoPilotStr === 'true',
    persistToGitHub: persistStr === 'true',
    maxChunkChars,
  };
}

export function saveHudConfig(cfg: Partial<HudConfig>): HudConfig {
  const current = loadHudConfig();
  const updated: HudConfig = { ...current, ...cfg };

  if (cfg.workerUrl !== undefined) {
    setStoredValue('worker_url', sanitizeNoGithubPat(updated.workerUrl, 'workerUrl'));
  }
  if (cfg.workerSecret !== undefined) {
    setStoredValue('worker_secret', sanitizeNoGithubPat(updated.workerSecret, 'workerSecret'));
  }
  if (cfg.repo !== undefined) {
    setStoredValue('owner_repo', sanitizeRepo(sanitizeNoGithubPat(updated.repo, 'repo')));
  }
  if (cfg.branch !== undefined) {
    setStoredValue('branch', sanitizeNoGithubPat(updated.branch, 'branch'));
  }
  if (cfg.autoPilot !== undefined) {
    setStoredValue('auto_pilot', updated.autoPilot ? 'true' : 'false');
  }
  if (cfg.persistToGitHub !== undefined) {
    setStoredValue('persist_to_github', updated.persistToGitHub ? 'true' : 'false');
  }
  if (cfg.includePaths !== undefined) {
    setStoredValue('include_paths', JSON.stringify(updated.includePaths));
  }
  if (cfg.maxChunkChars !== undefined) {
    setStoredValue('max_chunk_chars', String(updated.maxChunkChars));
  }

  return updated;
}
