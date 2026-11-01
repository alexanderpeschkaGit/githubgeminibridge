import type { HudConfig } from '../types';
import { getActiveProfileId, getStoredValue, setStoredValue } from './storage';

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
    owner: (entry.owner || '').trim(),
    repo: (entry.repo || '').trim(),
    branch: (entry.branch || '').trim(),
    targetBranch: (entry.targetBranch || '').trim() || undefined,
  };
}

function entryKey(e: RepoHistoryEntry): string {
  const n = normalizeEntry(e);
  return `${n.owner}|||${n.repo}|||${n.branch}|||${n.targetBranch || ''}`;
}

export function loadRepoHistory(): RepoHistoryEntry[] {
  try {
    const raw = getStoredValue(historyKey(), '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RepoHistoryEntry[] = [];
    const seen = new Set<string>();
    for (const p of parsed) {
      if (!p) continue;
      const n = normalizeEntry(p);
      if (!n.repo) continue;
      const key = entryKey(n);
      if (seen.has(key)) continue;
      seen.add(key);
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
      .filter((e) => e.repo)
      .slice(0, MAX_ENTRIES);
    setStoredValue(historyKey(), JSON.stringify(cleaned));
  } catch {
    // ignore
  }
}

export function pushRepoHistory(entry: RepoHistoryEntry): RepoHistoryEntry[] {
  const n = normalizeEntry(entry);
  if (!n.repo) return loadRepoHistory();
  const current = loadRepoHistory();
  const key = entryKey(n);
  const filtered = current.filter((e) => entryKey(e) !== key);
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
