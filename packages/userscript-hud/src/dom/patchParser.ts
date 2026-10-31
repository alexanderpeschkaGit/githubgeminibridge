import type {
  GeminiPatchPayload,
  FilePatchOperation,
  PatchBlock,
  CommitRequest,
} from '../types';
import { normalizeRepoPath } from '../../../../shared/repoPaths';
import { extractPathFromCode } from './pathHints';

export function isSearchReplace(text: string): boolean {
  return text.includes('<<<<<<<') && text.includes('=======') && text.includes('>>>>>>>');
}

function isValidPatchBlock(b: any): b is PatchBlock {
  return Boolean(b && typeof b === 'object' && typeof b.search === 'string' && typeof b.replace === 'string');
}

function isValidPatchOperation(p: any): p is FilePatchOperation {
  if (!p || typeof p.path !== 'string') return false;
  if (p.action === 'modify') {
    const hasValidBlocks = Array.isArray(p.blocks) && p.blocks.length > 0 && p.blocks.every(isValidPatchBlock);
    return hasValidBlocks || typeof p.fullContent === 'string';
  }
  if (p.action === 'create') {
    return typeof p.fullContent === 'string';
  }
  return p.action === 'delete';
}

function extractBalancedJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

function tryParseGeminiPayload(candidate: string): GeminiPatchPayload | null {
  const trimmed = candidate.trim();
  let searchFrom = 0;
  while (searchFrom < trimmed.length) {
    const startIdx = trimmed.indexOf('{', searchFrom);
    if (startIdx === -1) break;
    const balanced = extractBalancedJsonObject(trimmed, startIdx);
    if (balanced) {
      try {
        const obj = JSON.parse(balanced);
        if (
          obj &&
          typeof obj === 'object' &&
          typeof obj.commitMessage === 'string' &&
          Array.isArray(obj.patches) &&
          obj.patches.length > 0 &&
          obj.patches.every(isValidPatchOperation)
        ) {
          return obj as GeminiPatchPayload;
        }
      } catch {
        // Continue scanning next '{' candidate
      }
    }
    searchFrom = startIdx + 1;
  }
  return null;
}

/**
 * Parses a V2 GeminiPatchPayload from code text (e.g. from ```json or ```md code blocks).
 */
export function parseV2PatchPayloadFromCode(codeText: string): GeminiPatchPayload | null {
  if (!codeText || codeText.trim().length === 0) return null;

  let textToParse = codeText.trim();

  // Strip outer markdown code fences if present
  const fenceMatch = textToParse.match(/^```(?:json|md|markdown)?\s*([\s\S]*)\s*```$/i);
  if (fenceMatch) {
    textToParse = fenceMatch[1].trim();
  }

  // Try direct parse first (handles JSON strings that contain internal ``` fences)
  const direct = tryParseGeminiPayload(textToParse);
  if (direct) return direct;

  // If a markdown block wraps an inner ```json fenced block, extract from the first inner fence
  const innerFenceOpen = textToParse.match(/```(?:json)?\s*\{/i);
  if (innerFenceOpen && innerFenceOpen.index !== undefined) {
    const fromBrace = textToParse.slice(innerFenceOpen.index + innerFenceOpen[0].length - 1);
    const directInner = tryParseGeminiPayload(fromBrace);
    if (directInner) return directInner;
    const lastFenceIdx = fromBrace.lastIndexOf('```');
    const innerCandidate = lastFenceIdx !== -1 ? fromBrace.slice(0, lastFenceIdx) : fromBrace;
    const innerParsed = tryParseGeminiPayload(innerCandidate);
    if (innerParsed) return innerParsed;
  }

  return null;
}

