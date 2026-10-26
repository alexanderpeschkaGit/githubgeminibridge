import type { MixRequest, MixResponse } from '../types';
import { parseRepoOwner, getBranchHeadOid, commitSingleFileViaGraphQL } from '../utils/github';
import { buildChunkedMixXml } from './mixChunker';
import { fetchRecentCommitsAndVolatileFiles } from './recentCommits';
import { scanTarGzipStream, TarScanError, type TarScanResult } from './mixerTarScan';

// Preserve the historical module surface for existing importers.
export { escapeCdata, shouldSkipTarEntry, extractHeadOidFromPaxHeader } from './mixerTarScan';

/**
 * Handles POST /api/mix requests.
 * Fetches the repository tarball in a single HTTP subrequest, decompresses it on the fly,
 * filters files in Worker RAM without exceeding 128 MB, and outputs structured XML.
 */
export async function handleMixRequest(
  req: MixRequest,
  githubToken: string
): Promise<MixResponse> {
  let owner = '';
  let repo = '';
  try {
    const parsed = parseRepoOwner(req.repo);
    owner = parsed.owner;
    repo = parsed.repo;
  } catch (err: any) {
    return {
      status: 'ERROR',
      headOid: '',
      xmlContent: '',
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: err.message || 'Invalid repository format'
    };
  }

  const resolvedBranch = (req.branch || 'main').trim();
  const tarUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(resolvedBranch)}`;

  const res = await fetch(tarUrl, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Cloudflare-Worker-gemini-git-bridge'
    }
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    return {
      status: 'ERROR',
      headOid: '',
      xmlContent: '',
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: `GitHub tarball fetch failed with HTTP ${res.status} (${res.statusText}): ${errorBody}`
    };
  }

  if (!res.body) {
    return {
      status: 'ERROR',
      headOid: '',
      xmlContent: '',
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: 'GitHub tarball response body is empty'
    };
  }

  let scan: TarScanResult;
  try {
    scan = await scanTarGzipStream(res.body, req.includePaths);
  } catch (err: any) {
    if (err instanceof TarScanError) {
      return {
        status: 'ERROR',
        headOid: err.headOid || '',
        xmlContent: '',
        stats: { fileCount: 0, estimatedTokens: 0 },
        errorMessage: err.message
      };
    }
    throw err;
  }

  let headOid = scan.headOid;
  const fileTreeEntries = scan.fileTreeEntries;
  const files = scan.files;

  // Guarantee 40-character headOid
  if (!headOid || !/^[0-9a-fA-F]{40}$/.test(headOid)) {
    try {
      const branchInfo = await getBranchHeadOid(owner, repo, resolvedBranch, githubToken);
      headOid = branchInfo.headOid;
    } catch (err: any) {
      return {
        status: 'ERROR',
        headOid: '',
        xmlContent: '',
        stats: { fileCount: 0, estimatedTokens: 0 },
        errorMessage: `Failed to resolve 40-character HEAD commit OID: ${err.message}`
      };
    }
  }

  // Fetch recent commits & volatile files only on explicit opt-in (default: false)
  let recentCommitsText = '';
  let recentCommitsCount = 0;
  let volatileFilesCount = 0;
  if (req.includeRecentCommits === true) {
    try {
      const commitsResult = await fetchRecentCommitsAndVolatileFiles(
        owner,
        repo,
        resolvedBranch,
        githubToken,
        req.recentCommitsCount || 3
      );
      recentCommitsText = commitsResult.xmlContent;
      recentCommitsCount = commitsResult.commits.length;
      volatileFilesCount = commitsResult.volatileFiles.length;
    } catch {
      // Graceful fallback
    }
  }

  // Partition files and build structured XML representation(s)
  let mixResult;
  try {
    mixResult = buildChunkedMixXml({
      owner,
      repo,
      branch: resolvedBranch,
      headOid,
      fileTreeEntries,
      files,
      recentCommitsText,
      maxChunkChars: req.maxChunkChars,
      maxChunkBytes: req.maxChunkBytes,
      maxChunkTokens: req.maxChunkTokens,
      splitOutput: req.splitOutput,
    });
  } catch (err: any) {
    return {
      status: 'ERROR',
      headOid,
      xmlContent: '',
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: err.message || 'Failed to build chunked mix XML',
      ...(scan.skippedFiles && scan.skippedFiles.length > 0 ? { skippedFiles: scan.skippedFiles } : {})
    };
  }

  let persistedCommitOid: string | undefined;

  // Persist to GitHub if requested
  if (req.persistToGitHub === true) {
    try {
      const commitRes = await commitSingleFileViaGraphQL({
        repo: `${owner}/${repo}`,
        branch: resolvedBranch,
        expectedHeadOid: headOid,
        path: '_context/repo-mix.xml',
        content: mixResult.xmlContent,
        commitMessage: 'chore(context): update repo-mix.xml snapshot',
        token: githubToken
      });
      persistedCommitOid = commitRes.oid;
      headOid = commitRes.oid;
    } catch (err: any) {
      const skippedFiles = scan.skippedFiles && scan.skippedFiles.length > 0 ? scan.skippedFiles : undefined;
      return {
        status: 'ERROR',
        headOid,
        xmlContent: mixResult.xmlContent,
        parts: mixResult.parts,
        isChunked: mixResult.isChunked,
        stats: {
          ...mixResult.stats,
          ...(recentCommitsCount > 0 ? { recentCommitsCount, volatileFilesCount } : {})
        },
        errorMessage: `Failed to persist repo-mix.xml snapshot to GitHub: ${err.message}`,
        ...(skippedFiles ? { skippedFiles } : {})
      };
    }
  }

  const skippedFiles = scan.skippedFiles && scan.skippedFiles.length > 0 ? scan.skippedFiles : undefined;

  return {
    status: 'OK',
    headOid,
    xmlContent: mixResult.xmlContent,
    parts: mixResult.parts,
    isChunked: mixResult.isChunked,
    stats: {
      ...mixResult.stats,
      ...(recentCommitsCount > 0 ? { recentCommitsCount, volatileFilesCount } : {})
    },
    ...(persistedCommitOid ? { persistedCommitOid } : {}),
    ...(skippedFiles ? { skippedFiles } : {})
  };
}
