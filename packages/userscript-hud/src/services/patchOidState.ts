import type {
  GeminiPatchPayload,
  WorkerPatchRequest,
  WorkerPatchResponse,
} from '../../../../shared/types';
import type { HudConfig, HudState } from '../types';

const OID_REGEX = /^[0-9a-f]{40}$/i;

function normalizeBranch(branch: string): string {
  return (branch || '').trim().replace(/^refs\/heads\//, '');
}

/**
 * A snapshot OID is only meaningful for the exact repo+branch it was mixed from.
 * Persisting it without this scope made every patch fail with GIT_CONFLICT after
 * switching the repo/branch in the HUD (foreign OID vs. real branch HEAD).
 */
export function buildOidScope(config: Pick<HudConfig, 'repo' | 'branch'>): string {
  return `${(config.repo || '').trim().toLowerCase()}#${normalizeBranch(config.branch).toLowerCase()}`;
}

/**
 * Rehydrates persisted patch OIDs, discarding anything that does not belong to the
 * currently configured repo+branch (or to the currently configured target branch).
 */
export function resolvePatchOidState(
  config: HudConfig,
  stored: { headOidScope: string; headOid: string; targetHeadOid: string; targetHeadBranch: string }
): Pick<HudState, 'headOid' | 'targetHeadOid' | 'targetHeadBranch'> {
  if ((stored.headOidScope || '') !== buildOidScope(config)) {
    return { headOid: '', targetHeadOid: '', targetHeadBranch: '' };
  }

  const configuredTarget = normalizeBranch(config.targetBranch || '');
  const storedTarget = normalizeBranch(stored.targetHeadBranch || '');
  const targetIsCurrent = !!configuredTarget &&
    storedTarget === configuredTarget &&
    OID_REGEX.test(stored.targetHeadOid || '');

  return {
    headOid: OID_REGEX.test(stored.headOid || '') ? stored.headOid : '',
    targetHeadOid: targetIsCurrent ? stored.targetHeadOid : '',
    targetHeadBranch: targetIsCurrent ? storedTarget : '',
  };
}

export function buildWorkerPatchRequest(
  config: HudConfig,
  state: Pick<HudState, 'headOid' | 'targetHeadOid' | 'targetHeadBranch'>,
  payload: GeminiPatchPayload,
  dryRun?: boolean
): WorkerPatchRequest {
  const targetBranch = config.targetBranch?.trim() || undefined;
  const isDistinctTarget = !!targetBranch &&
    normalizeBranch(targetBranch) !== normalizeBranch(config.branch);
  const targetOidIsCurrent = isDistinctTarget &&
    normalizeBranch(state.targetHeadBranch) === normalizeBranch(targetBranch) &&
    OID_REGEX.test(state.targetHeadOid);
  return {
    repo: config.repo,
    branch: config.branch,
    expectedHeadOid: state.headOid,
    payload,
    targetBranch,
    expectedTargetHeadOid: targetOidIsCurrent ? state.targetHeadOid || undefined : undefined,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

/**
 * A patch may only be committed against a validated snapshot OID. The former V1
 * `/push` fallback is intentionally gone: it had no `expectedHeadOid` and could
 * apply search/replace blocks against an unknown revision (e.g. after a repo switch).
 */
export function isPatchSnapshotReady(state: Pick<HudState, 'headOid'>): boolean {
  return OID_REGEX.test(state.headOid || '');
}

export function patchSnapshotRequiredMessage(
  config: Pick<HudConfig, 'repo' | 'branch'>,
  commitMessage: string
): string {
  return `No repo mix snapshot for ${config.repo}@${config.branch}. Click "Load Repo Mix" first — patches are only committed against a validated HEAD OID. (Patch: "${commitMessage}")`;
}

/**
 * GIT_CONFLICT recovery: an OID that just lost a concurrency check must not survive,
 * otherwise every retry replays the same wrong token. A response without `targetBranch`
 * is a source-snapshot conflict (the mix is stale), one with `targetBranch` is a
 * target-branch race (only the target token is stale).
 */
export function resolveConflictOidReset(
  response: WorkerPatchResponse
): 'source' | 'target' | 'none' {
  if (response.status !== 'GIT_CONFLICT') return 'none';
  return response.targetBranch ? 'target' : 'source';
}

export function advancePatchOidState(
  config: HudConfig,
  response: WorkerPatchResponse
): Partial<Pick<HudState, 'headOid' | 'targetHeadOid' | 'targetHeadBranch'>> {
  if (
    (response.status !== 'COMMITTED' && response.status !== 'NO_CHANGES_NEEDED') ||
    !response.newHeadOid
  ) {
    return {};
  }

  const configuredTarget = config.targetBranch?.trim();
  const targetIsDistinct = !!configuredTarget &&
    normalizeBranch(configuredTarget) !== normalizeBranch(config.branch);
  if (targetIsDistinct && !response.targetBranch) return {};

  const effectiveBranch = normalizeBranch(response.targetBranch || config.branch);
  if (effectiveBranch === normalizeBranch(config.branch)) {
    return { headOid: response.newHeadOid };
  }
  return {
    targetHeadOid: response.newHeadOid,
    targetHeadBranch: effectiveBranch,
  };
}
