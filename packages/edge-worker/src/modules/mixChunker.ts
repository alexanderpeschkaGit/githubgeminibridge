import type { MixOmittedFile, MixPart, MixTruncation } from '../types';
import {
  buildMixTruncation,
  buildOmittedManifest,
  buildTruncationNotice,
  capFileTree,
  rankFilesForOmission,
  selectFilesWithinPartLimit,
} from './mixSelection';
import {
  buildPartXml,
  canFileFitContinuationPart,
  CONTINUATION_MIX_INSTRUCTIONS,
  fitPartXml,
  formatFileXml,
  packFilesIntoBuckets,
} from './mixSerializer';
import { buildContinuationParts } from './mixContinuation';

export { CONTINUATION_MIX_INSTRUCTIONS };

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
export function capRecentCommitsText(text?: string, maxChars: number = MAX_RECENT_COMMITS_CHARS): string {
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
  enableContinuation?: boolean;
}

export interface ChunkMixResult {
  xmlContent: string;
  parts?: MixPart[];
  continuationParts?: MixPart[];
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
    owner, repo, branch, headOid, fileTreeEntries, files,
    maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    splitOutput,
  } = input;

  const canEscalateBudget =
    (input.maxChunkChars === undefined || input.maxChunkChars === DEFAULT_MAX_CHUNK_CHARS) &&
    input.maxChunkBytes === undefined &&
    input.maxChunkTokens === undefined;

  const effectiveMaxChars = Math.min(
    maxChunkChars,
    maxChunkBytes,
    maxChunkTokens * 4,
    HARD_GEMINI_CHAR_LIMIT
  );
  // Absolute ceiling: a user budget may tighten but never raise the 100k hard limit.
  const maxPackBudget = canEscalateBudget ? HARD_GEMINI_CHAR_LIMIT : effectiveMaxChars;

  // 1. Serialize every file. Files that cannot fit one part on their own are
  // omitted explicitly and reported; they never block an otherwise usable mix.
  const treeEntries = [...fileTreeEntries];
  const validFiles: Array<{ path: string; content: string; fileXml: string }> = [];
  const omitted: MixOmittedFile[] = [];

  for (const f of files) {
    const fileXml = formatFileXml(f);
    const fits = canFileFitContinuationPart({
      owner, repo, branch, headOid,
      maxParts: MAX_GEMINI_PARTS,
      file: { path: f.path, content: f.content, fileXml },
      maxPartChars: maxPackBudget,
    });

    if (!fits) {
      omitted.push({ path: f.path, reason: 'file_over_hard_limit', chars: f.content.length });
      continue;
    }
    validFiles.push({ path: f.path, content: f.content, fileXml });
  }

  if (validFiles.length === 0 && files.length > 0) {
    const sample = omitted.slice(0, 5).map((entry) => entry.path).join(', ');
    const suffix = omitted.length > 5 ? ` and ${omitted.length - 5} more` : '';
    throw new Error(
      `RepoMix cannot include any file: all ${files.length} file(s) exceed the ${maxPackBudget}-character limit (${sample}${suffix}).`
    );
  }

  // 2. Full Tree with budget cap (<= 14k chars to reserve >= 71k chars for code)
  const maxTreeChars = Math.min(Math.floor(effectiveMaxChars * 0.45), 14_000);
  let fullTreeXml = capFileTree(treeEntries, maxTreeChars);

  // 2b. Cap metadata before partitioning: instructions + tree + metadata must stay inside Part 1.
  const part1OverheadChars = buildPartXml({
    owner, repo, branch, headOid,
    partNum: 1,
    totalParts: MAX_GEMINI_PARTS,
    instructionsText: DEFAULT_MIX_INSTRUCTIONS,
    treeText: fullTreeXml,
    fileXmlList: [],
  }).length;
  const metadataBudget = Math.max(0, Math.min(MAX_RECENT_COMMITS_CHARS, maxPackBudget - part1OverheadChars));
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
  }): { xml: string; entries: Array<{ path: string; content: string; fileXml: string }>; metadata: string } {
    return fitPartXml({
      owner, repo, branch, headOid,
      partNum: params.partNum,
      totalParts: params.totalParts,
      instructionsText: params.instructionsText,
      truncationNoticeText: params.truncationNoticeText,
      metadata: params.metadata,
      treeText: params.treeText,
      omittedManifestText: params.omittedManifestText,
      fileEntries: params.fileEntries,
      hardLimit: HARD_GEMINI_CHAR_LIMIT,
      capMetadataFn: capRecentCommitsText,
    });
  }

  // 3. Single-part fast path
  const rawFilesChars = validFiles.reduce((sum, f) => sum + f.fileXml.length + 1, 0);
  if (splitOutput !== true && omitted.length === 0 && part1OverheadChars + rawFilesChars <= HARD_GEMINI_CHAR_LIMIT) {
    const singleRawXml = buildPartXml({
      owner, repo, branch, headOid,
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

    const shouldSplit =
      single.xml.length > HARD_GEMINI_CHAR_LIMIT ||
      single.xml.length > maxPackBudget ||
      (splitOutput !== false && validFiles.length > 1 && singleRawXml.length > effectiveMaxChars);

    if (!shouldSplit) {
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
  }

  // 4. Partition by complete serialized size, including each part's tree and XML envelope.
  type FsEntry = { path: string; content: string; fileXml: string };
  let part1Extras: { notice: string; manifest: string } = { notice: '', manifest: '' };

  function partitionFiles(budgetChars: number, source: FsEntry[] = validFiles, part1ReserveChars = 0) {
    const partBudget = Math.min(budgetChars, maxPackBudget, HARD_GEMINI_CHAR_LIMIT);
    return packFilesIntoBuckets({
      owner, repo, branch, headOid,
      maxParts: MAX_GEMINI_PARTS,
      partBudget,
      part1Instructions: DEFAULT_MIX_INSTRUCTIONS,
      part1Notice: part1Extras.notice || undefined,
      part1RecentCommits: cappedRecentCommitsText || undefined,
      part1TreeText: fullTreeXml,
      part1Manifest: part1Extras.manifest || undefined,
      part1ReserveChars,
      files: source,
    });
  }

  const initialPack = partitionFiles(maxPackBudget, validFiles);
  const requiredParts = initialPack.buckets.length;

  let keptFiles = validFiles;
  let continuationParts: MixPart[] = [];
  let continuationFilesCount = 0;
  let continuationPartsCount = 0;
  let manifestMaxChars = 0;
  let part1ReserveChars = 0;

  if (!initialPack.allWithinBudget || requiredParts > MAX_GEMINI_PARTS || omitted.length > 0) {
    const part1WithMetaChars = part1OverheadChars + (cappedRecentCommitsText ? cappedRecentCommitsText.length + 1 : 0);
    manifestMaxChars = Math.max(0, Math.min(8_000, Math.floor((maxPackBudget - part1WithMetaChars - 1_500) * 0.5)));
    part1ReserveChars = manifestMaxChars + 1_200;

    const selection = selectFilesWithinPartLimit(
      validFiles,
      (subset) => {
        const res = partitionFiles(maxPackBudget, subset, part1ReserveChars);
        return res.allWithinBudget ? res.buckets.length : MAX_GEMINI_PARTS + 1;
      },
      MAX_GEMINI_PARTS
    );
    keptFiles = selection.kept;
    omitted.push(...selection.omitted);
    if (keptFiles.length === 0) {
      throw new Error(`RepoMix cannot include any file within ${MAX_GEMINI_PARTS} parts and the ${HARD_GEMINI_CHAR_LIMIT}-character limit.`);
    }
    const keptPaths = new Set(keptFiles.map((file) => file.path));
    fullTreeXml = capFileTree(treeEntries.filter((entry) => keptPaths.has(entry)), maxTreeChars);
  }

  // Budget ladder: 85k default first, then 95k, then the absolute 100k ceiling.
  const budgetLadder = canEscalateBudget
    ? [effectiveMaxChars, Math.min(95_000, HARD_GEMINI_CHAR_LIMIT), HARD_GEMINI_CHAR_LIMIT]
    : [effectiveMaxChars];
  const triedBudgets: number[] = [];
  let chunkBuckets: FsEntry[][] = [];
  for (const budget of budgetLadder) {
    if (triedBudgets.includes(budget)) continue;
    const packed = partitionFiles(budget, keptFiles, part1ReserveChars);
    chunkBuckets = packed.buckets;
    triedBudgets.push(budget);
    if (packed.allWithinBudget && chunkBuckets.length <= MAX_GEMINI_PARTS) break;
  }
  if (chunkBuckets.length > MAX_GEMINI_PARTS) {
    throw new Error(`RepoMix truncation invariant failed: ${chunkBuckets.length} parts after selecting within ${MAX_GEMINI_PARTS}.`);
  }

  if (omitted.length > 0) {
    const keptPaths = new Set(keptFiles.map((file) => file.path));
    if (input.enableContinuation === true) {
      const partLimitOmittedEntries = rankFilesForOmission(validFiles.filter((file) => !keptPaths.has(file.path)));
      if (partLimitOmittedEntries.length > 0) {
        const contRes = buildContinuationParts({
          owner, repo, branch, headOid,
          basePartCount: chunkBuckets.length,
          omittedEntries: partLimitOmittedEntries,
          effectiveMaxChars,
          maxPackBudget,
          canEscalateBudget,
          hardLimit: HARD_GEMINI_CHAR_LIMIT,
        });
        continuationParts = contRes.continuationParts;
        continuationFilesCount = contRes.coveredFilesCount;
        continuationPartsCount = continuationParts.length;
      }
    }

    part1Extras = {
      notice: buildTruncationNotice({
        includedFiles: keptFiles.length,
        totalFiles: files.length,
        omittedFiles: omitted,
        requiredParts,
        availableParts: MAX_GEMINI_PARTS,
        firstContinuationPart: chunkBuckets.length + 1,
        ...(input.enableContinuation === true ? { continuationPartsCount, continuationFilesCount } : {}),
      }),
      manifest: buildOmittedManifest(omitted, manifestMaxChars),
    };
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

    const partInstructions = partNum === 1 ? DEFAULT_MIX_INSTRUCTIONS : CONTINUATION_MIX_INSTRUCTIONS(partNum, totalParts);

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
      throw new Error(`RepoMix part ${partNum} serialized to ${partXml.length} characters, exceeding the ${HARD_GEMINI_CHAR_LIMIT}-character limit.`);
    }
    if (partXml.length > maxPackBudget) {
      throw new Error(`RepoMix part ${partNum} serialized to ${partXml.length} characters, exceeding the ${maxPackBudget}-character budget.`);
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
    throw new Error(`RepoMix output could not preserve the file accounting within ${MAX_GEMINI_PARTS} conforming parts.`);
  }

  const truncation = buildMixTruncation({
    omitted,
    requiredParts,
    maxParts: MAX_GEMINI_PARTS,
    includedFiles: emittedFileCount,
    totalFiles: files.length,
    enableContinuation: input.enableContinuation,
    continuationPartsCount,
    continuationFilesCount,
  });

  return {
    xmlContent: parts[0]?.xmlContent ?? '',
    parts,
    ...(continuationParts.length > 0 ? { continuationParts } : {}),
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
