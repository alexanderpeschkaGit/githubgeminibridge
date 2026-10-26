import type { GitHubCommitResult } from '../types';
import { normalizeRepoPath } from '../../../../shared/repoPaths';
import { utf8ToBase64 } from './encoding';
import { parseRepoOwner } from './githubRepo';
import { executeGraphQL } from './githubGraphQL';

/**
 * Executes createCommitOnBranch mutation.
 */
export async function createCommitOnBranch(
  owner: string,
  repo: string,
  branch: string,
  expectedHeadOid: string,
  message: string,
  additions: { path: string; contents: string }[],
  deletions: { path: string }[],
  token: string
): Promise<GitHubCommitResult> {
  const mutation = `
    mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          url
          messageHeadline
        }
      }
    }
  `;

  const headline = message.split('\n')[0].trim();
  const body = message.includes('\n') ? message.split('\n').slice(1).join('\n').trim() : undefined;

  const fileChanges: Record<string, any> = {};
  if (additions.length > 0) {
    fileChanges.additions = additions.map((addition) => ({
      ...addition,
      path: normalizeRepoPath(addition.path)
    }));
  }
  if (deletions.length > 0) {
    fileChanges.deletions = deletions.map((deletion) => ({
      path: normalizeRepoPath(deletion.path)
    }));
  }

  const cleanBranch = branch.replace(/^refs\/heads\//, '');

  const variables = {
    input: {
      branch: {
        repositoryNameWithOwner: `${owner}/${repo}`,
        branchName: cleanBranch
      },
      expectedHeadOid,
      message: {
        headline,
        body: body || null
      },
      fileChanges
    }
  };

  const data = await executeGraphQL<any>(mutation, variables, token);
  const commit = data?.createCommitOnBranch?.commit;

  if (!commit?.oid) {
    throw new Error('createCommitOnBranch did not return commit information.');
  }

  return {
    oid: commit.oid,
    url: commit.url,
    messageHeadline: commit.messageHeadline
  };
}

export interface CommitSingleFileParams {
  repo: string; // "owner/repo"
  branch: string;
  expectedHeadOid: string;
  path: string;
  content: string;
  commitMessage: string;
  token: string;
}

/**
 * Commits a single UTF-8 file via GitHub GraphQL createCommitOnBranch (e.g. for Stage 1 /_context/repo-mix.xml persistence).
 */
export async function commitSingleFileViaGraphQL(
  params: CommitSingleFileParams
): Promise<GitHubCommitResult>;
export async function commitSingleFileViaGraphQL(
  repoWithOwner: string,
  branch: string,
  expectedHeadOid: string,
  path: string,
  content: string,
  commitMessage: string,
  token: string
): Promise<GitHubCommitResult>;
export async function commitSingleFileViaGraphQL(
  owner: string,
  repo: string,
  branch: string,
  expectedHeadOid: string,
  path: string,
  content: string,
  commitMessage: string,
  token: string
): Promise<GitHubCommitResult>;
export async function commitSingleFileViaGraphQL(
  arg1: string | CommitSingleFileParams,
  arg2?: string,
  arg3?: string,
  arg4?: string,
  arg5?: string,
  arg6?: string,
  arg7?: string,
  arg8?: string
): Promise<GitHubCommitResult> {
  if (typeof arg1 === 'object' && arg1 !== null) {
    const { owner, repo } = parseRepoOwner(arg1.repo);
    const encoded = utf8ToBase64(arg1.content);
    return createCommitOnBranch(
      owner,
      repo,
      arg1.branch,
      arg1.expectedHeadOid,
      arg1.commitMessage,
      [{ path: arg1.path, contents: encoded }],
      [],
      arg1.token
    );
  }

  if (typeof arg8 === 'string') {
    const encoded = utf8ToBase64(arg6 as string);
    return createCommitOnBranch(
      arg1,
      arg2 as string,
      arg3 as string,
      arg4 as string,
      arg7 as string,
      [{ path: arg5 as string, contents: encoded }],
      [],
      arg8
    );
  }

  const { owner, repo } = parseRepoOwner(arg1);
  const encoded = utf8ToBase64(arg5 as string);
  return createCommitOnBranch(
    owner,
    repo,
    arg2 as string,
    arg3 as string,
    arg6 as string,
    [{ path: arg4 as string, contents: encoded }],
    [],
    arg7 as string
  );
}
