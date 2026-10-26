import type { HarvestedPatch, HudConfig, HudState } from '../types';
import {
  requestBranchHead,
  requestWorkerPatch,
} from '../services/workerClient';
import {
  executeSelfHealingTurn,
  MAX_SELF_HEALING_RETRIES,
} from '../services/selfHealing';
import {
  buildWorkerPatchRequest,
  isPatchSnapshotReady,
  patchSnapshotRequiredMessage,
  resolveConflictOidReset,
} from '../services/patchOidState';
import {
  applyPatchResponseOids,
  clearPatchOidState,
  clearTargetOidState,
  setSourceHeadOid,
} from '../services/patchOidStore';
import { removeHarvestedPatch } from '../services/patchQueue';
import { resolvePatchPaths } from '../services/patchPaths';
import { classifyRepoOwner, ownerOfRepo } from '../services/accountProfiles';

export interface HudApplyPatchDeps {
  config: HudConfig;
  state: HudState;
  openPanel: () => void;
  updateState: (partial: Partial<HudState>) => void;
  onApplyPatchCustom?: (patch: HarvestedPatch) => Promise<boolean>;
}

/** Applies one harvested patch through the worker, including OID recovery and self-healing. */
export async function applyHudPatch(
  patch: HarvestedPatch,
  { config, state, openPanel, updateState, onApplyPatchCustom }: HudApplyPatchDeps
): Promise<boolean> {
  if (onApplyPatchCustom) {
    return onApplyPatchCustom(patch);
  }

  openPanel();

  // A patch without a detected path can never succeed. Ask once, keep the answer in
  // the queue entry so a retry/self-healing round does not prompt again.
  const resolvedPaths = resolvePatchPaths(patch.payload, (index, total) => {
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
      return null;
    }
    return window.prompt(
      `File path for patch ${index}/${total} (repo-relative, e.g. src/App.tsx):`,
      ''
    );
  });
  if (resolvedPaths.cancelled) {
    updateState({
      status: 'ERROR',
      statusMessage: `❌ ${resolvedPaths.reason}`,
    });
    return false;
  }
  const effectivePayload = resolvedPaths.payload;
  state.harvestedPatches = state.harvestedPatches.map((entry) =>
    entry.id === patch.id ? { ...entry, payload: effectivePayload } : entry
  );

  updateState({
    status: 'PATCHING',
    statusMessage: `⏳ Applying patch: "${patch.commitMessage}"...`,
  });

  // Foreign-owner guard: mixing public foreign repos stays allowed, but commits
  // need a PAT for that owner which no registered account provides.
  const ownerMatch = classifyRepoOwner(config);
  if (ownerMatch === 'foreign') {
    updateState({
      status: 'ERROR',
      statusMessage: `❌ Patch blockiert: "${ownerOfRepo(config.repo)}" ist keiner der registrierten GitHub-Accounts. Öffentliche Repos können weiterhin gemischt werden, aber Commits brauchen einen PAT für diesen Owner.`,
    });
    return false;
  }

  try {
    // A missing snapshot (fresh install, cleared OID, repo switch, browser restart)
    // must not dead-end: resolve the branch's current HEAD through the worker and use
    // it as the concurrency token. The worker still validates it atomically on commit.
    if (!isPatchSnapshotReady(state)) {
      updateState({
        status: 'PATCHING',
        statusMessage: `🔄 No snapshot OID — resolving current HEAD of ${config.repo}@${config.branch}...`,
      });
      try {
        const resolvedOid = await requestBranchHead(config, config.repo, config.branch);
        setSourceHeadOid(config, state, resolvedOid);
        updateState({
          status: 'PATCHING',
          statusMessage: `🔄 Using current ${config.branch} HEAD ${resolvedOid.slice(0, 7)} as concurrency token (no repo mix snapshot).`,
        });
      } catch (resolveErr: any) {
        throw new Error(
          `${patchSnapshotRequiredMessage(config, patch.commitMessage)} (HEAD lookup failed: ${resolveErr.message || String(resolveErr)})`
        );
      }
    }

    if (state.headOid) {
      const patchReq = buildWorkerPatchRequest(config, state, effectivePayload);

      const res = await requestWorkerPatch(config, patchReq);
      if (res.status === 'COMMITTED') {
        state.harvestedPatches = removeHarvestedPatch(state.harvestedPatches, patch.id);
        applyPatchResponseOids(config, state, res);
        const branchLabel = res.targetBranch || config.branch;
        const prMsg = res.pullRequestUrl ? ` | 🔗 PR: ${res.pullRequestUrl}` : '';
        updateState({
          status: 'COMMITTED',
          statusMessage: `✅ Committed to ${branchLabel}: ${res.newHeadOid ? res.newHeadOid.slice(0, 7) : 'OK'} (${patch.commitMessage})${prMsg}`,
          retryCount: 0,
          lastErrors: [],
        });
        return true;
      }

      if (res.status === 'PREFLIGHT_FAILED') {
        const selfHealingResult = executeSelfHealingTurn(res, config, state, true);
        if (selfHealingResult.triggered) {
          updateState({
            status: 'PREFLIGHT_FAILED',
            statusMessage: `⚠️ Preflight failed. 🤖 Auto-Pilot self-healing prompt injected (Turn ${selfHealingResult.nextRetryCount}/${MAX_SELF_HEALING_RETRIES}).`,
            retryCount: selfHealingResult.nextRetryCount,
            lastErrors: res.errors || [],
          });
        } else {
          const reasonMsg =
            selfHealingResult.reason === 'MAX_RETRIES_EXCEEDED'
              ? `Max retries (${MAX_SELF_HEALING_RETRIES}) reached.`
              : 'Auto-pilot disabled.';
          updateState({
            status: 'PREFLIGHT_FAILED',
            statusMessage: `❌ Preflight failed. ${reasonMsg} Review errors below or trigger manual retry.`,
            retryCount: selfHealingResult.nextRetryCount,
            lastErrors: res.errors || [],
          });
        }
        return false;
      }

      if (res.status === 'GIT_CONFLICT' || res.status === 'ERROR') {
        const scopeHint = res.status === 'GIT_CONFLICT'
          ? ` [validated ${config.repo}@${config.branch}]`
          : '';
        const resetScope = resolveConflictOidReset(res);
        if (resetScope === 'source') {
          clearPatchOidState(state);
        } else if (resetScope === 'target') {
          clearTargetOidState(state);
        }
        const recoveryHint = resetScope === 'source'
          ? ' Stale snapshot OID discarded — click "Load Repo Mix" to mix the current HEAD, then retry.'
          : resetScope === 'target'
            ? ` Target OID discarded — retry to commit on the current "${config.targetBranch}" HEAD.`
            : '';
        updateState({
          status: res.status,
          statusMessage: `❌ ${res.status}: ${res.errorMessage || 'Preflight / Concurrency check failed'}${scopeHint}${recoveryHint}`,
          lastErrors: res.errors || [],
        });
        return false;
      }

      if (res.status === 'NO_CHANGES_NEEDED') {
        state.harvestedPatches = removeHarvestedPatch(state.harvestedPatches, patch.id);
        applyPatchResponseOids(config, state, res);
        updateState({
          status: 'IDLE',
          statusMessage: `ℹ️ No changes needed (idempotent patch).`,
        });
        return true;
      }
    }

    // Without a mix snapshot there is no expectedHeadOid to validate against.
    // A silent V1 /push fallback would commit against an unknown revision.
    throw new Error(patchSnapshotRequiredMessage(config, patch.commitMessage));
  } catch (err: any) {
    updateState({
      status: 'ERROR',
      statusMessage: `❌ Patch error: ${err.message || String(err)}`,
    });
    return false;
  }
}
