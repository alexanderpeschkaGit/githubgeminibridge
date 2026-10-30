import { escapeCdata } from './mixerTarScan';

export const CONTINUATION_MIX_INSTRUCTIONS = (partNum: number, totalParts: number): string =>
  `<instructions>\n# Part ${partNum}/${totalParts} Continuation: Refer to Part 1 for master file_tree and modification protocol.\n</instructions>`;

export interface PackableMixFile {
  path: string;
  content: string;
  fileXml: string;
}

export function formatFileXml(file: { path: string; content: string }): string {
  return `  <file path="${file.path}"><![CDATA[${escapeCdata(file.content)}]]></file>`;
}

export function buildPartXml(params: {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  partNum?: number;
  totalParts?: number;
  instructionsText?: string;
  truncationNoticeText?: string;
  recentCommitsText?: string;
  treeText: string;
  omittedManifestText?: string;
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
  if (params.truncationNoticeText) {
    sections.push(params.truncationNoticeText);
  }
  if (params.recentCommitsText) {
    sections.push(params.recentCommitsText);
  }
  sections.push('<file_tree>', params.treeText, '</file_tree>');
  if (params.omittedManifestText) {
    sections.push(params.omittedManifestText);
  }
  sections.push('<files>', ...params.fileXmlList, '</files>', '</repository>');

  return sections.join('\n');
}

export function fitPartXml<
  T extends { relativePath?: string; path?: string; content: string; fileXml?: string }
>(params: {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  partNum?: number;
  totalParts?: number;
  instructionsText?: string;
  truncationNoticeText?: string;
  metadata?: string;
  treeText: string;
  omittedManifestText?: string;
  fileEntries: T[];
  hardLimit: number;
  capMetadataFn?: (metadata: string, budget: number) => string;
}): { xml: string; entries: T[]; metadata: string } {
  const build = (meta: string): string =>
    buildPartXml({
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      headOid: params.headOid,
      partNum: params.partNum,
      totalParts: params.totalParts,
      instructionsText: params.instructionsText,
      truncationNoticeText: params.truncationNoticeText,
      recentCommitsText: meta || undefined,
      treeText: params.treeText,
      omittedManifestText: params.omittedManifestText,
      fileXmlList: params.fileEntries.map((e) =>
        e.fileXml ?? formatFileXml({ path: e.relativePath ?? e.path ?? '', content: e.content })
      ),
    });

  let metadata = params.metadata ?? '';
  let xml = build(metadata);
  if (xml.length > params.hardLimit && metadata && params.capMetadataFn) {
    metadata = params.capMetadataFn(
      metadata,
      Math.max(0, metadata.length - (xml.length - params.hardLimit) - 1)
    );
    xml = build(metadata);
  }
  if (xml.length > params.hardLimit && metadata) {
    metadata = '';
    xml = build(metadata);
  }
  return { xml, entries: params.fileEntries, metadata };
}

export function canFileFitContinuationPart(params: {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  maxParts: number;
  file: PackableMixFile;
  maxPartChars: number;
}): boolean {
  const treeText = `# Part ${params.maxParts}/${params.maxParts} files (1 files):\n${params.file.path}`;
  const xml = buildPartXml({
    owner: params.owner,
    repo: params.repo,
    branch: params.branch,
    headOid: params.headOid,
    partNum: params.maxParts,
    totalParts: params.maxParts,
    instructionsText: CONTINUATION_MIX_INSTRUCTIONS(params.maxParts, params.maxParts),
    treeText,
    fileXmlList: [params.file.fileXml],
  });
  return xml.length <= params.maxPartChars;
}

interface BucketState<T extends PackableMixFile> {
  entries: T[];
  filesXmlChars: number;
  pathsChars: number;
}

export function packFilesIntoBuckets<T extends PackableMixFile>(params: {
  owner: string;
  repo: string;
  branch: string;
  headOid: string;
  maxParts: number;
  partBudget: number;
  part1Instructions: string;
  part1Notice?: string;
  part1RecentCommits?: string;
  part1TreeText: string;
  part1Manifest?: string;
  part1ReserveChars?: number;
  files: T[];
}): { buckets: T[][]; allWithinBudget: boolean } {
  if (params.partBudget <= 0) {
    return {
      buckets: params.files.map((f) => [f]),
      allWithinBudget: false,
    };
  }

  const { owner, repo, branch, headOid, maxParts, partBudget } = params;

  // Base overhead of empty Part 1 (envelope + tree + notice + manifest + metadata + reserve)
  const part1EmptyLen =
    buildPartXml({
      owner,
      repo,
      branch,
      headOid,
      partNum: 1,
      totalParts: maxParts,
      instructionsText: params.part1Instructions,
      truncationNoticeText: params.part1Notice || undefined,
      recentCommitsText: params.part1RecentCommits || undefined,
      treeText: params.part1TreeText,
      omittedManifestText: params.part1Manifest || undefined,
      fileXmlList: [],
    }).length + (params.part1ReserveChars ?? 0);

  // Cached base lengths for continuation parts without tree or files
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
      totalParts: maxParts,
      instructionsText: CONTINUATION_MIX_INSTRUCTIONS(partNum, maxParts),
      treeText: dummy,
      fileXmlList: [],
    });
    const len = xml.length - dummy.length;
    contBaseCache.set(partNum, len);
    return len;
  }

  function candidateBucketSize(
    bucketIndex: number,
    current: BucketState<T>,
    addedFile?: T
  ): number {
    const newCount = current.entries.length + (addedFile ? 1 : 0);
    const newFilesXmlChars = current.filesXmlChars + (addedFile ? addedFile.fileXml.length : 0);

    if (bucketIndex === 0) {
      return part1EmptyLen + newFilesXmlChars + newCount;
    }

    const partNum = bucketIndex + 1;
    const newPathsChars = current.pathsChars + (addedFile ? addedFile.path.length : 0);
    const treeHeaderLen = `# Part ${partNum}/${maxParts} files (${newCount} files):\n`.length;
    const treeTextLen = treeHeaderLen + newPathsChars + Math.max(0, newCount - 1);
    const filesListLen = newFilesXmlChars + newCount;
    return getContBaseLen(partNum) + treeTextLen + filesListLen;
  }

  const packList = [...params.files].sort(
    (a, b) => b.fileXml.length - a.fileXml.length || a.path.localeCompare(b.path)
  );

  const buckets: BucketState<T>[] = [];
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
      const emptyState: BucketState<T> = { entries: [], filesXmlChars: 0, pathsChars: 0 };

      // Part-1 Overflow Guard:
      // If no buckets exist yet (nextIdx === 0) and the single largest file overflows Part 1
      // due to Part 1's overhead, check if the file fits a continuation part (index 1).
      // If so, reserve bucket 0 as empty so smaller files can backfill it later.
      if (nextIdx === 0 && candidateBucketSize(0, emptyState, file) > partBudget) {
        const fitsContinuation = candidateBucketSize(1, emptyState, file) <= partBudget;
        if (fitsContinuation && part1EmptyLen <= partBudget) {
          buckets.push({ entries: [], filesXmlChars: 0, pathsChars: 0 }); // Part 1 empty for now
          buckets.push({
            entries: [file],
            filesXmlChars: file.fileXml.length,
            pathsChars: file.path.length,
          });
          placed = true;
        }
      }

      if (!placed) {
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
  }

  if (buckets.length > maxParts) {
    allWithinBudget = false;
  }

  return {
    buckets: buckets.map((b) => b.entries),
    allWithinBudget,
  };
}
