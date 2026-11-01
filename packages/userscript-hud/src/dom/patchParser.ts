import type {
  GeminiPatchPayload,
  FilePatchOperation,
  PatchBlock,
  CommitRequest,
} from '../types';
import { normalizeRepoPath } from '../../../../shared/repoPaths';
import {
  extractBalancedJsonObject,
  parseV2PatchPayloadFromCode,
} from '../../../../shared/patchPayloadParser';
import { extractPathFromCode } from './pathHints';

export { extractBalancedJsonObject, parseV2PatchPayloadFromCode };

export function isSearchReplace(text: string): boolean {
  return text.includes('<<<<<<<') && text.includes('=======') && text.includes('>>>>>>>');
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
  if (/^\s*(?:```(?:json|md|markdown)?\s*)?\{\s*"(?:commitMessage|patches)"/.test(codeText)) {
    return null;
  }

  // If diff open markers are present, require balanced open/close markers (prevents premature harvest during streaming)
  if (codeText.includes('<<<<<<<')) {
    const openCount = (codeText.match(/^<{7}/gm) || []).length;
    const closeCount = (codeText.match(/^>{7}/gm) || []).length;
    if (openCount === 0 || openCount !== closeCount) {
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
      lastIndex = regex.lastIndex;
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
