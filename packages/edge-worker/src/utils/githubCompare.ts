export interface GitHubCompareResult {
  status: string;
  targetBehindBy: number;
  targetAheadBy: number;
  totalCommits: number;
}

/**
 * Compares two commits via GitHub's REST compare API:
 * GET /repos/{owner}/{repo}/compare/{targetOid}...{sourceOid}
 *
 * In this comparison:
 * - json.ahead_by means source is ahead of target (targetBehindBy)
 * - json.behind_by means source is behind target (targetAheadBy)
 */
export async function compareCommits(
  owner: string,
  repo: string,
  targetOid: string,
  sourceOid: string,
  token: string
): Promise<GitHubCompareResult> {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedTarget = encodeURIComponent(targetOid);
  const encodedSource = encodeURIComponent(sourceOid);

  const url = `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/compare/${encodedTarget}...${encodedSource}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Cloudflare-Worker-gemini-git-bridge',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to compare commits "${targetOid}" and "${sourceOid}" on "${owner}/${repo}": HTTP ${res.status} - ${errText}`);
  }

  const json: any = await res.json();
  return {
    status: typeof json.status === 'string' ? json.status : 'unknown',
    targetBehindBy: typeof json.ahead_by === 'number' ? json.ahead_by : 0,
    targetAheadBy: typeof json.behind_by === 'number' ? json.behind_by : 0,
    totalCommits: typeof json.total_commits === 'number' ? json.total_commits : 0
  };
}
