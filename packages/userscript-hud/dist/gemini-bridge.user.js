// ==UserScript==
// @name         Gemini Git Bridge & Shadow-DOM HUD
// @namespace    https://gemini-git-bridge.sikanda.workers.dev/
// @version      2.0.11
// @description  Commit code & search/replace patches directly from Google Gemini & AI Studio to GitHub via Cloudflare Worker (Shadow-DOM HUD)
// @author       Antigravity
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @noframes
// @connect      gemini-git-bridge.sikanda.workers.dev
// @connect      *.workers.dev
// @connect      raw.githubusercontent.com
// @downloadURL  https://raw.githubusercontent.com/alexanderpeschkaGit/githubgeminibridge/main/gemini-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/alexanderpeschkaGit/githubgeminibridge/main/gemini-bridge.user.js
// @run-at       document-idle
// ==/UserScript==

// --- Trusted Types (TrustedHTML) compatibility for Google Gemini & AI Studio ---
if (typeof window !== 'undefined' && window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
  try {
    window.trustedTypes.createPolicy('default', {
      createHTML: (string) => string,
      createScript: (string) => string,
      createScriptURL: (string) => string,
    });
  } catch (e) {
    try {
      window.trustedTypes.createPolicy('geminiBridgePolicy', {
        createHTML: (string) => string,
      });
    } catch (e2) {
      // Ignored if policy already exists
    }
  }
}

