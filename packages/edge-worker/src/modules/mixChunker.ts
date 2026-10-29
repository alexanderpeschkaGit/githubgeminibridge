import type { MixOmittedFile, MixPart, MixTruncation } from '../types';
import { buildOmittedManifest, buildTruncationNotice, capFileTree, selectFilesWithinPartLimit } from './mixSelection';
import { buildPartXml, formatFileXml } from './mixSerializer';

export const DEFAULT_MAX_CHUNK_CHARS = 85_000;     // 85k Chars (15% buffer below Gemini's 100k char cutoff)
export const HARD_GEMINI_CHAR_LIMIT = 100_000;     // Hard 100k character cutoff in Gemini Web UI
export const MAX_GEMINI_PARTS = 10;                // Gemini Web maximum file attachments per prompt guardrail
export const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024; // Legacy byte ceiling
export const DEFAULT_MAX_CHUNK_TOKENS = 125_000;   // Legacy token ceiling
export const MAX_RECENT_COMMITS_CHARS = 8_000;     // Metadata cap before partitioning (Part 1 only)
export const RECENT_COMMITS_TRUNCATION_MARKER = '... [recent_commits truncated to preserve character budget]';
const TRUNCATION_RESERVE_CHARS = 9_000;            // Part-1 notice + omitted manifest reserve

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
  truncation?: MixTruncation;
  stats: {
    fileCount: number;
    totalFileCount?: number;
    estimatedTokens: number;
    charCount: number;
  };
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

  const hasExplicitUserBudget =
    input.maxChunkChars !== undefined ||
    input.maxChunkBytes !== undefined ||
    input.maxChunkTokens !== undefined;

  const effectiveMaxChars = Math.min(
    maxChunkChars,
    maxChunkBytes,
    maxChunkTokens * 4,
    HARD_GEMINI_CHAR_LIMIT
  );
  // Absolute ceiling: a user budget may tighten but never raise the 100k hard limit.

  // 1. Serialize every file. Files that cannot fit one part on their own are
  // omitted explicitly and reported; they never block an otherwise usable mix.
  const treeEntries = [...fileTreeEntries];
  const validFiles: Array<{ path: string; content: string; fileXml: string }> = [];
  const omitted: MixOmittedFile[] = [];

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
      omitted.push({ path: f.path, reason: 'file_over_hard_limit', chars: f.content.length });
      continue;
    }

    validFiles.push({ path: f.path, content: f.content, fileXml });
  }

  if (validFiles.length === 0 && files.length > 0) {
    const sample = omitted.slice(0, 5).map((entry) => entry.path).join(', ');
    const suffix = omitted.length > 5 ? ` and ${omitted.length - 5} more` : '';
    throw new Error(
      `RepoMix cannot include any file: all ${files.length} file(s) exceed the ${HARD_GEMINI_CHAR_LIMIT}-character limit (${sample}${suffix}).`
    );
  }

  // 2. Full Tree with budget cap (<= 14k chars to reserve >= 71k chars for code)
  const maxTreeChars = Math.min(Math.floor(effectiveMaxChars * 0.45), 14_000);
  let fullTreeXml = capFileTree(treeEntries, maxTreeChars);

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
    truncationNoticeText?: string;
    metadata: string;
    treeText: string;
    omittedManifestText?: string;
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
        truncationNoticeText: params.truncationNoticeText,
        recentCommitsText: metadata || undefined,
        treeText,
        omittedManifestText: params.omittedManifestText,
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

  if (!shouldSplit && omitted.length === 0) {
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
        totalFileCount: files.length,
        estimatedTokens: Math.ceil(single.xml.length / 4),
        charCount: single.xml.length,
      },
    };
  }

  // 4. Partition by complete serialized size, including each part's tree and XML envelope.
  type FsEntry = { path: string; content: string; fileXml: string };
  let part1Extras: { notice: string; manifest: string } = { notice: '', manifest: '' };
  function partitionFiles(budgetChars: number, source: FsEntry[] = validFiles) {
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
        truncationNoticeText: partNum === 1 ? part1Extras.notice || undefined : undefined,
        recentCommitsText: partNum === 1 ? cappedRecentCommitsText || undefined : undefined,
        treeText,
        omittedManifestText: partNum === 1 ? part1Extras.manifest || undefined : undefined,
        fileXmlList: bucket.map((f) => f.fileXml),
      }).length;
    };

    // First-Fit Decreasing: largest files first, each placed into the first bucket that fits.
    // serializedSize stays the single source of truth for every fit decision.
    if (partBudget <= 0) return source.map((f) => [f]);
    const packList = [...source].sort(
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

  const maxPackBudget = hasExplicitUserBudget ? effectiveMaxChars : HARD_GEMINI_CHAR_LIMIT;
  const requiredParts = partitionFiles(maxPackBudget, validFiles).length;

  let keptFiles = validFiles;
  if (requiredParts > MAX_GEMINI_PARTS || omitted.length > 0) {
    const selectionBudget = Math.max(1, maxPackBudget - TRUNCATION_RESERVE_CHARS);
    const selection = selectFilesWithinPartLimit(
      validFiles,
      (subset) => partitionFiles(selectionBudget, subset).length,
      MAX_GEMINI_PARTS
    );
    keptFiles = selection.kept;
    omitted.push(...selection.omitted);
    if (keptFiles.length === 0) {
      throw new Error(
        `RepoMix cannot include any file within ${MAX_GEMINI_PARTS} parts and the ${HARD_GEMINI_CHAR_LIMIT}-character limit.`
      );
    }
    // The master tree must describe only files whose contents are present.
    const keptPaths = new Set(keptFiles.map((file) => file.path));
    fullTreeXml = capFileTree(
      treeEntries.filter((entry) => keptPaths.has(entry)),
      maxTreeChars
    );
    part1Extras = {
      notice: buildTruncationNotice({
        includedFiles: keptFiles.length,
        totalFiles: files.length,
        omittedFiles: omitted,
        requiredParts,
        availableParts: MAX_GEMINI_PARTS,
      }),
      manifest: buildOmittedManifest(omitted),
    };
  }

  // Budget ladder: 85k default first, then 95k, then the absolute 100k ceiling.
  const budgetLadder = hasExplicitUserBudget
    ? [effectiveMaxChars]
    : [
        effectiveMaxChars,
        Math.min(95_000, HARD_GEMINI_CHAR_LIMIT),
        HARD_GEMINI_CHAR_LIMIT,
      ];
  const triedBudgets: number[] = [];
  let chunkBuckets: Array<Array<{ path: string; content: string; fileXml: string }>> = [];
  for (const budget of budgetLadder) {
    if (triedBudgets.includes(budget)) continue;
    chunkBuckets = partitionFiles(budget, keptFiles);
    triedBudgets.push(budget);
    if (chunkBuckets.length <= MAX_GEMINI_PARTS) break;
  }
  if (chunkBuckets.length > MAX_GEMINI_PARTS) {
    throw new Error(
      `RepoMix truncation invariant failed: ${chunkBuckets.length} parts after selecting within ${MAX_GEMINI_PARTS}.`
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
      truncationNoticeText: partNum === 1 ? part1Extras.notice || undefined : undefined,
      metadata: partNum === 1 ? cappedRecentCommitsText : '',
      treeText: partTreeText,
      omittedManifestText: partNum === 1 ? part1Extras.manifest || undefined : undefined,
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

  if (parts.length > MAX_GEMINI_PARTS || emittedFileCount + omitted.length !== files.length) {
    throw new Error(
      `RepoMix output could not preserve the file accounting within ${MAX_GEMINI_PARTS} conforming parts.`
    );
  }

  const hasPartLimit = omitted.some((entry) => entry.reason === 'part_limit_exceeded');
  const hasHardLimit = omitted.some((entry) => entry.reason === 'file_over_hard_limit');
  const truncationReason: MixTruncation['reason'] =
    hasPartLimit && hasHardLimit ? 'mixed' : hasPartLimit ? 'part_limit_exceeded' : 'file_over_hard_limit';
  const truncation: MixTruncation | undefined = omitted.length > 0
    ? {
        reason: truncationReason,
        requiredParts,
        availableParts: MAX_GEMINI_PARTS,
        includedFiles: emittedFileCount,
        totalFiles: files.length,
        omittedFiles: [...omitted].sort((a, b) => a.path.localeCompare(b.path)),
        omittedChars: omitted.reduce((sum, entry) => sum + (entry.chars ?? 0), 0),
      }
    : undefined;

  return {
    xmlContent: parts[0]?.xmlContent ?? single.xml,
    parts,
    isChunked: true,
    ...(truncation ? { truncation } : {}),
    stats: {
      fileCount: emittedFileCount,
      totalFileCount: files.length,
      estimatedTokens: Math.ceil(totalChars / 4),
      charCount: totalChars,
    },
  };
}
