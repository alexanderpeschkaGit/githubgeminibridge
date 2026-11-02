import { normalizeRepoPath } from '../../../../shared/repoPaths';
import { getStoredValue, setStoredValue } from './storage';

export type ReviewScopeKey = string;

export interface PendingRevisionEntry {
  patchId: string;
  scopeKey: ReviewScopeKey;
  paths: string[];
  headOid?: string;
  targetHeadOid?: string;
  attribution?: 'exact' | 'file-match' | 'batch';
  timestamp: string;
  expiresAt: number;
}

const STORE_KEY = 'gm_patch_review_pending_v1';
const MAX_ENTRIES_PER_SCOPE = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FALLBACK_TAB_KEY = 'gm_patch_review_tab_key_v1';

function getOrCreateTabKey(): string {
  try {
    const existing = getStoredValue(FALLBACK_TAB_KEY, '');
    if (existing && typeof existing === 'string' && existing.length > 0) {
      return existing;
    }
    const key = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    setStoredValue(FALLBACK_TAB_KEY, key);
    return key;
  } catch {
    return `tab_${Date.now().toString(36)}`;
  }
}

export function buildConvoKey(): string {
  try {
    if (typeof location !== 'undefined') {
      const origin = location.origin || '';
      const pathname = location.pathname || '';
      if (origin || pathname) {
        return `${origin}${pathname}`;
      }
    }
  } catch {
    // ignore
  }
  return getOrCreateTabKey();
}

export function buildReviewScopeKey(params: {
  profileKey?: string;
  repoFullName?: string;
  sourceBranch?: string;
  targetBranch?: string;
  convoKey?: string;
}): ReviewScopeKey {
  const profileKey = params.profileKey || 'default';
  const repoFullName = params.repoFullName || 'unknown';
  const sourceBranch = params.sourceBranch || 'unknown';
  const targetBranch = params.targetBranch || sourceBranch || 'unknown';
  const convoKey = params.convoKey || buildConvoKey();
  return `${profileKey}|${repoFullName}|${sourceBranch}|${targetBranch}|${convoKey}`;
}

function normalizePaths(paths?: string[]): string[] {
  if (!Array.isArray(paths)) return [];
  const set = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const norm = normalizeRepoPath(p).replace(/\\/g, '/');
    if (norm === '' || norm === '.') continue;
    set.add(norm);
  }
  return Array.from(set);
}

function loadAll(): PendingRevisionEntry[] {
  try {
    const rawStr = getStoredValue(STORE_KEY, '[]');
    let raw: any = [];
    try {
      raw = JSON.parse(rawStr);
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    const filtered: PendingRevisionEntry[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.patchId !== 'string' || typeof entry.scopeKey !== 'string') continue;
      const expiresAt = typeof entry.expiresAt === 'number' ? entry.expiresAt : now + MAX_AGE_MS;
      if (expiresAt < now) continue;
      filtered.push({
        patchId: entry.patchId,
        scopeKey: entry.scopeKey,
        paths: normalizePaths(entry.paths),
        headOid: typeof entry.headOid === 'string' ? entry.headOid : undefined,
        targetHeadOid: typeof entry.targetHeadOid === 'string' ? entry.targetHeadOid : undefined,
        attribution: entry.attribution,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
        expiresAt
      });
    }
    return filtered;
  } catch {
    return [];
  }
}

function saveAll(entries: PendingRevisionEntry[]): void {
  try {
    const now = Date.now();
    const pruned = entries
      .filter((e) => e.expiresAt >= now)
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    // enforce caps per scope
    const byScope = new Map<string, PendingRevisionEntry[]>();
    for (const e of pruned) {
      if (!byScope.has(e.scopeKey)) byScope.set(e.scopeKey, []);
      byScope.get(e.scopeKey)!.push(e);
    }
    const out: PendingRevisionEntry[] = [];
    for (const list of byScope.values()) {
      const capped = list.slice(-MAX_ENTRIES_PER_SCOPE);
      out.push(...capped);
    }
    setStoredValue(STORE_KEY, JSON.stringify(out));
  } catch {
    // ignore storage errors
  }
}

export function isRevisionPending(patchId: string, scopeKey: ReviewScopeKey): boolean {
  if (!patchId || !scopeKey) return false;
  const entries = loadAll();
  return entries.some((e) => e.patchId === patchId && e.scopeKey === scopeKey);
}

export function getPendingEntry(patchId: string, scopeKey: ReviewScopeKey): PendingRevisionEntry | null {
  if (!patchId || !scopeKey) return null;
  const entries = loadAll();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.patchId === patchId && e.scopeKey === scopeKey) return e;
  }
  return null;
}

export function getPendingForScope(scopeKey: ReviewScopeKey): PendingRevisionEntry[] {
  if (!scopeKey) return [];
  const entries = loadAll();
  return entries.filter((e) => e.scopeKey === scopeKey);
}

export function markRevisionPending(entry: Omit<PendingRevisionEntry, 'timestamp' | 'expiresAt'> & Partial<Pick<PendingRevisionEntry, 'timestamp' | 'expiresAt'>>): PendingRevisionEntry {
  const now = Date.now();
  const normalized: PendingRevisionEntry = {
    patchId: entry.patchId,
    scopeKey: entry.scopeKey,
    paths: normalizePaths(entry.paths),
    headOid: entry.headOid,
    targetHeadOid: entry.targetHeadOid,
    attribution: entry.attribution,
    timestamp: entry.timestamp || new Date().toISOString(),
    expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : now + MAX_AGE_MS
  };
  const entries = loadAll();
  // replace existing for same patchId+scopeKey
  const filtered = entries.filter((e) => !(e.patchId === normalized.patchId && e.scopeKey === normalized.scopeKey));
  filtered.push(normalized);
  saveAll(filtered);
  return normalized;
}

export function restoreRevisionPending(patchId: string, scopeKey: ReviewScopeKey): boolean {
  if (!patchId || !scopeKey) return false;
  const entries = loadAll();
  const filtered = entries.filter((e) => !(e.patchId === patchId && e.scopeKey === scopeKey));
  if (filtered.length === entries.length) return false;
  saveAll(filtered);
  return true;
}

export function clearPendingForScope(scopeKey: ReviewScopeKey): void {
  if (!scopeKey) return;
  const entries = loadAll();
  const filtered = entries.filter((e) => e.scopeKey !== scopeKey);
  saveAll(filtered);
}

export function pruneExpired(): number {
  const entries = loadAll();
  const now = Date.now();
  const filtered = entries.filter((e) => e.expiresAt >= now);
  if (filtered.length === entries.length) return 0;
  saveAll(filtered);
  return entries.length - filtered.length;
}

export function pathsOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  const na = normalizePaths(a);
  const nb = normalizePaths(b);
  if (na.length === 0 || nb.length === 0) return false;
  const setB = new Set(nb);
  for (const p of na) {
    if (setB.has(p)) return true;
  }
  return false;
}
