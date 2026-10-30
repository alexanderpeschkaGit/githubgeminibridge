import type { MixPart } from '../types';
import {
  buildPartXml,
  CONTINUATION_MIX_INSTRUCTIONS,
  fitPartXml,
  formatFileXml,
  type PackableMixFile,
} from './mixSerializer';
import { selectFilesWithinPartLimit } from './mixSelection';

export const MAX_CONTINUATION_PARTS = 20;

export interface BuildContinuationPartsParams<T extends PackableMixFile = PackableMixFile> {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  basePartCount: number;
  omittedEntries: T[];
  effectiveMaxChars: number;
  maxPackBudget: number;
  canEscalateBudget: boolean;
  hardLimit: number;
}

export interface BuildContinuationPartsResult {
  continuationParts: MixPart[];
  coveredFilesCount: number;
}

interface ContinuationBucketState<T extends PackableMixFile> {
  entries: T[];
  filesXmlChars: number;
  pathsChars: number;
}

function packContinuationBuckets<T extends PackableMixFile>(params: {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  basePartCount: number;
  maxContinuationParts: number;
  partBudget: number;
  files: T[];
}): { buckets: T[][]; allWithinBudget: boolean } {
  if (params.partBudget <= 0 || params.files.length === 0) {
    return {
      buckets: params.files.map((f) => [f]),
      allWithinBudget: params.files.length === 0,
    };
  }

  const { owner, repo, branch, headOid, basePartCount, maxContinuationParts, partBudget } = params;
  const grandMaxParts = basePartCount + maxContinuationParts;

  const contBaseCache = new Map<number, number>();
  function getContBaseLen(partNum: number): number {
    const cached = contBaseCache.get(partNum);
    if (cached !== undefined) return cached;
    const dummy = '__TREE__';
    const xml = buildPartXml({
      owner,
      repo,
      branch,
      headOid,
      partNum,
      totalParts: grandMaxParts,
      instructionsText: CONTINUATION_MIX_INSTRUCTIONS(partNum, grandMaxParts),
      treeText: dummy,
      fileXmlList: [],
    });
    const len = xml.length - dummy.length;
    contBaseCache.set(partNum, len);
    return len;
  }

  function candidateBucketSize(
    bucketIndex: number,
    current: ContinuationBucketState<T>,
    addedFile?: T
  ): number {
    const newCount = current.entries.length + (addedFile ? 1 : 0);
    const newFilesXmlChars = current.filesXmlChars + (addedFile ? addedFile.fileXml.length : 0);
    const partNum = basePartCount + bucketIndex + 1;
    const newPathsChars = current.pathsChars + (addedFile ? addedFile.path.length : 0);
    const treeHeaderLen = `# Part ${partNum}/${grandMaxParts} files (${newCount} files):\n`.length;
    const treeTextLen = treeHeaderLen + newPathsChars + Math.max(0, newCount - 1);
    const filesListLen = newFilesXmlChars + newCount;
    return getContBaseLen(partNum) + treeTextLen + filesListLen;
  }

  const packList = [...params.files].sort(
    (a, b) => b.fileXml.length - a.fileXml.length || a.path.localeCompare(b.path)
  );

  const buckets: ContinuationBucketState<T>[] = [];
  let allWithinBudget = true;

  for (const file of packList) {
    let placed = false;
    for (let i = 0; i < buckets.length; i++) {
      const size = candidateBucketSize(i, buckets[i], file);
      if (size <= partBudget) {
        buckets[i].entries.push(file);
        buckets[i].filesXmlChars += file.fileXml.length;
        buckets[i].pathsChars += file.path.length;
        placed = true;
        break;
      }
    }

    if (!placed) {
      const nextIdx = buckets.length;
      const emptyState: ContinuationBucketState<T> = { entries: [], filesXmlChars: 0, pathsChars: 0 };
      const size = candidateBucketSize(nextIdx, emptyState, file);
      if (size > partBudget) {
        allWithinBudget = false;
      }
      buckets.push({
        entries: [file],
        filesXmlChars: file.fileXml.length,
        pathsChars: file.path.length,
      });
    }
  }

  if (buckets.length > maxContinuationParts) {
    allWithinBudget = false;
  }

  return {
    buckets: buckets.map((b) => b.entries),
    allWithinBudget,
  };
}

