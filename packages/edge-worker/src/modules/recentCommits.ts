/**
 * Module: recentCommits.ts
 * Fetches recent commit history and identifies volatile (frequently touched) files.
 * Formats structured XML metadata embedded into Part 1 of the RepoMix snapshot.
 */

export interface CommitFileChange {
  path: string;
  status: 'modified' | 'added' | 'removed' | 'renamed' | string;
}

export interface RecentCommitInfo {
  hash: string;
  date: string;
  author: string;
  title: string;
  files: CommitFileChange[];
}

export interface VolatileFileInfo {
  path: string;
  touchCount: number;
  latestStatus: string;
}

export interface RecentCommitsResult {
  commits: RecentCommitInfo[];
  volatileFiles: VolatileFileInfo[];
  xmlContent: string;
}

/**
 * Escapes characters for XML attribute and text compatibility.
 */
export function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Formats recent commits and volatile files into a structured XML block.
 */
export function formatRecentCommitsXml(
  commits: RecentCommitInfo[],
  volatileFiles: VolatileFileInfo[]
): string {
  if (!commits || commits.length === 0) {
    return '';
  }

  const sections: string[] = ['<recent_commits>'];
  for (const c of commits) {
    const authorAttr = escapeXml(c.author);
    const dateAttr = escapeXml(c.date);
    const hashAttr = escapeXml(c.hash);
    const titleText = escapeXml(c.title);

    sections.push(`  <commit hash="${hashAttr}" date="${dateAttr}" author="${authorAttr}">`);
    sections.push(`    <title>${titleText}</title>`);
    if (c.files.length > 0) {
      sections.push('    <files>');
      for (const f of c.files) {
        sections.push(`      <file path="${escapeXml(f.path)}" status="${escapeXml(f.status)}" />`);
      }
      sections.push('    </files>');
    }
    sections.push('  </commit>');
  }
  sections.push('</recent_commits>');

  if (volatileFiles && volatileFiles.length > 0) {
    sections.push('<volatile_files>');
    for (const v of volatileFiles) {
      sections.push(
        `  <file path="${escapeXml(v.path)}" touchCount="${v.touchCount}" latestStatus="${escapeXml(v.latestStatus)}" />`
      );
    }
    sections.push('</volatile_files>');
  }

  return sections.join('\n');
}

/**
 * Fetches recent commit metadata and file changes from GitHub REST API in parallel.
 * Aggregates touch frequencies to discover volatile files.
 * Always catches errors gracefully and never throws.
 */
export async function fetchRecentCommitsAndVolatileFiles(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  count = 3
): Promise<RecentCommitsResult> {
  const safeCount = Math.min(5, Math.max(1, count));
  const fallback: RecentCommitsResult = { commits: [], volatileFiles: [], xmlContent: '' };

  try {
    const listUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=${safeCount}`;
    const listRes = await fetch(listUrl, {
      headers: {
        'User-Agent': 'Cloudflare-Worker-gemini-git-bridge',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!listRes.ok) {
      return fallback;
    }

    const listData: any = await listRes.json();
    if (!Array.isArray(listData) || listData.length === 0) {
      return fallback;
    }

    const detailPromises = listData.slice(0, safeCount).map(async (c: any): Promise<RecentCommitInfo> => {
      const sha: string = c.sha || '';
      const rawMsg: string = c.commit?.message || '';
      const title = rawMsg.split('\n')[0] || '';
      const author: string = c.commit?.author?.name || c.author?.login || 'unknown';
      const date: string = c.commit?.author?.date || c.commit?.committer?.date || '';

      try {
        const detailUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`;
        const detailRes = await fetch(detailUrl, {
          headers: {
            'User-Agent': 'Cloudflare-Worker-gemini-git-bridge',
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
          },
        });

        if (detailRes.ok) {
          const detailData: any = await detailRes.json();
          const detailMsg: string = detailData.commit?.message || rawMsg;
          const detailTitle = detailMsg.split('\n')[0] || title;
          const detailAuthor: string = detailData.commit?.author?.name || detailData.author?.login || author;
          const detailDate: string = detailData.commit?.author?.date || detailData.commit?.committer?.date || date;
          const files: CommitFileChange[] = Array.isArray(detailData.files)
            ? detailData.files.map((f: any) => ({
                path: String(f.filename || ''),
                status: String(f.status || 'modified'),
              })).filter((f: CommitFileChange) => f.path.length > 0)
            : [];

          return {
            hash: sha,
            date: detailDate,
            author: detailAuthor,
            title: detailTitle,
            files,
          };
        }
      } catch {
        // Fall back to commit list metadata
      }

      return {
        hash: sha,
        date,
        author,
        title,
        files: [],
      };
    });

    const commits = await Promise.all(detailPromises);

    // Aggregate volatile files across all commits (sorted latest to oldest)
    const fileMap = new Map<string, { path: string; touchCount: number; latestStatus: string; latestCommitIndex: number }>();
    for (let cIdx = 0; cIdx < commits.length; cIdx++) {
      const commit = commits[cIdx];
      for (const f of commit.files) {
        if (!f.path) continue;
        const existing = fileMap.get(f.path);
        if (!existing) {
          fileMap.set(f.path, {
            path: f.path,
            touchCount: 1,
            latestStatus: f.status,
            latestCommitIndex: cIdx,
          });
        } else {
          existing.touchCount++;
        }
      }
    }

    const volatileFiles: VolatileFileInfo[] = Array.from(fileMap.values())
      .sort((a, b) => {
        if (b.touchCount !== a.touchCount) {
          return b.touchCount - a.touchCount;
        }
        return a.latestCommitIndex - b.latestCommitIndex;
      })
      .map(({ path, touchCount, latestStatus }) => ({ path, touchCount, latestStatus }));

    const xmlContent = formatRecentCommitsXml(commits, volatileFiles);

    return {
      commits,
      volatileFiles,
      xmlContent,
    };
  } catch {
    return fallback;
  }
}
