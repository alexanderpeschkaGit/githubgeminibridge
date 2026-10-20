import type {
  GeminiPatchPayload,
  WorkerPatchRequest,
  WorkerPatchResponse,
} from '../../../../shared/types';
import type { HudConfig, HudState } from '../types';

function normalizeBranch(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, '');
}

export function buildWorkerPatchRequest(
  config: HudConfig,
  state: Pick<HudState, 'headOid' | 'targetHeadOid' | 'targetHeadBranch'>,
  payload: GeminiPatchPayload
): WorkerPatchRequest {
  const targetBranch = config.targetBranch?.trim() || undefined;
  const isDistinctTarget = !!targetBranch &&
    normalizeBranch(targetBranch) !== normalizeBranch(config.branch);
  const targetOidIsCurrent = isDistinctTarget &&
    normalizeBranch(state.targetHeadBranch) === normalizeBranch(targetBranch) &&
    /^[0-9a-f]{40}$/i.test(state.targetHeadOid);
  return {
    repo: config.repo,
    branch: config.branch,
    expectedHeadOid: state.headOid,
    payload,
    targetBranch,
    expectedTargetHeadOid: targetOidIsCurrent ? state.targetHeadOid || undefined : undefined,
  };
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
