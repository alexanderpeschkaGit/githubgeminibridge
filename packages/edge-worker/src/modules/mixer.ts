import type { MixRequest, MixResponse } from '../types';
import { parseRepoOwner, getBranchHeadOid, commitSingleFileViaGraphQL } from '../utils/github';

/**
 * Escapes any occurrences of "]]>" inside file content as "]]]]><![CDATA[>"
 * to ensure that XML CDATA sections are never prematurely closed.
 */
export function escapeCdata(content: string): string {
  return content.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

/**
 * Filter decision helper to avoid allocating buffer or string memory for ignored entries.
 * Evaluates TAR entry metadata at the 512-byte header level.
 */
export function shouldSkipTarEntry(
  relPath: string,
  size: number,
  typeflag: string,
  includePaths?: string[]
): { skip: boolean; reason?: 'DIR_OR_NON_FILE' | 'IGNORED_PATH' | 'OVERSIZED' | 'NOT_INCLUDED' } {
  // 1. Directories, extended headers or non-regular files
  // In POSIX/USTAR tar: '0', '', '\0' are regular files. '5' is directory, 'g' PAX global, 'x' PAX extended.
  if (
    typeflag === '5' ||
    typeflag === 'g' ||
    typeflag === 'x' ||
    relPath.endsWith('/') ||
    (typeflag !== '0' && typeflag !== '' && typeflag !== '\0')
  ) {
    return { skip: true, reason: 'DIR_OR_NON_FILE' };
  }

  // 2. Normalize relPath (strip leading / or ./)
  const normalized = relPath.replace(/^\.?\/+/, '');
  if (!normalized) {
    return { skip: true, reason: 'DIR_OR_NON_FILE' };
  }

  const segments = normalized.split('/');
  const filename = segments[segments.length - 1];

  // 3. Ignored directory paths
  const ignoredDirNames = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    '.wrangler',
    '.turbo',
    '.next',
    'coverage',
    '_v1_backup',
    'backup_unused'
  ]);

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (ignoredDirNames.has(seg) || seg.startsWith('repomix_')) {
      return { skip: true, reason: 'IGNORED_PATH' };
    }
  }

  // 4. Ignored lockfiles, bundle outputs and temporary artifacts
  const ignoredFiles = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb'
  ]);

  if (
    ignoredFiles.has(filename) ||
    filename.endsWith('.bundle') ||
    filename.startsWith('repomix-output') ||
    /.*-bundle.*\.txt$/i.test(filename)
  ) {
    return { skip: true, reason: 'IGNORED_PATH' };
  }

  // 5. Ignored binary, media and archive extensions
  const ignoredExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.svg',
    '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg',
    '.woff', '.woff2', '.ttf', '.eot',
    '.pdf', '.zip', '.tar', '.gz', '.7z',
    '.wasm', '.exe', '.dll', '.so', '.dylib', '.pyc'
  ]);

  const extMatch = filename.match(/\.[a-zA-Z0-9]+$/);
  if (extMatch && ignoredExtensions.has(extMatch[0].toLowerCase())) {
    return { skip: true, reason: 'IGNORED_PATH' };
  }

  // 6. Whitelist includePaths filter
  if (includePaths && includePaths.length > 0) {
    const normalizedIncludes = includePaths.map((p) => p.replace(/^\.?\/+/, ''));
    const isIncluded = normalizedIncludes.some((prefix) => normalized.startsWith(prefix));
    if (!isIncluded) {
      return { skip: true, reason: 'NOT_INCLUDED' };
    }
  }

  // 7. Maximum file size guardrail (512 KB)
  if (size > 524288) {
    return { skip: true, reason: 'OVERSIZED' };
  }

  return { skip: false };
}

/**
 * Extracts a 40-character lowercase hexadecimal SHA from a PAX header payload or comment field.
 */
