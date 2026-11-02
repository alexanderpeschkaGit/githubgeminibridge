import type { HarvestedPatch } from '../types';
import { normalizeRepoPath } from '../../../../shared/repoPaths';
import { getStoredValue, setStoredValue } from './storage';

export type ReviewScopeInput =
  | string
  | {
      profileKey: string;
      repoFullName: string;
      sourceBranch: string;
      targetBranch: string;
      convoKey?: string;
    };

export interface RevisionPendingRecord {
  patchId: string;
  profileKey: string;
  repoFullName: string;
  sourceBranch: string;
  targetBranch: string;
  convoKey: string;
  paths: string[];
  timestamp: number;
}

const REVIEW_STORE_KEY = 'patch_review_store_v1';
const MAX_RECORDS_PER_SCOPE = 50;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function loadStore(): RevisionPendingRecord[] {
  try {
    const raw = getStoredValue(REVIEW_STORE_KEY, '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && typeof r.patchId === 'string' && typeof r.timestamp === 'number');
  } catch {
    return [];
  }
}

function saveStore(records: RevisionPendingRecord[]): void {
  try {
    setStoredValue(REVIEW_STORE_KEY, JSON.stringify(records));
  } catch {
    // ignore storage errors
  }
}

function normalizeScopeKeyParts(parts: Partial<RevisionPendingRecord>): string {
  return [
    (parts.profileKey || '').toLowerCase().trim(),
    (parts.repoFullName || '').toLowerCase().trim(),
    (parts.sourceBranch || '').toLowerCase().trim(),
    (parts.targetBranch || '').toLowerCase().trim(),
    (parts.convoKey || '').trim()
  ].join('|');
}

export function buildConvoKey(): string {
  try {
    if (typeof window !== 'undefined') {
      const loc = window.location;
      if (loc && loc.origin && loc.pathname) {
        // Use origin + pathname for conversation scope; fallback to session id
        const base = loc.origin + loc.pathname;
        if (base.length > 0) return base;
      }
    }
  } catch {}
  // Per-tab session identifier fallback
  try {
    if (typeof sessionStorage !== 'undefined') {
      let sid = sessionStorage.getItem('ggb_review_convo_session');
      if (!sid) {
        sid = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('ggb_review_convo_session', sid);
      }
      return sid;
    }
  } catch {}
  return 'default';
}

export function buildReviewScopeKey(parts: {
  profileKey: string;
  repoFullName: string;
  sourceBranch: string;
  targetBranch: string;
  convoKey?: string;
}): string {
  return normalizeScopeKeyParts({ ...parts, convoKey: parts.convoKey || buildConvoKey() });
}

export function isRevisionPending(
  patchId: string,
  scope: ReviewScopeInput
): boolean {
  const scopeKey = typeof scope === 'string' ? scope : buildReviewScopeKey(scope);
  const now = Date.now();
  const records = loadStore().filter((r) => now - r.timestamp <= MAX_AGE_MS);
  if (records.length !== loadStore().length) {
    saveStore(records);
  }
  return records.some((r) => r.patchId === patchId && normalizeScopeKeyParts(r) === scopeKey);
}

export function markRevisionPending(
  patchId: string,
  scopeOrKey: ReviewScopeInput,
  paths: string[]
): void {
  const scopeKey = typeof scopeOrKey === 'string' ? scopeOrKey : buildReviewScopeKey(scopeOrKey);
  const records = loadStore().filter((r) => Date.now() - r.timestamp <= MAX_AGE_MS);
  // Remove any existing record for this patchId in same scope
  const filtered = records.filter((r) => !(r.patchId === patchId && normalizeScopeKeyParts(r) === scopeKey));
  
  // Parse scope key back
  const parts = scopeKey.split('|');
  const record: RevisionPendingRecord = {
    patchId,
    profileKey: parts[0] || '',
    repoFullName: parts[1] || '',
    sourceBranch: parts[2] || '',
    targetBranch: parts[3] || '',
    convoKey: parts[4] || buildConvoKey(),
    paths: paths.map((p) => normalizeRepoPath(p)).filter(Boolean),
    timestamp: Date.now()
  };
  
  filtered.push(record);
  
  // Cap by scope count
  const scopeRecords = filtered.filter((r) => normalizeScopeKeyParts(r) === scopeKey);
  const otherRecords = filtered.filter((r) => normalizeScopeKeyParts(r) !== scopeKey);
  if (scopeRecords.length > MAX_RECORDS_PER_SCOPE) {
    scopeRecords.sort((a, b) => a.timestamp - b.timestamp);
    scopeRecords.splice(0, scopeRecords.length - MAX_RECORDS_PER_SCOPE);
  }
  
  saveStore([...otherRecords, ...scopeRecords]);
}

export function restoreRevisionPending(
  patchId: string,
  scope: ReviewScopeInput
): void {
  const scopeKey = typeof scope === 'string' ? scope : buildReviewScopeKey(scope);
  const records = loadStore().filter((r) => !(r.patchId === patchId && normalizeScopeKeyParts(r) === scopeKey));
  saveStore(records);
}

export function getPendingEntry(patchId: string, scopeKey: string): RevisionPendingRecord | null {
  const records = loadStore().filter((r) => Date.now() - r.timestamp <= MAX_AGE_MS);
  const found = records.find((r) => r.patchId === patchId && normalizeScopeKeyParts(r) === scopeKey);
  return found || null;
}

export function getPendingForScope(scopeKeyOrScope: string | { profileKey: string; repoFullName: string; sourceBranch: string; targetBranch: string; convoKey?: string }): RevisionPendingRecord[] {
  const scopeKey = typeof scopeKeyOrScope === 'string' ? scopeKeyOrScope : buildReviewScopeKey(scopeKeyOrScope);
  const records = loadStore().filter((r) => Date.now() - r.timestamp <= MAX_AGE_MS);
  return records.filter((r) => normalizeScopeKeyParts(r) === scopeKey);
}

export function pathsOverlap(a: string[], b: string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setA = new Set(
    a
      .map((p) => normalizeRepoPath(p).toLowerCase())
      .filter(Boolean)
  );
  for (const p of b) {
    const normB = normalizeRepoPath(p).toLowerCase();
    if (normB && setA.has(normB)) return true;
  }
  return false;
}
