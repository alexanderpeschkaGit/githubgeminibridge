import type { MixOmittedFile, MixTruncation } from '../types';

export interface OmissionFile {
  path: string;
  content: string;
  fileXml: string;
}

export interface OmissionSelection<T extends OmissionFile> {
  kept: T[];
  omitted: MixOmittedFile[];
  requiredParts: number;
}

const ROOT_CONFIG_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'wrangler.toml',
  'wrangler.jsonc',
  'pnpm-workspace.yaml',
  'turbo.json',
  'agents.md',
  'AGENTS.md',
  'GEMINI.md',
  '.repomixignore.cf',
  '.repomixignore',
]);

const ENTRYPOINT_PATTERN = /^(index|main|worker|app)\.(ts|tsx|js|jsx|mjs)$/;

/** Sorts and caps the master file tree to the character budget. */
export function capFileTree(entries: string[], maxChars: number): string {
  let tree = [...entries].sort().join('\n');
  if (tree.length > maxChars) {
    const truncated = tree.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    tree =
      (lastNewline !== -1 ? truncated.slice(0, lastNewline) : truncated) +
      '\n... [file_tree truncated to preserve character budget]';
  }
  return tree;
}

function priorityTier(filePath: string): number {
  const segments = filePath.split('/');
  const baseName = segments[segments.length - 1] ?? '';
  if (segments.length === 1 && ROOT_CONFIG_FILES.has(baseName)) return 0;
  if (
    ENTRYPOINT_PATTERN.test(baseName) &&
    (segments.length === 1 ||
      filePath.startsWith('src/') ||
      filePath.startsWith('shared/') ||
      filePath.startsWith('packages/'))
  ) {
    return 1;
  }
  if (
    filePath.startsWith('src/') ||
    filePath.startsWith('shared/') ||
    filePath.startsWith('packages/')
  ) {
    return 2;
  }
  if (filePath.startsWith('.agents/') || filePath.startsWith('scripts/')) {
    return 3;
  }
  return 4;
}

/**
 * Deterministic omission order: high-value paths are kept first, and within a tier
 * smaller serialized files are preferred so more files survive a tight budget.
 */
export function rankFilesForOmission<T extends OmissionFile>(files: T[]): T[] {
  return [...files].sort(
    (a, b) =>
      priorityTier(a.path) - priorityTier(b.path) ||
      a.fileXml.length - b.fileXml.length ||
      a.path.localeCompare(b.path)
  );
}

/**
 * Drops lowest-priority whole files until the kept set fits the part limit.
 * Never inspects or mutates file contents. Deterministic for identical input.
 */
export function selectFilesWithinPartLimit<T extends OmissionFile>(
  files: T[],
  countParts: (subset: T[]) => number,
  maxParts: number
): OmissionSelection<T> {
  const requiredParts = countParts(files);
  if (requiredParts <= maxParts) {
    return { kept: [...files], omitted: [], requiredParts };
  }

  const ranked = rankFilesForOmission(files);
  let low = 0;
  let high = ranked.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countParts(ranked.slice(0, mid)) <= maxParts) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const kept = ranked.slice(0, low);
  // Safety guard for potential FFD non-monotonic edge cases:
  while (kept.length > 0 && countParts(kept) > maxParts) {
    kept.pop();
  }

  const omitted: MixOmittedFile[] = ranked.slice(kept.length).map((file) => ({
    path: file.path,
    reason: 'part_limit_exceeded',
    chars: file.content.length,
  }));

  return { kept, omitted, requiredParts };
}

/** Builds the Part-1 manifest of omitted paths, capped to a fixed character budget. */
export function buildOmittedManifest(omitted: MixOmittedFile[], maxChars = 8_000): string {
  if (omitted.length === 0) return '';
  const sorted = [...omitted].sort((a, b) => a.path.localeCompare(b.path));
  const header = `<omitted_files count="${sorted.length}">`;
  const footer = '</omitted_files>';
  const marker = '... [omitted file list truncated to preserve character budget]';
  let body = '';

  for (const entry of sorted) {
    const line = `${entry.path}\n`;
    const projected = header.length + 1 + body.length + line.length + footer.length + 1;
    if (projected + marker.length + 2 > maxChars) {
      body += `${marker}\n`;
      break;
    }
    body += line;
  }

  return `${header}\n${body}${footer}`;
}

