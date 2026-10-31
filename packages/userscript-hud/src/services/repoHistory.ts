import type { HudConfig } from '../types';
import { getActiveProfileId, getStoredValue, sanitizeRepo, setStoredValue } from './storage';

export interface RepoHistoryEntry {
  owner: string;
  repo: string;
  branch: string;
  targetBranch?: string;
}

const HISTORY_KEY = 'repo_history_v1';
const MAX_ENTRIES = 4;

/** History is scoped per account profile so accounts never share entries. */
function historyKey(): string {
  try {
    return `${HISTORY_KEY}_${getActiveProfileId()}`;
  } catch {
    return HISTORY_KEY;
  }
}

function normalizeEntry(entry: RepoHistoryEntry): RepoHistoryEntry {
  return {
    owner: (entry.owner || '').trim().replace(/^\/+|\/+$/g, ''),
    repo: sanitizeRepo(entry.repo || '').replace(/^\/+|\/+$/g, ''),
    branch: (entry.branch || '').trim(),
    targetBranch: (entry.targetBranch || '').trim() || undefined,
  };
}

export function repoSlug(entry: RepoHistoryEntry): string {
  const n = normalizeEntry(entry);
  const owner = n.owner.toLowerCase();
  const repo = n.repo.toLowerCase();
  if (!repo) return '';
  if (repo.includes('/')) return repo;
  return owner ? `${owner}/${repo}` : repo;
}

export function loadRepoHistory(): RepoHistoryEntry[] {
  try {
    const raw = getStoredValue(historyKey(), '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RepoHistoryEntry[] = [];
    const seenSlugs = new Set<string>();
    for (const p of parsed) {
      if (!p) continue;
      const n = normalizeEntry(p);
      const slug = repoSlug(n);
      if (!slug || seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      out.push(n);
    }
    return out.slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveRepoHistory(entries: RepoHistoryEntry[]): void {
  try {
    const cleaned = entries
      .map(normalizeEntry)
      .filter((e) => Boolean(repoSlug(e)))
      .slice(0, MAX_ENTRIES);
    setStoredValue(historyKey(), JSON.stringify(cleaned));
  } catch {
    // ignore
  }
}

export function pushRepoHistory(entry: RepoHistoryEntry): RepoHistoryEntry[] {
  const n = normalizeEntry(entry);
  const targetSlug = repoSlug(n);
  if (!targetSlug) return loadRepoHistory();
  const current = loadRepoHistory();
  const filtered = current.filter((e) => repoSlug(e) !== targetSlug);
  const next = [n, ...filtered].slice(0, MAX_ENTRIES);
  saveRepoHistory(next);
  return next;
}

export function recordFromConfig(cfg: Partial<HudConfig>): RepoHistoryEntry[] {
  return pushRepoHistory({
    owner: cfg.owner || '',
    repo: cfg.repo || '',
    branch: cfg.branch || '',
    targetBranch: cfg.targetBranch || '',
  });
}
