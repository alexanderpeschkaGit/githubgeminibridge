import { BranchNotFoundError, getBranchHeadOid, createBranchRef } from '../utils/github';
import { classifyGitHubError } from '../utils/githubError';

export interface BranchHeadInfo {
  headOid: string;
  resolvedBranch: string;
  repositoryId?: string;
}

export interface ResolveSourceHeadParams {
  owner: string;
  repo: string;
  branch: string;
  expectedHeadOid: string;
  githubToken: string;
}

export interface ResolveOrCreateTargetParams {
  owner: string;
  repo: string;
  baseBranch: string;
  effectiveTargetBranch: string;
  sourceInfo: BranchHeadInfo;
  expectedTargetHeadOid?: string;
  createBranchIfNeeded?: boolean;
  dryRun?: boolean;
  githubToken: string;
  baseOidForCreate: string;
}

export interface ResolveOrCreateTargetResult {
  targetInfo: BranchHeadInfo;
  createdBranch: boolean;
}

const normalizeBranch = (branch: string) => branch.replace(/^refs\/heads\//, '');

export async function resolveSourceHead(params: ResolveSourceHeadParams): Promise<BranchHeadInfo> {
  try {
    return await getBranchHeadOid(params.owner, params.repo, params.branch, params.githubToken);
  } catch (err: any) {
    throw err;
  }
}

export async function resolveOrCreateTarget(params: ResolveOrCreateTargetParams): Promise<ResolveOrCreateTargetResult> {
  let targetInfo: BranchHeadInfo = params.sourceInfo;
  let createdBranch = false;

  try {
    targetInfo = await getBranchHeadOid(params.owner, params.repo, params.effectiveTargetBranch, params.githubToken);
    return { targetInfo, createdBranch };
  } catch (err: any) {
    if (!(err instanceof BranchNotFoundError)) {
      throw err;
    }

    if (params.expectedTargetHeadOid) {
      throw err;
    } else if (params.dryRun) {
      targetInfo = {
        headOid: params.baseOidForCreate,
        resolvedBranch: normalizeBranch(params.effectiveTargetBranch),
        repositoryId: params.sourceInfo.repositoryId
      };
      return { targetInfo, createdBranch: false };
    } else if (params.createBranchIfNeeded === false) {
      throw err;
    } else {
      try {
        const createdRef = await createBranchRef(
          params.owner,
          params.repo,
          params.effectiveTargetBranch,
          params.baseOidForCreate,
          params.githubToken,
          params.sourceInfo.repositoryId
        );
        createdBranch = true;
        targetInfo = {
          headOid: createdRef.oid || params.baseOidForCreate,
          resolvedBranch: normalizeBranch(params.effectiveTargetBranch),
          repositoryId: params.sourceInfo.repositoryId
        };
        return { targetInfo, createdBranch };
      } catch (createErr: any) {
        try {
          targetInfo = await getBranchHeadOid(params.owner, params.repo, params.effectiveTargetBranch, params.githubToken);
          return { targetInfo, createdBranch: false };
        } catch (resolveErr: any) {
          throw createErr;
        }
      }
    }
  }
}

export { BranchNotFoundError } from '../utils/github';
export { classifyGitHubError } from '../utils/githubError';
