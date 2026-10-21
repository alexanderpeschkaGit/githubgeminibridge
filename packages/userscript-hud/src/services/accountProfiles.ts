import type { HudConfig } from '../types';
import {
  getActiveProfileId,
  getStoredValue,
  loadHudConfig,
  sanitizeRepo,
  setStoredValue,
  type AccountProfileId,
} from './storage';

export const ACCOUNT_PROFILES = [
  { id: 'account1' as const, label: 'Account 1', workerName: 'gemini-git-bridge' },
  { id: 'account2' as const, label: 'Account 2', workerName: 'gemini-git-bridge-account2' },
];

export function isProfileConfigured(cfg: HudConfig): boolean {
  return Boolean(cfg.workerUrl && cfg.workerSecret);
}

export function switchAccountProfile(target: AccountProfileId): HudConfig {
  setStoredValue('active_profile', target);
  return loadHudConfig();
}

/** typed_wins: getipptes Repo wird vor dem Wechsel ins Zielprofil übernommen. */
export function switchAccountProfileWithRepo(target: AccountProfileId, repo: string): HudConfig {
  const cleaned = sanitizeRepo(repo);
  if (cleaned) setStoredValue(`${target}_owner_repo`, cleaned);
  setStoredValue('active_profile', target);
  return loadHudConfig();
}

export function ownerOfRepo(repo: string): string {
  const cleaned = (repo || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '');
  return cleaned.split('/')[0].trim().toLowerCase();
}

export type RepoOwnerMatch = 'active' | 'account1' | 'account2' | 'foreign' | 'empty';

export function classifyRepoOwner(cfg: HudConfig): RepoOwnerMatch {
  const owner = ownerOfRepo(cfg.repo);
  if (!owner) return 'empty';
  if (owner === (cfg.owner || '').trim().toLowerCase()) return 'active';
  const active = getActiveProfileId();
  const other = active === 'account1' ? 'account2' : 'account1';
  const otherOwner = getStoredValue(`${other}_owner`, '').trim().toLowerCase();
  if (otherOwner && owner === otherOwner) return other;
  return 'foreign';
}
