import type { MixPart } from '../types';
import { escapeCdata } from './mixer';

export const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024; // 512 KB
export const DEFAULT_MAX_CHUNK_TOKENS = 125_000;   // ~125k Tokens

export interface ChunkMixInput {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  fileTreeEntries: string[];
  files: Array<{ path: string; content: string }>;
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
  };
}

/**
 * Builds structured XML representation(s) of a repository.
 * Atomically partitions files across multiple sequentially numbered MixParts
 * without splitting individual files, keeping each chunk within size and token budgets.
 */
export function buildChunkedMixXml(input: ChunkMixInput): ChunkMixResult {
  const {
    owner,
    repo,
    branch,
    headOid,
    fileTreeEntries,
    files,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    splitOutput,
  } = input;

  const sortedTree = [...fileTreeEntries].sort();
  const fileTreeXml = sortedTree.join('\n');

  // Estimate total content size
  let totalRawSize = fileTreeXml.length + 200;
  for (const f of files) {
    totalRawSize += f.path.length + f.content.length + 60;
  }
  const totalEstimatedTokens = Math.ceil(totalRawSize / 4);

  const shouldSplit =
    splitOutput === true ||
    (splitOutput !== false &&
      files.length > 1 &&
      (totalRawSize > maxChunkBytes || totalEstimatedTokens > maxChunkTokens));

  // If splitting is not required or disabled, generate single XML
  if (!shouldSplit || files.length <= 1) {
    const filesXml = files
      .map((f) => `  <file path="${f.path}"><![CDATA[${escapeCdata(f.content)}]]></file>`)
      .join('\n');

    const singleXml = [
      `<repository repo="${owner}/${repo}" branch="${branch}" headOid="${headOid}">`,
      `<file_tree>`,
      fileTreeXml,
      `</file_tree>`,
      `<files>`,
      filesXml,
      `</files>`,
      `</repository>`,
    ].join('\n');

    return {
      xmlContent: singleXml,
      isChunked: false,
      stats: {
        fileCount: files.length,
        estimatedTokens: Math.ceil(singleXml.length / 4),
      },
    };
  }

  // Partition files atomically into chunks
  const chunkBuckets: Array<Array<{ path: string; content: string }>> = [];
  let currentBucket: Array<{ path: string; content: string }> = [];
  let currentBucketBytes = fileTreeXml.length + 300;

  for (const f of files) {
    const fileXmlSize = f.path.length + f.content.length + 60;
    const estimatedFileTokens = Math.ceil(fileXmlSize / 4);

    if (
      currentBucket.length > 0 &&
      (currentBucketBytes + fileXmlSize > maxChunkBytes ||
        Math.ceil((currentBucketBytes + fileXmlSize) / 4) > maxChunkTokens)
    ) {
      chunkBuckets.push(currentBucket);
      currentBucket = [];
      currentBucketBytes = fileTreeXml.length + 300;
    }

    currentBucket.push(f);
    currentBucketBytes += fileXmlSize;
  }

  if (currentBucket.length > 0) {
    chunkBuckets.push(currentBucket);
  }

  const totalParts = chunkBuckets.length;
  const parts: MixPart[] = [];

  for (let i = 0; i < totalParts; i++) {
    const bucket = chunkBuckets[i];
    const partNum = i + 1;
    const filesXml = bucket
      .map((f) => `  <file path="${f.path}"><![CDATA[${escapeCdata(f.content)}]]></file>`)
      .join('\n');

    const partXml = [
      `<repository repo="${owner}/${repo}" branch="${branch}" headOid="${headOid}" part="${partNum}" totalParts="${totalParts}">`,
      `<file_tree>`,
      fileTreeXml,
      `</file_tree>`,
      `<files>`,
      filesXml,
      `</files>`,
      `</repository>`,
    ].join('\n');

    parts.push({
      partIndex: partNum,
      totalParts,
      fileName: `repo-mix.part${partNum}.xml`,
      xmlContent: partXml,
      stats: {
        fileCount: bucket.length,
        estimatedTokens: Math.ceil(partXml.length / 4),
      },
    });
  }

  return {
    xmlContent: parts[0].xmlContent,
    parts,
    isChunked: true,
    stats: {
      fileCount: files.length,
      estimatedTokens: totalEstimatedTokens,
    },
  };
}
