import type { HarvestedPatch } from '../types';
import { createStablePatchId } from '../services/patchIdentity';
import {
  canInheritPathFromHeading,
  extractPathFromCode,
  fillMissingPatchPaths,
  refreshPatchPathFromDom,
} from './pathHints';
import {
  isSearchReplace,
  parseV2PatchPayloadFromCode,
  convertLegacyBlocksToV2Payload,
} from './patchParser';

export { extractPathFromCode } from './pathHints';
export {
  isSearchReplace,
  parseV2PatchPayloadFromCode,
  convertLegacyBlocksToV2Payload,
} from './patchParser';

function hasInlineBtn(root: Element | DocumentFragment | null | undefined): boolean {
  if (!root || typeof root.querySelector !== 'function') return false;
  return Boolean(root.querySelector('.ggb-inline-btn'));
}

function resolveCodeBlockScope(pre: HTMLElement): HTMLElement {
  const closestBlock = pre.closest('code-block') as HTMLElement | null;
  if (closestBlock) return closestBlock;
  const parent = pre.parentElement;
  if (parent && typeof parent.querySelectorAll === 'function') {
    const codeBlocksInParent = parent.querySelectorAll('pre, code-block');
    if (codeBlocksInParent.length <= 1) {
      return parent;
    }
  }
  return pre;
}

function findCopyButton(
  roots: Array<Element | DocumentFragment | null | undefined>
): HTMLElement | null {
  for (const root of roots) {
    if (!root || typeof root.querySelector !== 'function') continue;
    const bySelector = root.querySelector<HTMLElement>(
      'button[aria-label*="Copy"], button[aria-label*="copy"], button[aria-label*="Kopieren"], button[aria-label*="kopieren"], button[data-test-id*="copy"], button.copy-button, copy-button'
    );
    if (bySelector && !(bySelector.className || '').includes('ggb-inline-btn')) {
      return bySelector;
    }
    const allButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
    for (const btn of allButtons) {
      const cls = btn.className || '';
      if (cls.includes('ggb-inline-btn') || cls.includes('ggb-canvas-btn')) {
        continue;
      }
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
      if (label.includes('copy') || label.includes('kopier')) {
        return btn;
      }
    }
  }
  return null;
}

function findCodeHeader(
  roots: Array<Element | DocumentFragment | null | undefined>,
  pre: HTMLElement,
  codeEl: HTMLElement
): HTMLElement | null {
  for (const root of roots) {
    if (!root || typeof root.querySelectorAll !== 'function') continue;
    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>(
        '.code-block-decoration, .code-header, [class*="header"], header'
      )
    );
    for (const el of candidates) {
      if (el === pre || el === codeEl || el === codeEl.parentElement) continue;
      if (typeof el.contains === 'function' && el.contains(codeEl)) continue;
      return el;
    }
  }
  return null;
}

/**
 * Starts the DOM Harvester MutationObserver.
 * Watches for code blocks and Gemini Canvas cards, attaching Trusted-Types-safe buttons.
 */
