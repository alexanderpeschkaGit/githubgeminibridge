import {
  concatBuffers,
  parseAsciiString,
  parseOctal,
  parseIgnoreLines,
  matchesIgnorePattern,
  DEFAULT_IGNORED_DIR_NAMES,
  DEFAULT_IGNORED_FILES,
  DEFAULT_IGNORED_EXTENSIONS,
} from '../utils/tarUtils';

export interface TarScanResult {
  headOid: string | null;
  fileTreeEntries: string[];
  files: { path: string; content: string }[];
  skippedFiles?: Array<{ path: string; reason: 'too_large'; bytes?: number; chars?: number }>;
}

/**
 * Carries the partially resolved HEAD OID alongside a stream error so callers can
 * preserve exactly the same error response shape as before the extraction.
 */
export class TarScanError extends Error {
  readonly headOid: string | null;

  constructor(message: string, headOid: string | null) {
    super(message);
    this.name = 'TarScanError';
    this.headOid = headOid;
  }
}

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
): { skip: boolean; reason?: 'DIR_OR_NON_FILE' | 'IGNORED_PATH' | 'OVERSIZED' | 'NOT_INCLUDED' | 'GENERATED_BUNDLE' } {
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

  // Skip generated bundle artifacts explicitly with clear logging
  if (filename === 'gemini-bridge.user.js') {
    console.log(`[RepoMix] Skipping generated bundle: ${normalized} (path: ${normalized}, filename: ${filename})`);
    return { skip: true, reason: 'GENERATED_BUNDLE' };
  }

  // 3. Ignored directory paths (e.g. .venv, node_modules, dist, .git via DEFAULT_IGNORED_DIR_NAMES)
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (DEFAULT_IGNORED_DIR_NAMES.has(seg) || seg.startsWith('repomix_')) {
      return { skip: true, reason: 'IGNORED_PATH' };
    }
  }

  // 4. Ignored lockfiles, bundle outputs and temporary artifacts
  if (
    DEFAULT_IGNORED_FILES.has(filename) ||
    filename.endsWith('.bundle') ||
    filename.startsWith('repomix-output') ||
    /.*-bundle.*\.txt$/i.test(filename)
  ) {
    return { skip: true, reason: 'IGNORED_PATH' };
  }

  // 5. Ignored binary, media and archive extensions
  const extMatch = filename.match(/\.[a-zA-Z0-9]+$/);
  if (extMatch && DEFAULT_IGNORED_EXTENSIONS.has(extMatch[0].toLowerCase())) {
    return { skip: true, reason: 'IGNORED_PATH' };
  }

  // 6. Whitelist includePaths filter
  if (includePaths && includePaths.length > 0) {
    if (normalized !== '.repomixignore.cf' && normalized !== '.repomixignore') {
      const normalizedIncludes = includePaths.map((p) => p.replace(/^\.?\/+/, ''));
      const isIncluded = normalizedIncludes.some((prefix) => normalized.startsWith(prefix));
      if (!isIncluded) {
        return { skip: true, reason: 'NOT_INCLUDED' };
      }
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
  const match = paxText.match(/(?:^|\n)(?:\d+\s+)?comment=([0-9a-fA-F]{40})(?:\r?\n|$)/) || paxText.match(/\b([0-9a-fA-F]{40})\b/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Streams and decompresses a GitHub gzip tarball, filtering entries at the 512-byte
 * header level so ignored or oversized files never allocate buffer/string memory.
 */
export async function scanTarGzipStream(
  stream: ReadableStream<Uint8Array>,
  includePaths?: string[]
): Promise<TarScanResult> {
  const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
  const reader = decompressedStream.getReader();

  let buffer: Uint8Array = new Uint8Array(0);
  let eof = false;
  let consecutiveZeroBlocks = 0;

  let headOid: string | null = null;
  let nextPaxPath: string | null = null;

  const fileTreeEntries: string[] = [];
  const files: { path: string; content: string }[] = [];
  const dynamicIgnorePatterns: string[] = [];
  const textDecoder = new TextDecoder();
  const skippedFiles: Array<{ path: string; reason: 'too_large'; bytes?: number; chars?: number }> = [];

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

      // Early skip if dynamic ignore patterns already matched
      if (
        dynamicIgnorePatterns.length > 0 &&
        relPath !== '.repomixignore.cf' &&
        relPath !== '.repomixignore' &&
        matchesIgnorePattern(relPath, dynamicIgnorePatterns)
      ) {
        await discardBytes(paddedSize);
        continue;
      }

      // Filter check at header level
      const filterDecision = shouldSkipTarEntry(relPath, size, typeflag, includePaths);

      if (filterDecision.skip) {
        if (filterDecision.reason === 'OVERSIZED') {
          fileTreeEntries.push(`${relPath} [SKIPPED: >512KB]`);
          skippedFiles.push({ path: relPath, reason: 'too_large', bytes: size });
        } else if (filterDecision.reason === 'GENERATED_BUNDLE') {
          console.log(`[RepoMix] Skipped file: path=${relPath}, filename=gemini-bridge.user.js`);
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

      // Dynamically load ignore rules from .repomixignore.cf or .repomixignore
      if (relPath === '.repomixignore.cf' || relPath === '.repomixignore') {
        const newPatterns = parseIgnoreLines(content);
        if (newPatterns.length > 0) {
          dynamicIgnorePatterns.push(...newPatterns);
          for (let i = files.length - 1; i >= 0; i--) {
            if (matchesIgnorePattern(files[i].path, dynamicIgnorePatterns)) {
              files.splice(i, 1);
            }
          }
          for (let i = fileTreeEntries.length - 1; i >= 0; i--) {
            const entryPath = fileTreeEntries[i].replace(/\s+\[SKIPPED:.*\]$/, '');
            if (matchesIgnorePattern(entryPath, dynamicIgnorePatterns)) {
              fileTreeEntries.splice(i, 1);
            }
          }
        }
      }

      if (dynamicIgnorePatterns.length > 0 && matchesIgnorePattern(relPath, dynamicIgnorePatterns)) {
        continue;
      }

      fileTreeEntries.push(relPath);
      files.push({ path: relPath, content });
    }
  } catch (err: any) {
    throw new TarScanError(`Error processing tarball stream: ${err.message}`, headOid);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignored
    }
  }

  return { headOid, fileTreeEntries, files, skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined };
}
