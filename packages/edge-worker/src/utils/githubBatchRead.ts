import { normalizeRepoPath } from '../../../../shared/repoPaths';
import { parseRepoOwner } from './githubRepo';
import { executeGraphQL, fetchFileContent } from './githubGraphQL';

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

  // `expression: "<oid>:<path>"` is strict: "./src/a.ts", "/src/a.ts" and "src\a.ts"
  // all resolve to null, so every lookup goes through the canonical form.
  const uniquePaths = Array.from(new Set(paths.map((p) => normalizeRepoPath(p)))).filter(Boolean);
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
