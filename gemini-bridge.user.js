// ==UserScript==
// @name         Gemini Git Bridge & Shadow-DOM HUD
// @namespace    https://gemini-git-bridge.sikanda.workers.dev/
// @version      0.80.2
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
  // src/services/storage.ts
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
  var PROFILE_FIELDS = ["worker_url", "worker_secret", "owner", "owner_repo", "branch", "target_branch"];
  var PROFILE_MIGRATION_KEY = "account_profiles_migration_v1";
  function getActiveProfileId() {
    return getStoredValue("active_profile", "account1") === "account2" ? "account2" : "account1";
  }
  var DEFAULT_HUD_CONFIG = {
    workerUrl: "https://gemini-git-bridge.sikanda.workers.dev",
    // No bundled credential: the WORKER_SECRET is entered once in the HUD panel and kept
    // in GM storage. Shipping it in the userscript would publish it with every release.
    workerSecret: "",
    owner: "alexanderpeschkaGit",
    repo: "alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0",
    branch: "main",
    targetBranch: "",
    includePaths: [],
    autoPilot: false,
    persistToGitHub: false,
    maxChunkChars: 85e3,
    includeRecentCommits: false
  };
  var RECENT_COMMITS_MIGRATION_KEY = "recent_commits_opt_in_migration_v1";
  function migrateAccountProfiles() {
    if (getStoredValue(PROFILE_MIGRATION_KEY, "") === "true") return;
    for (const key of PROFILE_FIELDS) {
      const legacy = getStoredValue(key, "");
      if (legacy) setStoredValue(`account1_${key}`, legacy);
    }
    if (!getStoredValue("account1_owner", "")) {
      const legacyRepo = sanitizeRepo(getStoredValue("owner_repo", ""));
      const ownerFromRepo = legacyRepo.split("/")[0].trim();
      setStoredValue("account1_owner", ownerFromRepo || "alexanderpeschkaGit");
    }
    if (!getStoredValue("account2_owner", "")) {
      setStoredValue("account2_owner", "vijaysikanda");
    }
    setStoredValue(PROFILE_MIGRATION_KEY, "true");
  }
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
    migrateAccountProfiles();
    migrateRecentCommitsOptIn();
    const profile = getActiveProfileId();
    const a2 = profile === "account2";
    const readProfile = (key, fallback) => {
      const stored = getStoredValue(`${profile}_${key}`, "");
      if (stored) return stored;
      if (profile === "account1") return getStoredValue(key, fallback);
      return fallback;
    };
    const workerUrl = readProfile("worker_url", a2 ? "" : DEFAULT_HUD_CONFIG.workerUrl);
    const workerSecret = readProfile("worker_secret", a2 ? "" : DEFAULT_HUD_CONFIG.workerSecret);
    const owner = readProfile("owner", a2 ? "" : DEFAULT_HUD_CONFIG.owner);
    const repo = sanitizeRepo(readProfile("owner_repo", a2 ? "" : DEFAULT_HUD_CONFIG.repo));
    const branch = readProfile("branch", a2 ? "" : DEFAULT_HUD_CONFIG.branch);
    const targetBranch = readProfile("target_branch", a2 ? "" : DEFAULT_HUD_CONFIG.targetBranch ?? "");
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
      owner,
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
    const profile = getActiveProfileId();
    if (cfg.workerUrl !== void 0) {
      setStoredValue("worker_url", sanitizeNoGithubPat(updated.workerUrl, "workerUrl"));
      setStoredValue(`${profile}_worker_url`, sanitizeNoGithubPat(updated.workerUrl, "workerUrl"));
    }
    if (cfg.workerSecret !== void 0) {
      setStoredValue("worker_secret", sanitizeNoGithubPat(updated.workerSecret, "workerSecret"));
      setStoredValue(`${profile}_worker_secret`, sanitizeNoGithubPat(updated.workerSecret, "workerSecret"));
    }
    if (cfg.owner !== void 0) {
      setStoredValue("owner", sanitizeNoGithubPat(updated.owner, "owner"));
      setStoredValue(`${profile}_owner`, sanitizeNoGithubPat(updated.owner, "owner"));
    }
    if (cfg.repo !== void 0) {
      setStoredValue("owner_repo", sanitizeRepo(sanitizeNoGithubPat(updated.repo, "repo")));
      setStoredValue(`${profile}_owner_repo`, sanitizeRepo(sanitizeNoGithubPat(updated.repo, "repo")));
    }
    if (cfg.branch !== void 0) {
      setStoredValue("branch", sanitizeNoGithubPat(updated.branch, "branch"));
      setStoredValue(`${profile}_branch`, sanitizeNoGithubPat(updated.branch, "branch"));
    }
    if (cfg.targetBranch !== void 0) {
      setStoredValue("target_branch", sanitizeNoGithubPat(updated.targetBranch || "", "targetBranch"));
      setStoredValue(`${profile}_target_branch`, sanitizeNoGithubPat(updated.targetBranch || "", "targetBranch"));
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

  // src/services/runtimeInfo.ts
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

  // src/services/patchOidState.ts
  var OID_REGEX = /^[0-9a-f]{40}$/i;
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
    const targetIsCurrent = !!configuredTarget && storedTarget === configuredTarget && OID_REGEX.test(stored.targetHeadOid || "");
    return {
      headOid: OID_REGEX.test(stored.headOid || "") ? stored.headOid : "",
      targetHeadOid: targetIsCurrent ? stored.targetHeadOid : "",
      targetHeadBranch: targetIsCurrent ? storedTarget : ""
    };
  }
  function buildWorkerPatchRequest(config, state, payload, dryRun) {
    const targetBranch = config.targetBranch?.trim() || void 0;
    const isDistinctTarget = !!targetBranch && normalizeBranch(targetBranch) !== normalizeBranch(config.branch);
    const targetOidIsCurrent = isDistinctTarget && normalizeBranch(state.targetHeadBranch) === normalizeBranch(targetBranch) && OID_REGEX.test(state.targetHeadOid);
    return {
      repo: config.repo,
      branch: config.branch,
      expectedHeadOid: state.headOid,
      payload,
      targetBranch,
      expectedTargetHeadOid: targetOidIsCurrent ? state.targetHeadOid || void 0 : void 0,
      ...dryRun ? { dryRun: true } : {}
    };
  }
  function isPatchSnapshotReady(state) {
    return OID_REGEX.test(state.headOid || "");
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

  // src/services/patchOidStore.ts
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

  // ../../shared/repoPaths.ts
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

  // src/services/patchIdentity.ts
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

  // src/services/patchQueue.ts
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
  function partitionQueueForHolisticCheck(queue) {
    const ordered = fifoQueue(queue);
    const totalSnippets = ordered.length;
    const localErrors = [];
    const targetFiles = [];
    const validOperations = [];
    const forbidPatterns = [];
    const requireExports = {};
    const commitMessages = [];
    for (let snippetIndex = 0; snippetIndex < ordered.length; snippetIndex++) {
      const entry = ordered[snippetIndex];
      const operations = entry.payload?.patches ?? [];
      if (operations.length === 0) {
        localErrors.push({
          file: `(empty snippet #${snippetIndex + 1})`,
          stage: "SEARCH_REPLACE",
          message: "Code snippet contains no valid patch operations."
        });
      }
      for (const op of operations) {
        const issue = findRepoPathIssue(op.path);
        if (issue !== null) {
          const preview = (op.blocks?.[0]?.search || op.fullContent || entry.commitMessage || "").slice(0, 120);
          localErrors.push({
            file: op.path?.trim() || `(missing path in snippet #${snippetIndex + 1})`,
            stage: "SEARCH_REPLACE",
            message: `${issue} Provide a repo-relative path (e.g. "src/App.tsx") in the consolidated patch.`,
            codeSnippet: preview || void 0
          });
          continue;
        }
        const normPath = normalizeRepoPath(op.path);
        if (!targetFiles.includes(normPath)) {
          targetFiles.push(normPath);
        }
        const existingOp = validOperations.find((o) => o.path === normPath);
        if (existingOp) {
          if (existingOp.action === "modify" && op.action === "modify" && existingOp.blocks && op.blocks) {
            existingOp.blocks.push(...op.blocks);
          } else {
            const existingIdx = validOperations.indexOf(existingOp);
            validOperations[existingIdx] = { ...op, path: normPath };
          }
        } else {
          const clonedOp = {
            ...op,
            path: normPath,
            ...op.blocks ? { blocks: op.blocks.map((b) => ({ ...b })) } : {}
          };
          validOperations.push(clonedOp);
        }
      }
      for (const pattern of entry.payload?.preflight?.forbidPatterns ?? []) {
        if (!forbidPatterns.includes(pattern)) forbidPatterns.push(pattern);
      }
      for (const [filePath, symbols] of Object.entries(entry.payload?.preflight?.requireExports ?? {})) {
        const merged = requireExports[filePath] ?? [];
        for (const symbol of symbols) {
          if (!merged.includes(symbol)) merged.push(symbol);
        }
        requireExports[filePath] = merged;
      }
      if (entry.commitMessage) {
        commitMessages.push(entry.commitMessage);
      }
    }
    let validBatch = null;
    if (validOperations.length > 0) {
      const payload = {
        commitMessage: `batch: ${commitMessages.join(" | ") || `${ordered.length} harvested patches`}`,
        patches: validOperations
      };
      if (forbidPatterns.length > 0 || Object.keys(requireExports).length > 0) {
        payload.preflight = {};
        if (forbidPatterns.length > 0) payload.preflight.forbidPatterns = forbidPatterns;
        if (Object.keys(requireExports).length > 0) payload.preflight.requireExports = requireExports;
      }
      validBatch = {
        id: createStablePatchId("v2_json", payload),
        mode: "v2_json",
        commitMessage: payload.commitMessage,
        payload,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    return {
      validBatch,
      localErrors,
      targetFiles,
      totalSnippets
    };
  }

  // src/ui/hudStylesAndDom.ts
  var HUD_STYLES = `
  :host {
    all: initial;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  .hud-trigger {
    position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
    background: linear-gradient(135deg, #0f172a, #1e293b); color: #38bdf8;
    border: 1px solid rgba(56, 189, 248, 0.5); border-radius: 28px;
    padding: 10px 18px; font-size: 13px; font-weight: 700; cursor: pointer;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6); display: flex; align-items: center; gap: 8px;
    user-select: none; transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
  }
  .hud-trigger:hover {
    transform: translateY(-2px); box-shadow: 0 10px 28px rgba(56, 189, 248, 0.4);
    background: #0284c7; color: #ffffff;
  }
  .hud-trigger-badge {
    padding: 2px 7px; border-radius: 12px; font-size: 10px; font-weight: 800;
    text-transform: uppercase; background: rgba(56, 189, 248, 0.2); color: #38bdf8;
  }
  .hud-trigger-badge.idle { background: #334155; color: #94a3b8; }
  .hud-trigger-badge.mixing { background: #0284c7; color: #ffffff; }
  .hud-trigger-badge.patching { background: #d97706; color: #ffffff; }
  .hud-trigger-badge.committed { background: #059669; color: #ffffff; }
  .hud-trigger-badge.error { background: #dc2626; color: #ffffff; }

  .hud-panel {
    position: fixed; bottom: 80px; right: 24px; width: 440px;
    max-width: calc(100vw - 48px); max-height: calc(100vh - 120px);
    background: #0f172a; border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 16px;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.75); color: #f1f5f9; z-index: 2147483647;
    display: none; flex-direction: column; overflow: hidden; animation: hudFadeIn 0.2s ease-out;
  }
  .hud-panel.open { display: flex; }
  @keyframes hudFadeIn {
    from { opacity: 0; transform: translateY(10px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .hud-header {
    padding: 14px 18px; background: #1e293b; display: flex;
    align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .hud-title {
    font-size: 14px; font-weight: 700; color: #38bdf8;
    display: flex; align-items: center; gap: 8px;
  }
  .hud-close-btn {
    background: transparent; border: none; color: #94a3b8; font-size: 20px;
    line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px;
  }
  .hud-close-btn:hover { color: #ffffff; background: rgba(255, 255, 255, 0.1); }
  .hud-header-icon {
    background: transparent; border: none; color: #94a3b8; font-size: 15px;
    line-height: 1; cursor: pointer; padding: 4px 7px; border-radius: 6px;
  }
  .hud-header-icon:hover:not(:disabled) { color: #ffffff; background: rgba(255, 255, 255, 0.1); }
  .hud-header-icon:disabled { opacity: 0.45; cursor: progress; }
  .hud-update-banner {
    display: none; align-items: center; justify-content: space-between; gap: 10px;
    padding: 8px 10px; border-radius: 8px; font-size: 11px; line-height: 1.4; border: 1px solid transparent;
  }
  .hud-update-banner.update { background: #422006; color: #fcd34d; border-color: #d97706; }
  .hud-update-banner.ok { background: #064e3b; color: #6ee7b7; border-color: #059669; }
  .hud-update-banner.error { background: #7f1d1d; color: #fca5a5; border-color: #dc2626; }
  .hud-update-banner .hud-btn { flex: 0 0 auto; padding: 4px 10px; font-size: 11px; }
  .hud-body {
    padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;
  }
  .hud-form-row { display: flex; flex-direction: column; gap: 4px; }
  .hud-form-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; align-items: start;
  }
  .hud-repo-owner-grid {
    display: grid; grid-template-columns: minmax(0, 1.85fr) minmax(0, 1fr); gap: 10px; align-items: start;
  }
  .hud-repo-combo-wrap {
    position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0;
  }
  .hud-input-combo { display: flex; align-items: stretch; width: 100%; }
  .hud-input-combo .hud-input {
    flex: 1; min-width: 0; border-top-right-radius: 0; border-bottom-right-radius: 0;
  }
  .hud-combo-arrow {
    width: 30px; flex: 0 0 30px; display: flex; align-items: center; justify-content: center;
    background: #1e293b; border: 1px solid #334155; border-left: none;
    border-top-right-radius: 8px; border-bottom-right-radius: 8px;
    color: #94a3b8; cursor: pointer; font-size: 11px; line-height: 1; padding: 0;
    transition: background 0.2s, color 0.2s, border-color 0.2s; user-select: none;
  }
  .hud-combo-arrow:hover:not(:disabled) { background: #334155; color: #f8fafc; }
  .hud-combo-arrow:focus { outline: none; border-color: #38bdf8; }
  .hud-combo-arrow:disabled { opacity: 0.45; cursor: not-allowed; }
  .hud-repo-menu {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0;
    max-height: 180px; overflow-y: auto; z-index: 40; background: #0f172a;
    border: 1px solid #38bdf8; border-radius: 8px; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.6);
    display: flex; flex-direction: column; padding: 4px; gap: 2px;
  }
  .hud-repo-menu-item {
    width: 100%; text-align: left; background: transparent; border: none;
    border-radius: 4px; color: #e2e8f0; font-family: monospace; font-size: 11px;
    padding: 6px 8px; cursor: pointer; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; transition: background 0.15s, color 0.15s;
  }
  .hud-repo-menu-item:hover { background: #1e293b; color: #38bdf8; }
  .hud-repo-menu-item:focus { outline: none; background: #1e293b; color: #38bdf8; }
  .hud-account-worker-grid {
    display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start;
  }
  .hud-account-btns { display: flex; gap: 6px; }
  .hud-account-btns .hud-btn { padding: 7px 9px; font-size: 11px; white-space: nowrap; }
  .hud-toggles-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: nowrap; }
  .hud-retry-pill { font-size: 10px; color: #94a3b8; white-space: nowrap; }
  .hud-label {
    font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .hud-input {
    background: #1e293b; border: 1px solid #334155; border-radius: 8px;
    padding: 7px 10px; color: #f8fafc; font-size: 12px; font-family: monospace;
    outline: none; transition: border-color 0.2s;
  }
  .hud-input:focus { border-color: #38bdf8; box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2); }
  .hud-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 600;
    cursor: pointer; border: 1px solid transparent; transition: all 0.2s; user-select: none;
  }
  .hud-btn-primary {
    background: linear-gradient(135deg, #0284c7, #0369a1); color: #ffffff; border-color: #38bdf8;
  }
  .hud-btn-primary:hover:not(:disabled) {
    background: #0284c7; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
  }
  .hud-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
  .hud-btn-primary:disabled { background: #334155; border-color: #475569; color: #94a3b8; }
  .hud-btn-secondary { background: #1e293b; color: #cbd5e1; border-color: #334155; }
  .hud-btn-secondary:hover { background: #334155; color: #ffffff; }
  .hud-badge-oid {
    background: #022c22; border: 1px solid #059669; color: #6ee7b7;
    font-family: monospace; font-size: 11px; padding: 4px 8px; border-radius: 6px;
    word-break: break-all; display: inline-block;
  }
  .hud-status-box {
    padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 1.4;
    border: 1px solid transparent; word-break: break-word;
  }
  .hud-status-box.info { background: #0c4a6e; color: #7dd3fc; border-color: #0284c7; }
  .hud-status-box.success { background: #064e3b; color: #6ee7b7; border-color: #059669; }
  .hud-status-box.error { background: #7f1d1d; color: #fca5a5; border-color: #dc2626; }
  .hud-status-box.idle { background: #1e293b; color: #94a3b8; border-color: #334155; }
  .hud-toggle-label {
    display: flex; align-items: center; gap: 8px; cursor: pointer;
    font-size: 12px; font-weight: 600; color: #cbd5e1;
  }
  .hud-patch-queue {
    border: 1px solid #334155; border-radius: 8px; background: #182234; padding: 8px;
    min-height: 76px; max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
  }
  .hud-patch-item {
    background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 6px 10px;
    display: flex; align-items: center; justify-content: space-between; font-size: 11px; gap: 8px;
  }
  .hud-patch-item-title {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e2e8f0; flex: 1; min-width: 0;
  }
  .hud-patch-item-meta {
    display: flex; flex-direction: column; gap: 2px; overflow: hidden; flex: 1; min-width: 0;
  }
  .hud-patch-item-sub {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: #94a3b8;
  }
  .hud-account-hint {
    margin-top: 4px; padding: 5px 8px; font-size: 11px; border-left: 3px solid #38bdf8;
    background: rgba(56, 189, 248, 0.08); color: #e2e8f0;
  }
  .hud-account-hint.foreign { border-color: #fbbf24; background: rgba(251, 191, 36, 0.08); }
  .hud-account-hint .hud-btn { margin-left: 6px; padding: 2px 6px; font-size: 10px; }
`;
  var HUD_SHADOW_STYLES = HUD_STYLES;
  function createHudElement(tag, className, textContent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent !== void 0) el.textContent = textContent;
    return el;
  }

  // src/ui/hudDomTree.ts
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
    const repoOwnerGrid = createHudElement("div", "hud-repo-owner-grid");
    const repoComboWrap = createHudElement("div", "hud-repo-combo-wrap");
    const repoLabel = createHudElement("span", "hud-label", "GitHub Repository");
    repoLabel.title = "GitHub Repository (owner/repo)";
    const inputCombo = createHudElement("div", "hud-input-combo");
    const repoInput = createHudElement("input", "hud-input");
    repoInput.value = config.repo;
    const repoHistoryBtn = createHudElement("button", "hud-combo-arrow", "\u25BE");
    repoHistoryBtn.type = "button";
    repoHistoryBtn.title = "Recent Repositories";
    inputCombo.appendChild(repoInput);
    inputCombo.appendChild(repoHistoryBtn);
    const repoHistoryMenu = createHudElement("div", "hud-repo-menu");
    repoHistoryMenu.style.display = "none";
    repoComboWrap.appendChild(repoLabel);
    repoComboWrap.appendChild(inputCombo);
    repoComboWrap.appendChild(repoHistoryMenu);
    repoOwnerGrid.appendChild(repoComboWrap);
    const ownerRow = createHudElement("div", "hud-form-row");
    const ownerLabel = createHudElement("span", "hud-label", "GitHub Owner");
    ownerLabel.title = "GitHub Owner (active account)";
    const ownerInput = createHudElement("input", "hud-input");
    ownerInput.value = config.owner;
    ownerRow.appendChild(ownerLabel);
    ownerRow.appendChild(ownerInput);
    repoOwnerGrid.appendChild(ownerRow);
    body.appendChild(repoOwnerGrid);
    const ownerHintEl = createHudElement("div", "hud-account-hint");
    ownerHintEl.style.display = "none";
    body.appendChild(ownerHintEl);
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
    const accountWorkerGrid = createHudElement("div", "hud-account-worker-grid");
    const accountCol = createHudElement("div", "hud-form-row");
    const accountLabel = createHudElement("span", "hud-label", "Account");
    accountLabel.title = "GitHub Account Profile (active)";
    const accountBtnGroup = createHudElement("div", "hud-account-btns");
    const accountBtn1 = createHudElement("button", "hud-btn hud-btn-secondary", "\u{1F464} Acc 1");
    accountBtn1.type = "button";
    accountBtn1.title = "Switch to GitHub Account Profile 1";
    const accountBtn2 = createHudElement("button", "hud-btn hud-btn-secondary", "\u{1F464} Acc 2");
    accountBtn2.type = "button";
    accountBtn2.title = "Switch to GitHub Account Profile 2";
    accountBtnGroup.appendChild(accountBtn1);
    accountBtnGroup.appendChild(accountBtn2);
    accountCol.appendChild(accountLabel);
    accountCol.appendChild(accountBtnGroup);
    const workerUrlCol = createHudElement("div", "hud-form-row");
    const workerUrlLabel = createHudElement("span", "hud-label", "Worker URL");
    workerUrlLabel.title = "Worker URL (Edge Worker Endpoint)";
    const workerUrlInput = createHudElement("input", "hud-input");
    workerUrlInput.type = "url";
    workerUrlInput.placeholder = "https://<your-worker>.workers.dev";
    workerUrlInput.value = config.workerUrl;
    workerUrlInput.style.minWidth = "0";
    workerUrlCol.appendChild(workerUrlLabel);
    workerUrlCol.appendChild(workerUrlInput);
    accountWorkerGrid.appendChild(accountCol);
    accountWorkerGrid.appendChild(workerUrlCol);
    body.appendChild(accountWorkerGrid);
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
    const continueMixBtn = createHudElement("button", "hud-btn hud-btn-secondary", "\u23ED\uFE0F Next Parts");
    continueMixBtn.type = "button";
    continueMixBtn.style.display = "none";
    actionRow.appendChild(continueMixBtn);
    const batchFormulaBtn = createHudElement("button", "hud-btn hud-btn-secondary", "\u{1F9E9} Batch Formula");
    batchFormulaBtn.title = "Insert optimal V2 integratable batch prompt formula into chat";
    actionRow.appendChild(batchFormulaBtn);
    body.appendChild(actionRow);
    const togglesRow = createHudElement("div", "hud-toggles-row");
    const autoPilotGroup = createHudElement("div");
    autoPilotGroup.style.cssText = "display: flex; align-items: center; gap: 6px;";
    const autoPilotLabel = createHudElement("label", "hud-toggle-label");
    autoPilotLabel.title = "Auto-Pilot Self-Healing (max 3 retries)";
    const autoPilotCheck = createHudElement("input");
    autoPilotCheck.type = "checkbox";
    autoPilotCheck.checked = config.autoPilot;
    const autoPilotText = createHudElement("span", void 0, "\u{1F916} Auto-Pilot");
    autoPilotLabel.appendChild(autoPilotCheck);
    autoPilotLabel.appendChild(autoPilotText);
    const retryIndicator = createHudElement("span", "hud-retry-pill", "(" + state.retryCount + "/3)");
    autoPilotGroup.appendChild(autoPilotLabel);
    autoPilotGroup.appendChild(retryIndicator);
    const recentCommitsLabel = createHudElement("label", "hud-toggle-label");
    recentCommitsLabel.title = "Volatile Dateien & Letzte Commits in RepoMix einbeziehen";
    const recentCommitsCheck = createHudElement("input");
    recentCommitsCheck.type = "checkbox";
    recentCommitsCheck.checked = config.includeRecentCommits === true;
    const recentCommitsText = createHudElement("span", void 0, "\u{1F552} Letzte Commits");
    recentCommitsLabel.appendChild(recentCommitsCheck);
    recentCommitsLabel.appendChild(recentCommitsText);
    togglesRow.appendChild(autoPilotGroup);
    togglesRow.appendChild(recentCommitsLabel);
    body.appendChild(togglesRow);
    const queueHeaderRow = createHudElement("div");
    queueHeaderRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-top: 4px;";
    const queueLabel = createHudElement("span", "hud-label", "Harvested Patches");
    const queueActions = createHudElement("div");
    queueActions.style.cssText = "display: flex; gap: 6px;";
    const checkAllBtn = createHudElement("button", "hud-btn hud-btn-secondary", "\u{1F50D} Check All");
    checkAllBtn.style.cssText = "padding: 3px 8px; font-size: 11px;";
    checkAllBtn.title = "Dry-run preflight & syntax check across all harvested snippets without committing";
    const applyAllBtn = createHudElement("button", "hud-btn hud-btn-primary", "\u26A1 Apply All");
    applyAllBtn.style.cssText = "padding: 3px 8px; font-size: 11px;";
    const clearQueueBtn = createHudElement("button", "hud-btn hud-btn-secondary", "\u{1F5D1}\uFE0F Clear");
    clearQueueBtn.style.cssText = "padding: 3px 8px; font-size: 11px;";
    queueActions.appendChild(checkAllBtn);
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
      repoHistoryBtn,
      repoHistoryMenu,
      ownerInput,
      ownerHintEl,
      branchInput,
      targetBranchInput,
      workerUrlInput,
      accountBtn1,
      accountBtn2,
      secretInput,
      includePathsInput,
      maxChunkCharsInput,
      oidBadge,
      mixBtn,
      continueMixBtn,
      batchFormulaBtn,
      autoPilotCheck,
      recentCommitsCheck,
      retryIndicator,
      checkAllBtn,
      applyAllBtn,
      clearQueueBtn,
      patchQueueEl,
      emptyQueueMsg,
      statusBox
    };
  }

  // src/services/updateChecker.ts
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
  function isLegacyV2Running(running, latest) {
    return /^2\./.test(running.trim()) && /^0\./.test(latest.trim());
  }
  function evaluateUpdateState(currentVersion, latestVersion) {
    const running = (currentVersion || "").trim();
    const latest = (latestVersion || "").trim();
    const hasUpdate = Boolean(running) && (isLegacyV2Running(running, latest) || compareVersions(latest, running) > 0);
    return {
      currentVersion: running,
      latestVersion: latest,
      hasUpdate
    };
  }
  async function checkForScriptUpdate(options = {}) {
    if (!options.force && !isUpdateCheckDue()) return null;
    const latestVersion = await fetchLatestScriptVersion();
    setStoredValue(LAST_CHECK_KEY, String(Date.now()));
    return evaluateUpdateState(getRunningScriptVersion(), latestVersion);
  }

  // src/ui/updateBanner.ts
  var TRANSIENT_MESSAGE_MS = 6e3;
  function initHudUpdateBanner(dom, deps = {}) {
    const check = deps.check ?? checkForScriptUpdate;
    let hideTimer = null;
    let installUrl = "";
    let installVersion = "";
    const runningVersion = getRunningScriptVersion();
    if (runningVersion) {
      dom.updateCheckBtn.title = `Check published userscript version (running v${runningVersion})`;
    }
    dom.updateBanner.style.display = "none";
    const hide = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      installUrl = "";
      installVersion = "";
      dom.updateBanner.style.display = "none";
    };
    const show = (message, tone, action, persistent = false) => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      installUrl = action ? action.url : "";
      installVersion = action ? action.version : "";
      dom.updateBanner.className = `hud-update-banner ${tone}`;
      dom.updateBannerText.textContent = message;
      dom.updateBannerBtn.textContent = action ? action.label : "\xD7";
      dom.updateBannerBtn.title = action ? "Open the Tampermonkey update page" : "Dismiss";
      dom.updateBanner.style.display = "flex";
      if (!persistent) {
        hideTimer = setTimeout(hide, TRANSIENT_MESSAGE_MS);
      }
    };
    dom.updateBannerBtn.addEventListener("click", () => {
      if (!installUrl) {
        hide();
        return;
      }
      const targetUrl = installUrl;
      const targetVersion = installVersion;
      hide();
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(targetUrl, "_blank", "noopener");
      }
      show(
        targetVersion ? `\u2139\uFE0F Reload this page after installing v${targetVersion} to activate it.` : "\u2139\uFE0F Reload this page after installing the update to activate it.",
        "ok"
      );
    });
    const runCheck = async (force) => {
      dom.updateCheckBtn.disabled = true;
      try {
        const info = await check({ force });
        if (!info) return;
        if (!info.currentVersion) {
          const message = `\u26A0\uFE0F Running version unknown \u2014 published is v${info.latestVersion}. Reinstall the userscript if this persists.`;
          if (force) {
            show(message, "error", void 0, true);
          } else {
            console.warn("[Gemini Edge HUD]", message);
          }
          return;
        }
        if (info.hasUpdate) {
          show(
            `\u2B06 HUD v${info.latestVersion} is available (running v${info.currentVersion}).`,
            "update",
            {
              label: `\u2B06 Install v${info.latestVersion}`,
              url: buildUpdateUrl(info.latestVersion),
              version: info.latestVersion
            },
            true
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

  // src/services/repoHistory.ts
  var HISTORY_KEY = "repo_history_v1";
  var MAX_ENTRIES = 4;
  function historyKey() {
    try {
      return `${HISTORY_KEY}_${getActiveProfileId()}`;
    } catch {
      return HISTORY_KEY;
    }
  }
  function normalizeEntry(entry) {
    return {
      owner: (entry.owner || "").trim(),
      repo: (entry.repo || "").trim(),
      branch: (entry.branch || "").trim(),
      targetBranch: (entry.targetBranch || "").trim() || void 0
    };
  }
  function entryKey(e) {
    const n = normalizeEntry(e);
    return `${n.owner}|||${n.repo}|||${n.branch}|||${n.targetBranch || ""}`;
  }
  function loadRepoHistory() {
    try {
      const raw = getStoredValue(historyKey(), "");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      for (const p of parsed) {
        if (!p) continue;
        const n = normalizeEntry(p);
        if (!n.repo) continue;
        const key = entryKey(n);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(n);
      }
      return out.slice(0, MAX_ENTRIES);
    } catch {
      return [];
    }
  }
  function saveRepoHistory(entries) {
    try {
      const cleaned = entries.map(normalizeEntry).filter((e) => e.repo).slice(0, MAX_ENTRIES);
      setStoredValue(historyKey(), JSON.stringify(cleaned));
    } catch {
    }
  }
  function pushRepoHistory(entry) {
    const n = normalizeEntry(entry);
    if (!n.repo) return loadRepoHistory();
    const current = loadRepoHistory();
    const key = entryKey(n);
    const filtered = current.filter((e) => entryKey(e) !== key);
    const next = [n, ...filtered].slice(0, MAX_ENTRIES);
    saveRepoHistory(next);
    return next;
  }
  function recordFromConfig(cfg) {
    return pushRepoHistory({
      owner: cfg.owner || "",
      repo: cfg.repo || "",
      branch: cfg.branch || "",
      targetBranch: cfg.targetBranch || ""
    });
  }

  // src/ui/hudConfigBindings.ts
  var refreshRepoHistorySelect = null;
  function setRepoHistorySelectRefresher(fn) {
    refreshRepoHistorySelect = fn;
  }
  function refreshRepoHistorySelectNow() {
    refreshRepoHistorySelect?.();
  }
  function bindHudConfigInputs(deps) {
    const { dom, config, state, resetPatchOidState, clearTargetOidState: clearTargetOidState2, renderState } = deps;
    const recordCurrentHistory = () => {
      try {
        pushRepoHistory({
          owner: config.owner,
          repo: config.repo,
          branch: config.branch,
          targetBranch: config.targetBranch || ""
        });
      } catch {
      }
      refreshRepoHistorySelect?.();
    };
    dom.repoInput.onchange = () => {
      try {
        const sanitized = sanitizeRepo(sanitizeNoGithubPat(dom.repoInput.value.trim(), "repo"));
        const previousRepo = config.repo;
        config.repo = sanitized;
        dom.repoInput.value = sanitized;
        saveHudConfig({ repo: sanitized });
        if (sanitized !== previousRepo) resetPatchOidState(`Repository changed to "${sanitized}".`);
        recordCurrentHistory();
      } catch (e) {
        alert(e.message);
        dom.repoInput.value = config.repo;
      }
    };
    dom.ownerInput.onchange = () => {
      try {
        const sanitized = sanitizeNoGithubPat(dom.ownerInput.value.trim(), "owner");
        config.owner = sanitized;
        saveHudConfig({ owner: sanitized });
        recordCurrentHistory();
      } catch (e) {
        alert(e.message);
        dom.ownerInput.value = config.owner;
      }
    };
    dom.branchInput.onchange = () => {
      try {
        const sanitized = sanitizeNoGithubPat(dom.branchInput.value.trim(), "branch");
        const previousBranch = config.branch;
        config.branch = sanitized;
        saveHudConfig({ branch: sanitized });
        if (sanitized !== previousBranch) resetPatchOidState(`Branch changed to "${sanitized}".`);
        recordCurrentHistory();
      } catch (e) {
        alert(e.message);
        dom.branchInput.value = config.branch;
      }
    };
    dom.targetBranchInput.onchange = () => {
      try {
        const sanitized = sanitizeNoGithubPat(dom.targetBranchInput.value.trim(), "targetBranch");
        const previousTarget = config.targetBranch || "";
        config.targetBranch = sanitized;
        if (sanitized !== previousTarget) clearTargetOidState2(state);
        saveHudConfig({ targetBranch: sanitized });
        recordCurrentHistory();
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
    dom.workerUrlInput.onchange = () => {
      try {
        const sanitized = sanitizeNoGithubPat(dom.workerUrlInput.value.trim(), "workerUrl");
        const normalized = sanitized.replace(/\/+$/, "");
        config.workerUrl = normalized;
        dom.workerUrlInput.value = normalized;
        saveHudConfig({ workerUrl: normalized });
      } catch (e) {
        alert(e.message);
        dom.workerUrlInput.value = config.workerUrl;
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

  // src/ui/hudRepoHistoryDropdown.ts
  var activeDocumentClickHandler = null;
  var activeDocumentKeydownHandler = null;
  function formatRepoHistoryLabel(entry) {
    const repoLabel = entry.repo.includes("/") ? entry.repo : `${entry.owner}/${entry.repo}`;
    const target = entry.targetBranch ? ` -> ${entry.targetBranch}` : "";
    return `${repoLabel} @ ${entry.branch}${target}`;
  }
  function bindRepoHistoryDropdown(deps) {
    const { dom, config, state, resetPatchOidState, clearTargetOidState: clearTargetOidState2, refreshAccountHint: refreshAccountHint2, renderState } = deps;
    if (activeDocumentClickHandler) {
      document.removeEventListener("click", activeDocumentClickHandler);
      activeDocumentClickHandler = null;
    }
    if (activeDocumentKeydownHandler) {
      document.removeEventListener("keydown", activeDocumentKeydownHandler);
      activeDocumentKeydownHandler = null;
    }
    const closeMenu = () => {
      dom.repoHistoryMenu.style.display = "none";
      dom.repoHistoryBtn.setAttribute("aria-expanded", "false");
    };
    const openMenu = () => {
      dom.repoHistoryMenu.style.display = "flex";
      dom.repoHistoryBtn.setAttribute("aria-expanded", "true");
    };
    const onSelectEntry = (entry) => {
      const previousRepo = config.repo;
      const previousBranch = config.branch;
      const previousTarget = config.targetBranch || "";
      config.owner = entry.owner || config.owner;
      config.repo = sanitizeRepo(entry.repo || config.repo);
      config.branch = entry.branch || config.branch;
      config.targetBranch = entry.targetBranch || "";
      dom.ownerInput.value = config.owner;
      dom.repoInput.value = config.repo;
      dom.branchInput.value = config.branch;
      dom.targetBranchInput.value = config.targetBranch || "";
      saveHudConfig({
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        targetBranch: config.targetBranch
      });
      const repoOrBranchChanged = config.repo !== previousRepo || config.branch !== previousBranch;
      if (repoOrBranchChanged) {
        resetPatchOidState(`Switched to "${config.repo} @ ${config.branch}".`);
      } else if ((config.targetBranch || "") !== previousTarget) {
        clearTargetOidState2(state);
      }
      recordFromConfig(config);
      refresh();
      closeMenu();
      refreshAccountHint2();
      renderState();
    };
    const refresh = () => {
      const entries = loadRepoHistory();
      dom.repoHistoryMenu.textContent = "";
      if (entries.length === 0) {
        dom.repoHistoryBtn.disabled = true;
        dom.repoHistoryBtn.title = "No recent repositories";
        closeMenu();
        return;
      }
      dom.repoHistoryBtn.disabled = false;
      dom.repoHistoryBtn.title = "Recent Repositories";
      entries.forEach((entry) => {
        const label = formatRepoHistoryLabel(entry);
        const btn = createHudElement("button", "hud-repo-menu-item", label);
        btn.type = "button";
        btn.title = label;
        btn.onclick = (e) => {
          e.stopPropagation();
          onSelectEntry(entry);
        };
        dom.repoHistoryMenu.appendChild(btn);
      });
    };
    dom.repoHistoryMenu.onclick = (e) => e.stopPropagation();
    dom.repoHistoryBtn.onclick = (e) => {
      e.stopPropagation();
      if (dom.repoHistoryMenu.style.display === "none") {
        refresh();
        const entries = loadRepoHistory();
        if (entries.length > 0) {
          openMenu();
        }
      } else {
        closeMenu();
      }
    };
    const handleOutsideClick = (event) => {
      if (dom.repoHistoryMenu.style.display === "none") return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.includes(dom.repoHistoryBtn) || path.includes(dom.repoHistoryMenu)) {
        return;
      }
      const target = event.target;
      if (target) {
        if (dom.repoHistoryBtn.contains(target) || dom.repoHistoryMenu.contains(target)) {
          return;
        }
      }
      closeMenu();
    };
    dom.shadowRoot.addEventListener("click", handleOutsideClick);
    activeDocumentClickHandler = handleOutsideClick;
    document.addEventListener("click", handleOutsideClick);
    const handleKeydown = (event) => {
      if (event.key === "Escape" && dom.repoHistoryMenu.style.display !== "none") {
        closeMenu();
      }
    };
    dom.shadowRoot.addEventListener("keydown", handleKeydown);
    activeDocumentKeydownHandler = handleKeydown;
    document.addEventListener("keydown", handleKeydown);
    refresh();
    const refresher = Object.assign(
      () => {
        refresh();
      },
      {
        refresh: () => {
          refresh();
        },
        closeMenu: () => {
          closeMenu();
        }
      }
    );
    return refresher;
  }

  // src/services/accountProfiles.ts
  var ACCOUNT_PROFILES = [
    { id: "account1", label: "Account 1", workerName: "gemini-git-bridge" },
    { id: "account2", label: "Account 2", workerName: "gemini-git-bridge-account2" }
  ];
  function isProfileConfigured(cfg) {
    return Boolean(cfg.workerUrl && cfg.workerSecret);
  }
  function switchAccountProfile(target) {
    setStoredValue("active_profile", target);
    return loadHudConfig();
  }
  function switchAccountProfileWithRepo(target, repo) {
    const cleaned = sanitizeRepo(repo);
    if (cleaned) setStoredValue(`${target}_owner_repo`, cleaned);
    setStoredValue("active_profile", target);
    return loadHudConfig();
  }
  function ownerOfRepo(repo) {
    const cleaned = (repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "");
    return cleaned.split("/")[0].trim().toLowerCase();
  }
  function classifyRepoOwner(cfg) {
    const owner = ownerOfRepo(cfg.repo);
    if (!owner) return "empty";
    if (owner === (cfg.owner || "").trim().toLowerCase()) return "active";
    const active = getActiveProfileId();
    const other = active === "account1" ? "account2" : "account1";
    const otherOwner = getStoredValue(`${other}_owner`, "").trim().toLowerCase();
    if (otherOwner && owner === otherOwner) return other;
    return "foreign";
  }

  // src/ui/hudAccountSwitch.ts
  var activeDeps = null;
  function profileInfo(id) {
    return ACCOUNT_PROFILES.find((p) => p.id === id) ?? ACCOUNT_PROFILES[0];
  }
  function updateAccountButtons() {
    if (!activeDeps) return;
    const active = getActiveProfileId();
    const setBtn = (btn, id) => {
      if (id === active) {
        btn.className = "hud-btn hud-btn-primary";
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.className = "hud-btn hud-btn-secondary";
        btn.setAttribute("aria-pressed", "false");
      }
    };
    setBtn(activeDeps.dom.accountBtn1, "account1");
    setBtn(activeDeps.dom.accountBtn2, "account2");
  }
  function refreshAccountHint() {
    if (!activeDeps) return;
    const { dom, config } = activeDeps;
    const hint = dom.ownerHintEl;
    const match = classifyRepoOwner(config);
    if (match === "active" || match === "empty") {
      hint.textContent = "";
      hint.className = "hud-account-hint";
      hint.style.display = "none";
      return;
    }
    hint.textContent = "";
    hint.className = match === "foreign" ? "hud-account-hint foreign" : "hud-account-hint";
    hint.style.display = "block";
    if (match === "foreign") {
      hint.textContent = `\u26A0\uFE0F Owner "${ownerOfRepo(config.repo)}" ist keiner der registrierten GitHub-Accounts. \xD6ffentliche Repos k\xF6nnen weiterhin gemischt werden; Patches sind blockiert (kein PAT f\xFCr diesen Owner). Private Fremd-Repos scheitern auch beim Mix.`;
      return;
    }
    const info = profileInfo(match);
    const text = createHudElement("span", void 0, `\u26A0\uFE0F Dieses Repo geh\xF6rt zu ${info.label} (${info.workerName}).`);
    const switchBtn = createHudElement("button", "hud-btn hud-btn-secondary", `\u{1F501} Zu ${info.label} wechseln`);
    switchBtn.type = "button";
    switchBtn.onclick = () => switchViaHint(match);
    hint.appendChild(text);
    hint.appendChild(switchBtn);
  }
  function confirmSwitchDiscard(target) {
    if (!activeDeps) return false;
    const count = activeDeps.state.harvestedPatches.length;
    if (count === 0) return true;
    const info = profileInfo(target);
    return window.confirm(
      `${count} geerntete Patches geh\xF6ren zum aktiven Account und werden beim Wechsel zu ${info.label} verworfen. Trotzdem wechseln?`
    );
  }
  function switchViaHint(target) {
    if (!activeDeps) return;
    if (!confirmSwitchDiscard(target)) return;
    applySwitched(switchAccountProfileWithRepo(target, activeDeps.dom.repoInput.value), target);
  }
  function applySwitched(next, target) {
    if (!activeDeps) return;
    const { dom, config, state, resetPatchOidState, renderState } = activeDeps;
    const info = profileInfo(target);
    Object.assign(config, next);
    dom.ownerInput.value = next.owner;
    dom.workerUrlInput.value = next.workerUrl;
    dom.secretInput.value = next.workerSecret;
    dom.repoInput.value = next.repo;
    dom.branchInput.value = next.branch;
    dom.targetBranchInput.value = next.targetBranch || "";
    state.harvestedPatches = [];
    if (!isProfileConfigured(next)) {
      resetPatchOidState(
        `\u26A0\uFE0F ${info.label} ist noch nicht konfiguriert \u2014 Worker URL, Secret, Owner und Repo eintragen (Felder speichern beim Verlassen).`
      );
    } else {
      resetPatchOidState(`Account gewechselt zu ${info.label} (${info.workerName}) \u2014 Snapshot-OIDs zur\xFCckgesetzt.`);
    }
    updateAccountButtons();
    refreshAccountHint();
    recordFromConfig(config);
    refreshRepoHistorySelectNow();
    renderState();
  }
  function bindAccountSwitch(deps) {
    activeDeps = deps;
    const { dom } = deps;
    dom.accountBtn1.onclick = () => {
      if (!confirmSwitchDiscard("account1")) return;
      applySwitched(switchAccountProfile("account1"), "account1");
    };
    dom.accountBtn2.onclick = () => {
      if (!confirmSwitchDiscard("account2")) return;
      applySwitched(switchAccountProfile("account2"), "account2");
    };
    dom.repoInput.addEventListener("change", refreshAccountHint);
    dom.ownerInput.addEventListener("change", refreshAccountHint);
    return () => {
      updateAccountButtons();
      refreshAccountHint();
    };
  }

  // src/dom/injector.ts
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
    const existingText = inputEl instanceof HTMLTextAreaElement || "value" in inputEl ? inputEl.value : inputEl.textContent || "";
    const needsLeadingNewline = existingText.length > 0 && !/\r?\n$/.test(existingText);
    const cleanPromptText = (needsLeadingNewline ? `

${promptText}` : promptText).replace(/\u200B/g, "");
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, cleanPromptText);
    } catch (e) {
      inserted = false;
    }
    if (!inserted) {
      if (inputEl instanceof HTMLTextAreaElement || "value" in inputEl) {
        const textarea = inputEl;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        textarea.value = textarea.value.slice(0, start) + cleanPromptText + textarea.value.slice(end);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        inputEl.textContent = (inputEl.textContent || "") + cleanPromptText;
        inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: cleanPromptText }));
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

  // src/services/selfHealing.ts
  var MAX_SELF_HEALING_RETRIES = 3;
  function buildSelfHealingPrompt(errors, repo, branch, headOid, retryAttempt, options) {
    const formattedErrors = errors.map((err, idx) => {
      const loc = err.line ? err.column ? `:${err.line}:${err.column}` : `:${err.line}` : "";
      const snippet = err.codeSnippet ? `
   > ${err.codeSnippet}` : "";
      return `${idx + 1}. [Stage: ${err.stage}] ${err.file}${loc} \u2014 ${err.message}${snippet}`;
    }).join("\n");
    const targetBranch = options?.targetBranch?.trim() || branch;
    const targetFilesStr = options?.targetFiles && options.targetFiles.length > 0 ? options.targetFiles.join(", ") : "(resolve all affected files from errors below)";
    return `#solve Linter & Preflight Self-Healing Loop (Retry ${retryAttempt}/${MAX_SELF_HEALING_RETRIES})

The previous patch for repository "${repo}" on branch "${targetBranch}" was rejected during preflight validation.
Expected HEAD commit: "${headOid}".
Target Files in Scope: ${targetFilesStr}

Aggregated Preflight & Snippet Errors (${errors.length}):
${formattedErrors}

Fix Instructions:
1. Fix ALL listed syntax, missing-path, and rule errors across all affected files in a single cohesive response.
2. Hard Guardrail: NEVER use placeholder comments like "// ... existing code ...", "/* remaining code */", or "# ... existing code ...". Always provide complete search/replace blocks or full file content.
3. Anchor Context: Provide 2\u20134 lines of verbatim surrounding context in each search block so patches match unambiguously. Never reorder or alter union types in unmodified signature anchors.
4. Output Format: Emit exactly ONE directly importable Markdown/JSON patch block (\`\`\`json or \`\`\`md) containing a single valid GeminiPatchPayload JSON object. Every patch in "patches" MUST include an exact repo-relative "path" (e.g. "src/App.tsx") and at most one entry per file:
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
  function executeSelfHealingTurn(response, cfg, state, autoSubmit = true, targetFiles) {
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
      evalResult.nextRetryCount,
      {
        targetFiles,
        targetBranch: cfg.targetBranch?.trim() || void 0
      }
    );
    injectPromptText(prompt, autoSubmit);
    return {
      triggered: true,
      nextRetryCount: evalResult.nextRetryCount,
      prompt,
      reason: evalResult.reason
    };
  }

  // src/ui/hudRender.ts
  function renderHudState({ dom, state, config, updateState, onApplyPatch }) {
    dom.triggerBadge.className = `hud-trigger-badge ${state.status.toLowerCase()}`;
    dom.triggerBadge.textContent = state.status;
    if (state.headOid) {
      dom.oidBadge.textContent = state.headOid;
      dom.oidBadge.style.color = "#6ee7b7";
    } else {
      dom.oidBadge.textContent = "(Not mixed yet)";
      dom.oidBadge.style.color = "#94a3b8";
    }
    dom.retryIndicator.textContent = `(${state.retryCount}/3)`;
    dom.retryIndicator.title = `Self-Healing Retries: ${state.retryCount}/3`;
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
        const targetFiles = [];
        for (const p of state.harvestedPatches) {
          for (const op of p.payload?.patches || []) {
            if (op.path && !targetFiles.includes(op.path)) targetFiles.push(op.path);
          }
        }
        const prompt = buildSelfHealingPrompt(
          state.lastErrors,
          config.repo,
          config.branch,
          state.headOid,
          nextRetry,
          {
            targetFiles,
            targetBranch: config.targetBranch?.trim() || void 0
          }
        );
        injectPromptText(prompt, false);
        updateState({
          retryCount: nextRetry,
          statusMessage: `\u{1F527} Injected self-healing prompt (Turn ${nextRetry}/${MAX_SELF_HEALING_RETRIES}) into chat.`
        });
      };
      dom.statusBox.appendChild(healBtn);
    }
    const patchCount = state.harvestedPatches.length;
    const isBusy = state.status === "PATCHING" || state.status === "MIXING";
    if (state.continuationQueue && state.continuationQueue.length > 0) {
      const nextBatch = state.continuationQueue.slice(0, 10);
      const first = nextBatch[0]?.partIndex ?? 11;
      const last = nextBatch[nextBatch.length - 1]?.partIndex ?? first;
      const fileCount = nextBatch.reduce((sum, p) => sum + (p.stats?.fileCount ?? 0), 0);
      const totalRemaining = state.continuationQueue.length;
      dom.continueMixBtn.style.display = "inline-flex";
      dom.continueMixBtn.disabled = isBusy;
      dom.continueMixBtn.textContent = `\u23ED\uFE0F Parts ${first}\u2013${last}`;
      dom.continueMixBtn.title = `Inject Parts ${first}\u2013${last} (${fileCount} files, ${totalRemaining} part(s) remaining in queue)`;
    } else {
      dom.continueMixBtn.style.display = "none";
    }
    dom.checkAllBtn.disabled = patchCount === 0 || isBusy;
    dom.checkAllBtn.textContent = patchCount > 0 ? `\u{1F50D} Check (${patchCount})` : "\u{1F50D} Check All";
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
          onApplyPatch(patch);
        };
        meta.appendChild(itemTitle);
        meta.appendChild(itemSub);
        item.appendChild(meta);
        item.appendChild(applyBtn);
        dom.patchQueueEl.appendChild(item);
      });
    }
  }

  // src/services/workerClient.ts
  function isV2ErrorPayload(data) {
    if (!data || typeof data !== "object") {
      return false;
    }
    const payload = data;
    return typeof payload.status === "string" || typeof payload.errorMessage === "string" || Array.isArray(payload.errors);
  }
  function shouldResolveV2Error(status, data) {
    return (status === 400 || status === 409) && isV2ErrorPayload(data);
  }
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
              } else if (shouldResolveV2Error(res.status, data)) {
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
        if (shouldResolveV2Error(res.status, data)) {
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
      if (shouldResolveV2Error(res.status, data)) {
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
      maxChunkChars: req?.maxChunkChars ?? (cfg.maxChunkChars !== 85e3 ? cfg.maxChunkChars : void 0),
      maxChunkBytes: req?.maxChunkBytes,
      maxChunkTokens: req?.maxChunkTokens,
      splitOutput: req?.splitOutput,
      includeRecentCommits: req?.includeRecentCommits ?? cfg.includeRecentCommits,
      enableContinuation: req?.enableContinuation ?? true
    };
    return gmRequestJson(url, "POST", cfg.workerSecret, payload);
  }
  async function requestWorkerPatch(cfg, req) {
    const url = `${cfg.workerUrl}/api/patch`;
    return gmRequestJson(url, "POST", cfg.workerSecret, req);
  }
  var OID_REGEX2 = /^[0-9a-f]{40}$/i;
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
    return OID_REGEX2.test(String(oid || "")) ? String(oid) : "";
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

  // src/services/batchFormula.ts
  function buildBatchFormulaPrompt(config, state) {
    const sourceBranch = config.branch?.trim() || "main";
    const branchLabel = config.targetBranch?.trim() || sourceBranch;
    const sourceHint = branchLabel !== sourceBranch ? `, source branch: ${sourceBranch}` : "";
    const headLabel = state.headOid ? ` (base headOid: ${state.headOid.slice(0, 7)}${sourceHint})` : "";
    const scopeLabel = config.includePaths?.length ? `
- Active path scope: ${config.includePaths.join(", ")}` : "";
    const placeholderExample = "// ... existing code ...";
    return [
      `Output all code changes for this batch as a SINGLE atomic V2 GeminiPatchPayload JSON code block targeting ${config.repo}@${branchLabel}${headLabel}.${scopeLabel}`,
      "Batch Integration Rules:",
      '1. Emit exactly ONE ```json block with top-level keys "commitMessage" and "patches" (do NOT include worker request fields like branch or expectedHeadOid, and do NOT emit any other fenced code blocks in your response).',
      '2. Consolidate edits so each file path appears at most ONCE in "patches":',
      '   - Existing files: { "path": "repo/relative/path.ts", "action": "modify", "blocks": [{ "search": "...", "replace": "..." }] }',
      '   - New files: { "path": "repo/relative/new.ts", "action": "create", "fullContent": "..." }',
      '   - Deleted files: { "path": "repo/relative/old.ts", "action": "delete" }',
      '3. Every "search" string MUST include 2-4 lines of unique verbatim surrounding context from the RepoMix snapshot (order multiple blocks top-to-bottom; start "search" anchors BELOW unchanged function/type signatures or copy unchanged lines 1:1 without reordering union types).',
      `4. NEVER use placeholders ("${placeholderExample}", "/* rest unchanged */") or unclosed brackets/JSX tags.`,
      "5. NEVER patch paths listed in <omitted_files>, read-only legacy trees (_v1_backup/, cf-gemini-git-bridge/), or generated bundles (gemini-bridge.user.js, dist/)."
    ].join("\n");
  }

  // src/ui/hudMixAction.ts
  function bindMixAction({ dom, config, state, updateState }) {
    dom.mixBtn.onclick = async () => {
      try {
        dom.mixBtn.disabled = true;
        dom.mixBtn.style.opacity = "0.6";
        updateState({
          status: "MIXING",
          statusMessage: `\u23F3 Streaming repo mix for ${config.repo} (${config.branch})...`,
          continuationQueue: []
        });
        const res = await requestRepoMix(config);
        if (res.status === "OK" && (res.parts?.length || res.xmlContent)) {
          setSourceHeadOid(config, state, res.headOid);
          try {
            recordFromConfig(config);
            refreshRepoHistorySelectNow();
          } catch {
          }
          state.lastMixStats = res.stats;
          let injected = false;
          const metaCommits = res.stats.recentCommitsCount ? ` (incl. ${res.stats.recentCommitsCount} recent commits, ${res.stats.volatileFilesCount ?? 0} volatile files)` : "";
          const skipped = res.skippedFiles || [];
          const skippedNotice = skipped.length > 0 ? ` | Skipped ${skipped.length} file(s)${skipped.length <= 3 ? ": " + skipped.slice(0, 3).map((s) => s.path.split("/").pop()).join(", ") + (skipped.length > 3 ? "..." : "") : ""} \u2014 see details (add to .repomixignore.cf or narrow includePaths)` : "";
          const truncation = res.truncation;
          const nextContinuation = res.continuationParts ? [...res.continuationParts] : [];
          const continuationNoticeHint = nextContinuation.length > 0 ? ` \u2014 click "\u23ED\uFE0F Parts 11\u2013${10 + Math.min(10, nextContinuation.length)}" in Prompt 2` : "";
          const truncationNotice = truncation ? ` | \u26A0\uFE0F Truncated: ${truncation.includedFiles}/${truncation.totalFiles} files (${truncation.omittedFiles.length} omitted${truncation.omittedFiles.length <= 3 ? ": " + truncation.omittedFiles.slice(0, 3).map((entry) => entry.path.split("/").pop()).join(", ") : ""})${continuationNoticeHint} \u2014 add to .repomixignore.cf or narrow includePaths` : "";
          const slotNotice = res.parts && res.parts.length >= 9 ? ` | \u26A0\uFE0F Using ${res.parts.length}/10 Gemini attachment slots; existing prompt attachments may trigger the 10-file warning` : "";
          if (res.parts && res.parts.length > 1) {
            const partBreakdown = res.parts.map((p) => `P${p.partIndex}: ${(p.stats.charCount ?? p.xmlContent.length).toLocaleString()} chars`).join(", ");
            injected = injectRepoMixParts(
              res.parts.map((p) => ({ fileName: p.fileName, xmlContent: p.xmlContent }))
            );
            updateState({
              status: "IDLE",
              continuationQueue: nextContinuation,
              statusMessage: `\u2705 Loaded ${res.parts.length} parts (${res.stats.fileCount} files${metaCommits}, ~${res.stats.estimatedTokens} tokens) [${partBreakdown}]. Head: ${res.headOid.slice(0, 7)}${injected ? " (Injected into chat prompt)" : ""}${skippedNotice}${truncationNotice}${slotNotice}`
            });
          } else {
            injected = injectRepoMixFile(res.xmlContent);
            const charLen = res.stats.charCount ?? res.xmlContent.length;
            updateState({
              status: "IDLE",
              continuationQueue: nextContinuation,
              statusMessage: `\u2705 Loaded ${res.stats.fileCount} files${metaCommits} (${charLen.toLocaleString()} chars, ~${res.stats.estimatedTokens} tokens). Head: ${res.headOid.slice(0, 7)}${injected ? " (Injected into chat prompt)" : ""}${skippedNotice}${truncationNotice}${slotNotice}`
            });
          }
        } else {
          const skipped = res.skippedFiles || [];
          const skippedNotice = skipped.length > 0 ? ` | Skipped ${skipped.length} file(s) (add to .repomixignore.cf or narrow includePaths)` : "";
          updateState({
            status: "ERROR",
            statusMessage: `\u274C Mix error: ${res.errorMessage || "Unknown error"}${skippedNotice}`
          });
        }
      } catch (err) {
        updateState({
          status: "ERROR",
          statusMessage: `\u274C Mix error: ${err.message || String(err)}`
        });
      } finally {
        dom.mixBtn.disabled = false;
        dom.mixBtn.style.opacity = "1";
      }
    };
    dom.continueMixBtn.onclick = () => {
      if (!state.continuationQueue || state.continuationQueue.length === 0) return;
      const batch = state.continuationQueue.slice(0, 10);
      if (batch.length === 0) return;
      const first = batch[0].partIndex;
      const last = batch[batch.length - 1].partIndex;
      const promptEl = findPromptInputElement();
      if (!promptEl) {
        updateState({
          status: "ERROR",
          statusMessage: "\u274C Cannot inject continuation parts: chat prompt input element not found in DOM."
        });
        return;
      }
      const promptText = ("value" in promptEl ? promptEl.value : promptEl.textContent) || "";
      if (promptText.trim().length === 0) {
        injectPromptText(
          `[RepoMix Continuation: Parts ${first}\u2013${last} for ${config.repo} (${config.branch})]`,
          false
        );
      }
      const injected = injectRepoMixParts(
        batch.map((p) => ({ fileName: p.fileName, xmlContent: p.xmlContent }))
      );
      if (injected) {
        const remainingQueue = state.continuationQueue.slice(batch.length);
        state.continuationQueue = remainingQueue;
        const remainingNotice = remainingQueue.length > 0 ? ` (${remainingQueue.length} continuation part(s) remaining)` : "";
        updateState({
          status: "IDLE",
          continuationQueue: remainingQueue,
          statusMessage: `\u2705 Injected continuation Parts ${first}\u2013${last} into chat prompt${remainingNotice}.`
        });
      } else {
        updateState({
          statusMessage: `\u274C Failed to inject continuation Parts ${first}\u2013${last} into chat prompt. Focus prompt input and try again.`
        });
      }
    };
    dom.batchFormulaBtn.onclick = () => {
      const injected = injectPromptText(buildBatchFormulaPrompt(config, state), false);
      updateState({
        statusMessage: injected ? "\u{1F4CB} Injected optimal V2 Batch Formula into chat prompt." : "\u274C Could not find the chat prompt input to inject the Batch Formula."
      });
    };
  }

  // src/services/patchPaths.ts
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

  // src/ui/hudApplyPatch.ts
  async function applyHudPatch(patch, { config, state, openPanel, updateState, onApplyPatchCustom }) {
    if (onApplyPatchCustom) {
      return onApplyPatchCustom(patch);
    }
    openPanel();
    const ownerMatch = classifyRepoOwner(config);
    if (ownerMatch === "foreign") {
      updateState({
        status: "ERROR",
        statusMessage: `\u274C Patch blockiert: "${ownerOfRepo(config.repo)}" ist keiner der registrierten GitHub-Accounts. \xD6ffentliche Repos k\xF6nnen weiterhin gemischt werden, aber Commits brauchen einen PAT f\xFCr diesen Owner.`
      });
      return false;
    }
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
      updateState({
        status: "ERROR",
        statusMessage: `\u274C ${resolvedPaths.reason}`
      });
      return false;
    }
    const effectivePayload = resolvedPaths.payload;
    state.harvestedPatches = state.harvestedPatches.map(
      (entry) => entry.id === patch.id ? { ...entry, payload: effectivePayload } : entry
    );
    updateState({
      status: "PATCHING",
      statusMessage: `\u23F3 Applying patch: "${patch.commitMessage}"...`
    });
    try {
      if (!isPatchSnapshotReady(state)) {
        updateState({
          status: "PATCHING",
          statusMessage: `\u{1F504} No snapshot OID \u2014 resolving current HEAD of ${config.repo}@${config.branch}...`
        });
        try {
          const resolvedOid = await requestBranchHead(config, config.repo, config.branch);
          setSourceHeadOid(config, state, resolvedOid);
          updateState({
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
          updateState({
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
            updateState({
              status: "PREFLIGHT_FAILED",
              statusMessage: `\u26A0\uFE0F Preflight failed. \u{1F916} Auto-Pilot self-healing prompt injected (Turn ${selfHealingResult.nextRetryCount}/${MAX_SELF_HEALING_RETRIES}).`,
              retryCount: selfHealingResult.nextRetryCount,
              lastErrors: res.errors || []
            });
          } else {
            const reasonMsg = selfHealingResult.reason === "MAX_RETRIES_EXCEEDED" ? `Max retries (${MAX_SELF_HEALING_RETRIES}) reached.` : "Auto-pilot disabled.";
            updateState({
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
          updateState({
            status: res.status,
            statusMessage: `\u274C ${res.status}: ${res.errorMessage || "Preflight / Concurrency check failed"}${scopeHint}${recoveryHint}`,
            lastErrors: res.errors || []
          });
          return false;
        }
        if (res.status === "NO_CHANGES_NEEDED") {
          state.harvestedPatches = removeHarvestedPatch(state.harvestedPatches, patch.id);
          applyPatchResponseOids(config, state, res);
          updateState({
            status: "IDLE",
            statusMessage: `\u2139\uFE0F No changes needed (idempotent patch).`
          });
          return true;
        }
      }
      throw new Error(patchSnapshotRequiredMessage(config, patch.commitMessage));
    } catch (err) {
      updateState({
        status: "ERROR",
        statusMessage: `\u274C Patch error: ${err.message || String(err)}`
      });
      return false;
    }
  }
  async function runHolisticQueuePatch(deps) {
    deps.openPanel();
    if (!deps.dryRun) {
      const ownerMatch = classifyRepoOwner(deps.config);
      if (ownerMatch === "foreign") {
        deps.updateState({
          status: "ERROR",
          statusMessage: `\u274C Patch blockiert: "${ownerOfRepo(deps.config.repo)}" ist keiner der registrierten GitHub-Accounts. \xD6ffentliche Repos k\xF6nnen weiterhin gemischt werden, aber Commits brauchen einen PAT f\xFCr diesen Owner.`
        });
        return false;
      }
    }
    if (deps.state.harvestedPatches.length === 0) {
      return false;
    }
    const partition = partitionQueueForHolisticCheck(deps.state.harvestedPatches);
    const totalSnippets = partition.totalSnippets;
    const targetFiles = partition.targetFiles;
    deps.updateState({
      status: "PATCHING",
      statusMessage: deps.dryRun ? `\u23F3 Checking ${totalSnippets} snippet(s) across ${targetFiles.length} file(s) (Dry-Run)...` : `\u23F3 Validating and applying ${totalSnippets} snippet(s) across ${targetFiles.length} file(s)...`
    });
    try {
      if (!isPatchSnapshotReady(deps.state)) {
        deps.updateState({
          status: "PATCHING",
          statusMessage: `\u{1F504} No snapshot OID \u2014 resolving current HEAD of ${deps.config.repo}@${deps.config.branch}...`
        });
        try {
          const resolvedOid = await requestBranchHead(deps.config, deps.config.repo, deps.config.branch);
          setSourceHeadOid(deps.config, deps.state, resolvedOid);
        } catch (resolveErr) {
          deps.updateState({
            status: "ERROR",
            statusMessage: `\u274C HEAD lookup failed: ${resolveErr.message || String(resolveErr)}`
          });
          return false;
        }
      }
      let workerRes;
      if (partition.validBatch && deps.state.headOid) {
        const effectiveDryRun = deps.dryRun || partition.localErrors.length > 0;
        const patchReq = buildWorkerPatchRequest(
          deps.config,
          deps.state,
          partition.validBatch.payload,
          effectiveDryRun
        );
        workerRes = await requestWorkerPatch(deps.config, patchReq);
        if (workerRes.status === "GIT_CONFLICT" || workerRes.status === "ERROR") {
          const scopeHint = workerRes.status === "GIT_CONFLICT" ? ` [validated ${deps.config.repo}@${deps.config.branch}]` : "";
          const resetScope = resolveConflictOidReset(workerRes);
          if (resetScope === "source") {
            clearPatchOidState(deps.state);
          } else if (resetScope === "target") {
            clearTargetOidState(deps.state);
          }
          deps.updateState({
            status: workerRes.status,
            statusMessage: `\u274C ${workerRes.status}: ${workerRes.errorMessage || "Preflight / Concurrency check failed"}${scopeHint}`,
            lastErrors: workerRes.errors || []
          });
          return false;
        }
      }
      const allErrors = [
        ...partition.localErrors,
        ...workerRes?.errors || []
      ];
      if (allErrors.length > 0) {
        deps.onMarkQueueSuperseded?.(deps.state.harvestedPatches.map((p) => p.id));
        const syntheticRes = {
          status: "PREFLIGHT_FAILED",
          errors: allErrors
        };
        const selfHealingResult = executeSelfHealingTurn(syntheticRes, deps.config, deps.state, true, targetFiles);
        if (selfHealingResult.triggered) {
          deps.updateState({
            status: "PREFLIGHT_FAILED",
            statusMessage: `\u26A0\uFE0F Holistic validation failed (${allErrors.length} error(s) across ${totalSnippets} snippet(s)). \u{1F916} Auto-Pilot self-healing prompt injected (Turn ${selfHealingResult.nextRetryCount}/${MAX_SELF_HEALING_RETRIES}).`,
            retryCount: selfHealingResult.nextRetryCount,
            lastErrors: allErrors
          });
        } else {
          const reasonMsg = selfHealingResult.reason === "MAX_RETRIES_EXCEEDED" ? `Max retries (${MAX_SELF_HEALING_RETRIES}) reached.` : "Auto-pilot disabled.";
          deps.updateState({
            status: "PREFLIGHT_FAILED",
            statusMessage: `\u274C Holistic validation failed (${allErrors.length} error(s) across ${totalSnippets} snippet(s)). ${reasonMsg} Review errors below or trigger manual retry.`,
            retryCount: selfHealingResult.nextRetryCount,
            lastErrors: allErrors
          });
        }
        return false;
      }
      if (deps.dryRun || workerRes?.status === "VALIDATED") {
        deps.updateState({
          status: "IDLE",
          statusMessage: `\u2705 All ${totalSnippets} snippet(s) across ${targetFiles.length} file(s) passed preflight & syntax validation! Click "\u26A1 Apply All" to commit.`,
          lastErrors: [],
          retryCount: 0
        });
        return true;
      }
      if (workerRes?.status === "COMMITTED" || workerRes?.status === "NO_CHANGES_NEEDED") {
        deps.state.harvestedPatches = [];
        applyPatchResponseOids(deps.config, deps.state, workerRes);
        const branchLabel = workerRes.targetBranch || deps.config.targetBranch?.trim() || deps.config.branch;
        const prMsg = workerRes.pullRequestUrl ? ` | \u{1F517} PR: ${workerRes.pullRequestUrl}` : "";
        const commitMsg = workerRes.status === "NO_CHANGES_NEEDED" ? "\u2139\uFE0F All snippets already up-to-date (no changes needed)." : `\u2705 Committed ${totalSnippets} snippet(s) across ${targetFiles.length} file(s) to ${branchLabel}: ${workerRes.newHeadOid ? workerRes.newHeadOid.slice(0, 7) : "OK"}${prMsg}`;
        deps.updateState({
          status: workerRes.status === "NO_CHANGES_NEEDED" ? "IDLE" : "COMMITTED",
          statusMessage: commitMsg,
          lastErrors: [],
          retryCount: 0
        });
        return true;
      }
      return false;
    } catch (err) {
      deps.updateState({
        status: "ERROR",
        statusMessage: `\u274C Holistic queue error: ${err.message || String(err)}`
      });
      return false;
    }
  }

  // src/ui/shadowHud.ts
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
      harvestedPatches: [],
      continuationQueue: []
    };
    const dom = buildHudDomTree(config, state);
    const runningVersion = getRunningScriptVersion();
    if (runningVersion && dom.title) {
      dom.title.textContent = `\u26A1 Cloudflare Edge HUD v${runningVersion}`;
    }
    initHudUpdateBanner(dom);
    function updateState(partial) {
      Object.assign(state, partial);
      renderState();
    }
    function resetPatchOidState(reason) {
      clearPatchOidState(state);
      state.continuationQueue = [];
      updateState({
        status: "IDLE",
        statusMessage: `\u{1F504} ${reason} Snapshot OID reset \u2014 click "Load Repo Mix" before applying patches.`,
        retryCount: 0,
        lastErrors: [],
        continuationQueue: []
      });
    }
    function renderState() {
      renderHudState({
        dom,
        state,
        config,
        updateState: (partial) => updateState(partial),
        onApplyPatch: (patch) => {
          void handleApplyPatch(patch);
        }
      });
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
    const refreshRepoHistoryDropdown = bindRepoHistoryDropdown({
      dom,
      config,
      state,
      resetPatchOidState,
      clearTargetOidState,
      refreshAccountHint,
      renderState
    });
    bindHudConfigInputs({
      dom,
      config,
      state,
      resetPatchOidState,
      clearTargetOidState,
      renderState
    });
    setRepoHistorySelectRefresher(refreshRepoHistoryDropdown);
    const applyAccountSwitch = bindAccountSwitch({ dom, config, state, resetPatchOidState, renderState });
    applyAccountSwitch();
    bindMixAction({
      dom,
      config,
      state,
      updateState: (partial) => updateState(partial)
    });
    const handleApplyPatch = (patch) => applyHudPatch(patch, {
      config,
      state,
      openPanel,
      updateState: (partial) => updateState(partial),
      onApplyPatchCustom
    });
    let supersededPatchIds = /* @__PURE__ */ new Set();
    dom.clearQueueBtn.onclick = () => {
      state.harvestedPatches = [];
      supersededPatchIds.clear();
      renderState();
    };
    dom.checkAllBtn.onclick = async () => {
      if (state.harvestedPatches.length === 0 || state.status === "PATCHING" || state.status === "MIXING") return;
      await runHolisticQueuePatch({
        config,
        state,
        openPanel,
        updateState: (partial) => updateState(partial),
        dryRun: true,
        onMarkQueueSuperseded: (ids) => {
          supersededPatchIds = new Set(ids);
        }
      });
    };
    dom.applyAllBtn.onclick = async () => {
      if (state.harvestedPatches.length === 0 || state.status === "PATCHING" || state.status === "MIXING") return;
      if (onApplyPatchCustom) {
        const { applied, total } = await runPatchQueue(
          state.harvestedPatches,
          handleApplyPatch,
          (patch, index, totalCount) => {
            updateState({
              status: "PATCHING",
              statusMessage: `\u23F3 [${index + 1}/${totalCount}] Applying patch: "${patch.commitMessage}"...`
            });
          }
        );
        if (applied === total) {
          updateState({
            status: "COMMITTED",
            statusMessage: `\u{1F389} All ${applied} patches successfully applied and committed!`
          });
        }
        return;
      }
      await runHolisticQueuePatch({
        config,
        state,
        openPanel,
        updateState: (partial) => updateState(partial),
        dryRun: false,
        onMarkQueueSuperseded: (ids) => {
          supersededPatchIds = new Set(ids);
        }
      });
    };
    const controller = {
      getState: () => ({ ...state }),
      updateState: (partial) => {
        updateState(partial);
      },
      openPanel,
      closePanel,
      handleApplyPatch,
      addHarvestedPatch: (patch) => {
        if (supersededPatchIds.size > 0) {
          state.harvestedPatches = state.harvestedPatches.filter((p) => !supersededPatchIds.has(p.id));
          supersededPatchIds.clear();
        }
        const next = enqueueHarvestedPatch(state.harvestedPatches, patch);
        if (next === state.harvestedPatches) return;
        state.harvestedPatches = next;
        renderState();
      }
    };
    renderState();
    return controller;
  }

  // src/dom/pathHints.ts
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

  // src/dom/harvester.ts
  function isSearchReplace(text) {
    return text.includes("<<<<<<<") && text.includes("=======") && text.includes(">>>>>>>");
  }
  function parseV2PatchPayloadFromCode(codeText) {
    if (!codeText || codeText.trim().length === 0) return null;
    let textToParse = codeText.trim();
    const fenceMatch = textToParse.match(/^```(?:json|md|markdown)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) {
      textToParse = fenceMatch[1].trim();
    }
    const innerJsonFence = textToParse.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
    if (innerJsonFence) {
      textToParse = innerJsonFence[1].trim();
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
  function extractSectionPath(sectionText) {
    if (!sectionText || !sectionText.trim()) return "";
    const fromCode = extractPathFromCode(sectionText);
    if (fromCode) return normalizeRepoPath(fromCode);
    const headerMatch = sectionText.match(/(?:^|\r?\n)\s*#{1,6}\s*([^\r\n]+)/);
    if (headerMatch && headerMatch[1]) {
      const cleaned = headerMatch[1].replace(/[`*]/g, "").trim();
      const labeled = cleaned.match(/(?:filepath|file|path)\s*[:=]\s*([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)/i);
      if (labeled && labeled[1]) return normalizeRepoPath(labeled[1]);
      const candidate = cleaned.replace(/[:;,]+$/, "").trim();
      if (/^[A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+$/.test(candidate)) {
        return normalizeRepoPath(candidate);
      }
    }
    return "";
  }
  function convertLegacyBlocksToV2Payload(codeText, defaultPath) {
    if (!codeText || codeText.trim().length === 0) return null;
    const detectedPath = normalizeRepoPath(extractPathFromCode(codeText) || defaultPath || "");
    const hasDiffBlocks = isSearchReplace(codeText);
    const describePath = detectedPath || "no path detected";
    if (hasDiffBlocks) {
      const fileOpsMap = /* @__PURE__ */ new Map();
      const fileOrder = [];
      const regex = /<{7}[^\r\n]*\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7}[^\r\n]*/g;
      let match;
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
        fileOpsMap.get(activePath).push({
          search: match[1],
          replace: match[2]
        });
        lastIndex = regex.lastIndex;
      }
      if (fileOrder.length > 0) {
        const patches = fileOrder.map((path) => ({
          path,
          action: "modify",
          blocks: fileOpsMap.get(path)
        }));
        const commitMessage = patches.length === 1 ? `refactor(${patches[0].path || "no path detected"}): apply search/replace patch` : `refactor(multi-file): apply search/replace across ${patches.length} files`;
        const payload2 = {
          commitMessage,
          patches
        };
        const legacyPayload2 = {
          repo: "",
          message: payload2.commitMessage,
          files: patches.map((p) => ({
            path: p.path,
            diff: codeText,
            patches: p.blocks || []
          }))
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
        if (converted && (isSearchReplace(codeText) || Boolean(detectedPath))) {
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

  // src/index.ts
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