export function startDomHarvester(
  onPatchHarvested: (patch: HarvestedPatch) => void,
  onInlineApply: (patch: HarvestedPatch) => void,
  onPatchUpdated?: (patch: HarvestedPatch) => void
): MutationObserver {
  const processedSet = new WeakSet<Element>();
  const harvestedBlocks = new Map<
    HTMLElement,
    { codeEl: Element; lastCodeText: string; patch: HarvestedPatch }
  >();
  const pendingPathFills: Array<{
    element: HTMLElement;
    codeText: string;
    patch: HarvestedPatch;
  }> = [];

  function parseCodeBlockPayload(codeText: string, pre: HTMLElement): HarvestedPatch | null {
    if (codeText.length < 15) return null;
    const v2Payload = parseV2PatchPayloadFromCode(codeText);
    if (v2Payload) {
      return {
        id: createStablePatchId('v2_json', v2Payload),
        mode: 'v2_json',
        commitMessage: v2Payload.commitMessage,
        payload: v2Payload,
        timestamp: new Date().toLocaleTimeString(),
      };
    }
    const detectedPath = extractPathFromCode(codeText, pre);
    const converted = convertLegacyBlocksToV2Payload(codeText, detectedPath || undefined);
    if (converted && (isSearchReplace(codeText) || Boolean(detectedPath))) {
      const legacyMode: HarvestedPatch['mode'] = isSearchReplace(codeText)
        ? 'v1_search_replace'
        : 'v2_json';
      return {
        id: createStablePatchId(legacyMode, converted.payload),
        mode: legacyMode,
        commitMessage: converted.payload.commitMessage,
        payload: converted.payload,
        legacyPayload: converted.legacyPayload,
        timestamp: new Date().toLocaleTimeString(),
      };
    }
    return null;
  }

  /** Streaming can append additional diff sections after the first harvest; update in-place when text grows. */
  function refreshStreamingBlocks(): void {
    for (const [el, entry] of harvestedBlocks.entries()) {
      if (el.isConnected === false) {
        harvestedBlocks.delete(el);
        continue;
      }
      const liveText = (entry.codeEl.textContent || '').trim();
      if (!liveText || liveText === entry.lastCodeText) continue;
      const updated = parseCodeBlockPayload(liveText, el);
      if (!updated) continue;
      entry.lastCodeText = liveText;
      if (updated.id !== entry.patch.id) {
        entry.patch.id = updated.id;
        entry.patch.mode = updated.mode;
        entry.patch.commitMessage = updated.commitMessage;
        entry.patch.payload = updated.payload;
        entry.patch.legacyPayload = updated.legacyPayload;
        onPatchUpdated?.(entry.patch);
      }
    }
  }

  /** Streaming can render the heading after the block; retry pending paths on every scan. */
  function refreshPendingPathFills(): void {
    for (let index = pendingPathFills.length - 1; index >= 0; index -= 1) {
      const pending = pendingPathFills[index];
      if (!canInheritPathFromHeading(pending.patch) || pending.element.isConnected === false) {
        pendingPathFills.splice(index, 1);
        continue;
      }
      if (fillMissingPatchPaths(pending.patch, extractPathFromCode(pending.codeText, pending.element))) {
        pendingPathFills.splice(index, 1);
        onPatchUpdated?.(pending.patch);
      }
    }
  }

  function processCodeBlock(pre: HTMLElement) {
    if (processedSet.has(pre) || pre.getAttribute('data-ggh-processed') === 'true') {
      return;
    }

    // Button/header lookups stay inside this code block so a sibling header is never claimed.
    const scope = resolveCodeBlockScope(pre);
    if (
      hasInlineBtn(scope) ||
      hasInlineBtn(pre) ||
      hasInlineBtn(pre.shadowRoot) ||
      hasInlineBtn(scope.shadowRoot)
    ) {
      processedSet.add(pre);
      pre.setAttribute('data-ggh-processed', 'true');
      return;
    }

    const codeEl =
      (pre.shadowRoot || pre).querySelector('code') ||
      pre.querySelector('code') ||
      pre;
    const codeText = (codeEl.textContent || '').trim();
    const harvested = parseCodeBlockPayload(codeText, pre);
    if (!harvested) return;

    // Only mark as processed AFTER a successful harvest.
    // If the JSON is incomplete or streaming, leave the element unflagged so subsequent observer ticks re-try automatically as tokens arrive.
    processedSet.add(pre);
    pre.setAttribute('data-ggh-processed', 'true');
    const innerPre = (pre.shadowRoot || pre).querySelector('pre');
    if (innerPre) {
      processedSet.add(innerPre);
      innerPre.setAttribute('data-ggh-processed', 'true');
    }

    const currentPatch = harvested;
    harvestedBlocks.set(pre, { codeEl, lastCodeText: codeText, patch: currentPatch });

    // Create Trusted-Types-safe inline action button
    const btn = document.createElement('button');
    btn.className = 'ggb-inline-btn';
    btn.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 5px 12px !important;
      background: linear-gradient(135deg, #0284c7, #0369a1) !important;
      color: #ffffff !important;
      border: 1px solid #38bdf8 !important;
      border-radius: 8px !important;
      font-family: ui-sans-serif, system-ui, sans-serif !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      cursor: pointer !important;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35) !important;
      margin: 6px !important;
      z-index: 2147483647 !important;
      user-select: none !important;
      transition: all 0.2s ease !important;
    `;
    btn.textContent =
      harvested.mode === 'v2_json' ? '⚡ Push Patch (/api/patch)' : '🚀 Push via Bridge';

    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The full answer (and with it the filename heading) is guaranteed to be
      // rendered by the time the user clicks, so resolve a missing path now.
      const liveText = (codeEl.textContent || '').trim() || codeText;
      refreshPatchPathFromDom(currentPatch, liveText, pre);
      onInlineApply(currentPatch);
    };

    const searchRoots: Array<Element | DocumentFragment | null | undefined> = [
      pre.shadowRoot,
      scope.shadowRoot,
      scope,
      pre,
    ];

    const copyBtn = findCopyButton(searchRoots);
    let attached = false;

    if (copyBtn && copyBtn.parentElement) {
      const parent = copyBtn.parentElement;
      if (!hasInlineBtn(parent)) {
        parent.insertBefore(btn, copyBtn);
        attached = true;
      }
    }

    if (!attached) {
      const codeHeader = findCodeHeader(searchRoots, pre, codeEl);
      if (codeHeader) {
        if (!hasInlineBtn(codeHeader)) {
          codeHeader.appendChild(btn);
          attached = true;
        }
      }
    }

    if (!attached) {
      pre.style.position = 'relative';
      btn.style.position = 'absolute';
      btn.style.top = '8px';
      btn.style.right = '40px';
      pre.appendChild(btn);
    }

    if (canInheritPathFromHeading(currentPatch)) {
      pendingPathFills.push({ element: pre, codeText, patch: currentPatch });
    }

    onPatchHarvested(currentPatch);
  }

  function processCanvasCards() {
    // Gemini Canvas export buttons & cards
    const exportCandidateButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button:not([data-ggh-canvas-processed])')
    );
    const exportBtns = exportCandidateButtons.filter((b) => {
      const txt = (b.textContent || b.getAttribute('aria-label') || '').trim();
      return txt.includes('Exportieren') || txt.includes('Export');
    });

    exportBtns.forEach((exportBtn) => {
      exportBtn.setAttribute('data-ggh-canvas-processed', 'true');
      const headerBar = exportBtn.parentElement;
      if (!headerBar || headerBar.querySelector('.ggb-canvas-btn')) return;

      const btn = document.createElement('button');
      btn.className = 'ggb-canvas-btn';
      btn.style.cssText = `
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 5px 12px !important;
        background: #0284c7 !important;
        color: #ffffff !important;
        border: 1px solid #38bdf8 !important;
        border-radius: 8px !important;
        font-family: ui-sans-serif, system-ui, sans-serif !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        margin-right: 8px !important;
        z-index: 2147483647 !important;
      `;
      btn.textContent = '🚀 Push Canvas to GitHub';

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const card = exportBtn.closest(
          '[class*="card"], [class*="container"], [class*="editor"], [class*="canvas"], [class*="panel"], section, div'
        );
        let cardText = '';
        if (card) {
          const contentArea =
            card.querySelector<HTMLElement>('[contenteditable], [class*="content"], [class*="body"], [class*="text"]') ||
            (card as HTMLElement);
          cardText = contentArea.textContent || '';
        }

        const detectedPath = extractPathFromCode(cardText, null);
        const converted = convertLegacyBlocksToV2Payload(
          cardText,
          detectedPath || 'canvas-update.md'
        );

        if (converted) {
          const patch: HarvestedPatch = {
            id: 'canvas-' + Date.now(),
            mode: isSearchReplace(cardText) ? 'v1_search_replace' : 'v2_json',
            commitMessage: converted.payload.commitMessage,
            payload: converted.payload,
            legacyPayload: converted.legacyPayload,
            timestamp: new Date().toLocaleTimeString(),
          };
          onInlineApply(patch);
        }
      };

      headerBar.insertBefore(btn, exportBtn);
    });
  }

  function scanDOM() {
    refreshStreamingBlocks();
    refreshPendingPathFills();
    const blocks = document.querySelectorAll<HTMLElement>(
      'code-block:not([data-ggh-processed]), pre:not([data-ggh-processed])'
    );
    blocks.forEach((el) => {
      if (el.tagName.toLowerCase() === 'pre' && el.closest('code-block')) {
        processedSet.add(el);
        el.setAttribute('data-ggh-processed', 'true');
        return;
      }
      processCodeBlock(el);
    });
    processCanvasCards();
  }

  const observer = new MutationObserver(() => {
    scanDOM();
  });

  if (typeof document !== 'undefined') {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (document.body) {
          observer.observe(document.body, { childList: true, subtree: true });
        }
      });
    }
    scanDOM();
  }

  return observer;
}
