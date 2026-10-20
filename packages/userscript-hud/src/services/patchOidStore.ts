import type { WorkerPatchResponse } from '../../../../shared/types';
import type { HudConfig, HudState } from '../types';
import { getStoredValue, setStoredValue } from './storage';
import { advancePatchOidState, buildOidScope, resolvePatchOidState } from './patchOidState';

export type PatchOidFields = Pick<HudState, 'headOid' | 'targetHeadOid' | 'targetHeadBranch'>;

/**
 * Reads the persisted patch OIDs. Snapshots of a different repo/branch are dropped,
 * because an OID is a freshness token for one exact repo+branch snapshot only.
 */
export function loadPatchOidState(config: HudConfig): PatchOidFields {
  return resolvePatchOidState(config, {
    headOidScope: getStoredValue('head_oid_scope', ''),
    headOid: getStoredValue('head_oid', ''),
    targetHeadOid: getStoredValue('target_head_oid', ''),
    targetHeadBranch: getStoredValue('target_head_branch', ''),
  });
}

export function setSourceHeadOid(config: HudConfig, state: PatchOidFields, oid: string): void {
  state.headOid = oid;
  setStoredValue('head_oid', oid);
  setStoredValue('head_oid_scope', buildOidScope(config));
}

export function clearPatchOidState(state: PatchOidFields): void {
  state.headOid = '';
  setStoredValue('head_oid', '');
  setStoredValue('head_oid_scope', '');
  clearTargetOidState(state);
}

export function clearTargetOidState(state: PatchOidFields): void {
  state.targetHeadOid = '';
  state.targetHeadBranch = '';
  setStoredValue('target_head_oid', '');
  setStoredValue('target_head_branch', '');
}

/** Advances source/target OIDs after a COMMITTED or NO_CHANGES_NEEDED response. */
export function applyPatchResponseOids(
  config: HudConfig,
  state: PatchOidFields,
  response: WorkerPatchResponse
): void {
  const updates = advancePatchOidState(config, response);
  if (updates.headOid) {
    setSourceHeadOid(config, state, updates.headOid);
  }
  if (updates.targetHeadOid) {
    const branch = updates.targetHeadBranch || '';
    state.targetHeadOid = updates.targetHeadOid;
    state.targetHeadBranch = branch;
    setStoredValue('target_head_oid', updates.targetHeadOid);
    setStoredValue('target_head_branch', branch);
  }
}