export function buildContinuationParts<T extends PackableMixFile = PackableMixFile>(
  params: BuildContinuationPartsParams<T>
): BuildContinuationPartsResult {
  const {
    owner,
    repo,
    branch,
    headOid,
    basePartCount,
    omittedEntries,
    effectiveMaxChars,
    maxPackBudget,
    canEscalateBudget,
    hardLimit,
  } = params;

  if (!omittedEntries || omittedEntries.length === 0) {
    return { continuationParts: [], coveredFilesCount: 0 };
  }

  const entries: T[] = omittedEntries.map((f) => ({
    ...f,
    fileXml: f.fileXml ?? formatFileXml({ path: f.path, content: f.content }),
  }));

  function partitionContinuation(budgetChars: number, source: T[]) {
    const partBudget = Math.min(budgetChars, maxPackBudget, hardLimit);
    return packContinuationBuckets({
      owner,
      repo,
      branch,
      headOid,
      basePartCount,
      maxContinuationParts: MAX_CONTINUATION_PARTS,
      partBudget,
      files: source,
    });
  }

  const initialPack = partitionContinuation(maxPackBudget, entries);
  let keptFiles = entries;

  if (!initialPack.allWithinBudget || initialPack.buckets.length > MAX_CONTINUATION_PARTS) {
    const selection = selectFilesWithinPartLimit(
      entries,
      (subset) => {
        const res = partitionContinuation(maxPackBudget, subset);
        return res.allWithinBudget ? res.buckets.length : MAX_CONTINUATION_PARTS + 1;
      },
      MAX_CONTINUATION_PARTS
    );
    keptFiles = selection.kept;
  }

  if (keptFiles.length === 0) {
    return { continuationParts: [], coveredFilesCount: 0 };
  }

  const budgetLadder = canEscalateBudget
    ? [
        effectiveMaxChars,
        Math.min(95_000, hardLimit),
        hardLimit,
      ]
    : [effectiveMaxChars];

  const triedBudgets: number[] = [];
  let chunkBuckets: T[][] = [];

  for (const budget of budgetLadder) {
    if (triedBudgets.includes(budget)) continue;
    const packed = partitionContinuation(budget, keptFiles);
    chunkBuckets = packed.buckets;
    triedBudgets.push(budget);
    if (packed.allWithinBudget && chunkBuckets.length <= MAX_CONTINUATION_PARTS) {
      break;
    }
  }

  if (chunkBuckets.length > MAX_CONTINUATION_PARTS) {
    throw new Error(
      `RepoMix continuation invariant failed: ${chunkBuckets.length} parts after selecting within ${MAX_CONTINUATION_PARTS}.`
    );
  }

  const totalParts = basePartCount + chunkBuckets.length;
  const continuationParts: MixPart[] = [];
  let coveredFilesCount = 0;

  for (let i = 0; i < chunkBuckets.length; i++) {
    const bucket = chunkBuckets[i];
    const partIndex = basePartCount + i + 1;
    const partTreeText = `# Part ${partIndex}/${totalParts} files (${bucket.length} files):\n${bucket.map((b) => b.path).join('\n')}`;
    const partInstructions = CONTINUATION_MIX_INSTRUCTIONS(partIndex, totalParts);

    const fitted = fitPartXml({
      owner,
      repo,
      branch,
      headOid,
      partNum: partIndex,
      totalParts,
      instructionsText: partInstructions,
      treeText: partTreeText,
      fileEntries: bucket,
      hardLimit,
    });

    const partXml = fitted.xml;
    if (partXml.length > hardLimit) {
      throw new Error(
        `RepoMix continuation part ${partIndex} serialized to ${partXml.length} characters, exceeding the ${hardLimit}-character limit.`
      );
    }
    if (partXml.length > maxPackBudget) {
      throw new Error(
        `RepoMix continuation part ${partIndex} serialized to ${partXml.length} characters, exceeding the ${maxPackBudget}-character budget.`
      );
    }

    coveredFilesCount += bucket.length;
    continuationParts.push({
      partIndex,
      totalParts,
      fileName: `repo-mix.part${partIndex}.txt`,
      xmlContent: partXml,
      stats: {
        fileCount: bucket.length,
        estimatedTokens: Math.ceil(partXml.length / 4),
        charCount: partXml.length,
      },
    });
  }

  return { continuationParts, coveredFilesCount };
}