export interface TruncationSummary {
  includedFiles: number;
  totalFiles: number;
  omittedFiles: MixOmittedFile[];
  requiredParts: number;
  availableParts: number;
  firstContinuationPart?: number;
  continuationPartsCount?: number;
  continuationFilesCount?: number;
}

/** LLM-visible notice: omission is explicit and patching omitted paths is forbidden. */
export function buildTruncationNotice(summary: TruncationSummary): string {
  const rawSample = summary.omittedFiles
    .slice(0, 5)
    .map((entry) => entry.path)
    .join(', ');
  const sample = rawSample.length > 480 ? `${rawSample.slice(0, 477)}...` : rawSample;
  const suffix = rawSample.length <= 480 && summary.omittedFiles.length > 5 ? ' ...' : '';
  const reasons = [...new Set(summary.omittedFiles.map((entry) => entry.reason))].join(', ');
  const firstCont = summary.firstContinuationPart ?? 11;
  const lastCont = firstCont + (summary.continuationPartsCount ?? 0) - 1;
  const continuationNotice =
    summary.continuationFilesCount && summary.continuationFilesCount > 0
      ? `${summary.continuationFilesCount} omitted file(s) are pre-packed into ${summary.continuationPartsCount ?? 0} continuation part(s) (Parts ${firstCont}-${lastCont}) for follow-up prompt attachment.`
      : '';
  return [
    '<truncation_notice>',
    `RepoMix is TRUNCATED to fit Gemini's ${summary.availableParts}-file attachment limit.`,
    `Included: ${summary.includedFiles} of ${summary.totalFiles} files. Omitted: ${summary.omittedFiles.length} file(s) (${reasons}).`,
    `The complete file set would need at least ${summary.requiredParts} parts; available: ${summary.availableParts}.`,
    sample ? `Sample omitted paths: ${sample}${suffix}` : '',
    'Do not emit patches for omitted paths. Ask the user to narrow includePaths or update .repomixignore.cf.',
    continuationNotice,
    '</truncation_notice>',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface BuildMixTruncationParams {
  omitted: MixOmittedFile[];
  requiredParts: number;
  maxParts: number;
  includedFiles: number;
  totalFiles: number;
  enableContinuation?: boolean;
  continuationPartsCount?: number;
  continuationFilesCount?: number;
}

export function buildMixTruncation(params: BuildMixTruncationParams): MixTruncation | undefined {
  const {
    omitted,
    requiredParts,
    maxParts,
    includedFiles,
    totalFiles,
    enableContinuation,
    continuationPartsCount = 0,
    continuationFilesCount = 0,
  } = params;
  if (omitted.length === 0) return undefined;

  const hasPartLimit = omitted.some((entry) => entry.reason === 'part_limit_exceeded');
  const hasHardLimit = omitted.some((entry) => entry.reason === 'file_over_hard_limit');
  const truncationReason: MixTruncation['reason'] =
    hasPartLimit && hasHardLimit ? 'mixed' : hasPartLimit ? 'part_limit_exceeded' : 'file_over_hard_limit';

  return {
    reason: truncationReason,
    requiredParts,
    availableParts: maxParts,
    includedFiles,
    totalFiles,
    omittedFiles: [...omitted].sort((a, b) => a.path.localeCompare(b.path)),
    omittedChars: omitted.reduce((sum, entry) => sum + (entry.chars ?? 0), 0),
    ...(enableContinuation === true
      ? {
          continuationPartsCount,
          continuationFilesCount,
          unrecoverableFilesCount: Math.max(0, omitted.length - continuationFilesCount),
        }
      : {}),
  };
}
