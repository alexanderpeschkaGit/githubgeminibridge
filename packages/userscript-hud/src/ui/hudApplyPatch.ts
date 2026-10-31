import type { HarvestedPatch, HudConfig, HudState, LinterError, WorkerPatchResponse } from '../types';
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
import { removeHarvestedPatch, partitionQueueForHolisticCheck } from '../services/patchQueue';
import { resolvePatchPaths } from '../services/patchPaths';
import { classifyRepoOwner, ownerOfRepo } from '../services/accountProfiles';

export interface HudApplyPatchDeps {
  config: HudConfig;
  state: HudState;
  openPanel: () => void;
  updateState: (partial: Partial<HudState>) => void;
  onApplyPatchCustom?: (patch: HarvestedPatch) => Promise<boolean>;
  onMarkQueueSuperseded?: (ids: string[]) => void;
}

function checkForeignOwnerBlocked(
  config: HudConfig,
  updateState: (partial: Partial<HudState>) => void
): boolean {
  if (classifyRepoOwner(config) !== 'foreign') return false;
  updateState({
    status: 'ERROR',
    statusMessage: `❌ Patch blockiert: "${ownerOfRepo(config.repo)}" ist keiner der registrierten GitHub-Accounts. Öffentliche Repos können weiterhin gemischt werden, aber Commits brauchen einen PAT für diesen Owner.`,
  });
  return true;
}

function handleConflictOrError(
  res: WorkerPatchResponse,
  config: HudConfig,
  state: HudState,
  updateState: (partial: Partial<HudState>) => void
): false {
  const scopeHint = res.status === 'GIT_CONFLICT' ? ` [validated ${config.repo}@${config.branch}]` : '';
  const resetScope = resolveConflictOidReset(res);
  if (resetScope === 'source') {
    clearPatchOidState(state);
  } else if (resetScope === 'target') {
    clearTargetOidState(state);
  }
  const recoveryHint =
    resetScope === 'source'
      ? ' Stale snapshot OID discarded — click "Load Repo Mix" to mix the current HEAD, then retry.'
      : resetScope === 'target'
        ? ` Target OID discarded — retry to commit on the current "${config.targetBranch}" HEAD.`
        : '';
  updateState({
    status: res.status === 'GIT_CONFLICT' ? 'GIT_CONFLICT' : 'ERROR',
    statusMessage: `❌ ${res.status}: ${res.errorMessage || 'Preflight / Concurrency check failed'}${scopeHint}${recoveryHint}`,
    lastErrors: res.errors || [],
  });
  return false;
}

function handlePreflightFailure(
  res: WorkerPatchResponse,
  config: HudConfig,
  state: HudState,
  updateState: (partial: Partial<HudState>) => void,
  prefixLabel: string,
  targetFiles?: string[]
): false {
  const selfHealingResult = executeSelfHealingTurn(res, config, state, true, targetFiles);
  const errors = res.errors || [];
  if (selfHealingResult.triggered) {
    updateState({
      status: 'PREFLIGHT_FAILED',
      statusMessage: `⚠️ ${prefixLabel} 🤖 Auto-Pilot self-healing prompt injected (Turn ${selfHealingResult.nextRetryCount}/${MAX_SELF_HEALING_RETRIES}).`,
      retryCount: selfHealingResult.nextRetryCount,
      lastErrors: errors,
    });
  } else {
    const reasonMsg =
      selfHealingResult.reason === 'MAX_RETRIES_EXCEEDED'
        ? `Max retries (${MAX_SELF_HEALING_RETRIES}) reached.`
        : 'Auto-pilot disabled.';
    updateState({
      status: 'PREFLIGHT_FAILED',
      statusMessage: `❌ ${prefixLabel} ${reasonMsg} Review errors below or trigger manual retry.`,
      retryCount: selfHealingResult.nextRetryCount,
      lastErrors: errors,
    });
  }
  return false;
}