export function extractSectionPath(sectionText: string): string {
  if (!sectionText || !sectionText.trim()) return '';

  const lines = sectionText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmedLine = lines[i].trim();
    if (!trimmedLine) continue;

    const inlineMatch = trimmedLine.match(/(?:\/\/|#|\/\*)\s*(?:filepath|file|path):\s*([^\r\n*]+)/i);
    if (inlineMatch && inlineMatch[1]) {
      return normalizeRepoPath(inlineMatch[1].trim().replace(/^["']|["']$/g, ''));
    }

    const bareComment = trimmedLine.match(/^(?:\/\/|#|\/\*+)\s*([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)\s*\*?\/?$/);
    if (bareComment && bareComment[1]) {
      return normalizeRepoPath(bareComment[1]);
    }

    const headerMatch = trimmedLine.match(/^#{1,6}\s+(.+)$/);
    if (headerMatch && headerMatch[1]) {
      const cleaned = headerMatch[1].replace(/[`*]/g, '').trim();
      const labeled = cleaned.match(
        /(?:filepath|file|path)\s*[:=]\s*([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)/i
      );
      if (labeled && labeled[1]) return normalizeRepoPath(labeled[1]);
      const candidate = cleaned.replace(/[:;,]+$/, '').trim();
      if (/^[A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+$/.test(candidate)) {
        return normalizeRepoPath(candidate);
      }
    }
  }

  const fromCode = extractPathFromCode(sectionText);
  if (fromCode) return normalizeRepoPath(fromCode);
  return '';
}

/**
 * Parses search/replace blocks or raw file content into both V2 GeminiPatchPayload and V1 CommitRequest.
 */
export function convertLegacyBlocksToV2Payload(
  codeText: string,
  defaultPath?: string
): { payload: GeminiPatchPayload; legacyPayload: CommitRequest } | null {
  if (!codeText || codeText.trim().length === 0) return null;

  // Never convert an incomplete/streaming V2 JSON payload into a raw file creation
  const strippedFence = codeText.trim().replace(/^```(?:json|md|markdown)?\s*/i, '');
  if (
    /^\{\s*(?:"(?:commit|patch|preflight)[a-zA-Z]*"|\s*$)/.test(strippedFence) ||
    /```(?:json)?\s*\{\s*(?:"(?:commit|patch|preflight)|$)/i.test(codeText)
  ) {
    return null;
  }

  const nonEmptyLines = codeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = nonEmptyLines[0] || '';
  const lastLine = nonEmptyLines[nonEmptyLines.length - 1] || '';
  const startsWithPathComment =
    /^(?:\/\/|#|\/\*)\s*(?:filepath|file|path):/i.test(firstLine) ||
    /^(?:\/\/|#|\/\*+)\s*[A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+\s*\*?\/?$/.test(firstLine);

  // Do not harvest a header-only path comment or a path comment followed by an emerging '<' diff marker
  if (
    startsWithPathComment &&
    (nonEmptyLines.length === 1 ||
      (nonEmptyLines.length === 2 && /^<{1,7}(?:\s*(?:SEARCH|ORIGINAL|HEAD)?)?\s*$/i.test(lastLine)))
  ) {
    return null;
  }
  if (nonEmptyLines.length === 1 && /^<{1,7}(?:\s*(?:SEARCH|ORIGINAL|HEAD)?)?\s*$/i.test(firstLine)) {
    return null;
  }

  // Line-anchored diff marker balance check (ignores '// =======' comment banners in full-file code)
  const openCount = (codeText.match(/^<{7}/gm) || []).length;
  if (openCount > 0) {
    const sepCount = (codeText.match(/^={7}\s*$/gm) || []).length;
    const closeCount = (codeText.match(/^>{7}/gm) || []).length;
    const hasTrailingPartialMarker =
      /^(?:<{1,7}(?:\s*(?:SEARCH|ORIGINAL|HEAD)?)?|={1,7}|>{1,6})\s*$/i.test(lastLine);
    if (openCount !== sepCount || openCount !== closeCount || hasTrailingPartialMarker) {
      return null;
    }
  }

  const detectedPath = normalizeRepoPath(extractPathFromCode(codeText) || defaultPath || '');
  const hasDiffBlocks = isSearchReplace(codeText);
  const describePath = detectedPath || 'no path detected';

  if (hasDiffBlocks) {
    const fileOpsMap = new Map<string, PatchBlock[]>();
    const fileOrder: string[] = [];
    const regex = /<{7}[^\r\n]*\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7}[^\r\n]*/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let currentPath = detectedPath;
    let extractedBlocks = 0;

    while ((match = regex.exec(codeText)) !== null) {
      const preceding = codeText.substring(lastIndex, match.index);
      const sectionPath = extractSectionPath(preceding);
      if (sectionPath) {
        currentPath = sectionPath;
      }

      const activePath = currentPath;
      if (!fileOpsMap.has(activePath)) {
        fileOpsMap.set(activePath, []);
        fileOrder.push(activePath);
      }
      fileOpsMap.get(activePath)!.push({
        search: match[1],
        replace: match[2],
      });
      extractedBlocks++;
      lastIndex = regex.lastIndex;
    }

    if (extractedBlocks !== openCount || fileOrder.length === 0) {
      return null;
    }

    if (fileOrder.length > 0) {
      const patches: FilePatchOperation[] = fileOrder.map((path) => ({
        path,
        action: 'modify',
        blocks: fileOpsMap.get(path)!,
      }));

      const commitMessage =
        patches.length === 1
          ? `refactor(${patches[0].path || 'no path detected'}): apply search/replace patch`
          : `refactor(multi-file): apply search/replace across ${patches.length} files`;

      const payload: GeminiPatchPayload = {
        commitMessage,
        patches,
      };

      const legacyPayload: CommitRequest = {
        repo: '',
        message: payload.commitMessage,
        files: patches.map((p) => ({
          path: p.path,
          diff: codeText,
          patches: p.blocks || [],
        })),
      };

      return { payload, legacyPayload };
    }
  }

  // Not search/replace: Treat as full file update
  const fileOp: FilePatchOperation = {
    path: detectedPath,
    action: 'create',
    fullContent: codeText,
  };

  const payload: GeminiPatchPayload = {
    commitMessage: `feat(${describePath}): update file via Gemini Git Bridge`,
    patches: [fileOp],
  };

  const legacyPayload: CommitRequest = {
    repo: '',
    message: payload.commitMessage,
    files: [
      {
        path: detectedPath,
        content: codeText,
      },
    ],
  };

  return { payload, legacyPayload };
}
