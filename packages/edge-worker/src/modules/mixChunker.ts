import type { MixPart } from '../types';
import { escapeCdata } from './mixer';

export const DEFAULT_MAX_CHUNK_CHARS = 85_000;     // 85k Chars (15% buffer below Gemini's 100k char cutoff)
export const HARD_GEMINI_CHAR_LIMIT = 100_000;     // Hard 100k character cutoff in Gemini Web UI
export const MAX_GEMINI_PARTS = 10;                // Gemini Web maximum file attachments per prompt guardrail
export const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024; // Legacy byte ceiling
export const DEFAULT_MAX_CHUNK_TOKENS = 125_000;   // Legacy token ceiling
export const MAX_RECENT_COMMITS_CHARS = 8_000;     // Metadata cap before partitioning (Part 1 only)
export const RECENT_COMMITS_TRUNCATION_MARKER = '... [recent_commits truncated to preserve character budget]';

/**
 * Deterministically caps recent-commit metadata so it can never inflate a part.
 * Keeps complete leading lines and appends a visible truncation marker.
 */
export function capRecentCommitsText(
  text?: string,
  maxChars: number = MAX_RECENT_COMMITS_CHARS
): string {
  if (!text || text.trim().length === 0) return '';
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  const sliceBudget = limit - RECENT_COMMITS_TRUNCATION_MARKER.length - 1;
  if (sliceBudget <= 0) return RECENT_COMMITS_TRUNCATION_MARKER.slice(0, limit);
  const head = text.slice(0, sliceBudget);
  const lastNewline = head.lastIndexOf('\n');
  const kept = lastNewline > 0 ? head.slice(0, lastNewline) : head;
  return `${kept}\n${RECENT_COMMITS_TRUNCATION_MARKER}`;
}

/**
 * Universal instructions embedded directly into the RepoMix snapshot.
 * Grounding the AI on codebase structure, distinguishing read-only vs modification tasks,
 * and enforcing bridge-compatible patch formatting without placeholders.
 */
export const DEFAULT_MIX_INSTRUCTIONS = [
  '<instructions>',
  '# REPOSITORY CONTEXT AND PROTOCOL',
  '1. CONTEXT: The files below represent the authoritative codebase snapshot at commit headOid.',
  '2. MULTI-PART: If split across parts, all parts form the complete repository (Part 1 contains the master file_tree).',
  '3. READ-ONLY TASKS: If the user asks questions, explains logic, or reviews code: Answer naturally in the requested language. Do NOT emit patches.',
  '4. MODIFICATION TASKS: If and only if the user explicitly requests code changes, bugfixes, or new files:',
  '   - Never rewrite whole existing files.',
  '   - Never use placeholders (e.g. "// ... existing code ...", "/* rest unchanged */").',
  '   - Search snippets must match existing code verbatim (including whitespace/indentation).',
  '   - Prefer the V2 GeminiPatchPayload JSON format below. It is a payload only; worker request fields are supplied separately.',
  '     ```json',
  '     {',
  '       "commitMessage": "feat: describe the change",',
  '       "patches": [',
  '         { "path": "src/example.ts", "action": "modify", "blocks": [{ "search": "export const oldValue = 1;", "replace": "export const newValue = 2;" }] },',
  '         { "path": "src/new-file.ts", "action": "create", "fullContent": "export const helper = () => true;\\n" },',
  '         { "path": "src/obsolete.ts", "action": "delete" }',
  '       ]',
  '     }',
  '     ```',
  '   - For V2 modify operations, use blocks with exact search and replace strings; create operations use fullContent; delete operations need no content fields.',
  '   - Keep the classic V1 Search/Replace block format as a separate fallback, not as a V2 JSON variant.',
  '     V1 BLOCK LAYOUT: the "// filepath: relative/path.ext" line must be the FIRST line INSIDE the code block, above the SEARCH marker.',
  '     V1 PATH PLACEMENT: never put the filename outside the code block. No markdown heading, no numbered list item such as "3. src/file.ts", and no path backticks above the block.',
  '     V1 GRANULARITY: exactly one code block per file. A multi-file change needs one block per file, each carrying its own filepath header.',
  '     V1 MARKERS: use the established SEARCH, separator, and REPLACE markers, each one alone on its own line.',
  '</instructions>',
  ].join('\n');

export const CONTINUATION_MIX_INSTRUCTIONS = (partNum: number, totalParts: number): string =>
  `<instructions>\n# Part ${partNum}/${totalParts} Continuation: Refer to Part 1 for master file_tree and modification protocol.\n</instructions>`;

