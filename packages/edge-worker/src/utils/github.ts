import type { GitHubCommitResult } from '../types';
import { utf8ToBase64 } from './encoding';

const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

export class BranchNotFoundError extends Error {
  constructor(owner: string, repo: string, branch: string) {
    super(`Branch "${branch}" was not found in repository "${owner}/${repo}".`);
    this.name = 'BranchNotFoundError';
  }
}

/**
 * Splits "owner/repo" into { owner, repo }.
 */
export function parseRepoOwner(repoInput: string, ownerInput?: string): { owner: string; repo: string } {
  if (ownerInput && repoInput && !repoInput.includes('/')) {
    return { owner: ownerInput.trim(), repo: repoInput.trim() };
  }
  const parts = repoInput.trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository format "${repoInput}". Expected "owner/repo".`);
  }
  return {
    owner: parts[0],
    repo: parts.slice(1).join('/')
  };
}

/**
 * Generic GitHub GraphQL executor.
 */
export async function executeGraphQL<T = any>(
  query: string,
  variables: Record<string, any>,
  token: string
): Promise<T> {
  const res = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': 'Cloudflare-Worker-gemini-git-bridge',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GraphQL HTTP error ${res.status} (${res.statusText}): ${text}`);
  }

  const json: any = await res.json();
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors.map((e: any) => e.message).join(' | ');
    throw new Error(`GitHub GraphQL error: ${msg}`);
  }

  return json.data as T;
}

/**
 * Retrieves the current HEAD commit OID for a branch.
 */
export async function getBranchHeadOid(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<{ headOid: string; resolvedBranch: string; repositoryId?: string }> {
  const qualifiedBranch = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;

  const query = `
    query GetBranchHead($owner: String!, $repo: String!, $branch: String!) {
      repository(owner: $owner, name: $repo) {
        id
        ref(qualifiedName: $branch) { name target { oid } }
        defaultBranchRef { name target { oid } }
      }
    }
  `;

  const data = await executeGraphQL<any>(query, { owner, repo, branch: qualifiedBranch }, token);
  const repository = data?.repository;

  if (!repository) {
    throw new Error(`Repository "${owner}/${repo}" was not found or is not accessible with the provided token.`);
  }

  if (repository.ref?.target?.oid) {
    return { headOid: repository.ref.target.oid, resolvedBranch: repository.ref.name, repositoryId: repository.id };
  }

  if (!branch && repository.defaultBranchRef?.target?.oid) {
    return { headOid: repository.defaultBranchRef.target.oid, resolvedBranch: repository.defaultBranchRef.name, repositoryId: repository.id };
  }

  throw new BranchNotFoundError(owner, repo, branch || qualifiedBranch);
}

/**
 * Creates a new Git ref (branch) pointing to a specific commit OID.
 */
export async function createBranchRef(
  owner: string,
  repo: string,
  branchName: string,
  oid: string,
  token: string,
  repositoryId?: string
): Promise<{ refName: string; oid: string }> {
  const cleanBranch = branchName.replace(/^refs\/heads\//, '');
  const qualifiedName = `refs/heads/${cleanBranch}`;

  // 1. Try GraphQL createRef mutation if repositoryId is known
  if (repositoryId) {
    const mutation = `
      mutation CreateRef($input: CreateRefInput!) {
        createRef(input: $input) { ref { name target { oid } } }
      }
    `;
    try {
      const data = await executeGraphQL<any>(mutation, { input: { repositoryId, name: qualifiedName, oid } }, token);
      const ref = data?.createRef?.ref;
      if (ref?.name) return { refName: ref.name, oid: ref.target?.oid || oid };
    } catch {
      // Fall through to REST if GraphQL fails
    }
  }

  // 2. REST API fallback
  const restUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`;
  const res = await fetch(restUrl, {
    method: 'POST',
    headers: {
      'User-Agent': 'Cloudflare-Worker-gemini-git-bridge',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: qualifiedName, sha: oid })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to create branch "${cleanBranch}" on "${owner}/${repo}": HTTP ${res.status} - ${errText}`);
  }

  const json: any = await res.json();
  return { refName: json.ref, oid: json.object?.sha || oid };
}

/**
 * Fetches existing file content from GitHub using GraphQL Blob or REST raw content fallback.
 */
