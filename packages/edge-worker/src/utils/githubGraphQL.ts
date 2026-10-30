const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

export class BranchNotFoundError extends Error {
  readonly defaultBranch?: string;

  constructor(owner: string, repo: string, branch: string, defaultBranch?: string) {
    super(`Branch "${branch}" was not found in repository "${owner}/${repo}".`);
    this.name = 'BranchNotFoundError';
    this.defaultBranch = defaultBranch || undefined;
  }
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

  throw new BranchNotFoundError(
    owner,
    repo,
    branch || qualifiedBranch,
    repository.defaultBranchRef?.name
  );
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