/** Applies one harvested patch through the worker, including OID recovery and self-healing. */
export async function applyHudPatch(
  patch: HarvestedPatch,
  { config, state, openPanel, updateState, onApplyPatchCustom, onMarkQueueSuperseded }: HudApplyPatchDeps
): Promise<boolean> {
  if (onApplyPatchCustom) {
    return onApplyPatchCustom(patch);
  }

  openPanel();

  // Foreign-owner guard: mixing public foreign repos stays allowed, but commits
  // need a PAT for that owner which no registered account provides.
  if (checkForeignOwnerBlocked(config, updateState)) {
    return false;
  }

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
        onMarkQueueSuperseded?.([patch.id]);
        const patchTargetFiles = Array.from(
          new Set(effectivePayload.patches.map((p) => p.path).filter(Boolean))
        );
        return handlePreflightFailure(
          res,
          config,
          state,
          updateState,
          'Preflight failed.',
          patchTargetFiles
        );
      }

      if (res.status === 'GIT_CONFLICT' || res.status === 'ERROR') {
        return handleConflictOrError(res, config, state, updateState);
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


export interface HolisticQueuePatchDeps extends HudApplyPatchDeps {
  dryRun: boolean;
  onMarkQueueSuperseded?: (ids: string[]) => void;
}

/**
 * Runs a holistic validation across all snippets in the queue:
 * combines missing-path and syntax/linter errors non-fail-fast without prompt popups.
 */
export async function runHolisticQueuePatch(deps: HolisticQueuePatchDeps): Promise<boolean> {
  deps.openPanel();

  if (!deps.dryRun && checkForeignOwnerBlocked(deps.config, deps.updateState)) {
    return false;
  }

  if (deps.state.harvestedPatches.length === 0) {
    return false;
  }

  const partition = partitionQueueForHolisticCheck(deps.state.harvestedPatches);
  const totalSnippets = partition.totalSnippets;
  const targetFiles = partition.targetFiles;

  deps.updateState({
    status: 'PATCHING',
    statusMessage: deps.dryRun
      ? `⏳ Checking ${totalSnippets} snippet(s) across ${targetFiles.length} file(s) (Dry-Run)...`
      : `⏳ Validating and applying ${totalSnippets} snippet(s) across ${targetFiles.length} file(s)...`,
  });

  try {
    if (partition.validBatch && !isPatchSnapshotReady(deps.state)) {
      deps.updateState({
        status: 'PATCHING',
        statusMessage: `🔄 No snapshot OID — resolving current HEAD of ${deps.config.repo}@${deps.config.branch}...`,
      });
      try {
        const resolvedOid = await requestBranchHead(deps.config, deps.config.repo, deps.config.branch);
        setSourceHeadOid(deps.config, deps.state, resolvedOid);
      } catch (resolveErr: any) {
        deps.updateState({
          status: 'ERROR',
          statusMessage: `❌ HEAD lookup failed: ${resolveErr.message || String(resolveErr)}`,
        });
        return false;
      }
    }

    let workerRes: WorkerPatchResponse | undefined;
    if (partition.validBatch && deps.state.headOid) {
      const effectiveDryRun = deps.dryRun || partition.localErrors.length > 0;
      const patchReq = buildWorkerPatchRequest(
        deps.config,
        deps.state,
        partition.validBatch.payload,
        effectiveDryRun
      );
      workerRes = await requestWorkerPatch(deps.config, patchReq);

      if (workerRes.status === 'GIT_CONFLICT' || workerRes.status === 'ERROR') {
        return handleConflictOrError(workerRes, deps.config, deps.state, deps.updateState);
      }
    }

    const allErrors: LinterError[] = [
      ...partition.localErrors,
      ...(workerRes?.errors || [])
    ];

    if (allErrors.length > 0) {
      deps.onMarkQueueSuperseded?.(deps.state.harvestedPatches.map((p) => p.id));
      return handlePreflightFailure(
        { status: 'PREFLIGHT_FAILED', errors: allErrors },
        deps.config,
        deps.state,
        deps.updateState,
        `Holistic validation failed (${allErrors.length} error(s) across ${totalSnippets} snippet(s)).`,
        targetFiles
      );
    }

    if (deps.dryRun || workerRes?.status === 'VALIDATED') {
      deps.updateState({
        status: 'IDLE',
        statusMessage: `✅ All ${totalSnippets} snippet(s) across ${targetFiles.length} file(s) passed preflight & syntax validation! Click "⚡ Apply All" to commit.`,
        lastErrors: [],
        retryCount: 0,
      });
      return true;
    }

    if (workerRes?.status === 'COMMITTED' || workerRes?.status === 'NO_CHANGES_NEEDED') {
      deps.state.harvestedPatches = [];
      applyPatchResponseOids(deps.config, deps.state, workerRes);
      const branchLabel = workerRes.targetBranch || deps.config.targetBranch?.trim() || deps.config.branch;
      const prMsg = workerRes.pullRequestUrl ? ` | 🔗 PR: ${workerRes.pullRequestUrl}` : '';
      const commitMsg = workerRes.status === 'NO_CHANGES_NEEDED'
        ? 'ℹ️ All snippets already up-to-date (no changes needed).'
        : `✅ Committed ${totalSnippets} snippet(s) across ${targetFiles.length} file(s) to ${branchLabel}: ${workerRes.newHeadOid ? workerRes.newHeadOid.slice(0, 7) : 'OK'}${prMsg}`;

      deps.updateState({
        status: workerRes.status === 'NO_CHANGES_NEEDED' ? 'IDLE' : 'COMMITTED',
        statusMessage: commitMsg,
        lastErrors: [],
        retryCount: 0,
      });
      return true;
    }

    deps.updateState({
      status: 'ERROR',
      statusMessage: `❌ Holistic validation could not complete: ${patchSnapshotRequiredMessage(deps.config, 'batch queue')}`,
    });
    return false;
  } catch (err: any) {
    deps.updateState({
      status: 'ERROR',
      statusMessage: `❌ Holistic queue error: ${err.message || String(err)}`,
    });
    return false;
  }
}
