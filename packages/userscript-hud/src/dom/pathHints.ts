import type { HarvestedPatch } from '../types';
import { normalizeRepoPath } from '../../../../shared/repoPaths';

const FILE_PATH_TOKEN = /^[A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+$/;
const LABELED_HEADER_PATH =
  /(?:filepath|file[\s_-]?path|filename|dateiname|file|datei|pfad|path)\s*[:=]\s*([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)/i;
const PATH_COMMENT_LINE = /^(?:\/\/|#|\/\*+)\s*([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)\s*\*?\/?$/;
const DIFF_MARKER_LINE = /^<{7}/;

/** Header lookups stay inside one message; Gemini nests markdown blocks in layout wrappers. */
const MAX_HEADER_ANCESTOR_DEPTH = 4;
const MAX_HEADER_SIBLINGS = 3;
const MAX_HEADER_TEXT_CHARS = 300;
const CODE_BLOCK_TAGS = new Set(['PRE', 'CODE-BLOCK']);
const HEADER_SEARCH_STOP_TAGS = new Set([
  'BODY',
  'HTML',
  'MESSAGE-CONTENT',
  'MODEL-RESPONSE',
  'USER-QUERY',
]);

/**
 * Reduces markdown chrome so headers like "3. `src/a.ts`", "### **src/a.ts**" or "- src/a.ts"
 * collapse to a bare path token.
 */
function stripHeaderDecoration(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text
      .replace(/^[*_`"'\s]+/, '')
      .replace(/[*_`"'\s]+$/, '')
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:[-*+•]|\d+[.)])\s+/, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Turns a header element's text into a repo path, accepting labeled ("File: src/a.ts")
 * and bare-path variants while never inventing a path from prose.
 */
function matchHeaderPath(raw: string): string {
  const text = stripHeaderDecoration(raw).replace(/[*`]/g, '');
  if (!text) return '';

  const labeled = text.match(LABELED_HEADER_PATH);
  if (labeled && labeled[1]) return labeled[1];

  const candidate = text.replace(/[:;,]+$/, '').trim();
  return FILE_PATH_TOKEN.test(candidate) ? candidate : '';
}

function elementTag(element: Element): string {
  return (element.tagName || '').toUpperCase();
}

/** True for a `<pre>`/`<code-block>` or for a wrapper that contains one. */
function containsCodeBlock(element: Element): boolean {
  if (CODE_BLOCK_TAGS.has(elementTag(element))) return true;
  return typeof element.querySelector === 'function' && !!element.querySelector('pre, code-block');
}

/** Stops the ancestor walk at the message container so an earlier turn's heading is never used. */
function isHeaderSearchBoundary(element: Element): boolean {
  if (HEADER_SEARCH_STOP_TAGS.has(elementTag(element))) return true;
  const className = typeof element.className === 'string' ? element.className : '';
  return /(?:^|\s)(?:markdown|markdown-main-panel|response-content)(?:\s|$)/.test(className);
}

/**
 * Collects header candidates around a code element: its own previous siblings first,
 * then the previous siblings of every wrapper up to the message container. Gemini renders
 * the heading outside the block wrapper and sometimes adds another layout div in between,
 * so a single-level sibling lookup misses it.
 */
function collectHeaderElements(preElement?: HTMLElement | null): Element[] {
  const elements: Element[] = [];
  let current: Element | null = preElement ?? null;

  for (let depth = 0; current && depth <= MAX_HEADER_ANCESTOR_DEPTH; depth += 1) {
    let prev = current.previousElementSibling;
    for (let i = 0; i < MAX_HEADER_SIBLINGS && prev; i += 1) {
      // A heading never sits behind another code block; its text may contain a
      // "// filepath:" hint that belongs to a different file.
      if (containsCodeBlock(prev)) break;
      const text = (prev.textContent || '').trim();
      if (text && text.length <= MAX_HEADER_TEXT_CHARS && !elements.includes(prev)) {
        elements.push(prev);
      }
      prev = prev.previousElementSibling;
    }

    const parent: Element | null = current.parentElement;
    if (!parent || isHeaderSearchBoundary(parent)) break;
    current = parent;
  }

  return elements;
}

/**
 * Extracts a file path hint from code comments or preceding elements in the DOM.
 */
export function extractPathFromCode(codeText: string, preElement?: HTMLElement | null): string {
  // 1. Inline comment hints: // filepath: ... | # path: ... | /* path: ... */
  const inlineMatch = codeText.match(/(?:\/\/|#|\/\*)\s*(?:filepath|file|path):\s*([^\r\n*]+)/i);
  if (inlineMatch && inlineMatch[1]) {
    const inlinePath = inlineMatch[1].trim().replace(/^["']|["']$/g, '');
    return normalizeRepoPath(inlinePath);
  }

  // 2. Bare path comment directly above the diff markers ("// src/a.ts" instead of "// filepath: ...")
  const codeLines = codeText.split(/\r?\n/);
  const firstContentIndex = codeLines.findIndex((line) => line.trim().length > 0);
  const bareComment =
    firstContentIndex >= 0 ? codeLines[firstContentIndex].trim().match(PATH_COMMENT_LINE) : null;
  if (bareComment && bareComment[1]) {
    const nextLine =
      codeLines.slice(firstContentIndex + 1).find((line) => line.trim().length > 0)?.trim() ?? '';
    if (DIFF_MARKER_LINE.test(nextLine)) {
      return normalizeRepoPath(bareComment[1]);
    }
  }

  // 3. Look for a filename header above the code block ("3. `src/a.ts`", "**src/a.ts**", "File: src/a.ts")
  for (const element of collectHeaderElements(preElement)) {
    const headerPath = matchHeaderPath(element.textContent ?? '');
    if (headerPath) {
      return normalizeRepoPath(headerPath);
    }
  }

  return '';
}

/** A harvested patch is unusable until every file operation has a repo path. */
export function hasMissingPatchPath(patch: HarvestedPatch): boolean {
  return (patch.payload.patches || []).some((filePatch) => !filePatch.path);
}

/** Only a single-file block can inherit the heading above it (multi-file JSON cannot). */
export function canInheritPathFromHeading(patch: HarvestedPatch): boolean {
  return (patch.payload.patches || []).length === 1 && hasMissingPatchPath(patch);
}

/** Fills paths that were unknown at harvest time; keeps V2 payload and V1 fallback in sync. */
export function fillMissingPatchPaths(patch: HarvestedPatch, path: string): boolean {
  if (!path) return false;
  let changed = false;
  for (const filePatch of patch.payload.patches || []) {
    if (!filePatch.path) {
      filePatch.path = path;
      changed = true;
    }
  }
  for (const file of patch.legacyPayload?.files || []) {
    if (!file.path) {
      file.path = path;
      changed = true;
    }
  }
  return changed;
}

/**
 * Gemini streams the answer, so a code block can be harvested before its filename
 * heading exists in the DOM. Re-read the DOM at click time instead of asking the user.
 */
export function refreshPatchPathFromDom(
  patch: HarvestedPatch,
  codeText: string,
  element: HTMLElement
): void {
  if (!canInheritPathFromHeading(patch)) return;
  fillMissingPatchPaths(patch, extractPathFromCode(codeText, element));
}