export async function fetchFileContent(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  token: string
): Promise<string> {
  // 1. Try GraphQL Blob object expression
  const expression = `${branch}:${path}`;
  const query = `
    query GetFileBlob($owner: String!, $repo: String!, $expression: String!) {
      repository(owner: $owner, name: $repo) {
        object(expression: $expression) {
          ... on Blob {
            text
            isTruncated
          }
        }
      }
    }
  `;

  try {
    const data = await executeGraphQL<any>(query, { owner, repo, expression }, token);
    const blob = data?.repository?.object;
    if (blob && typeof blob.text === 'string' && !blob.isTruncated) {
      return blob.text;
    }
  } catch {
    // If GraphQL blob query failed, proceed to REST fallback
  }

  // 2. REST raw contents fallback
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const restUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(restUrl, {
    headers: {
      'User-Agent': 'Cloudflare-Worker-gemini-git-bridge',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.raw+json'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch file "${path}" from "${owner}/${repo}" on branch "${branch}": HTTP ${res.status}`);
  }

  return await res.text();
}

export interface BatchFetchParams {
  repo: string; // "owner/repo"
  branch: string;
  paths: string[];
  token: string;
}

/**
 * Fetches multiple files in a SINGLE GitHub GraphQL request using dynamic aliases (f0, f1, ...).
 * Returns a map of { [path]: content | null } where null indicates the file does not exist on the branch.
 */
export async function fetchMultipleFilesViaGraphQL(
  params: BatchFetchParams
): Promise<Record<string, string | null>>;
export async function fetchMultipleFilesViaGraphQL(
  repoWithOwner: string,
  branch: string,
  paths: string[],
  token: string
): Promise<Record<string, string | null>>;
export async function fetchMultipleFilesViaGraphQL(
  owner: string,
  repo: string,
  branch: string,
  paths: string[],
  token: string
): Promise<Record<string, string | null>>;
export async function fetchMultipleFilesViaGraphQL(
  arg1: string | BatchFetchParams,
  arg2?: string,
  arg3?: string | string[],
  arg4?: string | string[],
  arg5?: string
): Promise<Record<string, string | null>> {
  let owner: string;
  let repo: string;
  let branch: string;
  let paths: string[];
  let token: string;

  if (typeof arg1 === 'object' && arg1 !== null) {
    const parsed = parseRepoOwner(arg1.repo);
    owner = parsed.owner;
    repo = parsed.repo;
    branch = arg1.branch;
    paths = arg1.paths;
    token = arg1.token;
  } else if (Array.isArray(arg3) && typeof arg4 === 'string') {
    const parsed = parseRepoOwner(arg1);
    owner = parsed.owner;
    repo = parsed.repo;
    branch = arg2 as string;
    paths = arg3;
    token = arg4;
  } else {
    owner = arg1;
    repo = arg2 as string;
    branch = arg3 as string;
    paths = arg4 as string[];
    token = arg5 as string;
  }

  const uniquePaths = Array.from(new Set(paths));
  const result: Record<string, string | null> = {};
  if (uniquePaths.length === 0) {
    return result;
  }

  const varDefs: string[] = ['$owner: String!', '$repo: String!'];
  const fields: string[] = [];
  const variables: Record<string, any> = { owner, repo };

  uniquePaths.forEach((p, idx) => {
    const varName = `exp_${idx}`;
    varDefs.push(`$${varName}: String!`);
    variables[varName] = `${branch}:${p}`;
    fields.push(`
      f${idx}: object(expression: $${varName}) {
        ... on Blob {
          text
          isTruncated
        }
      }
    `);
  });

  const query = `
    query BatchGetFileBlobs(${varDefs.join(', ')}) {
      repository(owner: $owner, name: $repo) {
        ${fields.join('\n')}
      }
    }
  `;

  const data = await executeGraphQL<any>(query, variables, token);
  const repoObj = data?.repository;
  if (!repoObj) {
    throw new Error(`Repository "${owner}/${repo}" was not found or is not accessible.`);
  }

  for (let idx = 0; idx < uniquePaths.length; idx++) {
    const p = uniquePaths[idx];
    const blob = repoObj[`f${idx}`];
    if (!blob) {
      result[p] = null;
    } else if (blob.isTruncated) {
      result[p] = await fetchFileContent(owner, repo, branch, p, token);
    } else {
      result[p] = typeof blob.text === 'string' ? blob.text : null;
    }
  }

  return result;
}

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
    fileChanges.additions = additions;
  }
  if (deletions.length > 0) {
    fileChanges.deletions = deletions;
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