"use strict";
(() => {
  // packages/userscript-hud/src/services/storage.ts
  var PAT_REGEX = /(?:ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{30,}|gho_[a-zA-Z0-9]{20,}|ghs_[a-zA-Z0-9]{20,})/;
  function sanitizeNoGithubPat(value, fieldName = "value") {
    if (!value) return "";
    if (PAT_REGEX.test(value)) {
      throw new Error(
        `[Security Guardrail] Storing a GitHub Personal Access Token in browser storage (${fieldName}) is strictly forbidden!`
      );
    }
    return value.trim();
  }
  function getStoredValue(key, defaultValue = "") {
    try {
      if (typeof GM_getValue === "function") {
        const val = GM_getValue(key);
        if (val !== void 0 && val !== null && val !== "") {
          return sanitizeNoGithubPat(String(val), key);
        }
      }
    } catch (err) {
      console.warn(`[Gemini Bridge Storage] GM_getValue error for ${key}:`, err);
    }
    try {
      if (typeof localStorage !== "undefined") {
        const local = localStorage.getItem("gemini_bridge_" + key);
        if (local !== null && local !== void 0 && local !== "") {
          return sanitizeNoGithubPat(local, key);
        }
      }
    } catch (err) {
      console.warn(`[Gemini Bridge Storage] localStorage.getItem error for ${key}:`, err);
    }
    return defaultValue;
  }
  function sanitizeRepo(repoStr) {
    let cleaned = (repoStr || "").trim();
    cleaned = cleaned.replace(/^https?:\/\/github\.com\//i, "");
    cleaned = cleaned.replace(/^git@github\.com:/i, "");
    cleaned = cleaned.replace(/https?:?$/i, "");
    cleaned = cleaned.replace(/\/+$/, "");
    return cleaned.trim();
  }
  function setStoredValue(key, value) {
    const safeVal = sanitizeNoGithubPat(value, key);
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, safeVal);
      }
    } catch (err) {
      console.warn(`[Gemini Bridge Storage] GM_setValue error for ${key}:`, err);
    }
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("gemini_bridge_" + key, safeVal);
      }
    } catch (err) {
      console.warn(`[Gemini Bridge Storage] localStorage.setItem error for ${key}:`, err);
    }
  }
  var DEFAULT_HUD_CONFIG = {
    workerUrl: "https://gemini-git-bridge.sikanda.workers.dev",
    // No bundled credential: the WORKER_SECRET is entered once in the HUD panel and kept
    // in GM storage. Shipping it in the userscript would publish it with every release.
    workerSecret: "",
    repo: "alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0",
    branch: "preview",
    targetBranch: "",
    includePaths: [],
    autoPilot: false,
    persistToGitHub: false,
    maxChunkChars: 85e3,
    includeRecentCommits: false
  };
  var RECENT_COMMITS_MIGRATION_KEY = "recent_commits_opt_in_migration_v1";
  function migrateRecentCommitsOptIn() {
    if (getStoredValue(RECENT_COMMITS_MIGRATION_KEY, "") === "true") {
      return;
    }
    if (getStoredValue("include_recent_commits", "") === "true") {
      setStoredValue("include_recent_commits", "false");
      if (getStoredValue("include_recent_commits", "") === "true") {
        console.warn(
          "[Gemini Bridge Storage] Could not migrate legacy include_recent_commits=true to false; retrying on next load."
        );
        return;
      }
    }
    setStoredValue(RECENT_COMMITS_MIGRATION_KEY, "true");
    if (getStoredValue(RECENT_COMMITS_MIGRATION_KEY, "") !== "true") {
      console.warn(
        "[Gemini Bridge Storage] Could not persist the recent-commits migration marker; migration will retry on next load."
      );
    }
  }
  function loadHudConfig() {
    migrateRecentCommitsOptIn();
    const workerUrl = getStoredValue("worker_url", DEFAULT_HUD_CONFIG.workerUrl);
    const workerSecret = getStoredValue("worker_secret", DEFAULT_HUD_CONFIG.workerSecret);
    const repo = sanitizeRepo(getStoredValue("owner_repo", DEFAULT_HUD_CONFIG.repo));
    const branch = getStoredValue("branch", DEFAULT_HUD_CONFIG.branch);
    const targetBranch = getStoredValue("target_branch", DEFAULT_HUD_CONFIG.targetBranch || "");
    const autoPilotStr = getStoredValue("auto_pilot", "false");
    const persistStr = getStoredValue("persist_to_github", "false");
    const includePathsStr = getStoredValue("include_paths", "");
    const includeRecentCommitsStr = getStoredValue("include_recent_commits", "false");
    let includePaths = [];
    if (includePathsStr) {
      try {
        includePaths = JSON.parse(includePathsStr);
        if (!Array.isArray(includePaths)) includePaths = [];
      } catch {
        includePaths = includePathsStr.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }
    const maxChunkCharsStr = getStoredValue("max_chunk_chars", "85000");
    const parsedChars = parseInt(maxChunkCharsStr, 10);
    const maxChunkChars = Number.isFinite(parsedChars) && parsedChars >= 1e4 && parsedChars <= 2e6 ? parsedChars : 85e3;
    return {
      workerUrl: workerUrl.replace(/\/+$/, ""),
      workerSecret,
      repo,
      branch,
      targetBranch,
      includePaths,
      autoPilot: autoPilotStr === "true",
      persistToGitHub: persistStr === "true",
      maxChunkChars,
      includeRecentCommits: includeRecentCommitsStr === "true"
    };
  }
  function saveHudConfig(cfg) {
    const current = loadHudConfig();
    const updated = { ...current, ...cfg };
    if (cfg.workerUrl !== void 0) {
      setStoredValue("worker_url", sanitizeNoGithubPat(updated.workerUrl, "workerUrl"));
    }
    if (cfg.workerSecret !== void 0) {
      setStoredValue("worker_secret", sanitizeNoGithubPat(updated.workerSecret, "workerSecret"));
    }
    if (cfg.repo !== void 0) {
      setStoredValue("owner_repo", sanitizeRepo(sanitizeNoGithubPat(updated.repo, "repo")));
    }
    if (cfg.branch !== void 0) {
      setStoredValue("branch", sanitizeNoGithubPat(updated.branch, "branch"));
    }
    if (cfg.targetBranch !== void 0) {
      setStoredValue("target_branch", sanitizeNoGithubPat(updated.targetBranch || "", "targetBranch"));
    }
    if (cfg.autoPilot !== void 0) {
      setStoredValue("auto_pilot", updated.autoPilot ? "true" : "false");
    }
    if (cfg.persistToGitHub !== void 0) {
      setStoredValue("persist_to_github", updated.persistToGitHub ? "true" : "false");
    }
    if (cfg.includePaths !== void 0) {
      setStoredValue("include_paths", JSON.stringify(updated.includePaths));
    }
    if (cfg.maxChunkChars !== void 0) {
      setStoredValue("max_chunk_chars", String(updated.maxChunkChars));
    }
    if (cfg.includeRecentCommits !== void 0) {
      setStoredValue("include_recent_commits", updated.includeRecentCommits ? "true" : "false");
    }
    return updated;
  }

  // packages/userscript-hud/src/services/workerClient.ts
  async function gmRequestJson(url, method, secret, body) {
    const headers = {
      "Accept": "application/json",
      "Authorization": `Bearer ${secret}`,
      "x-bridge-secret": secret
    };
    let payloadString;
    if (body !== void 0) {
      headers["Content-Type"] = "application/json";
      payloadString = typeof body === "string" ? body : JSON.stringify(body);
    }
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data: payloadString,
          onload: (res) => {
            try {
              const data = JSON.parse(res.responseText);
              if (res.status >= 200 && res.status < 300) {
                resolve(data);
              } else {
                const errMsg = data?.error || data?.errorMessage || `HTTP ${res.status}: ${res.responseText}`;
                reject(new Error(errMsg));
              }
            } catch (err) {
              if (res.status >= 200 && res.status < 300) {
                resolve(res.responseText);
              } else {
                reject(new Error(`HTTP ${res.status}: ${res.responseText}`));
              }
            }
          },
          onerror: (err) => {
            reject(new Error(`Network error calling Cloudflare Worker: ${err?.statusText || err || "Unknown error"}`));
          },
          ontimeout: () => {
            reject(new Error("Request to Cloudflare Worker timed out"));
          }
        });
      });
    }
    if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
      const res = await GM.xmlHttpRequest({
        method,
        url,
        headers,
        data: payloadString
      });
      try {
        const data = JSON.parse(res.responseText);
        if (res.status >= 200 && res.status < 300) {
          return data;
        }
        throw new Error(data?.error || data?.errorMessage || `HTTP ${res.status}: ${res.responseText}`);
      } catch (e) {
        if (res.status >= 200 && res.status < 300) {
          return res.responseText;
        }
        throw e;
      }
    }
    if (typeof fetch === "function") {
      const res = await fetch(url, {
        method,
        headers,
        body: payloadString
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (res.ok) {
        return data;
      }
      throw new Error(data?.error || data?.errorMessage || `HTTP ${res.status}: ${text}`);
    }
    throw new Error("No supported HTTP client found (GM_xmlhttpRequest, GM.xmlHttpRequest, or fetch)");
  }
  async function checkWorkerHealth(cfg) {
    const url = `${cfg.workerUrl}/health`;
    return gmRequestJson(url, "GET", cfg.workerSecret);
  }
  async function requestRepoMix(cfg, req) {
    const url = `${cfg.workerUrl}/api/mix`;
    const payload = {
      repo: req?.repo || cfg.repo,
      branch: req?.branch || cfg.branch,
      includePaths: req?.includePaths || (cfg.includePaths.length > 0 ? cfg.includePaths : void 0),
      persistToGitHub: req?.persistToGitHub ?? cfg.persistToGitHub,
      maxChunkChars: req?.maxChunkChars ?? cfg.maxChunkChars,
      maxChunkBytes: req?.maxChunkBytes,
      maxChunkTokens: req?.maxChunkTokens,
      splitOutput: req?.splitOutput,
      includeRecentCommits: req?.includeRecentCommits ?? cfg.includeRecentCommits
    };
    return gmRequestJson(url, "POST", cfg.workerSecret, payload);
  }
  async function requestWorkerPatch(cfg, req) {
    const url = `${cfg.workerUrl}/api/patch`;
    return gmRequestJson(url, "POST", cfg.workerSecret, req);
  }
  var OID_REGEX = /^[0-9a-f]{40}$/i;
  function parseRepoSlug(repo) {
    const cleaned = (repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    const parts = cleaned.split("/").filter(Boolean);
    if (parts.length !== 2) {
      throw new Error(`Invalid repository "${repo}": expected "owner/name".`);
    }
    return { owner: parts[0], name: parts[1] };
  }
  function buildBranchHeadRequestBody(repo, branch) {
    const { owner, name } = parseRepoSlug(repo);
    const branchName = (branch || "").trim().replace(/^refs\/heads\//, "");
    if (!branchName) {
      throw new Error("Cannot resolve a HEAD OID without a branch name.");
    }
    return {
      query: "query BranchHead($owner: String!, $repo: String!, $branch: String!) { repository(owner: $owner, name: $repo) { ref(qualifiedName: $branch) { target { oid } } } }",
      variables: { owner, repo: name, branch: `refs/heads/${branchName}` }
    };
  }
  function extractBranchHeadOid(payload) {
    const oid = payload?.data?.repository?.ref?.target?.oid;
    return OID_REGEX.test(String(oid || "")) ? String(oid) : "";
  }
  async function requestBranchHead(cfg, repo, branch) {
    const body = buildBranchHeadRequestBody(repo, branch);
    const payload = await gmRequestJson(
      `${cfg.workerUrl}/graphql`,
      "POST",
      cfg.workerSecret,
      body
    );
    const oid = extractBranchHeadOid(payload);
    if (!oid) {
      throw new Error(`Branch "${body.variables.branch}" was not found in ${body.variables.owner}/${body.variables.repo}.`);
    }
    return oid;
  }
  async function requestLegacyCommit(cfg, req) {
    const url = `${cfg.workerUrl}/push`;
    return gmRequestJson(url, "POST", cfg.workerSecret, req);
  }

  // packages/userscript-hud/src/dom/injector.ts
  function findPromptInputElement() {
    if (typeof document === "undefined") return null;
    const geminiSelectors = [
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ];
    for (const sel of geminiSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return el;
      }
    }
    const aiStudioSelectors = [
      "ms-autosize-textarea textarea",
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="prompt" i]',
      "textarea.prompt-textarea",
      "textarea"
    ];
    for (const sel of aiStudioSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return el;
      }
    }
    return document.querySelector('textarea, div[contenteditable="true"]');
  }
  function injectRepoMixParts(parts) {
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    if (!parts || parts.length === 0) return false;
    const inputEl = findPromptInputElement();
    const target = inputEl || document.activeElement || document.body;
    try {
      const dataTransfer = new DataTransfer();
      for (const part of parts) {
        const file = new File([part.xmlContent], part.fileName, { type: "text/plain" });
        dataTransfer.items.add(file);
      }
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true
      });
      target.dispatchEvent(pasteEvent);
      return true;
    } catch (err) {
      console.error("[Gemini Bridge Injector] Failed to inject repo mix parts:", err);
      return false;
    }
  }
  function injectRepoMixFile(xmlContent, fileName = "repo-mix.txt") {
    return injectRepoMixParts([{ fileName, xmlContent }]);
  }
  function injectPromptText(promptText, autoSubmit = false) {
    if (typeof document === "undefined") return false;
    const inputEl = findPromptInputElement();
    if (!inputEl) {
      console.warn("[Gemini Bridge Injector] Prompt input element not found");
      return false;
    }
    inputEl.focus();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, promptText);
    } catch (e) {
      inserted = false;
    }
    if (!inserted) {
      if (inputEl instanceof HTMLTextAreaElement || "value" in inputEl) {
        const textarea = inputEl;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        textarea.value = textarea.value.slice(0, start) + promptText + textarea.value.slice(end);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        inputEl.textContent = (inputEl.textContent || "") + promptText;
        inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: promptText }));
      }
    }
    if (autoSubmit) {
      setTimeout(() => {
        const sendButtonSelectors = [
          "button.send-button",
          'button[aria-label*="Send" i]',
          'button[aria-label*="Senden" i]',
          'button[aria-label*="Run" i]',
          "ms-run-button button",
          "button.run-button"
        ];
        for (const sel of sendButtonSelectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled) {
            btn.click();
            break;
          }
        }
      }, 300);
    }
    return true;
  }

  // packages/userscript-hud/src/services/selfHealing.ts
  var MAX_SELF_HEALING_RETRIES = 3;
  function buildSelfHealingPrompt(errors, repo, branch, headOid, retryAttempt) {
    const formattedErrors = errors.map((err, idx) => {
      const loc = err.line ? err.column ? `:${err.line}:${err.column}` : `:${err.line}` : "";
      const snippet = err.codeSnippet ? `
   > ${err.codeSnippet}` : "";
      return `${idx + 1}. [Stage: ${err.stage}] ${err.file}${loc} \u2014 ${err.message}${snippet}`;
    }).join("\n");
    return `#solve Linter & Preflight Self-Healing Loop (Retry ${retryAttempt}/${MAX_SELF_HEALING_RETRIES})

The previous patch for repository "${repo}" on branch "${branch}" was rejected during Edge-Worker preflight validation.
Expected HEAD commit: "${headOid}".

Aggregated Preflight Errors (${errors.length}):
${formattedErrors}

Fix Instructions:
1. Fix ALL listed syntax and rule errors in a single cohesive response.
2. Hard Guardrail: NEVER use placeholder comments like "// ... existing code ...", "/* remaining code */", or "# ... existing code ...". Always provide complete search/replace blocks or full file content.
3. Provide your correction as a single valid JSON codeblock matching the GeminiPatchPayload schema:
\`\`\`json
{
  "commitMessage": "fix: resolve preflight linter errors (retry ${retryAttempt})",
  "patches": [
    {
      "path": "path/to/file.ext",
      "action": "modify",
      "blocks": [
        {
          "search": "exact string to replace",
          "replace": "replacement string"
        }
      ]
    }
  ]
}
\`\`\`
`;
  }
  function shouldTriggerSelfHealing(response, autoPilot, currentRetryCount) {
    if (response.status === "COMMITTED") {
      return {
        trigger: false,
        nextRetryCount: 0,
        reason: "COMMITTED_SUCCESS"
      };
    }
    if (response.status !== "PREFLIGHT_FAILED") {
      return {
        trigger: false,
        nextRetryCount: currentRetryCount,
        reason: "STATUS_NOT_PREFLIGHT_FAILED"
      };
    }
    if (!Array.isArray(response.errors) || response.errors.length === 0) {
      return {
        trigger: false,
        nextRetryCount: currentRetryCount,
        reason: "NO_ERRORS_REPORTED"
      };
    }
    if (currentRetryCount >= MAX_SELF_HEALING_RETRIES) {
      return {
        trigger: false,
        nextRetryCount: currentRetryCount,
        reason: "MAX_RETRIES_EXCEEDED"
      };
    }
    if (!autoPilot) {
      return {
        trigger: false,
        nextRetryCount: currentRetryCount,
        reason: "AUTOPILOT_DISABLED"
      };
    }
    return {
      trigger: true,
      nextRetryCount: currentRetryCount + 1,
      reason: "PREFLIGHT_FAILED_AUTO_RETRY"
    };
  }
  function executeSelfHealingTurn(response, cfg, state, autoSubmit = true) {
    const evalResult = shouldTriggerSelfHealing(response, cfg.autoPilot, state.retryCount);
    if (!evalResult.trigger) {
      return {
        triggered: false,
        nextRetryCount: evalResult.nextRetryCount,
        reason: evalResult.reason
      };
    }
    const prompt = buildSelfHealingPrompt(
      response.errors || [],
      cfg.repo,
      cfg.branch,
      state.headOid,
      evalResult.nextRetryCount
    );
    injectPromptText(prompt, autoSubmit);
    return {
      triggered: true,
      nextRetryCount: evalResult.nextRetryCount,
      prompt,
      reason: evalResult.reason
    };
  }

  // packages/userscript-hud/src/services/patchOidState.ts
  var OID_REGEX2 = /^[0-9a-f]{40}$/i;
  function normalizeBranch(branch) {
    return (branch || "").trim().replace(/^refs\/heads\//, "");
  }
  function buildOidScope(config) {
    return `${(config.repo || "").trim().toLowerCase()}#${normalizeBranch(config.branch).toLowerCase()}`;
  }
  function resolvePatchOidState(config, stored) {
    if ((stored.headOidScope || "") !== buildOidScope(config)) {
      return { headOid: "", targetHeadOid: "", targetHeadBranch: "" };
    }
    const configuredTarget = normalizeBranch(config.targetBranch || "");
    const storedTarget = normalizeBranch(stored.targetHeadBranch || "");
    const targetIsCurrent = !!configuredTarget && storedTarget === configuredTarget && OID_REGEX2.test(stored.targetHeadOid || "");
    return {
      headOid: OID_REGEX2.test(stored.headOid || "") ? stored.headOid : "",
      targetHeadOid: targetIsCurrent ? stored.targetHeadOid : "",
      targetHeadBranch: targetIsCurrent ? storedTarget : ""
    };
  }
  function buildWorkerPatchRequest(config, state, payload) {
    const targetBranch = config.targetBranch?.trim() || void 0;
    const isDistinctTarget = !!targetBranch && normalizeBranch(targetBranch) !== normalizeBranch(config.branch);
    const targetOidIsCurrent = isDistinctTarget && normalizeBranch(state.targetHeadBranch) === normalizeBranch(targetBranch) && OID_REGEX2.test(state.targetHeadOid);
    return {
      repo: config.repo,
      branch: config.branch,
      expectedHeadOid: state.headOid,
      payload,
      targetBranch,
      expectedTargetHeadOid: targetOidIsCurrent ? state.targetHeadOid || void 0 : void 0
    };
  }
  function isPatchSnapshotReady(state) {
    return OID_REGEX2.test(state.headOid || "");
  }
  function patchSnapshotRequiredMessage(config, commitMessage) {
    return `No repo mix snapshot for ${config.repo}@${config.branch}. Click "Load Repo Mix" first \u2014 patches are only committed against a validated HEAD OID. (Patch: "${commitMessage}")`;
  }
  function resolveConflictOidReset(response) {
    if (response.status !== "GIT_CONFLICT") return "none";
    return response.targetBranch ? "target" : "source";
  }
  function advancePatchOidState(config, response) {
    if (response.status !== "COMMITTED" && response.status !== "NO_CHANGES_NEEDED" || !response.newHeadOid) {
      return {};
    }
    const configuredTarget = config.targetBranch?.trim();
    const targetIsDistinct = !!configuredTarget && normalizeBranch(configuredTarget) !== normalizeBranch(config.branch);
    if (targetIsDistinct && !response.targetBranch) return {};
    const effectiveBranch = normalizeBranch(response.targetBranch || config.branch);
    if (effectiveBranch === normalizeBranch(config.branch)) {
      return { headOid: response.newHeadOid };
    }
    return {
      targetHeadOid: response.newHeadOid,
      targetHeadBranch: effectiveBranch
    };
  }

  // packages/userscript-hud/src/services/runtimeInfo.ts
  var INIT_FAILURE_ID = "gemini-edge-hud-init-error";
  function getRunningScriptVersion() {
    if (typeof GM_info === "undefined" || !GM_info || !GM_info.script) {
      return "";
    }
    return GM_info.script.version || GM_info.script.versionString || "";
  }
  function reportHudInitFailure(error) {
    console.error("[Gemini Edge HUD] Initialisation failed:", error);
    if (typeof document === "undefined" || !document.body) return;
    if (document.getElementById(INIT_FAILURE_ID)) return;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const version = getRunningScriptVersion();
    const box = document.createElement("div");
    box.id = INIT_FAILURE_ID;
    box.textContent = `\u26A1 Gemini Edge HUD${version ? ` v${version}` : ""} failed to initialise: ${message}`;
    box.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:460px",
      "padding:10px 14px",
      "border-radius:8px",
      "background:#7f1d1d",
      "color:#fff",
      "font:12px/1.5 system-ui,sans-serif",
      "box-shadow:0 6px 24px rgba(0,0,0,.45)",
      "white-space:pre-wrap"
    ].join(";");
    document.body.appendChild(box);
  }

  // packages/userscript-hud/src/services/patchOidStore.ts
  function loadPatchOidState(config) {
    return resolvePatchOidState(config, {
      headOidScope: getStoredValue("head_oid_scope", ""),
      headOid: getStoredValue("head_oid", ""),
      targetHeadOid: getStoredValue("target_head_oid", ""),
      targetHeadBranch: getStoredValue("target_head_branch", "")
    });
  }
  function setSourceHeadOid(config, state, oid) {
    state.headOid = oid;
    setStoredValue("head_oid", oid);
    setStoredValue("head_oid_scope", buildOidScope(config));
  }
  function clearPatchOidState(state) {
    state.headOid = "";
    setStoredValue("head_oid", "");
    setStoredValue("head_oid_scope", "");
    clearTargetOidState(state);
  }
  function clearTargetOidState(state) {
    state.targetHeadOid = "";
    state.targetHeadBranch = "";
    setStoredValue("target_head_oid", "");
    setStoredValue("target_head_branch", "");
  }
  function applyPatchResponseOids(config, state, response) {
    const updates = advancePatchOidState(config, response);
    if (updates.headOid) {
      setSourceHeadOid(config, state, updates.headOid);
    }
    if (updates.targetHeadOid) {
      const branch = updates.targetHeadBranch || "";
      state.targetHeadOid = updates.targetHeadOid;
      state.targetHeadBranch = branch;
      setStoredValue("target_head_oid", updates.targetHeadOid);
      setStoredValue("target_head_branch", branch);
    }
  }

  // packages/userscript-hud/src/services/patchIdentity.ts
  function canonicalize(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry));
    }
    if (value && typeof value === "object") {
      const record = value;
      const sorted = {};
      for (const key of Object.keys(record).sort()) {
        const entry = record[key];
        if (entry === void 0) continue;
        sorted[key] = canonicalize(entry);
      }
      return sorted;
    }
    return value;
  }
  function computePatchSignature(mode, payload) {
    return JSON.stringify([mode, payload.commitMessage, canonicalize(payload.patches)]);
  }
  function djb2Hash(input) {
    let hash = 5381;
    for (let index = 0; index < input.length; index++) {
      hash = hash * 33 ^ input.charCodeAt(index);
    }
    return hash >>> 0;
  }
  function createStablePatchId(mode, payload) {
    return "patch-" + djb2Hash(computePatchSignature(mode, payload)).toString(36);
  }

  // packages/userscript-hud/src/services/patchQueue.ts
  var MAX_QUEUED_PATCHES = 20;
  function isDuplicatePatch(queue, candidate) {
    const signature = computePatchSignature(candidate.mode, candidate.payload);
    return queue.some(
      (existing) => existing.id === candidate.id || computePatchSignature(existing.mode, existing.payload) === signature
    );
  }
  function enqueueHarvestedPatch(queue, patch) {
    if (isDuplicatePatch(queue, patch)) return queue;
    return [patch, ...queue].slice(0, MAX_QUEUED_PATCHES);
  }
  function removeHarvestedPatch(queue, patchId) {
    return queue.filter((entry) => entry.id !== patchId);
  }
  function fifoQueue(queue) {
    return [...queue].reverse();
  }
  async function runPatchQueue(queue, apply, onProgress) {
    const ordered = fifoQueue(queue);
    const total = ordered.length;
    let applied = 0;
    for (let index = 0; index < total; index++) {
      const patch = ordered[index];
      onProgress(patch, index, total);
      if (!await apply(patch)) return { applied, total };
      applied++;
    }
    return { applied, total };
  }

  // shared/repoPaths.ts
  function normalizeRepoPath(input) {
    return (input || "").trim().replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  }
  function findRepoPathIssue(input) {
    const raw = (input || "").trim();
    if (!raw) {
      return 'Patch has no file path. Add a "// filepath: <repo/relative/path>" hint above the code block.';
    }
    const normalized = normalizeRepoPath(raw);
    if (!normalized) {
      return `Patch path "${raw}" does not point to a file inside the repository.`;
    }
    if (/^[a-zA-Z]:\//.test(normalized)) {
      return `Patch path "${raw}" must be repo-relative (absolute drive paths are not allowed).`;
    }
    if (normalized.split("/").some((segment) => segment === ".." || segment === ".")) {
      return `Patch path "${raw}" must be repo-relative and must not contain "." or ".." segments.`;
    }
    return null;
  }

  // packages/userscript-hud/src/services/patchPaths.ts
  function resolvePatchPaths(payload, prompt) {
    const patches = (payload.patches || []).map((patch) => ({
      ...patch,
      path: normalizeRepoPath(patch.path)
    }));
    const missing = patches.filter((patch) => findRepoPathIssue(patch.path) !== null);
    for (let index = 0; index < missing.length; index++) {
      const answer = prompt(index + 1, missing.length);
      if (answer === null || answer === void 0) {
        return {
          payload,
          cancelled: true,
          reason: 'Patch cancelled \u2014 no file path provided. Add a "// filepath: src/your-file.ts" hint to the code block and harvest it again.'
        };
      }
      const candidate = normalizeRepoPath(answer);
      const issue = findRepoPathIssue(candidate);
      if (issue) {
        return { payload, cancelled: true, reason: issue };
      }
      missing[index].path = candidate;
    }
    return { payload: { ...payload, patches }, cancelled: false };
  }

  // packages/userscript-hud/src/ui/hudStylesAndDom.ts
  var HUD_STYLES = `
  :host {
    all: initial;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * {
    box-sizing: border-box;
  }
  .hud-trigger {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    background: linear-gradient(135deg, #0f172a, #1e293b);
    color: #38bdf8;
    border: 1px solid rgba(56, 189, 248, 0.5);
    border-radius: 28px;
    padding: 10px 18px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
  }
  .hud-trigger:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 28px rgba(56, 189, 248, 0.4);
    background: #0284c7;
    color: #ffffff;
  }
  .hud-trigger-badge {
    padding: 2px 7px;
    border-radius: 12px;
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    background: rgba(56, 189, 248, 0.2);
    color: #38bdf8;
  }
  .hud-trigger-badge.idle { background: #334155; color: #94a3b8; }
  .hud-trigger-badge.mixing { background: #0284c7; color: #ffffff; }
  .hud-trigger-badge.patching { background: #d97706; color: #ffffff; }
  .hud-trigger-badge.committed { background: #059669; color: #ffffff; }
  .hud-trigger-badge.error { background: #dc2626; color: #ffffff; }

  .hud-panel {
    position: fixed;
    bottom: 80px;
    right: 24px;
    width: 440px;
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 120px);
    background: #0f172a;
    border: 1px solid rgba(56, 189, 248, 0.35);
    border-radius: 16px;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.75);
    color: #f1f5f9;
    z-index: 2147483647;
    display: none;
    flex-direction: column;
    overflow: hidden;
    animation: hudFadeIn 0.2s ease-out;
  }
  .hud-panel.open {
    display: flex;
  }
  @keyframes hudFadeIn {
    from { opacity: 0; transform: translateY(10px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .hud-header {
    padding: 14px 18px;
    background: #1e293b;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .hud-title {
    font-size: 14px;
    font-weight: 700;
    color: #38bdf8;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hud-close-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 6px;
  }
  .hud-close-btn:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.1);
  }
  .hud-header-icon {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 7px;
    border-radius: 6px;
  }
  .hud-header-icon:hover:not(:disabled) {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.1);
  }
  .hud-header-icon:disabled {
    opacity: 0.45;
    cursor: progress;
  }
  .hud-update-banner {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.4;
    border: 1px solid transparent;
  }
  .hud-update-banner.update { background: #422006; color: #fcd34d; border-color: #d97706; }
  .hud-update-banner.ok { background: #064e3b; color: #6ee7b7; border-color: #059669; }
  .hud-update-banner.error { background: #7f1d1d; color: #fca5a5; border-color: #dc2626; }
  .hud-update-banner .hud-btn {
    flex: 0 0 auto;
    padding: 4px 10px;
    font-size: 11px;
  }
  .hud-body {
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .hud-form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hud-form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 12px;
    align-items: start;
  }
  .hud-label {
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .hud-input {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 7px 10px;
    color: #f8fafc;
    font-size: 12px;
    font-family: monospace;
    outline: none;
    transition: border-color 0.2s;
  }
  .hud-input:focus {
    border-color: #38bdf8;
    box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
  }
  .hud-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.2s;
    user-select: none;
  }
  .hud-btn-primary {
    background: linear-gradient(135deg, #0284c7, #0369a1);
    color: #ffffff;
    border-color: #38bdf8;
  }
  .hud-btn-primary:hover:not(:disabled) {
    background: #0284c7;
    box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
  }
  .hud-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    box-shadow: none;
  }
  .hud-btn-primary:disabled {
    background: #334155;
    border-color: #475569;
    color: #94a3b8;
  }
  .hud-btn-secondary {
    background: #1e293b;
    color: #cbd5e1;
    border-color: #334155;
  }
  .hud-btn-secondary:hover {
    background: #334155;
    color: #ffffff;
  }
  .hud-badge-oid {
    background: #022c22;
    border: 1px solid #059669;
    color: #6ee7b7;
    font-family: monospace;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 6px;
    word-break: break-all;
    display: inline-block;
  }
  .hud-status-box {
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.4;
    border: 1px solid transparent;
    word-break: break-word;
  }
  .hud-status-box.info { background: #0c4a6e; color: #7dd3fc; border-color: #0284c7; }
  .hud-status-box.success { background: #064e3b; color: #6ee7b7; border-color: #059669; }
  .hud-status-box.error { background: #7f1d1d; color: #fca5a5; border-color: #dc2626; }
  .hud-status-box.idle { background: #1e293b; color: #94a3b8; border-color: #334155; }

  .hud-toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: #cbd5e1;
  }
  .hud-patch-queue {
    border: 1px solid #334155;
    border-radius: 8px;
    background: #182234;
    padding: 8px;
    min-height: 76px;
    max-height: 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hud-patch-item {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 6px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    gap: 8px;
  }
  .hud-patch-item-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #e2e8f0;
    flex: 1;
    min-width: 0;
  }
  .hud-patch-item-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    flex: 1;
    min-width: 0;
  }
  .hud-patch-item-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: #94a3b8;
  }
`;
  var HUD_SHADOW_STYLES = HUD_STYLES;
  function createHudElement(tag, className, textContent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent !== void 0) el.textContent = textContent;
    return el;
  }

  // packages/userscript-hud/src/ui/hudDomTree.ts
  function buildHudDomTree(config, state) {
    const existing = document.getElementById("gemini-edge-hud-root");
    if (existing) {
      existing.remove();
    }
    const host = createHudElement("div");
    host.id = "gemini-edge-hud-root";
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647;";
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    const styleEl = createHudElement("style");
    styleEl.textContent = HUD_STYLES;
    shadowRoot.appendChild(styleEl);
    const trigger = createHudElement("div", "hud-trigger");
    const triggerIcon = createHudElement("span", void 0, "\u26A1");
    const triggerLabel = createHudElement("span", void 0, "Gemini Edge HUD");
    const triggerBadge = createHudElement("span", "hud-trigger-badge idle", "IDLE");
    trigger.appendChild(triggerIcon);
    trigger.appendChild(triggerLabel);
    trigger.appendChild(triggerBadge);
    shadowRoot.appendChild(trigger);
    const panel = createHudElement("div", "hud-panel");
    const header = createHudElement("div", "hud-header");
    const title = createHudElement("div", "hud-title", "\u26A1 Cloudflare Edge HUD");
    const updateCheckBtn = createHudElement("button", "hud-header-icon", "\u27F3");
    updateCheckBtn.title = "Check published userscript version";
    const closeBtn = createHudElement("button", "hud-close-btn", "\xD7");
    closeBtn.title = "Close Panel";
    header.appendChild(title);
    header.appendChild(updateCheckBtn);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = createHudElement("div", "hud-body");
    const updateBanner = createHudElement("div", "hud-update-banner");
    const updateBannerText = createHudElement("span", void 0, "");
    const updateBannerBtn = createHudElement("button", "hud-btn hud-btn-primary", "\u2B06 Update");
    updateBanner.appendChild(updateBannerText);
    updateBanner.appendChild(updateBannerBtn);
    body.appendChild(updateBanner);
    const repoRow = createHudElement("div", "hud-form-row");
    const repoLabel = createHudElement("span", "hud-label", "GitHub Repository (owner/repo)");
    const repoInput = createHudElement("input", "hud-input");
    repoInput.value = config.repo;
    repoRow.appendChild(repoLabel);
    repoRow.appendChild(repoInput);
    body.appendChild(repoRow);
    const branchGrid = createHudElement("div", "hud-form-grid");
    const branchRow = createHudElement("div", "hud-form-row");
    const branchLabel = createHudElement("span", "hud-label", "Branch");
    const branchInput = createHudElement("input", "hud-input");
    branchInput.value = config.branch;
    branchRow.appendChild(branchLabel);
    branchRow.appendChild(branchInput);
    const targetBranchRow = createHudElement("div", "hud-form-row");
    const targetBranchLabel = createHudElement("span", "hud-label", "Target Branch (optional)");
    const targetBranchInput = createHudElement("input", "hud-input");
    targetBranchInput.placeholder = "Same as mix branch (or e.g. preview, feature/...)";
    targetBranchInput.value = config.targetBranch || "";
    targetBranchRow.appendChild(targetBranchLabel);
    targetBranchRow.appendChild(targetBranchInput);
    branchGrid.appendChild(branchRow);
    branchGrid.appendChild(targetBranchRow);
    body.appendChild(branchGrid);
    const scopeGrid = createHudElement("div", "hud-form-grid");
    const pathsRow = createHudElement("div", "hud-form-row");
    const pathsLabel = createHudElement("span", "hud-label", "Include Paths (comma-separated, optional)");
    const includePathsInput = createHudElement("input", "hud-input");
    includePathsInput.placeholder = "e.g. src/, packages/edge-worker/";
    includePathsInput.value = (config.includePaths || []).join(", ");
    pathsRow.appendChild(pathsLabel);
    pathsRow.appendChild(includePathsInput);
    const maxChunkRow = createHudElement("div", "hud-form-row");
    const maxChunkLabel = createHudElement("span", "hud-label", "Max Chunk Chars (Default: 85000, Max 10 Parts)");
    const maxChunkCharsInput = createHudElement("input", "hud-input");
    maxChunkCharsInput.type = "number";
    maxChunkCharsInput.min = "10000";
    maxChunkCharsInput.max = "2000000";
    maxChunkCharsInput.value = String(config.maxChunkChars || 85e3);
    maxChunkRow.appendChild(maxChunkLabel);
    maxChunkRow.appendChild(maxChunkCharsInput);
    scopeGrid.appendChild(pathsRow);
    scopeGrid.appendChild(maxChunkRow);
    body.appendChild(scopeGrid);
    const secretGrid = createHudElement("div", "hud-form-grid");
    const secretRow = createHudElement("div", "hud-form-row");
    const secretLabel = createHudElement("span", "hud-label", "Worker Secret (WORKER_SECRET)");
    const secretInput = createHudElement("input", "hud-input");
    secretInput.type = "password";
    secretInput.value = config.workerSecret;
    secretRow.appendChild(secretLabel);
    secretRow.appendChild(secretInput);
    const oidRow = createHudElement("div", "hud-form-row");
    const oidLabel = createHudElement("span", "hud-label", "Head OID (Optimistic Concurrency)");
    const oidBadge = createHudElement("div", "hud-badge-oid", state.headOid || "(Not mixed yet)");
    oidRow.appendChild(oidLabel);
    oidRow.appendChild(oidBadge);
    secretGrid.appendChild(secretRow);
    secretGrid.appendChild(oidRow);
    body.appendChild(secretGrid);
    const actionRow = createHudElement("div");
    actionRow.style.cssText = "display: flex; gap: 8px;";
    const mixBtn = createHudElement("button", "hud-btn hud-btn-primary", "\u{1F4E6} Load Repo Mix (/api/mix)");
    mixBtn.style.flex = "1";
    actionRow.appendChild(mixBtn);
    body.appendChild(actionRow);
    const optRow = createHudElement("div");
    optRow.style.cssText = "display: flex; align-items: center; justify-content: space-between;";
    const autoPilotLabel = createHudElement("label", "hud-toggle-label");
    const autoPilotCheck = createHudElement("input");
    autoPilotCheck.type = "checkbox";
    autoPilotCheck.checked = config.autoPilot;
    const autoPilotText = createHudElement("span", void 0, "\u{1F916} Auto-Pilot Self-Healing");
    autoPilotLabel.appendChild(autoPilotCheck);
    autoPilotLabel.appendChild(autoPilotText);
    const retryIndicator = createHudElement("span", void 0, `Retries: ${state.retryCount}/3`);
    retryIndicator.style.cssText = "font-size: 11px; color: #94a3b8;";
    optRow.appendChild(autoPilotLabel);
    optRow.appendChild(retryIndicator);
    body.appendChild(optRow);
    const commitsRow = createHudElement("div");
    commitsRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-top: 4px;";
    const recentCommitsLabel = createHudElement("label", "hud-toggle-label");
    const recentCommitsCheck = createHudElement("input");
    recentCommitsCheck.type = "checkbox";
    recentCommitsCheck.checked = config.includeRecentCommits === true;
    const recentCommitsText = createHudElement("span", void 0, "\u{1F552} Volatile Dateien & Letzte Commits");
    recentCommitsLabel.appendChild(recentCommitsCheck);
    recentCommitsLabel.appendChild(recentCommitsText);
    commitsRow.appendChild(recentCommitsLabel);
    body.appendChild(commitsRow);
    const queueHeaderRow = createHudElement("div");
    queueHeaderRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-top: 4px;";
    const queueLabel = createHudElement("span", "hud-label", "Harvested Patches");
    const queueActions = createHudElement("div");
    queueActions.style.cssText = "display: flex; gap: 6px;";
    const applyAllBtn = createHudElement("button", "hud-btn hud-btn-primary", "\u26A1 Apply All");
    applyAllBtn.style.cssText = "padding: 3px 8px; font-size: 11px;";
    const clearQueueBtn = createHudElement("button", "hud-btn hud-btn-secondary", "\u{1F5D1}\uFE0F Clear");
    clearQueueBtn.style.cssText = "padding: 3px 8px; font-size: 11px;";
    queueActions.appendChild(applyAllBtn);
    queueActions.appendChild(clearQueueBtn);
    queueHeaderRow.appendChild(queueLabel);
    queueHeaderRow.appendChild(queueActions);
    body.appendChild(queueHeaderRow);
    const patchQueueEl = createHudElement("div", "hud-patch-queue");
    const emptyQueueMsg = createHudElement("div", void 0, "No patches harvested from chat yet.");
    emptyQueueMsg.style.cssText = "color: #64748b; font-size: 11px; text-align: center; padding: 6px;";
    patchQueueEl.appendChild(emptyQueueMsg);
    body.appendChild(patchQueueEl);
    const statusBox = createHudElement("div", "hud-status-box idle", state.statusMessage);
    body.appendChild(statusBox);
    panel.appendChild(body);
    shadowRoot.appendChild(panel);
    return {
      host,
      shadowRoot,
      trigger,
      triggerBadge,
      panel,
      title,
      updateCheckBtn,
      updateBanner,
      updateBannerText,
      updateBannerBtn,
      closeBtn,
      repoInput,
      branchInput,
      targetBranchInput,
      secretInput,
      includePathsInput,
      maxChunkCharsInput,
      oidBadge,
      mixBtn,
      autoPilotCheck,
      recentCommitsCheck,
      retryIndicator,
      applyAllBtn,
      clearQueueBtn,
      patchQueueEl,
      emptyQueueMsg,
      statusBox
    };
  }

  // packages/userscript-hud/src/services/updateChecker.ts
  var SCRIPT_SOURCE_URL = "https://raw.githubusercontent.com/alexanderpeschkaGit/githubgeminibridge/main/gemini-bridge.user.js";
  var LAST_CHECK_KEY = "script_update_last_check";
  var CHECK_INTERVAL_MS = 6 * 60 * 60 * 1e3;
  var CHECK_TIMEOUT_MS = 15e3;
  function parseUserscriptVersion(source) {
    const block = (source || "").match(/\/\/\s*==UserScript==\r?\n([\s\S]*?)\/\/\s*==\/UserScript==/);
    if (!block) return "";
    const version = block[1].match(/^\/\/\s*@version\s+(\S+)\s*$/m);
    return version ? version[1].trim() : "";
  }
  function compareVersions(a, b) {
    const toParts = (value) => (value || "").trim().split(/[.+-]/).map((part) => {
      const parsed = parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    const left = toParts(a);
    const right = toParts(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
  function buildUpdateUrl(version) {
    const suffix = version ? `?v=${encodeURIComponent(version)}` : "";
    return `${SCRIPT_SOURCE_URL}${suffix}`;
  }
  function isUpdateCheckDue(nowMs = Date.now()) {
    const last = parseInt(getStoredValue(LAST_CHECK_KEY, "0"), 10);
    if (!Number.isFinite(last) || last <= 0) return true;
    return nowMs - last >= CHECK_INTERVAL_MS;
  }
  function readText(url) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          timeout: CHECK_TIMEOUT_MS,
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              resolve(res.responseText);
            } else {
              reject(new Error(`HTTP ${res.status} while fetching the published userscript`));
            }
          },
          onerror: () => reject(new Error("Network error while checking the published userscript")),
          ontimeout: () => reject(new Error("Update check timed out"))
        });
      });
    }
    if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
      return GM.xmlHttpRequest({
        method: "GET",
        url,
        timeout: CHECK_TIMEOUT_MS,
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" }
      }).then((res) => {
        if (res.status >= 200 && res.status < 300) return res.responseText;
        throw new Error(`HTTP ${res.status} while fetching the published userscript`);
      });
    }
    if (typeof fetch === "function") {
      return fetch(url, { cache: "no-store" }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} while fetching the published userscript`);
        return res.text();
      });
    }
    return Promise.reject(new Error("No supported HTTP client found for the update check"));
  }
  async function fetchLatestScriptVersion() {
    const source = await readText(`${SCRIPT_SOURCE_URL}?t=${Date.now()}`);
    const version = parseUserscriptVersion(source);
    if (!version) throw new Error("Published userscript has no valid @version metadata block");
    return version;
  }
  async function checkForScriptUpdate(options = {}) {
    const currentVersion = getRunningScriptVersion();
    if (!currentVersion) return null;
    if (!options.force && !isUpdateCheckDue()) return null;
    const latestVersion = await fetchLatestScriptVersion();
    setStoredValue(LAST_CHECK_KEY, String(Date.now()));
    return {
      currentVersion,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, currentVersion) > 0
    };
  }

  // packages/userscript-hud/src/ui/updateBanner.ts
  var TRANSIENT_MESSAGE_MS = 6e3;
  function initHudUpdateBanner(dom) {
    let hideTimer = null;
    let installUrl = "";
    const hide = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      installUrl = "";
      dom.updateBanner.style.display = "none";
    };
    const show = (message, tone, action) => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      installUrl = action ? action.url : "";
      dom.updateBanner.className = `hud-update-banner ${tone}`;
      dom.updateBannerText.textContent = message;
      dom.updateBannerBtn.textContent = action ? action.label : "\xD7";
      dom.updateBannerBtn.title = action ? "Open the Tampermonkey update page" : "Dismiss";
      dom.updateBanner.style.display = "flex";
      if (!action || !action.persistent) {
        hideTimer = setTimeout(hide, TRANSIENT_MESSAGE_MS);
      }
    };
    dom.updateBannerBtn.addEventListener("click", () => {
      if (!installUrl) {
        hide();
        return;
      }
      window.open(installUrl, "_blank", "noopener");
    });
    const runCheck = async (force) => {
      dom.updateCheckBtn.disabled = true;
      try {
        const info = await checkForScriptUpdate({ force });
        if (!info) return;
        if (info.hasUpdate) {
          show(
            `\u2B06 HUD v${info.latestVersion} is available (running v${info.currentVersion}).`,
            "update",
            {
              label: `\u2B06 Install v${info.latestVersion}`,
              url: buildUpdateUrl(info.latestVersion),
              persistent: true
            }
          );
        } else if (force) {
          show(`\u2705 HUD is up to date (v${info.currentVersion}).`, "ok");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[Gemini Edge HUD] Update check failed:", err);
        if (force) show(`\u26A0\uFE0F Update check failed: ${message}`, "error");
      } finally {
        dom.updateCheckBtn.disabled = false;
      }
    };
    dom.updateCheckBtn.addEventListener("click", () => {
      void runCheck(true);
    });
    void runCheck(false);
  }

  // packages/userscript-hud/src/ui/hudConfigBindings.ts
  function bindHudConfigInputs(deps) {
    const { dom, config, state, resetPatchOidState, clearTargetOidState: clearTargetOidState2, renderState } = deps;
    dom.repoInput.onchange = () => {
      try {
        const sanitized = sanitizeNoGithubPat(dom.repoInput.value.trim(), "repo");
        const previousRepo = config.repo;
        config.repo = sanitized;
        saveHudConfig({ repo: sanitized });
        if (sanitized !== previousRepo) resetPatchOidState(`Repository changed to "${sanitized}".`);
      } catch (e) {
        alert(e.message);
        dom.repoInput.value = config.repo;
      }
    };
    dom.branchInput.onchange = () => {
      try {
        const sanitized = sanitizeNoGithubPat(dom.branchInput.value.trim(), "branch");
        const previousBranch = config.branch;
        config.branch = sanitized;
        saveHudConfig({ branch: sanitized });
        if (sanitized !== previousBranch) resetPatchOidState(`Branch changed to "${sanitized}".`);
      } catch (e) {
        alert(e.message);
        dom.branchInput.value = config.branch;
      }
    };
    dom.targetBranchInput.onchange = () => {
      try {
        const sanitized = sanitizeNoGithubPat(dom.targetBranchInput.value.trim(), "targetBranch");
        config.targetBranch = sanitized;
        clearTargetOidState2(state);
        saveHudConfig({ targetBranch: sanitized });
        renderState();
      } catch (e) {
        alert(e.message);
        dom.targetBranchInput.value = config.targetBranch || "";
      }
    };
    dom.includePathsInput.onchange = () => {
      try {
        const raw = dom.includePathsInput.value.trim();
        const paths = raw.split(",").map((s) => s.trim()).filter(Boolean);
        config.includePaths = paths;
        saveHudConfig({ includePaths: paths });
      } catch (e) {
        alert(e.message);
        dom.includePathsInput.value = (config.includePaths || []).join(", ");
      }
    };
    dom.maxChunkCharsInput.onchange = () => {
      try {
        const val = parseInt(dom.maxChunkCharsInput.value, 10);
        const safe = Math.max(1e4, Math.min(2e6, Number.isFinite(val) ? val : 85e3));
        config.maxChunkChars = safe;
        dom.maxChunkCharsInput.value = String(safe);
        saveHudConfig({ maxChunkChars: safe });
      } catch (e) {
        alert(e.message);
        dom.maxChunkCharsInput.value = String(config.maxChunkChars || 85e3);
      }
    };
    dom.secretInput.onchange = () => {
      try {
        const sanitized = sanitizeNoGithubPat(dom.secretInput.value.trim(), "workerSecret");
        config.workerSecret = sanitized;
        saveHudConfig({ workerSecret: sanitized });
      } catch (e) {
        alert(e.message);
        dom.secretInput.value = config.workerSecret;
      }
    };
    dom.autoPilotCheck.onchange = () => {
      config.autoPilot = dom.autoPilotCheck.checked;
      saveHudConfig({ autoPilot: config.autoPilot });
    };
    dom.recentCommitsCheck.onchange = () => {
      config.includeRecentCommits = dom.recentCommitsCheck.checked;
      saveHudConfig({ includeRecentCommits: config.includeRecentCommits });
    };
  }

  // packages/userscript-hud/src/ui/shadowHud.ts
  function mountShadowHud(onApplyPatchCustom) {
    if (typeof document === "undefined") {
      throw new Error("mountShadowHud requires a DOM environment");
    }
    const config = loadHudConfig();
    const state = {
      ...loadPatchOidState(config),
      lastMixStats: null,
      status: "IDLE",
      statusMessage: config.workerSecret ? "Ready. Load Repo Mix or commit patches." : "Set your Worker Secret (WORKER_SECRET) in the panel before using the bridge.",
      retryCount: 0,
      lastErrors: [],
      harvestedPatches: []
    };
    const dom = buildHudDomTree(config, state);
    const runningVersion = getRunningScriptVersion();
    if (runningVersion && dom.title) {
      dom.title.textContent = `\u26A1 Cloudflare Edge HUD v${runningVersion}`;
    }
    initHudUpdateBanner(dom);
    function resetPatchOidState(reason) {
      clearPatchOidState(state);
      controller.updateState({
        status: "IDLE",
        statusMessage: `\u{1F504} ${reason} Snapshot OID reset \u2014 click "Load Repo Mix" before applying patches.`,
        retryCount: 0,
        lastErrors: []
      });
    }
    function renderState() {
      dom.triggerBadge.className = `hud-trigger-badge ${state.status.toLowerCase()}`;
      dom.triggerBadge.textContent = state.status;
      if (state.headOid) {
        dom.oidBadge.textContent = state.headOid;
        dom.oidBadge.style.color = "#6ee7b7";
      } else {
        dom.oidBadge.textContent = "(Not mixed yet)";
        dom.oidBadge.style.color = "#94a3b8";
      }
      dom.retryIndicator.textContent = `Retries: ${state.retryCount}/3`;
      const statusClasses = {
        ERROR: "error",
        PREFLIGHT_FAILED: "error",
        GIT_CONFLICT: "error",
        COMMITTED: "success",
        MIXING: "info",
        PATCHING: "info"
      };
      dom.statusBox.className = `hud-status-box ${statusClasses[state.status] || "idle"}`;
      dom.statusBox.textContent = "";
      const mainMsg = createHudElement("div", void 0, state.statusMessage);
      dom.statusBox.appendChild(mainMsg);
      if (state.lastErrors && state.lastErrors.length > 0) {
        const errList = createHudElement("ul");
        errList.style.cssText = "margin: 6px 0 0 16px; padding: 0; font-size: 11px;";
        state.lastErrors.forEach((err) => {
          const li = createHudElement("li", void 0, `[${err.stage}] ${err.file}: ${err.message}`);
          errList.appendChild(li);
        });
        dom.statusBox.appendChild(errList);
        const healBtn = createHudElement("button", "hud-btn hud-btn-secondary", "\u{1F527} Send Self-Healing Prompt to Chat");
        healBtn.style.cssText = "margin-top: 8px; width: 100%; font-size: 11px; padding: 5px 8px; border-color: #38bdf8; color: #38bdf8;";
        healBtn.onclick = () => {
          const nextRetry = (state.retryCount || 0) + 1;
          const prompt = buildSelfHealingPrompt(
            state.lastErrors,
            config.repo,
            config.branch,
            state.headOid,
            nextRetry
          );
          injectPromptText(prompt, false);
          controller.updateState({
            retryCount: nextRetry,
            statusMessage: `\u{1F527} Injected self-healing prompt (Turn ${nextRetry}/${MAX_SELF_HEALING_RETRIES}) into chat.`
          });
        };
        dom.statusBox.appendChild(healBtn);
      }
      const patchCount = state.harvestedPatches.length;
      const isBusy = state.status === "PATCHING" || state.status === "MIXING";
      dom.applyAllBtn.disabled = patchCount === 0 || isBusy;
      dom.applyAllBtn.textContent = patchCount > 0 ? `\u26A1 Apply All (${patchCount})` : "\u26A1 Apply All";
      dom.clearQueueBtn.disabled = patchCount === 0 || isBusy;
      dom.patchQueueEl.textContent = "";
      if (state.harvestedPatches.length === 0) {
        dom.patchQueueEl.appendChild(dom.emptyQueueMsg);
      } else {
        state.harvestedPatches.forEach((patch) => {
          const item = createHudElement("div", "hud-patch-item");
          const meta = createHudElement("div", "hud-patch-item-meta");
          const paths = (patch.payload.patches || []).map((p) => p.path);
          const pathLabel = paths.length > 0 ? paths.join(", ") : patch.commitMessage;
          const itemTitle = createHudElement(
            "div",
            "hud-patch-item-title",
            `${patch.mode === "v2_json" ? "\u26A1" : "\u{1F4DD}"} ${pathLabel}`
          );
          itemTitle.title = pathLabel;
          const itemSub = createHudElement("div", "hud-patch-item-sub", patch.commitMessage);
          itemSub.title = patch.commitMessage;
          const applyBtn = createHudElement("button", "hud-btn hud-btn-primary", "Apply");
          applyBtn.style.cssText = "padding: 3px 8px; font-size: 11px;";
          applyBtn.disabled = isBusy;
          applyBtn.onclick = () => {
            controller.handleApplyPatch(patch);
          };
          meta.appendChild(itemTitle);
          meta.appendChild(itemSub);
          item.appendChild(meta);
          item.appendChild(applyBtn);
          dom.patchQueueEl.appendChild(item);
        });
      }
    }
    const openPanel = () => {
      dom.panel.classList.add("open");
    };
    const closePanel = () => {
      dom.panel.classList.remove("open");
    };
    dom.trigger.onclick = () => {
      if (dom.panel.classList.contains("open")) {
        closePanel();
      } else {
        openPanel();
      }
    };
    dom.closeBtn.onclick = closePanel;
    bindHudConfigInputs({
      dom,
      config,
      state,
      resetPatchOidState,
      clearTargetOidState,
      renderState
    });
    dom.mixBtn.onclick = async () => {
      try {
        dom.mixBtn.disabled = true;
        dom.mixBtn.style.opacity = "0.6";
        controller.updateState({
          status: "MIXING",
          statusMessage: `\u23F3 Streaming repo mix for ${config.repo} (${config.branch})...`
        });
        const res = await requestRepoMix(config);
        if (res.status === "OK" && (res.parts?.length || res.xmlContent)) {
          setSourceHeadOid(config, state, res.headOid);
          state.lastMixStats = res.stats;
          let injected = false;
          const metaCommits = res.stats.recentCommitsCount ? ` (incl. ${res.stats.recentCommitsCount} recent commits, ${res.stats.volatileFilesCount ?? 0} volatile files)` : "";
          if (res.parts && res.parts.length > 1) {
            const partBreakdown = res.parts.map((p) => `P${p.partIndex}: ${(p.stats.charCount ?? p.xmlContent.length).toLocaleString()} chars`).join(", ");
            injected = injectRepoMixParts(
              res.parts.map((p) => ({ fileName: p.fileName, xmlContent: p.xmlContent }))
            );
            controller.updateState({
              status: "IDLE",
              statusMessage: `\u2705 Loaded ${res.parts.length} parts (${res.stats.fileCount} files${metaCommits}, ~${res.stats.estimatedTokens} tokens) [${partBreakdown}]. Head: ${res.headOid.slice(0, 7)}${injected ? " (Injected into chat prompt)" : ""}`
            });
          } else {
            injected = injectRepoMixFile(res.xmlContent);
            const charLen = res.stats.charCount ?? res.xmlContent.length;
            controller.updateState({
              status: "IDLE",
              statusMessage: `\u2705 Loaded ${res.stats.fileCount} files${metaCommits} (${charLen.toLocaleString()} chars, ~${res.stats.estimatedTokens} tokens). Head: ${res.headOid.slice(0, 7)}${injected ? " (Injected into chat prompt)" : ""}`
            });
          }
        } else {
          controller.updateState({
            status: "ERROR",
            statusMessage: `\u274C Mix error: ${res.errorMessage || "Unknown error"}`
          });
        }
      } catch (err) {
        controller.updateState({
          status: "ERROR",
          statusMessage: `\u274C Mix error: ${err.message || String(err)}`
        });
      } finally {
        dom.mixBtn.disabled = false;
        dom.mixBtn.style.opacity = "1";
      }
    };
    const handleApplyPatch = async (patch) => {
      if (onApplyPatchCustom) {
        return onApplyPatchCustom(patch);
      }
      controller.openPanel();
      const resolvedPaths = resolvePatchPaths(patch.payload, (index, total) => {
        if (typeof window === "undefined" || typeof window.prompt !== "function") {
          return null;
        }
        return window.prompt(
          `File path for patch ${index}/${total} (repo-relative, e.g. src/App.tsx):`,
          ""
        );
      });
      if (resolvedPaths.cancelled) {
        controller.updateState({
          status: "ERROR",
          statusMessage: `\u274C ${resolvedPaths.reason}`
        });
        return false;
      }
      const effectivePayload = resolvedPaths.payload;
      state.harvestedPatches = state.harvestedPatches.map(
        (entry) => entry.id === patch.id ? { ...entry, payload: effectivePayload } : entry
      );
      controller.updateState({
        status: "PATCHING",
        statusMessage: `\u23F3 Applying patch: "${patch.commitMessage}"...`
      });
      try {
        if (!isPatchSnapshotReady(state)) {
          controller.updateState({
            status: "PATCHING",
            statusMessage: `\u{1F504} No snapshot OID \u2014 resolving current HEAD of ${config.repo}@${config.branch}...`
          });
          try {
            const resolvedOid = await requestBranchHead(config, config.repo, config.branch);
            setSourceHeadOid(config, state, resolvedOid);
            controller.updateState({
              status: "PATCHING",
              statusMessage: `\u{1F504} Using current ${config.branch} HEAD ${resolvedOid.slice(0, 7)} as concurrency token (no repo mix snapshot).`
            });
          } catch (resolveErr) {
            throw new Error(
              `${patchSnapshotRequiredMessage(config, patch.commitMessage)} (HEAD lookup failed: ${resolveErr.message || String(resolveErr)})`
            );
          }
        }
        if (state.headOid) {
          const patchReq = buildWorkerPatchRequest(config, state, effectivePayload);
          const res = await requestWorkerPatch(config, patchReq);
          if (res.status === "COMMITTED") {
            state.harvestedPatches = removeHarvestedPatch(state.harvestedPatches, patch.id);
            applyPatchResponseOids(config, state, res);
            const branchLabel = res.targetBranch || config.branch;
            const prMsg = res.pullRequestUrl ? ` | \u{1F517} PR: ${res.pullRequestUrl}` : "";
            controller.updateState({
              status: "COMMITTED",
              statusMessage: `\u2705 Committed to ${branchLabel}: ${res.newHeadOid ? res.newHeadOid.slice(0, 7) : "OK"} (${patch.commitMessage})${prMsg}`,
              retryCount: 0,
              lastErrors: []
            });
            return true;
          }
          if (res.status === "PREFLIGHT_FAILED") {
            const selfHealingResult = executeSelfHealingTurn(res, config, state, true);
            if (selfHealingResult.triggered) {
              controller.updateState({
                status: "PREFLIGHT_FAILED",
                statusMessage: `\u26A0\uFE0F Preflight failed. \u{1F916} Auto-Pilot self-healing prompt injected (Turn ${selfHealingResult.nextRetryCount}/${MAX_SELF_HEALING_RETRIES}).`,
                retryCount: selfHealingResult.nextRetryCount,
                lastErrors: res.errors || []
              });
            } else {
              const reasonMsg = selfHealingResult.reason === "MAX_RETRIES_EXCEEDED" ? `Max retries (${MAX_SELF_HEALING_RETRIES}) reached.` : "Auto-pilot disabled.";
              controller.updateState({
                status: "PREFLIGHT_FAILED",
                statusMessage: `\u274C Preflight failed. ${reasonMsg} Review errors below or trigger manual retry.`,
                retryCount: selfHealingResult.nextRetryCount,
                lastErrors: res.errors || []
              });
            }
            return false;
          }
          if (res.status === "GIT_CONFLICT" || res.status === "ERROR") {
            const scopeHint = res.status === "GIT_CONFLICT" ? ` [validated ${config.repo}@${config.branch}]` : "";
            const resetScope = resolveConflictOidReset(res);
            if (resetScope === "source") {
              clearPatchOidState(state);
            } else if (resetScope === "target") {
              clearTargetOidState(state);
            }
            const recoveryHint = resetScope === "source" ? ' Stale snapshot OID discarded \u2014 click "Load Repo Mix" to mix the current HEAD, then retry.' : resetScope === "target" ? ` Target OID discarded \u2014 retry to commit on the current "${config.targetBranch}" HEAD.` : "";
            controller.updateState({
              status: res.status,
              statusMessage: `\u274C ${res.status}: ${res.errorMessage || "Preflight / Concurrency check failed"}${scopeHint}${recoveryHint}`,
              lastErrors: res.errors || []
            });
            return false;
          }
          if (res.status === "NO_CHANGES_NEEDED") {
            state.harvestedPatches = removeHarvestedPatch(state.harvestedPatches, patch.id);
            applyPatchResponseOids(config, state, res);
            controller.updateState({
              status: "IDLE",
              statusMessage: `\u2139\uFE0F No changes needed (idempotent patch).`
            });
            return true;
          }
        }
        throw new Error(patchSnapshotRequiredMessage(config, patch.commitMessage));
      } catch (err) {
        controller.updateState({
          status: "ERROR",
          statusMessage: `\u274C Patch error: ${err.message || String(err)}`
        });
        return false;
      }
    };
    dom.clearQueueBtn.onclick = () => {
      state.harvestedPatches = [];
      renderState();
    };
    dom.applyAllBtn.onclick = async () => {
      if (state.harvestedPatches.length === 0 || state.status === "PATCHING" || state.status === "MIXING") return;
      const { applied, total } = await runPatchQueue(
        state.harvestedPatches,
        handleApplyPatch,
        (patch, index, totalCount) => {
          controller.updateState({
            status: "PATCHING",
            statusMessage: `\u23F3 [${index + 1}/${totalCount}] Applying patch: "${patch.commitMessage}"...`
          });
        }
      );
      if (applied < total) return;
      controller.updateState({
        status: "COMMITTED",
        statusMessage: `\u{1F389} All ${applied} patches successfully applied and committed!`
      });
    };
    const controller = {
      getState: () => ({ ...state }),
      updateState: (partial) => {
        Object.assign(state, partial);
        renderState();
      },
      openPanel,
      closePanel,
      handleApplyPatch,
      addHarvestedPatch: (patch) => {
        const next = enqueueHarvestedPatch(state.harvestedPatches, patch);
        if (next === state.harvestedPatches) return;
        state.harvestedPatches = next;
        renderState();
      }
    };
    renderState();
    return controller;
  }

  // packages/userscript-hud/src/dom/pathHints.ts
  var FILE_PATH_TOKEN = /^[A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+$/;
  var LABELED_HEADER_PATH = /(?:filepath|file[\s_-]?path|filename|dateiname|file|datei|pfad|path)\s*[:=]\s*([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)/i;
  var PATH_COMMENT_LINE = /^(?:\/\/|#|\/\*+)\s*([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)\s*\*?\/?$/;
  var DIFF_MARKER_LINE = /^<{7}/;
  var MAX_HEADER_ANCESTOR_DEPTH = 4;
  var MAX_HEADER_SIBLINGS = 3;
  var MAX_HEADER_TEXT_CHARS = 300;
  var CODE_BLOCK_TAGS = /* @__PURE__ */ new Set(["PRE", "CODE-BLOCK"]);
  var HEADER_SEARCH_STOP_TAGS = /* @__PURE__ */ new Set([
    "BODY",
    "HTML",
    "MESSAGE-CONTENT",
    "MODEL-RESPONSE",
    "USER-QUERY"
  ]);
  function stripHeaderDecoration(raw) {
    let text = raw.replace(/\s+/g, " ").trim();
    for (let i = 0; i < 3; i += 1) {
      const next = text.replace(/^[*_`"'\s]+/, "").replace(/[*_`"'\s]+$/, "").replace(/^#{1,6}\s*/, "").replace(/^(?:[-*+•]|\d+[.)])\s+/, "").trim();
      if (next === text) break;
      text = next;
    }
    return text;
  }
  function matchHeaderPath(raw) {
    const text = stripHeaderDecoration(raw).replace(/[*`]/g, "");
    if (!text) return "";
    const labeled = text.match(LABELED_HEADER_PATH);
    if (labeled && labeled[1]) return labeled[1];
    const candidate = text.replace(/[:;,]+$/, "").trim();
    return FILE_PATH_TOKEN.test(candidate) ? candidate : "";
  }
  function elementTag(element) {
    return (element.tagName || "").toUpperCase();
  }
  function containsCodeBlock(element) {
    if (CODE_BLOCK_TAGS.has(elementTag(element))) return true;
    return typeof element.querySelector === "function" && !!element.querySelector("pre, code-block");
  }
  function isHeaderSearchBoundary(element) {
    if (HEADER_SEARCH_STOP_TAGS.has(elementTag(element))) return true;
    const className = typeof element.className === "string" ? element.className : "";
    return /(?:^|\s)(?:markdown|markdown-main-panel|response-content)(?:\s|$)/.test(className);
  }
  function collectHeaderElements(preElement) {
    const elements = [];
    let current = preElement ?? null;
    for (let depth = 0; current && depth <= MAX_HEADER_ANCESTOR_DEPTH; depth += 1) {
      let prev = current.previousElementSibling;
      for (let i = 0; i < MAX_HEADER_SIBLINGS && prev; i += 1) {
        if (containsCodeBlock(prev)) break;
        const text = (prev.textContent || "").trim();
        if (text && text.length <= MAX_HEADER_TEXT_CHARS && !elements.includes(prev)) {
          elements.push(prev);
        }
        prev = prev.previousElementSibling;
      }
      const parent = current.parentElement;
      if (!parent || isHeaderSearchBoundary(parent)) break;
      current = parent;
    }
    return elements;
  }
  function extractPathFromCode(codeText, preElement) {
    const inlineMatch = codeText.match(/(?:\/\/|#|\/\*)\s*(?:filepath|file|path):\s*([^\r\n*]+)/i);
    if (inlineMatch && inlineMatch[1]) {
      const inlinePath = inlineMatch[1].trim().replace(/^["']|["']$/g, "");
      return normalizeRepoPath(inlinePath);
    }
    const codeLines = codeText.split(/\r?\n/);
    const firstContentIndex = codeLines.findIndex((line) => line.trim().length > 0);
    const bareComment = firstContentIndex >= 0 ? codeLines[firstContentIndex].trim().match(PATH_COMMENT_LINE) : null;
    if (bareComment && bareComment[1]) {
      const nextLine = codeLines.slice(firstContentIndex + 1).find((line) => line.trim().length > 0)?.trim() ?? "";
      if (DIFF_MARKER_LINE.test(nextLine)) {
        return normalizeRepoPath(bareComment[1]);
      }
    }
    for (const element of collectHeaderElements(preElement)) {
      const headerPath = matchHeaderPath(element.textContent ?? "");
      if (headerPath) {
        return normalizeRepoPath(headerPath);
      }
    }
    return "";
  }
  function hasMissingPatchPath(patch) {
    return (patch.payload.patches || []).some((filePatch) => !filePatch.path);
  }
  function canInheritPathFromHeading(patch) {
    return (patch.payload.patches || []).length === 1 && hasMissingPatchPath(patch);
  }
  function fillMissingPatchPaths(patch, path) {
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
  function refreshPatchPathFromDom(patch, codeText, element) {
    if (!canInheritPathFromHeading(patch)) return;
    fillMissingPatchPaths(patch, extractPathFromCode(codeText, element));
  }

  // packages/userscript-hud/src/dom/harvester.ts
  function isSearchReplace(text) {
    return text.includes("<<<<<<<") && text.includes("=======") && text.includes(">>>>>>>");
  }
  function parseV2PatchPayloadFromCode(codeText) {
    if (!codeText || codeText.trim().length === 0) return null;
    let textToParse = codeText.trim();
    const fenceMatch = textToParse.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) {
      textToParse = fenceMatch[1].trim();
    }
    if (!textToParse.startsWith("{") || !textToParse.endsWith("}")) {
      const startIdx = textToParse.indexOf("{");
      const endIdx = textToParse.lastIndexOf("}");
      if (startIdx !== -1 && endIdx > startIdx) {
        textToParse = textToParse.substring(startIdx, endIdx + 1);
      } else {
        return null;
      }
    }
    try {
      const obj = JSON.parse(textToParse);
      if (obj && typeof obj === "object" && typeof obj.commitMessage === "string" && Array.isArray(obj.patches) && obj.patches.length > 0) {
        const validPatches = obj.patches.every(
          (p) => p && typeof p.path === "string" && (p.action === "modify" || p.action === "create" || p.action === "delete")
        );
        if (validPatches) {
          return obj;
        }
      }
    } catch {
    }
    return null;
  }
  function convertLegacyBlocksToV2Payload(codeText, defaultPath) {
    if (!codeText || codeText.trim().length === 0) return null;
    const detectedPath = normalizeRepoPath(extractPathFromCode(codeText) || defaultPath || "");
    const hasDiffBlocks = isSearchReplace(codeText);
    const describePath = detectedPath || "no path detected";
    if (hasDiffBlocks) {
      const blocks = [];
      const regex = /<{7}[^\r\n]*\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7}[^\r\n]*/g;
      let match;
      while ((match = regex.exec(codeText)) !== null) {
        blocks.push({
          search: match[1],
          replace: match[2]
        });
      }
      if (blocks.length > 0) {
        const fileOp2 = {
          path: detectedPath,
          action: "modify",
          blocks
        };
        const payload2 = {
          commitMessage: `refactor(${describePath}): apply search/replace patch`,
          patches: [fileOp2]
        };
        const legacyPayload2 = {
          repo: "",
          message: payload2.commitMessage,
          files: [
            {
              path: detectedPath,
              diff: codeText,
              patches: blocks
            }
          ]
        };
        return { payload: payload2, legacyPayload: legacyPayload2 };
      }
    }
    const fileOp = {
      path: detectedPath,
      action: "create",
      fullContent: codeText
    };
    const payload = {
      commitMessage: `feat(${describePath}): update file via Gemini Git Bridge`,
      patches: [fileOp]
    };
    const legacyPayload = {
      repo: "",
      message: payload.commitMessage,
      files: [
        {
          path: detectedPath,
          content: codeText
        }
      ]
    };
    return { payload, legacyPayload };
  }
  function startDomHarvester(onPatchHarvested, onInlineApply) {
    const processedSet = /* @__PURE__ */ new WeakSet();
    const pendingPathFills = [];
    function refreshPendingPathFills() {
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
    function processCodeBlock(pre) {
      if (processedSet.has(pre) || pre.getAttribute("data-ggh-processed") === "true") {
        return;
      }
      processedSet.add(pre);
      pre.setAttribute("data-ggh-processed", "true");
      const codeEl = pre.querySelector("code") || pre;
      const codeText = (codeEl.textContent || "").trim();
      if (codeText.length < 15) return;
      const scope = pre.closest("code-block") || pre.parentElement || pre;
      if (scope.querySelector(".ggb-inline-btn")) return;
      let harvested = null;
      const v2Payload = parseV2PatchPayloadFromCode(codeText);
      if (v2Payload) {
        harvested = {
          id: createStablePatchId("v2_json", v2Payload),
          mode: "v2_json",
          commitMessage: v2Payload.commitMessage,
          payload: v2Payload,
          timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString()
        };
      } else {
        const detectedPath = extractPathFromCode(codeText, pre);
        const converted = convertLegacyBlocksToV2Payload(codeText, detectedPath || void 0);
        if (converted) {
          const legacyMode = isSearchReplace(codeText) ? "v1_search_replace" : "v2_json";
          harvested = {
            id: createStablePatchId(legacyMode, converted.payload),
            mode: legacyMode,
            commitMessage: converted.payload.commitMessage,
            payload: converted.payload,
            legacyPayload: converted.legacyPayload,
            timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString()
          };
        }
      }
      if (!harvested) return;
      const currentPatch = harvested;
      const btn = document.createElement("button");
      btn.className = "ggb-inline-btn";
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
      btn.textContent = harvested.mode === "v2_json" ? "\u26A1 Push Patch (/api/patch)" : "\u{1F680} Push via Bridge";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        refreshPatchPathFromDom(currentPatch, codeText, pre);
        onInlineApply(currentPatch);
      };
      const codeHeader = Array.from(
        scope.querySelectorAll('.code-block-decoration, .code-header, [class*="header"]')
      ).find((el) => !pre.contains(el));
      if (codeHeader) {
        if (codeHeader.querySelector(".ggb-inline-btn")) return;
        codeHeader.appendChild(btn);
      } else {
        pre.style.position = "relative";
        btn.style.position = "absolute";
        btn.style.top = "8px";
        btn.style.right = "40px";
        pre.appendChild(btn);
      }
      if (canInheritPathFromHeading(currentPatch)) {
        pendingPathFills.push({ element: pre, codeText, patch: currentPatch });
      }
      onPatchHarvested(currentPatch);
    }
    function processCanvasCards() {
      const exportCandidateButtons = Array.from(
        document.querySelectorAll("button:not([data-ggh-canvas-processed])")
      );
      const exportBtns = exportCandidateButtons.filter((b) => {
        const txt = (b.textContent || b.getAttribute("aria-label") || "").trim();
        return txt.includes("Exportieren") || txt.includes("Export");
      });
      exportBtns.forEach((exportBtn) => {
        exportBtn.setAttribute("data-ggh-canvas-processed", "true");
        const headerBar = exportBtn.parentElement;
        if (!headerBar || headerBar.querySelector(".ggb-canvas-btn")) return;
        const btn = document.createElement("button");
        btn.className = "ggb-canvas-btn";
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
        btn.textContent = "\u{1F680} Push Canvas to GitHub";
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const card = exportBtn.closest(
            '[class*="card"], [class*="container"], [class*="editor"], [class*="canvas"], [class*="panel"], section, div'
          );
          let cardText = "";
          if (card) {
            const contentArea = card.querySelector('[contenteditable], [class*="content"], [class*="body"], [class*="text"]') || card;
            cardText = contentArea.textContent || "";
          }
          const detectedPath = extractPathFromCode(cardText, null);
          const converted = convertLegacyBlocksToV2Payload(
            cardText,
            detectedPath || "canvas-update.md"
          );
          if (converted) {
            const patch = {
              id: "canvas-" + Date.now(),
              mode: isSearchReplace(cardText) ? "v1_search_replace" : "v2_json",
              commitMessage: converted.payload.commitMessage,
              payload: converted.payload,
              legacyPayload: converted.legacyPayload,
              timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString()
            };
            onInlineApply(patch);
          }
        };
        headerBar.insertBefore(btn, exportBtn);
      });
    }
    function scanDOM() {
      refreshPendingPathFills();
      const blocks = document.querySelectorAll(
        "code-block:not([data-ggh-processed]), pre:not([data-ggh-processed])"
      );
      blocks.forEach((el) => {
        if (el.tagName.toLowerCase() === "pre" && el.closest("code-block")) {
          el.setAttribute("data-ggh-processed", "true");
          return;
        }
        processCodeBlock(el);
      });
      processCanvasCards();
    }
    const observer = new MutationObserver(() => {
      scanDOM();
    });
    if (typeof document !== "undefined") {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
          }
        });
      }
      scanDOM();
    }
    return observer;
  }

  // packages/userscript-hud/src/index.ts
  var controllerInstance = null;
  function initGeminiEdgeHud() {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return null;
    }
    if (controllerInstance) {
      return controllerInstance;
    }
    if (window.top !== window.self) {
      return null;
    }
    const runningVersion = getRunningScriptVersion();
    try {
      const cfg = loadHudConfig();
      console.log(`[Gemini Edge HUD] Initializing (script v${runningVersion || "unknown"}) with config:`, {
        workerUrl: cfg.workerUrl,
        repo: cfg.repo,
        branch: cfg.branch
      });
      controllerInstance = mountShadowHud();
      startDomHarvester(
        (patch) => {
          controllerInstance?.addHarvestedPatch(patch);
        },
        (patch) => {
          controllerInstance?.handleApplyPatch(patch);
        }
      );
    } catch (error) {
      reportHudInitFailure(error);
      return null;
    }
    console.log(`\u26A1 [Gemini Edge HUD] Successfully mounted v${runningVersion || "unknown"} in Shadow DOM.`);
    return controllerInstance;
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => initGeminiEdgeHud());
    } else {
      initGeminiEdgeHud();
    }
  }
})();
