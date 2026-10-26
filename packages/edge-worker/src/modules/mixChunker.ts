import type { MixPart } from '../types';
import { escapeCdata } from './mixerTarScan';

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

  // 1. Reject any file that cannot be serialized within the hard Gemini cap.
  // A single file must never be silently dropped: if it exceeds the limit, the
  // entire RepoMix must fail explicitly rather than returning partial output.
  const treeEntries = [...fileTreeEntries];
  const validFiles: Array<{ path: string; content: string; fileXml: string }> = [];
  const blockedFiles: string[] = [];

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
      blockedFiles.push(f.path);
      continue;
    }

    validFiles.push({ path: f.path, content: f.content, fileXml });
  }

  if (blockedFiles.length > 0) {
    const blockedList = blockedFiles.slice(0, 5).join(', ');
    const suffix = blockedFiles.length > 5 ? ` and ${blockedFiles.length - 5} more` : '';
    throw new Error(
      `RepoMix cannot preserve ${blockedFiles.length} file(s) without splitting an individual file beyond the ${HARD_GEMINI_CHAR_LIMIT}-character limit: ${blockedList}${suffix}.`
    );
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
  // Measured Part 1 overhead (envelope + instructions + master tree) via the real serializer.
  const part1OverheadChars = buildPartXml({
    owner,
    repo,
    branch,
    headOid,
    partNum: 1,
    totalParts: MAX_GEMINI_PARTS,
    instructionsText: DEFAULT_MIX_INSTRUCTIONS,
    treeText: fullTreeXml,
    fileXmlList: [],
  }).length;
  const metadataBudget = Math.max(
    0,
    Math.min(MAX_RECENT_COMMITS_CHARS, effectiveMaxChars - part1OverheadChars)
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
    let xml = build(params.treeText, metadata, params.fileEntries);
    if (xml.length > HARD_GEMINI_CHAR_LIMIT && metadata) {
      metadata = capRecentCommitsText(
        metadata,
        Math.max(0, metadata.length - (xml.length - HARD_GEMINI_CHAR_LIMIT) - 1)
      );
      xml = build(params.treeText, metadata, params.fileEntries);
    }
    if (xml.length > HARD_GEMINI_CHAR_LIMIT && metadata) {
      metadata = '';
      xml = build(params.treeText, metadata, params.fileEntries);
    }
    return { xml, entries: params.fileEntries, metadata };
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

  // Oversized complete serialization must split, never return as a success-shaped single part.
  const shouldSplit =
    splitOutput === true ||
    single.xml.length > HARD_GEMINI_CHAR_LIMIT ||
    (splitOutput !== false &&
      validFiles.length > 1 &&
      singleRawXml.length > effectiveMaxChars);

  if (!shouldSplit) {
    if (single.xml.length > HARD_GEMINI_CHAR_LIMIT) {
      throw new Error(
        `RepoMix serialized to ${single.xml.length} characters, exceeding the ${HARD_GEMINI_CHAR_LIMIT}-character limit.`
      );
    }
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

  // 4. Partition by complete serialized size, including each part's tree and XML envelope.
  type FsEntry = { path: string; content: string; fileXml: string };
  function partitionFiles(budgetChars: number) {
    const partBudget = Math.min(budgetChars, HARD_GEMINI_CHAR_LIMIT);
    const serializedSize = (bucket: FsEntry[], index: number): number => {
      const partNum = index + 1;
      const treeText =
        index === 0
          ? fullTreeXml
          : `# Part ${partNum}/${MAX_GEMINI_PARTS} files (${bucket.length} files):\n${bucket.map((f) => f.path).join('\n')}`;
      return buildPartXml({
        owner,
        repo,
        branch,
        headOid,
        partNum,
        totalParts: MAX_GEMINI_PARTS,
        instructionsText:
          partNum === 1 ? DEFAULT_MIX_INSTRUCTIONS : CONTINUATION_MIX_INSTRUCTIONS(partNum, MAX_GEMINI_PARTS),
        recentCommitsText: partNum === 1 ? cappedRecentCommitsText || undefined : undefined,
        treeText,
        fileXmlList: bucket.map((f) => f.fileXml),
      }).length;
    };

    // First-Fit Decreasing: largest files first, each placed into the first bucket that fits.
    // serializedSize stays the single source of truth for every fit decision.
    if (partBudget <= 0) return validFiles.map((f) => [f]);
    const packList = [...validFiles].sort(
      (a, b) => b.fileXml.length - a.fileXml.length || a.path.localeCompare(b.path)
    );
    const buckets: FsEntry[][] = [];
    for (const file of packList) {
      let placed = false;
      for (let i = 0; i < buckets.length; i++) {
        const candidate = [...buckets[i], file];
        if (serializedSize(candidate, i) <= partBudget) {
          buckets[i] = candidate;
          placed = true;
          break;
        }
      }
      if (!placed) buckets.push([file]);
    }
    return buckets;
  }

  // Budget ladder: 85k default first, then 95k, then the absolute 100k ceiling.
  const budgetLadder = [
    effectiveMaxChars,
    Math.min(95_000, HARD_GEMINI_CHAR_LIMIT),
    HARD_GEMINI_CHAR_LIMIT,
  ];
  const triedBudgets: Array<{ budget: number; parts: number }> = [];
  let chunkBuckets: Array<Array<{ path: string; content: string; fileXml: string }>> = [];
  for (const budget of budgetLadder) {
    if (triedBudgets.some((t) => t.budget === budget)) continue;
    chunkBuckets = partitionFiles(budget);
    triedBudgets.push({ budget, parts: chunkBuckets.length });
    if (chunkBuckets.length <= MAX_GEMINI_PARTS) break;
  }
  if (chunkBuckets.length > MAX_GEMINI_PARTS) {
    const partsAt = (budget: number): number =>
      triedBudgets.find((t) => t.budget === budget)?.parts ?? -1;
    const metrics = {
      files: validFiles.length,
      largestFileXmlChars: validFiles.reduce((max, f) => Math.max(max, f.fileXml.length), 0),
      partsTriedAt85k: partsAt(DEFAULT_MAX_CHUNK_CHARS),
      partsTriedAt95k: partsAt(95_000),
      partsTriedAt100k: partsAt(HARD_GEMINI_CHAR_LIMIT),
      part1OverheadChars,
      treeChars: fullTreeXml.length,
      cappedMetaChars: cappedRecentCommitsText.length,
    };
    throw new Error(
      `RepoMix needs more than ${MAX_GEMINI_PARTS} parts to preserve all files within the ${HARD_GEMINI_CHAR_LIMIT}-character limit. Metrics: ${JSON.stringify(metrics)}`
    );
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
    if (partXml.length > HARD_GEMINI_CHAR_LIMIT) {
      throw new Error(
        `RepoMix part ${partNum} serialized to ${partXml.length} characters, exceeding the ${HARD_GEMINI_CHAR_LIMIT}-character limit.`
      );
    }
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

  if (parts.length > MAX_GEMINI_PARTS || emittedFileCount !== validFiles.length) {
    throw new Error(
      `RepoMix output could not preserve all files within ${MAX_GEMINI_PARTS} conforming parts.`
    );
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
