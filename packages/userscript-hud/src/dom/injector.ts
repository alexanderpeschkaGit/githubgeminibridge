/**
 * DOM-Injector for Google Gemini and Google AI Studio
 */

export function findPromptInputElement(): HTMLElement | HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;

  // 1. Gemini Web (gemini.google.com)
  const geminiSelectors = [
    'rich-textarea div[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
  ];

  for (const sel of geminiSelectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.offsetParent !== null) {
      return el;
    }
  }

  // 2. Google AI Studio (aistudio.google.com)
  const aiStudioSelectors = [
    'ms-autosize-textarea textarea',
    'textarea[aria-label*="prompt" i]',
    'textarea[placeholder*="prompt" i]',
    'textarea.prompt-textarea',
    'textarea',
  ];

  for (const sel of aiStudioSelectors) {
    const el = document.querySelector<HTMLTextAreaElement>(sel);
    if (el && el.offsetParent !== null) {
      return el;
    }
  }

  // 3. Fallback
  return document.querySelector<HTMLElement>('textarea, div[contenteditable="true"]');
}

export interface MixFileItem {
  fileName: string;
  xmlContent: string;
}

/**
 * Injects multiple repo-mix parts as a virtual file paste into the chat prompt area.
 */
export function injectRepoMixParts(parts: MixFileItem[]): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (!parts || parts.length === 0) return false;

  const inputEl = findPromptInputElement();
  const target = inputEl || document.activeElement || document.body;

  try {
    const dataTransfer = new DataTransfer();
    for (const part of parts) {
      const file = new File([part.xmlContent], part.fileName, { type: 'text/plain' });
      dataTransfer.items.add(file);
    }

    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true,
    });

    target.dispatchEvent(pasteEvent);
    return true;
  } catch (err) {
    console.error('[Gemini Bridge Injector] Failed to inject repo mix parts:', err);
    return false;
  }
}

/**
 * Injects repo-mix.txt as a virtual file paste into the chat prompt area.
 */
export function injectRepoMixFile(xmlContent: string, fileName = 'repo-mix.txt'): boolean {
  return injectRepoMixParts([{ fileName, xmlContent }]);
}

/**
 * Focuses the prompt input, types promptText and optionally clicks the send/run button.
 */
export function injectPromptText(promptText: string, autoSubmit = false): boolean {
  if (typeof document === 'undefined') return false;

  const inputEl = findPromptInputElement();
  if (!inputEl) {
    console.warn('[Gemini Bridge Injector] Prompt input element not found');
    return false;
  }

  inputEl.focus();

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, promptText);
  } catch (e) {
    inserted = false;
  }

  if (!inserted) {
    if (inputEl instanceof HTMLTextAreaElement || 'value' in inputEl) {
      const textarea = inputEl as HTMLTextAreaElement;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      textarea.value = textarea.value.slice(0, start) + promptText + textarea.value.slice(end);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      inputEl.textContent = (inputEl.textContent || '') + promptText;
      inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
    }
  }

  if (autoSubmit) {
    setTimeout(() => {
      const sendButtonSelectors = [
        'button.send-button',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Senden" i]',
        'button[aria-label*="Run" i]',
        'ms-run-button button',
        'button.run-button',
      ];

      for (const sel of sendButtonSelectors) {
        const btn = document.querySelector<HTMLButtonElement>(sel);
        if (btn && !btn.disabled) {
          btn.click();
          break;
        }
      }
    }, 300);
  }

  return true;
}
