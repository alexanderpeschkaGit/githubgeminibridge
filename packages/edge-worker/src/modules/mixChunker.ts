import type { MixPart } from '../types';
import { escapeCdata } from './mixer';

export const DEFAULT_MAX_CHUNK_CHARS = 85_000;     // 85k Chars (15% buffer below Gemini's 100k char cutoff)
export const HARD_GEMINI_CHAR_LIMIT = 100_000;     // Hard 100k character cutoff in Gemini Web UI
export const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024; // Legacy byte ceiling
export const DEFAULT_MAX_CHUNK_TOKENS = 125_000;   // Legacy token ceiling

export interface ChunkMixInput {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  fileTreeEntries: string[];
  files: Array<{ path: string; content: string }>;
  maxChunkChars?: number;
  maxChunkBytes?: number;
  maxChunkTokens?: number;
  splitOutput?: boolean;
}

export interface ChunkMixResult {
  xmlContent: string;
  parts?: MixPart[];
  isChunked: boolean;
  stats: {
    fileCount: number;
    estimatedTokens: number;
    charCount: number;
  };
}

/**
 * Formats a single file as a safe XML `<file>` element.
 */
function formatFileXml(f: { path: string; content: string }): string {
  return `  <file path="${f.path}"><![CDATA[${escapeCdata(f.content)}]]></file>`;
}

/**
 * Builds a complete structured XML document for a single mix part or the whole repository.
 */
function buildPartXml(params: {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  partNum?: number;
  totalParts?: number;
  treeText: string;
  fileXmlList: string[];
}): string {
  const repoAttr =
    params.partNum !== undefined && params.totalParts !== undefined
      ? `<repository repo="${params.owner}/${params.repo}" branch="${params.branch}" headOid="${params.headOid}" part="${params.partNum}" totalParts="${params.totalParts}">`
      : `<repository repo="${params.owner}/${params.repo}" branch="${params.branch}" headOid="${params.headOid}">`;

  return [
    repoAttr,
    '<file_tree>',
    params.treeText,
    '</file_tree>',
    '<files>',
    ...params.fileXmlList,
    '</files>',
    '</repository>',
  ].join('\n');
}

/**
 * Builds structured XML representation(s) of a repository.
 * Atomically partitions files across multiple sequentially numbered MixParts
 * without splitting individual files, keeping each chunk strictly within character budgets (<= 85k default, <= 100k hard limit).
 */
