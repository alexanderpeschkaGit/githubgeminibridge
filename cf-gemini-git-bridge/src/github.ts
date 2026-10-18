import type { GitHubCommitResult } from './types';

const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

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
): Promise<{ headOid: string; resolvedBranch: string }> {
  const qualifiedBranch = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;

  const query = `
    query GetBranchHead($owner: String!, $repo: String!, $branch: String!) {
      repository(owner: $owner, name: $repo) {
        ref(qualifiedName: $branch) {
          name
          target {
            oid
          }
        }
        defaultBranchRef {
          name
          target {
            oid
          }
        }
      }
    }
  `;

  const data = await executeGraphQL<any>(query, { owner, repo, branch: qualifiedBranch }, token);
  const repository = data?.repository;

  if (!repository) {
    throw new Error(`Repository "${owner}/${repo}" was not found or is not accessible with the provided token.`);
  }

  if (repository.ref?.target?.oid) {
    return {
      headOid: repository.ref.target.oid,
      resolvedBranch: repository.ref.name
    };
  }

  // If specific branch not found, but branch was default/empty or fallback
  if (!branch && repository.defaultBranchRef?.target?.oid) {
    return {
      headOid: repository.defaultBranchRef.target.oid,
      resolvedBranch: repository.defaultBranchRef.name
    };
  }

  throw new Error(`Branch "${branch}" (or "${qualifiedBranch}") not found in repository "${owner}/${repo}".`);
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

  const variables = {
    input: {
      branch: {
        repositoryNameWithOwner: `${owner}/${repo}`,
        branchName: branch
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