export interface ChunkMixInput {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  fileTreeEntries: string[];
  files: Array<{ path: string; content: string }>;
  recentCommitsText?: string;
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
  instructionsText?: string;
  recentCommitsText?: string;
  treeText: string;
  fileXmlList: string[];
}): string {
  const repoAttr =
    params.partNum !== undefined && params.totalParts !== undefined
      ? `<repository repo="${params.owner}/${params.repo}" branch="${params.branch}" headOid="${params.headOid}" part="${params.partNum}" totalParts="${params.totalParts}">`
      : `<repository repo="${params.owner}/${params.repo}" branch="${params.branch}" headOid="${params.headOid}">`;

  const sections: string[] = [repoAttr];
  if (params.instructionsText) {
    sections.push(params.instructionsText);
  }
  if (params.recentCommitsText) {
    sections.push(params.recentCommitsText);
  }
  sections.push(
    '<file_tree>',
    params.treeText,
    '</file_tree>',
    '<files>',
    ...params.fileXmlList,
    '</files>',
    '</repository>'
  );

  return sections.join('\n');
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
    maxChunkTokens * 4,
    HARD_GEMINI_CHAR_LIMIT
  );
  // Absolute ceiling: a user budget may tighten but never raise the 100k hard limit.

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
      instructionsText: DEFAULT_MIX_INSTRUCTIONS,
      treeText: f.path,
      fileXmlList: [fileXml],
    });

    if (standaloneXml.length > HARD_GEMINI_CHAR_LIMIT) {
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

  // 2b. Cap metadata before partitioning: instructions + tree + metadata must stay inside Part 1.
  const part1OverheadGuess = fullTreeXml.length + DEFAULT_MIX_INSTRUCTIONS.length + 512;
  const metadataBudget = Math.max(
    0,
    Math.min(MAX_RECENT_COMMITS_CHARS, effectiveMaxChars - part1OverheadGuess)
  );
  const cappedRecentCommitsText = capRecentCommitsText(input.recentCommitsText, metadataBudget);

  // 2c. Builds a part and measures the final serialized size against the absolute ceiling.
  function fitPart(params: {
    partNum?: number;
    totalParts?: number;
    instructionsText: string;
    metadata: string;
    treeText: string;
    fileEntries: Array<{ path: string; content: string; fileXml: string }>;
  }): {
    xml: string;
    entries: Array<{ path: string; content: string; fileXml: string }>;
    metadata: string;
    skippedPaths: string[];
  } {
    const build = (
      treeText: string,
      metadata: string,
      entries: Array<{ path: string; content: string; fileXml: string }>
    ): string =>
      buildPartXml({
        owner,
        repo,
        branch,
        headOid,
        partNum: params.partNum,
        totalParts: params.totalParts,
        instructionsText: params.instructionsText,
        recentCommitsText: metadata || undefined,
        treeText,
        fileXmlList: entries.map((e) => e.fileXml),
      });

    let metadata = params.metadata;
    let entries = params.fileEntries;
    let treeText = params.treeText;
    const skippedPaths: string[] = [];
    let xml = build(treeText, metadata, entries);
    if (xml.length <= HARD_GEMINI_CHAR_LIMIT) {
      return { xml, entries, metadata, skippedPaths };
    }

    if (metadata) {
      const overflow = xml.length - HARD_GEMINI_CHAR_LIMIT;
      metadata = capRecentCommitsText(params.metadata, Math.max(0, params.metadata.length - overflow - 1));
      xml = build(treeText, metadata, entries);
      if (xml.length <= HARD_GEMINI_CHAR_LIMIT) {
        return { xml, entries, metadata, skippedPaths };
      }
      metadata = '';
      xml = build(treeText, metadata, entries);
      if (xml.length <= HARD_GEMINI_CHAR_LIMIT) {
        return { xml, entries, metadata, skippedPaths };
      }
    }

    // Indivisible content that still cannot fit: drop whole files with a visible tree annotation.
    while (entries.length > 0 && xml.length > HARD_GEMINI_CHAR_LIMIT) {
      skippedPaths.push(entries[entries.length - 1].path);
      entries = entries.slice(0, -1);
      const annotations = skippedPaths.map((p) => `${p} [SKIPPED: exceeds 100k part limit]`);
      treeText = `${params.treeText}\n${annotations.join('\n')}`;
      xml = build(treeText, metadata, entries);
    }

    return { xml, entries, metadata, skippedPaths };
  }

  // 3. Single-part fast path: the split decision uses the unconstrained size,
  // the emitted part is then measured against the absolute ceiling.
  const singleRawXml = buildPartXml({
    owner,
    repo,
    branch,
    headOid,
    instructionsText: DEFAULT_MIX_INSTRUCTIONS,
    recentCommitsText: cappedRecentCommitsText || undefined,
    treeText: fullTreeXml,
    fileXmlList: validFiles.map((f) => f.fileXml),
  });

  const single = fitPart({
    instructionsText: DEFAULT_MIX_INSTRUCTIONS,
    metadata: cappedRecentCommitsText,
    treeText: fullTreeXml,
    fileEntries: validFiles,
  });

  // Splitting is forced when fitting the single part would have to drop whole files (data loss),
  // so an oversized payload is never returned as a success-shaped single part.
  const shouldSplit =
    splitOutput === true ||
    single.skippedPaths.length > 0 ||
    (splitOutput !== false &&
      validFiles.length > 1 &&
      singleRawXml.length > effectiveMaxChars);

  if (!shouldSplit) {
    return {
      xmlContent: single.xml,
      isChunked: false,
      stats: {
        fileCount: single.entries.length,
        estimatedTokens: Math.ceil(single.xml.length / 4),
        charCount: single.xml.length,
      },
    };
  }

  // 4. Multi-part atomic pre-file partitioning with Gemini 10-parts guardrail
  function partitionFiles(budgetChars: number) {
    const buckets: Array<Array<{ path: string; content: string; fileXml: string }>> = [];
    let currentBucket: Array<{ path: string; content: string; fileXml: string }> = [];
    const partBudget = Math.min(budgetChars, HARD_GEMINI_CHAR_LIMIT);
    const part1BaseOverhead =
      fullTreeXml.length +
      220 +
      DEFAULT_MIX_INSTRUCTIONS.length +
      (cappedRecentCommitsText ? cappedRecentCommitsText.length + 1 : 0);
    let currentBucketChars = part1BaseOverhead;

    for (let i = 0; i < validFiles.length; i++) {
      const f = validFiles[i];
      const isPart1 = buckets.length === 0;
      const fileAdditionChars = isPart1
        ? f.fileXml.length + 1
        : f.fileXml.length + 1 + f.path.length + 1;

      if (currentBucket.length > 0) {
        if (currentBucketChars + fileAdditionChars > partBudget) {
          buckets.push(currentBucket);
          currentBucket = [];
          currentBucketChars = 260 + CONTINUATION_MIX_INSTRUCTIONS(2, 2).length;
        }
      } else if (isPart1) {
        // Empty Part 1: a first file that cannot share Part 1 with tree, instructions and metadata
        // starts Part 2 instead of pushing the measured part budget.
        if (currentBucketChars + fileAdditionChars > partBudget) {
          buckets.push([]);
          currentBucket = [];
          currentBucketChars = 260 + CONTINUATION_MIX_INSTRUCTIONS(2, 2).length;
        }
      }

      currentBucket.push(f);
      currentBucketChars += (buckets.length === 0 ? f.fileXml.length + 1 : f.fileXml.length + 1 + f.path.length + 1);
    }

    if (currentBucket.length > 0) {
      buckets.push(currentBucket);
    }
    return buckets;
  }

  let dynamicMaxChars = effectiveMaxChars;
  let chunkBuckets = partitionFiles(dynamicMaxChars);

  if (chunkBuckets.length > MAX_GEMINI_PARTS) {
    // Upscale budget so total parts fit within MAX_GEMINI_PARTS
    const totalRawChars =
      validFiles.reduce((acc, f) => acc + f.fileXml.length, 0) +
      fullTreeXml.length +
      cappedRecentCommitsText.length;
    dynamicMaxChars = Math.min(
      HARD_GEMINI_CHAR_LIMIT,
      Math.max(dynamicMaxChars, Math.ceil(totalRawChars / (MAX_GEMINI_PARTS - 1)))
    );
    chunkBuckets = partitionFiles(dynamicMaxChars);

    while (chunkBuckets.length > MAX_GEMINI_PARTS) {
      let minCombinedSize = Infinity;
      let minIndex = 0;
      for (let j = 0; j < chunkBuckets.length - 1; j++) {
        const combined = chunkBuckets[j].length + chunkBuckets[j + 1].length;
        if (combined < minCombinedSize) {
          minCombinedSize = combined;
          minIndex = j;
        }
      }
      chunkBuckets[minIndex] = [...chunkBuckets[minIndex], ...chunkBuckets[minIndex + 1]];
      chunkBuckets.splice(minIndex + 1, 1);
    }
  }

  const totalParts = chunkBuckets.length;
  const parts: MixPart[] = [];
  let totalChars = 0;
  let emittedFileCount = 0;

  for (let i = 0; i < totalParts; i++) {
    const bucket = chunkBuckets[i];
    const partNum = i + 1;
    const partTreeText =
      i === 0
        ? fullTreeXml
        : `# Part ${partNum}/${totalParts} files (${bucket.length} files):\n${bucket.map((b) => b.path).join('\n')}`;

    const partInstructions =
      partNum === 1
        ? DEFAULT_MIX_INSTRUCTIONS
        : CONTINUATION_MIX_INSTRUCTIONS(partNum, totalParts);

    const fitted = fitPart({
      partNum,
      totalParts,
      instructionsText: partInstructions,
      metadata: partNum === 1 ? cappedRecentCommitsText : '',
      treeText: partTreeText,
      fileEntries: bucket,
    });

    const partXml = fitted.xml;
    totalChars += partXml.length;
    emittedFileCount += fitted.entries.length;

    parts.push({
      partIndex: partNum,
      totalParts,
      fileName: totalParts === 1 ? 'repo-mix.txt' : `repo-mix.part${partNum}.txt`,
      xmlContent: partXml,
      stats: {
        fileCount: fitted.entries.length,
        estimatedTokens: Math.ceil(partXml.length / 4),
        charCount: partXml.length,
      },
    });
  }

  return {
    xmlContent: parts[0]?.xmlContent ?? single.xml,
    parts,
    isChunked: true,
    stats: {
      fileCount: emittedFileCount,
      estimatedTokens: Math.ceil(totalChars / 4),
      charCount: totalChars,
    },
  };
}