export function buildChunkedMixXml(input: ChunkMixInput): ChunkMixResult {
  const {
    owner,
    repo,
    branch,
    headOid,
    fileTreeEntries,
    files,
    maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    splitOutput,
  } = input;

  const effectiveMaxChars = Math.min(
    maxChunkChars,
    maxChunkBytes,
    maxChunkTokens * 4
  );
  const hardFileLimit = Math.max(effectiveMaxChars, HARD_GEMINI_CHAR_LIMIT);

  // 1. Format all files and filter oversized single files (> 100k chars)
  const treeEntries = [...fileTreeEntries];
  const validFiles: Array<{ path: string; content: string; fileXml: string }> = [];

  for (const f of files) {
    const fileXml = formatFileXml(f);
    const standaloneXml = buildPartXml({
      owner,
      repo,
      branch,
      headOid,
      partNum: 1,
      totalParts: 1,
      treeText: f.path,
      fileXmlList: [fileXml],
    });

    if (standaloneXml.length > hardFileLimit) {
      const idx = treeEntries.indexOf(f.path);
      const skippedAnnotation = `${f.path} [SKIPPED: >100k chars for Gemini Chat limit]`;
      if (idx !== -1) {
        treeEntries[idx] = skippedAnnotation;
      } else {
        treeEntries.push(skippedAnnotation);
      }
    } else {
      validFiles.push({ path: f.path, content: f.content, fileXml });
    }
  }

  // 2. Full Tree with budget cap (<= 14k chars to reserve >= 71k chars for code)
  const maxTreeChars = Math.min(Math.floor(effectiveMaxChars * 0.45), 14_000);
  let fullTreeXml = [...treeEntries].sort().join('\n');
  if (fullTreeXml.length > maxTreeChars) {
    const truncated = fullTreeXml.slice(0, maxTreeChars);
    const lastNewline = truncated.lastIndexOf('\n');
    fullTreeXml =
      (lastNewline !== -1 ? truncated.slice(0, lastNewline) : truncated) +
      '\n... [file_tree truncated to preserve character budget]';
  }

  // 3. Single-part fast path
  const singleXml = buildPartXml({
    owner,
    repo,
    branch,
    headOid,
    treeText: fullTreeXml,
    fileXmlList: validFiles.map((f) => f.fileXml),
  });

  const shouldSplit =
    splitOutput === true ||
    (splitOutput !== false &&
      validFiles.length > 1 &&
      singleXml.length > effectiveMaxChars);

  if (!shouldSplit) {
    return {
      xmlContent: singleXml,
      isChunked: false,
      stats: {
        fileCount: validFiles.length,
        estimatedTokens: Math.ceil(singleXml.length / 4),
        charCount: singleXml.length,
      },
    };
  }

  // 4. Multi-part atomic pre-file partitioning
  const chunkBuckets: Array<Array<{ path: string; content: string; fileXml: string }>> = [];
  let currentBucket: Array<{ path: string; content: string; fileXml: string }> = [];
  const part1BaseOverhead = fullTreeXml.length + 220;
  let currentBucketChars = part1BaseOverhead;

  for (let i = 0; i < validFiles.length; i++) {
    const f = validFiles[i];
    const isPart1 = chunkBuckets.length === 0;
    const fileAdditionChars = isPart1
      ? f.fileXml.length + 1
      : f.fileXml.length + 1 + f.path.length + 1;

    if (currentBucket.length > 0) {
      if (currentBucketChars + fileAdditionChars > effectiveMaxChars) {
        chunkBuckets.push(currentBucket);
        currentBucket = [];
        currentBucketChars = 260; // Base overhead for compact part 2..N
      }
    } else if (isPart1) {
      // Empty Part 1: check if file alone with fullTreeXml would exceed 100k
      if (currentBucketChars + fileAdditionChars > hardFileLimit) {
        chunkBuckets.push([]);
        currentBucket = [];
        currentBucketChars = 260;
      }
    }

    const activeIsPart1 = chunkBuckets.length === 0;
    const activeAdditionChars = activeIsPart1
      ? f.fileXml.length + 1
      : f.fileXml.length + 1 + f.path.length + 1;

    currentBucket.push(f);
    currentBucketChars += activeAdditionChars;
  }

  if (currentBucket.length > 0) {
    chunkBuckets.push(currentBucket);
  }

  const totalParts = chunkBuckets.length;
  const parts: MixPart[] = [];
  let totalChars = 0;

  for (let i = 0; i < totalParts; i++) {
    const bucket = chunkBuckets[i];
    const partNum = i + 1;
    const partTreeText =
      i === 0
        ? fullTreeXml
        : `# Part ${partNum}/${totalParts} files (${bucket.length} files):\n${bucket.map((b) => b.path).join('\n')}`;

    const partXml = buildPartXml({
      owner,
      repo,
      branch,
      headOid,
      partNum,
      totalParts,
      treeText: partTreeText,
      fileXmlList: bucket.map((f) => f.fileXml),
    });

    totalChars += partXml.length;

    parts.push({
      partIndex: partNum,
      totalParts,
      fileName: `repo-mix.part${partNum}.xml`,
      xmlContent: partXml,
      stats: {
        fileCount: bucket.length,
        estimatedTokens: Math.ceil(partXml.length / 4),
        charCount: partXml.length,
      },
    });
  }

  return {
    xmlContent: parts[0]?.xmlContent ?? singleXml,
    parts,
    isChunked: true,
    stats: {
      fileCount: validFiles.length,
      estimatedTokens: Math.ceil(totalChars / 4),
      charCount: totalChars,
    },
  };
}
