// ==UserScript==
// @name         Gemini Git Bridge
// @namespace    https://gemini-git-bridge.sikanda.workers.dev/
// @version      1.0.0
// @description  Commit code & search/replace patches directly from Google Gemini & AI Studio to GitHub via Cloudflare Worker
// @author       Antigravity
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      gemini-git-bridge.sikanda.workers.dev
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // --- Deployed Bridge Configuration ---
  const BRIDGE_WORKER_URL = 'https://gemini-git-bridge.sikanda.workers.dev';
  const BRIDGE_SECRET = 'fc1bec3f781b59dee2e576650460f417269fd44d3b0e39d77ae18480c270524f';

  // --- Storage Helpers ---
  function getStored(key, defaultValue) {
    if (typeof GM_getValue === 'function') {
      return GM_getValue(key, defaultValue);
    }
    return localStorage.getItem('gemini_bridge_' + key) || defaultValue;
  }

  function setStored(key, value) {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, value);
    } else {
      localStorage.setItem('gemini_bridge_' + key, value);
    }
  }

  let defaultOwnerRepo = getStored('owner_repo', 'alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0');
  let defaultBranch = getStored('branch', 'preview');

  // --- Styles ---
  const STYLES = `
    .ggb-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      background: linear-gradient(135deg, #1e293b, #0f172a);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 8px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      transition: all 0.2s ease;
      user-select: none;
      z-index: 10;
    }
    .ggb-btn:hover {
      background: linear-gradient(135deg, #0284c7, #0369a1);
      color: #ffffff;
      border-color: #38bdf8;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(2, 132, 199, 0.4);
    }
    .ggb-float-trigger {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 10px 18px;
      background: #0f172a;
      color: #38bdf8;
      border: 1px solid #38bdf8;
      border-radius: 24px;
      font-size: 13px;
      font-weight: 700;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      z-index: 999999;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .ggb-float-trigger:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 24px rgba(56, 189, 248, 0.4);
    }
    .ggb-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000000;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    .ggb-modal {
      background: #0f172a;
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 16px;
      width: 580px;
      max-width: 92vw;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
      color: #f1f5f9;
      overflow: hidden;
      animation: ggb-fadein 0.2s ease-out;
    }
    @keyframes ggb-fadein {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    .ggb-modal-header {
      padding: 16px 20px;
      background: #1e293b;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .ggb-modal-header h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: #38bdf8;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ggb-close-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 18px;
      cursor: pointer;
      line-height: 1;
      padding: 4px;
    }
    .ggb-close-btn:hover { color: #ffffff; }
    .ggb-modal-body {
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .ggb-form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ggb-form-group label {
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ggb-input, .ggb-textarea {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 9px 12px;
      color: #f8fafc;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    .ggb-input:focus, .ggb-textarea:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
    }
    .ggb-file-pill {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 8px 12px;
      font-family: monospace;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #cbd5e1;
    }
    .ggb-status {
      font-size: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      display: none;
    }
    .ggb-status.info { display: block; background: #0c4a6e; color: #7dd3fc; border: 1px solid #0284c7; }
    .ggb-status.success { display: block; background: #064e3b; color: #6ee7b7; border: 1px solid #059669; }
    .ggb-status.error { display: block; background: #7f1d1d; color: #fca5a5; border: 1px solid #dc2626; }
    .ggb-modal-footer {
      padding: 14px 20px;
      background: #1e293b;
      border-top: 1px solid rgba(255,255,255,0.08);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;
  document.head.appendChild(styleEl);

  // --- Network Request to Cloudflare Worker Relay ---
  async function sendCommitToBridge(payload) {
    return new Promise((resolve, reject) => {
      const url = `${BRIDGE_WORKER_URL}/commit`;

      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST',
          url: url,
          headers: {
            'Content-Type': 'application/json',
            'x-bridge-secret': BRIDGE_SECRET
          },
          data: JSON.stringify(payload),
          onload: function (res) {
            try {
              const data = JSON.parse(res.responseText);
              if (res.status >= 200 && res.status < 300 && data.success) {
                resolve(data);
              } else {
                reject(new Error(data.error || `HTTP ${res.status}: ${res.responseText}`));
              }
            } catch (e) {
              reject(new Error(`Failed to parse response: ${res.responseText}`));
            }
          },
          onerror: function (err) {
            reject(new Error('Network error calling Cloudflare Worker Bridge'));
          }
        });
      } else {
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bridge-secret': BRIDGE_SECRET
          },
          body: JSON.stringify(payload)
        })
          .then((res) => res.json())
          .then((data) => {
            if (data.success) resolve(data);
            else reject(new Error(data.error || 'Commit failed'));
          })
          .catch(reject);
      }
    });
  }

  // --- Path & Patch Extraction Helpers ---
  function extractPathFromCode(codeText, preElement) {
    // 1. Look for inline comments: // filepath: ... or // path: ...
    const inlineMatch = codeText.match(/(?:\/\/|#|\/\*)\s*(?:filepath|file|path):\s*([^\r\n*]+)/i);
    if (inlineMatch) return inlineMatch[1].trim();

    // 2. Look for filename header right above the code block
    if (preElement) {
      let prev = preElement.previousElementSibling;
      for (let i = 0; i < 3 && prev; i++) {
        const text = prev.textContent.trim();
        const headerMatch = text.match(/(?:File|Pfad|Datei)?:\s*([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/i);
        if (headerMatch) return headerMatch[1].trim();
        if (/^[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+$/.test(text)) return text;
        prev = prev.previousElementSibling;
      }
    }

    return '';
  }

  function isSearchReplace(text) {
    return text.includes('<<<<<<<') && text.includes('=======');
  }

  // --- Commit Dialog UI ---
  function openCommitDialog(initialFiles, suggestedMessage = '') {
    const existing = document.querySelector('.ggb-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'ggb-modal-overlay';

    const defaultMsg = suggestedMessage || 'feat: update files via Gemini Git Bridge';

    overlay.innerHTML = `
      <div class="ggb-modal">
        <div class="ggb-modal-header">
          <h3>⚡ Gemini Git Bridge</h3>
          <button class="ggb-close-btn">&times;</button>
        </div>
        <div class="ggb-modal-body">
          <div class="ggb-form-group">
            <label>GitHub Repository (owner/repo)</label>
            <input type="text" class="ggb-input" id="ggb-repo" value="${defaultOwnerRepo}" placeholder="owner/repository" />
          </div>
          <div class="ggb-form-group">
            <label>Target Branch</label>
            <input type="text" class="ggb-input" id="ggb-branch" value="${defaultBranch}" placeholder="main" />
          </div>
          <div class="ggb-form-group">
            <label>Commit Message</label>
            <textarea class="ggb-textarea" id="ggb-msg" rows="2">${defaultMsg}</textarea>
          </div>
          <div class="ggb-form-group">
            <label>Dateien (${initialFiles.length})</label>
            <div id="ggb-files-list" style="display:flex; flex-direction:column; gap:6px;"></div>
          </div>
          <div class="ggb-status" id="ggb-status"></div>
        </div>
        <div class="ggb-modal-footer">
          <button class="ggb-btn" id="ggb-cancel-btn" style="background:transparent; color:#94a3b8; border-color:#334155;">Abbrechen</button>
          <button class="ggb-btn" id="ggb-commit-btn" style="padding: 7px 18px; font-size:13px;">🚀 Auf GitHub committen</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const filesList = overlay.querySelector('#ggb-files-list');
    const repoInput = overlay.querySelector('#ggb-repo');
    const branchInput = overlay.querySelector('#ggb-branch');
    const msgInput = overlay.querySelector('#ggb-msg');
    const statusBox = overlay.querySelector('#ggb-status');
    const commitBtn = overlay.querySelector('#ggb-commit-btn');
    const cancelBtn = overlay.querySelector('#ggb-cancel-btn');
    const closeBtn = overlay.querySelector('.ggb-close-btn');

    // Populate file list with editable paths
    const fileEntries = initialFiles.map((file, idx) => {
      const container = document.createElement('div');
      container.className = 'ggb-file-pill';
      const typeBadge = isSearchReplace(file.content || file.diff || '')
        ? '<span style="color:#f59e0b; font-size:11px;">[Search/Replace Patch]</span>'
        : '<span style="color:#10b981; font-size:11px;">[Vollständige Datei]</span>';

      container.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; flex:1;">
          <span>📄</span>
          <input type="text" class="ggb-input" style="padding:4px 8px; font-size:12px; flex:1;" value="${file.path}" placeholder="pfad/zur/datei.ts" id="ggb-path-${idx}" />
          ${typeBadge}
        </div>
      `;
      filesList.appendChild(container);
      return { ...file, idx };
    });

    const close = () => overlay.remove();
    closeBtn.onclick = close;
    cancelBtn.onclick = close;

    commitBtn.onclick = async () => {
      const ownerRepo = repoInput.value.trim();
      const branch = branchInput.value.trim();
      const message = msgInput.value.trim();

      const [owner, repo] = ownerRepo.split('/');
      if (!owner || !repo) {
        statusBox.className = 'ggb-status error';
        statusBox.textContent = 'Fehler: Bitte Repository als "owner/repo" angeben (z.B. alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0).';
        return;
      }

      setStored('owner_repo', ownerRepo);
      setStored('branch', branch);

      const filesToCommit = fileEntries.map((fe) => {
        const pathEl = overlay.querySelector(`#ggb-path-${fe.idx}`);
        const finalPath = pathEl ? pathEl.value.trim() : fe.path;
        return {
          path: finalPath,
          content: fe.content,
          diff: fe.diff
        };
      });

      if (filesToCommit.some((f) => !f.path)) {
        statusBox.className = 'ggb-status error';
        statusBox.textContent = 'Fehler: Alle Dateien müssen einen gültigen Zielpfad haben!';
        return;
      }

      commitBtn.disabled = true;
      commitBtn.style.opacity = '0.5';
      statusBox.className = 'ggb-status info';
      statusBox.innerHTML = `⏳ Sende Commit an Cloudflare Worker Relay... (${filesToCommit.length} Datei(en))`;

      try {
        const payload = {
          owner,
          repo,
          branch,
          message,
          files: filesToCommit
        };

        const result = await sendCommitToBridge(payload);

        statusBox.className = 'ggb-status success';
        statusBox.innerHTML = `
          ✅ <strong>Commit erfolgreich!</strong><br/>
          OID: <code style="color:#fff;">${result.commit.oid.slice(0, 7)}</code> auf Branch <code style="color:#fff;">${result.branch}</code><br/>
          <a href="${result.commit.url}" target="_blank" style="color:#38bdf8; text-decoration:underline; font-weight:600; display:inline-block; margin-top:4px;">
            🔗 Commit auf GitHub ansehen &rarr;
          </a>
        `;
        commitBtn.textContent = 'Erledigt';
      } catch (err) {
        statusBox.className = 'ggb-status error';
        statusBox.innerHTML = `❌ <strong>Fehler beim Commit:</strong><br/>${err.message}`;
        commitBtn.disabled = false;
        commitBtn.style.opacity = '1';
      }
    };
  }

  // --- Attach Action Buttons to Code Blocks in Gemini UI ---
  function enhanceCodeBlocks() {
    const codeBlocks = document.querySelectorAll('pre:not([data-ggb-processed])');

    codeBlocks.forEach((pre) => {
      pre.setAttribute('data-ggb-processed', 'true');

      const codeEl = pre.querySelector('code');
      const codeText = (codeEl ? codeEl.innerText : pre.innerText) || '';

      // Only attach if code block has enough content
      if (codeText.length < 15) return;

      const detectedPath = extractPathFromCode(codeText, pre);
      const isPatch = isSearchReplace(codeText);

      const btn = document.createElement('button');
      btn.className = 'ggb-btn';
      btn.style.margin = '6px';
      btn.innerHTML = isPatch ? '⚡ Git Patch committen' : '🚀 Zu GitHub pushen';

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const fileObj = {
          path: detectedPath || 'src/datei.ts',
          content: isPatch ? undefined : codeText,
          diff: isPatch ? codeText : undefined
        };

        openCommitDialog([fileObj], isPatch ? 'refactor: apply search/replace patch' : 'feat: add / update file');
      };

      // Find code header or prepend to pre
      const codeHeader = pre.parentElement?.querySelector('.code-block-decoration, .code-header, [class*="header"]');
      if (codeHeader) {
        codeHeader.appendChild(btn);
      } else {
        pre.style.position = 'relative';
        btn.style.position = 'absolute';
        btn.style.top = '8px';
        btn.style.right = '40px';
        pre.appendChild(btn);
      }
    });
  }

  // --- Floating Button to Scan Whole Chat for Patches ---
  function createFloatingTrigger() {
    if (document.querySelector('.ggb-float-trigger')) return;

    const trigger = document.createElement('div');
    trigger.className = 'ggb-float-trigger';
    trigger.innerHTML = '<span>⚡</span> <span>Git Bridge</span>';

    trigger.onclick = () => {
      // Find all code blocks in the current view
      const blocks = Array.from(document.querySelectorAll('pre code, pre'));
      const files = [];

      blocks.forEach((el) => {
        const text = el.innerText || '';
        const path = extractPathFromCode(text, el.closest('pre'));
        if (path) {
          files.push({
            path,
            content: isSearchReplace(text) ? undefined : text,
            diff: isSearchReplace(text) ? text : undefined
          });
        }
      });

      if (files.length === 0) {
        openCommitDialog([{ path: 'src/file.ts', content: '' }], 'chore: update via Gemini Git Bridge');
      } else {
        openCommitDialog(files, `feat: commit ${files.length} file(s) from Gemini chat`);
      }
    };

    document.body.appendChild(trigger);
  }

  // --- Observer for Dynamic DOM updates in Gemini ---
  const observer = new MutationObserver(() => {
    enhanceCodeBlocks();
    createFloatingTrigger();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial run
  enhanceCodeBlocks();
  createFloatingTrigger();
  console.log('[Gemini Git Bridge] Loaded. Connected to:', BRIDGE_WORKER_URL);
})();
