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

/**
 * Starts the DOM Harvester MutationObserver.
 * Watches for code blocks and Gemini Canvas cards, attaching Trusted-Types-safe buttons.
 */
export function startDomHarvester(
  onPatchHarvested: (patch: HarvestedPatch) => void,
  onInlineApply: (patch: HarvestedPatch) => void
): MutationObserver {
  const processedSet = new WeakSet<Element>();
  const pendingPathFills: Array<{
    element: HTMLElement;
    codeText: string;
    patch: HarvestedPatch;
  }> = [];

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
      }
    }
  }

  function processCodeBlock(pre: HTMLElement) {
    if (processedSet.has(pre) || pre.getAttribute('data-ggh-processed') === 'true') {
      return;
    }
    processedSet.add(pre);
    pre.setAttribute('data-ggh-processed', 'true');

    const codeEl = pre.querySelector('code') || pre;
    const codeText = (codeEl.textContent || '').trim();
    if (codeText.length < 15) return;

    // Button/header lookups stay inside this code block so a sibling header is never claimed.
    const scope =
      (pre.closest('code-block') as HTMLElement | null) || pre.parentElement || pre;
    if (scope.querySelector('.ggb-inline-btn')) return;

    let harvested: HarvestedPatch | null = null;

    // Check for V2 JSON payload first
    const v2Payload = parseV2PatchPayloadFromCode(codeText);
    if (v2Payload) {
      harvested = {
        id: createStablePatchId('v2_json', v2Payload),
        mode: 'v2_json',
        commitMessage: v2Payload.commitMessage,
        payload: v2Payload,
        timestamp: new Date().toLocaleTimeString(),
      };
    } else {
      // Check for legacy diff or file (require diff markers or an explicit path hint so prose blocks are ignored)
      const detectedPath = extractPathFromCode(codeText, pre);
      const converted = convertLegacyBlocksToV2Payload(codeText, detectedPath || undefined);
      if (converted && (isSearchReplace(codeText) || Boolean(detectedPath))) {
        const legacyMode: HarvestedPatch['mode'] = isSearchReplace(codeText)
          ? 'v1_search_replace'
          : 'v2_json';
        harvested = {
          id: createStablePatchId(legacyMode, converted.payload),
          mode: legacyMode,
          commitMessage: converted.payload.commitMessage,
          payload: converted.payload,
          legacyPayload: converted.legacyPayload,
          timestamp: new Date().toLocaleTimeString(),
        };
      }
    }

    if (!harvested) return;
    const currentPatch = harvested;

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
      refreshPatchPathFromDom(currentPatch, codeText, pre);
      onInlineApply(currentPatch);
    };

    const codeHeader = Array.from(
      scope.querySelectorAll('.code-block-decoration, .code-header, [class*="header"]')
    ).find((el) => !pre.contains(el));

    if (codeHeader) {
      if (codeHeader.querySelector('.ggb-inline-btn')) return;
      codeHeader.appendChild(btn);
    } else {
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
    refreshPendingPathFills();
    const blocks = document.querySelectorAll<HTMLElement>(
      'code-block:not([data-ggh-processed]), pre:not([data-ggh-processed])'
    );
    blocks.forEach((el) => {
      if (el.tagName.toLowerCase() === 'pre' && el.closest('code-block')) {
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