export function extractHeadOidFromPaxHeader(paxText: string): string | null {
  // Standard git tarball PAX global header: "52 comment=7b20464295e26ecb00996fc108eb39d675e0b6be\n"
  const match = paxText.match(/(?:^|\n)(?:\d+\s+)?comment=([0-9a-fA-F]{40})(?:\r?\n|$)/);
  if (match) {
    return match[1].toLowerCase();
  }

  const directMatch = paxText.match(/\b([0-9a-fA-F]{40})\b/);
  if (directMatch) {
    return directMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Helper to concat two Uint8Arrays.
 */
function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

/**
 * Parses a null-terminated ASCII string from a Uint8Array slice.
 */
function parseAsciiString(buffer: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && buffer[end] !== 0) {
    end++;
  }
  let str = '';
  for (let i = start; i < end; i++) {
    str += String.fromCharCode(buffer[i]);
  }
  return str.trim();
}

/**
 * Parses an octal integer from a TAR header field.
 */
function parseOctal(buffer: Uint8Array, start: number, length: number): number {
  const raw = parseAsciiString(buffer, start, length);
  if (!raw) return 0;
  const parsed = parseInt(raw, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

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

  // Stream decompression
  const decompressedStream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const reader = decompressedStream.getReader();

  let buffer: Uint8Array<any> = new Uint8Array(0);
  let eof = false;
  let consecutiveZeroBlocks = 0;

  let headOid: string | null = null;
  let nextPaxPath: string | null = null;

  const fileTreeEntries: string[] = [];
  const files: { path: string; content: string }[] = [];
  const textDecoder = new TextDecoder();

  // Read next chunk into buffer if needed
  async function ensureBytes(count: number): Promise<boolean> {
    while (buffer.length < count) {
      const { value, done } = await reader.read();
      if (done || !value) {
        eof = true;
        return false;
      }
      buffer = concatBuffers(buffer, value);
    }
    return true;
  }

  // Discard bytes from stream without keeping in memory
  async function discardBytes(count: number): Promise<void> {
    if (buffer.length >= count) {
      buffer = buffer.subarray(count);
      return;
    }
    let remaining = count - buffer.length;
    buffer = new Uint8Array(0);
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done || !value) {
        eof = true;
        return;
      }
      if (value.length <= remaining) {
        remaining -= value.length;
      } else {
        buffer = value.subarray(remaining);
        remaining = 0;
      }
    }
  }

  try {
    while (!eof) {
      const hasHeader = await ensureBytes(512);
      if (!hasHeader && buffer.length < 512) {
        break;
      }

      const header = buffer.subarray(0, 512);

      // Check for zero block (tar termination)
      let isZero = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) {
          isZero = false;
          break;
        }
      }

      if (isZero) {
        consecutiveZeroBlocks++;
        buffer = buffer.subarray(512);
        if (consecutiveZeroBlocks >= 2) {
          // TAR EOF reached
          break;
        }
        continue;
      }
      consecutiveZeroBlocks = 0;

      // Parse TAR Header
      const name = parseAsciiString(header, 0, 100);
      const size = parseOctal(header, 124, 12);
      const typeflagRaw = header[156];
      const typeflag = typeflagRaw === 0 || typeflagRaw === 32 ? '0' : String.fromCharCode(typeflagRaw);
      const prefix = parseAsciiString(header, 345, 155);

      const paddedSize = Math.ceil(size / 512) * 512;

      // Slice out the 512-byte header
      buffer = buffer.subarray(512);

      // 1. PAX Global Extended Header (contains head commit SHA in comment=...)
      if (typeflag === 'g') {
        await ensureBytes(paddedSize);
        const payloadBytes = buffer.subarray(0, size);
        buffer = buffer.subarray(paddedSize);
        const paxText = textDecoder.decode(payloadBytes);
        const extracted = extractHeadOidFromPaxHeader(paxText);
        if (extracted) {
          headOid = extracted;
        }
        continue;
      }

      // 2. PAX Extended Header (overrides path for the next entry)
      if (typeflag === 'x') {
        await ensureBytes(paddedSize);
        const payloadBytes = buffer.subarray(0, size);
        buffer = buffer.subarray(paddedSize);
        const paxText = textDecoder.decode(payloadBytes);
        const match = paxText.match(/(?:^|\n)\d+\s+path=(.+?)(?:\r?\n|$)/);
        if (match) {
          nextPaxPath = match[1].trim();
        }
        continue;
      }

      // Reconstruct entry path
      const rawEntryPath = nextPaxPath || (prefix ? `${prefix}/${name}` : name);
      nextPaxPath = null;

      // Strip top-level repository prefix directory created by GitHub (e.g. "owner-repo-<sha>/")
      const slashIndex = rawEntryPath.indexOf('/');
      if (slashIndex === -1) {
        // Root directory entry or top-level file
        await discardBytes(paddedSize);
        continue;
      }

      const rootPrefix = rawEntryPath.slice(0, slashIndex);
      const relPath = rawEntryPath.slice(slashIndex + 1);

      // Check if rootPrefix ends with 40-character hex SHA
      if (!headOid) {
        const rootMatch = rootPrefix.match(/-([0-9a-fA-F]{40})$/);
        if (rootMatch) {
          headOid = rootMatch[1].toLowerCase();
        }
      }

      if (!relPath || relPath.endsWith('/')) {
        // Directory entry
        await discardBytes(paddedSize);
        continue;
      }

      // Filter check at header level
      const filterDecision = shouldSkipTarEntry(relPath, size, typeflag, req.includePaths);

      if (filterDecision.skip) {
        if (filterDecision.reason === 'OVERSIZED') {
          fileTreeEntries.push(`${relPath} [SKIPPED: >512KB]`);
        }
        await discardBytes(paddedSize);
        continue;
      }

      // Read file content
      await ensureBytes(paddedSize);
      const fileBytes = buffer.subarray(0, size);
      buffer = buffer.subarray(paddedSize);

      const content = textDecoder.decode(fileBytes);

      // Skip binary files if null bytes are present
      if (content.includes('\0')) {
        continue;
      }

      fileTreeEntries.push(relPath);
      files.push({ path: relPath, content });
    }
  } catch (err: any) {
    return {
      status: 'ERROR',
      headOid: headOid || '',
      xmlContent: '',
      stats: { fileCount: 0, estimatedTokens: 0 },
      errorMessage: `Error processing tarball stream: ${err.message}`
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignored
    }
  }

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

  // Sort file tree alphabetically
  fileTreeEntries.sort();

  const fileTreeXml = fileTreeEntries.join('\n');
  const filesXml = files
    .map((f) => `  <file path="${f.path}"><![CDATA[${escapeCdata(f.content)}]]></file>`)
    .join('\n');

  const xmlContent = [
    `<repository repo="${owner}/${repo}" branch="${resolvedBranch}" headOid="${headOid}">`,
    `<file_tree>`,
    fileTreeXml,
    `</file_tree>`,
    `<files>`,
    filesXml,
    `</files>`,
    `</repository>`
  ].join('\n');

  const stats = {
    fileCount: files.length,
    estimatedTokens: Math.ceil(xmlContent.length / 4)
  };

  let persistedCommitOid: string | undefined;

  // Persist to GitHub if requested
  if (req.persistToGitHub === true) {
    try {
      const commitRes = await commitSingleFileViaGraphQL({
        repo: `${owner}/${repo}`,
        branch: resolvedBranch,
        expectedHeadOid: headOid,
        path: '_context/repo-mix.xml',
        content: xmlContent,
        commitMessage: 'chore(context): update repo-mix.xml snapshot',
        token: githubToken
      });
      persistedCommitOid = commitRes.oid;
      headOid = commitRes.oid;
    } catch (err: any) {
      return {
        status: 'ERROR',
        headOid,
        xmlContent,
        stats,
        errorMessage: `Failed to persist repo-mix.xml snapshot to GitHub: ${err.message}`
      };
    }
  }

  return {
    status: 'OK',
    headOid,
    xmlContent,
    stats,
    ...(persistedCommitOid ? { persistedCommitOid } : {})
  };
}
