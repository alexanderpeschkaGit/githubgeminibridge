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

export type AccountProfileId = 'account1' | 'account2';
const PROFILE_FIELDS = ['worker_url', 'worker_secret', 'owner', 'owner_repo', 'branch', 'target_branch'] as const;
const PROFILE_MIGRATION_KEY = 'account_profiles_migration_v1';

export function getActiveProfileId(): AccountProfileId {
  return getStoredValue('active_profile', 'account1') === 'account2' ? 'account2' : 'account1';
}

export const DEFAULT_HUD_CONFIG: HudConfig = {
  workerUrl: 'https://gemini-git-bridge.sikanda.workers.dev',
  // No bundled credential: the WORKER_SECRET is entered once in the HUD panel and kept
  // in GM storage. Shipping it in the userscript would publish it with every release.
  workerSecret: '',
  owner: 'alexanderpeschkaGit',
  repo: 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0',
  branch: 'preview',
  targetBranch: '',
  includePaths: [],
  autoPilot: false,
  persistToGitHub: false,
  maxChunkChars: 85000,
  includeRecentCommits: false,
};

const RECENT_COMMITS_MIGRATION_KEY = 'recent_commits_opt_in_migration_v1';

/**
 * One-time migration to per-account profiles: seeds `account1_*` from the legacy
 * flat keys and assigns a default owner per account. Account 2 never inherits
 * account 1 values — an empty profile stays empty.
 */
function migrateAccountProfiles(): void {
  if (getStoredValue(PROFILE_MIGRATION_KEY, '') === 'true') return;

  for (const key of PROFILE_FIELDS) {
    const legacy = getStoredValue(key, '');
    if (legacy) setStoredValue(`account1_${key}`, legacy);
  }
  if (!getStoredValue('account1_owner', '')) {
    const legacyRepo = sanitizeRepo(getStoredValue('owner_repo', ''));
    const ownerFromRepo = legacyRepo.split('/')[0].trim();
    setStoredValue('account1_owner', ownerFromRepo || 'alexanderpeschkaGit');
  }
  if (!getStoredValue('account2_owner', '')) {
    setStoredValue('account2_owner', 'vijaysikanda');
  }
  setStoredValue(PROFILE_MIGRATION_KEY, 'true');
}

/**
 * One-time migration from the former default-on behavior.
 * A legacy stored "true" is reset to false exactly once; afterwards an explicit
 * user opt-in is preserved because the migration marker is already set.
 */
function migrateRecentCommitsOptIn(): void {
  if (getStoredValue(RECENT_COMMITS_MIGRATION_KEY, '') === 'true') {
    return;
  }

  if (getStoredValue('include_recent_commits', '') === 'true') {
    setStoredValue('include_recent_commits', 'false');
    if (getStoredValue('include_recent_commits', '') === 'true') {
      console.warn(
        '[Gemini Bridge Storage] Could not migrate legacy include_recent_commits=true to false; retrying on next load.'
      );
      return;
    }
  }

  setStoredValue(RECENT_COMMITS_MIGRATION_KEY, 'true');
  if (getStoredValue(RECENT_COMMITS_MIGRATION_KEY, '') !== 'true') {
    console.warn(
      '[Gemini Bridge Storage] Could not persist the recent-commits migration marker; migration will retry on next load.'
    );
  }
}

export function loadHudConfig(): HudConfig {
  migrateAccountProfiles();
  migrateRecentCommitsOptIn();

  const profile = getActiveProfileId();
  const a2 = profile === 'account2';
  const readProfile = (key: string, fallback: string) => {
    const stored = getStoredValue(`${profile}_${key}`, '');
    if (stored) return stored;
    if (profile === 'account1') return getStoredValue(key, fallback);
    return fallback; // account2: KEIN Legacy-Fallback → keine Account-1-Werte!
  };

  const workerUrl = readProfile('worker_url', a2 ? '' : DEFAULT_HUD_CONFIG.workerUrl);
  const workerSecret = readProfile('worker_secret', a2 ? '' : DEFAULT_HUD_CONFIG.workerSecret);
  const owner = readProfile('owner', a2 ? '' : DEFAULT_HUD_CONFIG.owner);
  const repo = sanitizeRepo(readProfile('owner_repo', a2 ? '' : DEFAULT_HUD_CONFIG.repo));
  const branch = readProfile('branch', a2 ? '' : DEFAULT_HUD_CONFIG.branch);
  const targetBranch = readProfile('target_branch', a2 ? '' : DEFAULT_HUD_CONFIG.targetBranch ?? '');
  const autoPilotStr = getStoredValue('auto_pilot', 'false');
  const persistStr = getStoredValue('persist_to_github', 'false');
  const includePathsStr = getStoredValue('include_paths', '');
  const includeRecentCommitsStr = getStoredValue('include_recent_commits', 'false');

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
    owner,
    repo,
    branch,
    targetBranch,
    includePaths,
    autoPilot: autoPilotStr === 'true',
    persistToGitHub: persistStr === 'true',
    maxChunkChars,
    includeRecentCommits: includeRecentCommitsStr === 'true',
  };
}

export function saveHudConfig(cfg: Partial<HudConfig>): HudConfig {
  const current = loadHudConfig();
  const updated: HudConfig = { ...current, ...cfg };
  const profile = getActiveProfileId();

  if (cfg.workerUrl !== undefined) {
    setStoredValue('worker_url', sanitizeNoGithubPat(updated.workerUrl, 'workerUrl'));
    setStoredValue(`${profile}_worker_url`, sanitizeNoGithubPat(updated.workerUrl, 'workerUrl'));
  }
  if (cfg.workerSecret !== undefined) {
    setStoredValue('worker_secret', sanitizeNoGithubPat(updated.workerSecret, 'workerSecret'));
    setStoredValue(`${profile}_worker_secret`, sanitizeNoGithubPat(updated.workerSecret, 'workerSecret'));
  }
  if (cfg.owner !== undefined) {
    setStoredValue('owner', sanitizeNoGithubPat(updated.owner, 'owner'));
    setStoredValue(`${profile}_owner`, sanitizeNoGithubPat(updated.owner, 'owner'));
  }
  if (cfg.repo !== undefined) {
    setStoredValue('owner_repo', sanitizeRepo(sanitizeNoGithubPat(updated.repo, 'repo')));
    setStoredValue(`${profile}_owner_repo`, sanitizeRepo(sanitizeNoGithubPat(updated.repo, 'repo')));
  }
  if (cfg.branch !== undefined) {
    setStoredValue('branch', sanitizeNoGithubPat(updated.branch, 'branch'));
    setStoredValue(`${profile}_branch`, sanitizeNoGithubPat(updated.branch, 'branch'));
  }
  if (cfg.targetBranch !== undefined) {
    setStoredValue('target_branch', sanitizeNoGithubPat(updated.targetBranch || '', 'targetBranch'));
    setStoredValue(`${profile}_target_branch`, sanitizeNoGithubPat(updated.targetBranch || '', 'targetBranch'));
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
  if (cfg.includeRecentCommits !== undefined) {
    setStoredValue('include_recent_commits', updated.includeRecentCommits ? 'true' : 'false');
  }

  return updated;
}
