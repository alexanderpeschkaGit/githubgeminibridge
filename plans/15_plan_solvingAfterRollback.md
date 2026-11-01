## Execution Metadata
- **Plan ID:** plan-20261101124000-f1f6
- **Artifact Path:** .tmp/plans/plan-20261101124000-f1f6.md
- **Base SHA:** 076debf0ad54f5ff3469e75866dad1371617a29c
- **Recommended Workflow:** #exec
- **Recommended Execution Model:** FLASH
- **Flash-Only Viability:** YES (Micro-Batched <= 6)
- **Complexity Assessment:** All 4 implementation steps and 1 verification/checkpoint step are bounded to <= 4 files per step, use localized Anchor Snippets, preserve 100% of existing test and Canvas contracts, and keep every active TypeScript file well below the 500-line ceiling (max is 428 lines).

---

# Plan: Parser Hardening, Repo History Hygiene, Stream/Auth Safeguards & Doc Sync (`#plan #flash`)

## 1. Architecture & Logic

### Step 1 — Shared Balanced JSON Parser & Harvester Destructive-Create Guard `[Score: 5/10 | Tier: FLASH | Independent]`
- **Preflight Findings:**
  - `packages/edge-worker/src/modules/webhookHandler.ts` (`extractPatchPayload`) and `packages/local-cli/src/localRunner.ts` (`extractJsonFromResponse`) use a non-greedy regex `/```(?:json)?\s*([\s\S]*?)\s*```/i` that truncates valid V2 JSON payloads whenever a `replace` or `fullContent` string contains inner triple-backtick code fences (` ``` `).
  - `packages/userscript-hud/src/dom/harvester.ts` (`processCodeBlock`) calls `convertLegacyBlocksToV2Payload(codeText, detectedPath || undefined)` whenever `Boolean(detectedPath)` is true. If Gemini emits an illustrative non-diff code block beneath a filename heading or `// filepath:` comment, `convertLegacyBlocksToV2Payload` falls through to `action: 'create'` with `fullContent: codeText`, queuing a destructive whole-file overwrite.
  - `scripts/patches_and_tests/harvester-modules.mjs` resolves relative imports via `RELATIVE_MODULES` in dependency order; any new shared module imported by `patchParser.ts` must be registered there before `./patchParser`.
- **Logic & Fallbacks:**
  - Create `shared/patchPayloadParser.ts` containing `extractBalancedJsonObject`, `parseV2PatchPayloadFromCode` (preserving the exact balanced scanner and inner-fence fallback from `patchParser.ts`), and `extractJsonFromResponse` (which strips outer markdown fences greedily and extracts a balanced JSON object if present, preserving raw JSON passthrough for `test-local-cli.mjs`).
  - Re-export `parseV2PatchPayloadFromCode` from `packages/userscript-hud/src/dom/patchParser.ts` and register `'../../../../shared/patchPayloadParser'` in `scripts/patches_and_tests/harvester-modules.mjs`.
  - In `packages/userscript-hud/src/dom/harvester.ts`, restrict `processCodeBlock` fallback harvesting to `isSearchReplace(codeText) === true`. Leave `convertLegacyBlocksToV2Payload` in `patchParser.ts` and `processCanvasCards()` in `harvester.ts` completely unchanged so Gemini Canvas export cards and direct unit tests continue to work as before.
- **Exit Condition:** `npm --prefix packages/edge-worker run typecheck`, `npm --prefix packages/userscript-hud run typecheck`, `npm --prefix packages/local-cli run typecheck`, `node scripts/patches_and_tests/test-harvest-dedupe.mjs`, and `node scripts/patches_and_tests/test-path-normalization.mjs` pass.

### Step 2 — HUD Repo History Case-Insensitive Dedupe & Input Churn Prevention `[Score: 4/10 | Tier: FLASH | Independent]`
- **Preflight Findings:**
  - `packages/userscript-hud/src/services/repoHistory.ts` scopes storage per profile via `historyKey()` (`repo_history_v1_${getActiveProfileId()}`), which must be preserved. However, `entryKey` is case-sensitive and `normalizeEntry` does not normalize GitHub URLs via `sanitizeRepo`.
  - `packages/userscript-hud/src/ui/hudConfigBindings.ts` calls `pushRepoHistory` on every raw input `onchange` event, polluting the 4-slot history with unverified edits before any mix or patch occurs.
- **Logic & Fallbacks:**
  - In `repoHistory.ts`, keep `historyKey()` untouched. In `normalizeEntry`, apply `sanitizeRepo(entry.repo || '')` and preserve `entry.owner` when present, falling back to the `owner/` prefix of `repo` only when `entry.owner` is empty. Lowercase `entryKey` so `loadRepoHistory()` and `pushRepoHistory()` deduplicate case-insensitively on both existing stored items and new items while keeping display casing intact.
  - In `hudConfigBindings.ts`, change `recordCurrentHistory` to only invoke `refreshRepoHistorySelect?.()` without pushing unverified edits.
  - In `hudApplyPatch.ts`, call `recordFromConfig(config)` and `refreshRepoHistorySelectNow()` on successful `COMMITTED` / `NO_CHANGES_NEEDED` responses so verified patch runs also record history alongside `hudMixAction.ts`, `hudRepoHistoryDropdown.ts`, and `hudAccountSwitch.ts`.
- **Exit Condition:** `npm --prefix packages/userscript-hud run typecheck` and `node scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs` pass.

### Step 3 — Worker Constant-Time Auth Hardening & Tarball Cumulative RAM Guardrail `[Score: 5/10 | Tier: FLASH | Independent]`
- **Preflight Findings:**
  - `packages/edge-worker/src/index.ts` (`verifyAuth`) short-circuits on `headerBytes.length === secretBytes.length`, leaking secret length.
  - `packages/edge-worker/src/modules/mixerTarScan.ts` (`scanTarGzipStream`) caps individual files at 512 KB (`shouldSkipTarEntry`), but does not cap total accumulated bytes across `files[]`.
- **Logic & Fallbacks:**
  - In `packages/edge-worker/src/index.ts`, implement a synchronous, exception-free `constantTimeEqual(provided: string, secret: string): boolean` that seeds `let diff = providedBytes.length ^ secretBytes.length` and always loops `secretBytes.length` times.
  - In `packages/edge-worker/src/modules/mixerTarScan.ts`, export `MAX_TOTAL_TAR_BYTES = 24 * 1024 * 1024` (24 MB). Track `totalCollectedBytes` across regular files (excluding `.repomixignore.cf` and `.repomixignore`). If `totalCollectedBytes + size > MAX_TOTAL_TAR_BYTES`, discard the entry via `discardBytes(paddedSize)`, push `${relPath} [SKIPPED: total mix >24MB]` to `fileTreeEntries`, and record `{ path: relPath, reason: 'too_large', bytes: size }` in `skippedFiles`. If dynamic ignore rules splice out earlier files, subtract their byte length from `totalCollectedBytes`.
- **Exit Condition:** `npm --prefix packages/edge-worker run typecheck` and `node scripts/patches_and_tests/test-webhook-worker.mjs` pass.

### Step 4 — Regression Tests & Contract Documentation Sync `[Score: 3/10 | Tier: FLASH_LITE | Depends on: Steps 1–3]`
- **Preflight Findings:**
  - `howto.info` (lines 45–68) still shows the legacy `{ branch, message, files }` JSON format instead of `GeminiPatchPayload`.
  - Regression suites need explicit assertions for the new invariants (non-diff code block with heading ignored by harvester; case-insensitive `pushRepoHistory` dedupe).
- **Logic & Fallbacks:**
  - Add focused assertions to `scripts/patches_and_tests/test-harvest-dedupe.mjs` and `scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs`.
  - Update `howto.info`, `.agents/rules/edge-worker-architecture.md`, and `.agents/rules/userscript-shadow-hud.md`.
- **Exit Condition:** `node scripts/patches_and_tests/test-harvest-dedupe.mjs` and `node scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs` pass.

### Step 5 — Full Validation Gate, Lockstep Bundle Build & Checkpoint Commit `[Score: 3/10 | Tier: FLASH_LITE | Depends on: Step 4]`
- **Logic & Fallbacks:**
  - Execute package typechecks, rebuild `edge-worker`, `local-cli`, and `userscript-hud` (`npm run release:patch`), run `worker-smoke.mjs` and `run-regressions.mjs`, verify `git --no-pager diff --check`, and create a path-scoped Conventional Commit on `main` (no `git push`, no `wrangler deploy`).

---

## 2. File Inventory

### Step 1 Files
1. **`shared/patchPayloadParser.ts`** *(Create new file, ~115 lines)*
   - **Instruction 1.1:** Create `shared/patchPayloadParser.ts` with `extractBalancedJsonObject`, `parseV2PatchPayloadFromCode`, and `extractJsonFromResponse`:
     ```ts
     import type { GeminiPatchPayload, FilePatchOperation, PatchBlock } from './types';

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

     export function extractBalancedJsonObject(text: string, startIndex: number): string | null {
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
         const lastFenceIdx = fromBrace.lastIndexOf('```');
         const innerCandidate = lastFenceIdx !== -1 ? fromBrace.slice(0, lastFenceIdx) : fromBrace;
         const innerParsed = tryParseGeminiPayload(innerCandidate);
         if (innerParsed) return innerParsed;
       }

       return null;
     }

     /**
      * Extracts a JSON string from LLM markdown output, preserving inner backtick fences
      * inside JSON string literals when present.
      */
     export function extractJsonFromResponse(raw: string): string {
       const trimmed = (raw || '').trim();
       if (!trimmed) return '';

       const v2Parsed = parseV2PatchPayloadFromCode(trimmed);
       if (v2Parsed) {
         return JSON.stringify(v2Parsed);
       }

       const outerFenceMatch = trimmed.match(/^```(?:json|md|markdown)?\s*([\s\S]*)\s*```$/i);
       const candidate = outerFenceMatch && outerFenceMatch[1] ? outerFenceMatch[1].trim() : trimmed;
       const braceIdx = candidate.indexOf('{');
       if (braceIdx !== -1) {
         const balanced = extractBalancedJsonObject(candidate, braceIdx);
         if (balanced) return balanced.trim();
       }
       return candidate;
     }
     ```
2. **`packages/userscript-hud/src/dom/patchParser.ts`**
   - **Instruction 1.2:** Replace lines 1–116 of `packages/userscript-hud/src/dom/patchParser.ts` with imports/re-exports from `../../../../shared/patchPayloadParser`, keeping `isSearchReplace`, `extractSectionPath`, and `convertLegacyBlocksToV2Payload` untouched:
     ```ts
     // Anchor: lines 1-116 of packages/userscript-hud/src/dom/patchParser.ts
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
     ```
3. **`scripts/patches_and_tests/harvester-modules.mjs`**
   - **Instruction 1.3:** Register `'../../../../shared/patchPayloadParser'` in `RELATIVE_MODULES` immediately after `'../../../../shared/repoPaths'` and before `'./patchParser'`:
     ```js
     // Anchor: lines 18-30 of scripts/patches_and_tests/harvester-modules.mjs
       {
         specifier: '../../../../shared/repoPaths',
         source: 'shared/repoPaths.ts',
       },
       {
         specifier: '../../../../shared/patchPayloadParser',
         source: 'shared/patchPayloadParser.ts',
       },
       {
         specifier: './pathHints',
         source: 'packages/userscript-hud/src/dom/pathHints.ts',
       },
     ```
4. **`packages/userscript-hud/src/dom/harvester.ts`, `packages/edge-worker/src/modules/webhookHandler.ts`, & `packages/local-cli/src/localRunner.ts`**
   - **Instruction 1.4:** In `packages/userscript-hud/src/dom/harvester.ts`, restrict the `else` branch in `processCodeBlock` (lines 150–167) to `else if (isSearchReplace(codeText))` so plain non-diff code blocks in chat are never turned into `action: 'create'` overwrites (while `processCanvasCards` at line 251 remains unchanged):
     ```ts
     // Anchor: lines 150-167 of packages/userscript-hud/src/dom/harvester.ts
         } else if (isSearchReplace(codeText)) {
           // Check for legacy diff blocks (plain non-diff code blocks in chat are never auto-harvested as file creates)
           const detectedPath = extractPathFromCode(codeText, pre);
           const converted = convertLegacyBlocksToV2Payload(codeText, detectedPath || undefined);
           if (converted) {
             harvested = {
               id: createStablePatchId('v1_search_replace', converted.payload),
               mode: 'v1_search_replace',
               commitMessage: converted.payload.commitMessage,
               payload: converted.payload,
               legacyPayload: converted.legacyPayload,
               timestamp: new Date().toLocaleTimeString(),
             };
           }
         }
     ```
   - **Instruction 1.5:** In `packages/edge-worker/src/modules/webhookHandler.ts`, import `parseV2PatchPayloadFromCode` and `extractJsonFromResponse` from `'../../../../shared/patchPayloadParser'` and update `extractPatchPayload`:
     ```ts
     // Anchor: lines 96-100 of packages/edge-worker/src/modules/webhookHandler.ts
     export function extractPatchPayload(text: string): GeminiPatchPayload {
       const parsed = parseV2PatchPayloadFromCode(text);
       if (parsed) return parsed;
       return JSON.parse(extractJsonFromResponse(text)) as GeminiPatchPayload;
     }
     ```
   - **Instruction 1.6:** In `packages/local-cli/src/localRunner.ts`, import `extractJsonFromResponse` and `parseV2PatchPayloadFromCode` from `'../../../shared/patchPayloadParser'`, re-export `extractJsonFromResponse`, and use `parseV2PatchPayloadFromCode(text) ?? (JSON.parse(extractJsonFromResponse(text)) as GeminiPatchPayload)` in `callGeminiForPatch`.

### Step 2 Files
5. **`packages/userscript-hud/src/services/repoHistory.ts`**
   - **Instruction 2.1:** Import `sanitizeRepo` from `'./storage'`. Update `normalizeEntry` to sanitize `repo`, keep `entry.owner` if non-empty (falling back to the `repo` prefix only when `entry.owner` is empty), and lowercase `entryKey`:
     ```ts
     // Anchor: lines 1-35 of packages/userscript-hud/src/services/repoHistory.ts
     import type { HudConfig } from '../types';
     import { getActiveProfileId, getStoredValue, sanitizeRepo, setStoredValue } from './storage';

     export interface RepoHistoryEntry {
       owner: string;
       repo: string;
       branch: string;
       targetBranch?: string;
     }

     const HISTORY_KEY = 'repo_history_v1';
     const MAX_ENTRIES = 4;

     /** History is scoped per account profile so accounts never share entries. */
     function historyKey(): string {
       try {
         return `${HISTORY_KEY}_${getActiveProfileId()}`;
       } catch {
         return HISTORY_KEY;
       }
     }

     function normalizeEntry(entry: RepoHistoryEntry): RepoHistoryEntry {
       const cleanedRepo = sanitizeRepo(entry.repo || '');
       const slashIdx = cleanedRepo.indexOf('/');
       const derivedOwner = slashIdx > 0 ? cleanedRepo.slice(0, slashIdx).trim() : '';
       return {
         owner: (entry.owner || '').trim() || derivedOwner,
         repo: cleanedRepo,
         branch: (entry.branch || '').trim(),
         targetBranch: (entry.targetBranch || '').trim() || undefined,
       };
     }

     function entryKey(e: RepoHistoryEntry): string {
       const n = normalizeEntry(e);
       return `${n.owner.toLowerCase()}|||${n.repo.toLowerCase()}|||${n.branch.toLowerCase()}|||${(n.targetBranch || '').toLowerCase()}`;
     }
     ```
6. **`packages/userscript-hud/src/ui/hudConfigBindings.ts` & `packages/userscript-hud/src/ui/hudApplyPatch.ts`**
   - **Instruction 2.2:** In `packages/userscript-hud/src/ui/hudConfigBindings.ts`, remove unused `pushRepoHistory` import and change `recordCurrentHistory` so raw `onchange` events only refresh the dropdown UI without pushing unverified edits to storage:
     ```ts
     // Anchor: lines 29-41 of packages/userscript-hud/src/ui/hudConfigBindings.ts
       const recordCurrentHistory = () => {
         refreshRepoHistorySelect?.();
       };
     ```
   - **Instruction 2.3:** In `packages/userscript-hud/src/ui/hudApplyPatch.ts`, import `recordFromConfig` from `'../services/repoHistory'` and `refreshRepoHistorySelectNow` from `'./hudConfigBindings'`, and call both inside the `COMMITTED` and `NO_CHANGES_NEEDED` branches (wrapped in `try { ... } catch {}`).

### Step 3 Files
7. **`packages/edge-worker/src/index.ts`**
   - **Instruction 3.1:** Replace the length-branching comparisons in `verifyAuth` (lines 55–91) with `constantTimeEqual(provided: string, secret: string): boolean`:
     ```ts
     // Anchor: lines 55-91 of packages/edge-worker/src/index.ts
     function constantTimeEqual(provided: string, secret: string): boolean {
       const enc = new TextEncoder();
       const providedBytes = enc.encode(provided);
       const secretBytes = enc.encode(secret);
       if (secretBytes.length === 0) {
         return false;
       }
       let diff = providedBytes.length ^ secretBytes.length;
       for (let i = 0; i < secretBytes.length; i++) {
         const pByte = i < providedBytes.length ? providedBytes[i] : 0;
         diff |= pByte ^ secretBytes[i];
       }
       return diff === 0;
     }

     export function verifyAuth(request: Request, env: WorkerEnv): boolean {
       const secret = resolveSecret(env);
       if (!secret) {
         return false;
       }

       const customHeader = request.headers.get('x-bridge-secret');
       if (customHeader && constantTimeEqual(customHeader, secret)) {
         return true;
       }

       const authHeader = request.headers.get('Authorization');
       if (authHeader) {
         const token = authHeader.replace(/^Bearer\s+/i, '').trim();
         if (token && constantTimeEqual(token, secret)) {
           return true;
         }
       }

       return false;
     }
     ```
8. **`packages/edge-worker/src/modules/mixerTarScan.ts`**
   - **Instruction 3.2:** Export `MAX_TOTAL_TAR_BYTES = 24 * 1024 * 1024` and track `totalCollectedBytes` inside `scanTarGzipStream`:
     ```ts
     // Anchor: lines 39-43 of packages/edge-worker/src/modules/mixerTarScan.ts
     const MINIFIED_ASSET_PATTERN = /\.min\.(?:js|mjs|cjs|css)$/i;
     export const MAX_TOTAL_TAR_BYTES = 24 * 1024 * 1024; // 24 MB cumulative stream cap
     ```
     ```ts
     // Anchor: lines 146-152 of packages/edge-worker/src/modules/mixerTarScan.ts
       const fileTreeEntries: string[] = [];
       const files: { path: string; content: string }[] = [];
       const dynamicIgnorePatterns: string[] = [];
       const textDecoder = new TextDecoder();
       const skippedFiles: Array<{ path: string; reason: 'too_large'; bytes?: number; chars?: number }> = [];
       let totalCollectedBytes = 0;
     ```
     ```ts
     // Anchor: lines 296-326 of packages/edge-worker/src/modules/mixerTarScan.ts
           const isIgnoreConfig = relPath === '.repomixignore.cf' || relPath === '.repomixignore';
           if (!isIgnoreConfig && totalCollectedBytes + size > MAX_TOTAL_TAR_BYTES) {
             fileTreeEntries.push(`${relPath} [SKIPPED: total mix >24MB]`);
             skippedFiles.push({ path: relPath, reason: 'too_large', bytes: size });
             await discardBytes(paddedSize);
             continue;
           }

           // Read file content
           await ensureBytes(paddedSize);
           const fileBytes = buffer.subarray(0, size);
           buffer = buffer.subarray(paddedSize);

           const content = textDecoder.decode(fileBytes);

           // Skip binary files if null bytes are present
           if (content.includes('\0')) {
             continue;
           }

           // Dynamically load ignore rules from .repomixignore.cf or .repomixignore
           if (isIgnoreConfig) {
             const newPatterns = parseIgnoreLines(content);
             if (newPatterns.length > 0) {
               dynamicIgnorePatterns.push(...newPatterns);
               for (let i = files.length - 1; i >= 0; i--) {
                 if (matchesIgnorePattern(files[i].path, dynamicIgnorePatterns)) {
                   totalCollectedBytes = Math.max(0, totalCollectedBytes - files[i].content.length);
                   files.splice(i, 1);
                 }
               }
               for (let i = fileTreeEntries.length - 1; i >= 0; i--) {
                 const entryPath = fileTreeEntries[i].replace(/\s+\[SKIPPED:.*\]$/, '');
                 if (matchesIgnorePattern(entryPath, dynamicIgnorePatterns)) {
                   fileTreeEntries.splice(i, 1);
                 }
               }
             }
           }

           if (dynamicIgnorePatterns.length > 0 && matchesIgnorePattern(relPath, dynamicIgnorePatterns)) {
             continue;
           }

           totalCollectedBytes += size;
           fileTreeEntries.push(relPath);
           files.push({ path: relPath, content });
     ```

### Step 4 Files
9. **`scripts/patches_and_tests/test-harvest-dedupe.mjs` & `scripts/patches_and_tests/test-mix-continuation-and-hud-layout.mjs`**
   - **Instruction 4.1:** In `test-harvest-dedupe.mjs` (after test 9 around line 608), add test 10 verifying that a plain non-diff code block with a `// filepath: src/plain.ts` comment or heading is NOT harvested by `startDomHarvester` as an `action: 'create'` overwrite.
   - **Instruction 4.2:** In `test-mix-continuation-and-hud-layout.mjs` (at the end of Part 2), bundle `packages/userscript-hud/src/services/repoHistory.ts` and assert that pushing `Owner/Repo` followed by `owner/repo` deduplicates to 1 entry in `loadRepoHistory()` while preserving profile scoping.
10. **`howto.info`, `.agents/rules/edge-worker-architecture.md`, & `.agents/rules/userscript-shadow-hud.md`**
    - **Instruction 4.3:** In `howto.info` (lines 45–68), update the V2 JSON example to use `commitMessage`, `patches`, `action: "modify" | "create" | "delete"`, and `blocks: [{ search, replace }]`.
    - **Instruction 4.4:** Sync `.agents/rules/edge-worker-architecture.md` (note `MAX_TOTAL_TAR_BYTES = 24 MB` cap and current `/health` version) and `.agents/rules/userscript-shadow-hud.md` (note chat harvester requires V2 JSON or V1 diff markers, and case-insensitive repo history dedupe).

---

## 3. Risk & Complexity

| Step | Score | Tier | Risk & Mitigation |
| :--- | :---: | :---: | :--- |
| **Step 1: Shared Parser & Harvester Guard** | `5/10` | `FLASH` | `harvester-modules.mjs` updated in lockstep; `extractJsonFromResponse` preserves raw JSON passthrough for `test-local-cli.mjs`; `processCanvasCards()` and `convertLegacyBlocksToV2Payload` untouched. |
| **Step 2: Repo History Dedupe & Bindings** | `4/10` | `FLASH` | Profile scoping (`historyKey()`) and explicit `entry.owner` preserved; `loadRepoHistory()` normalizes existing stored items automatically. |
| **Step 3: Constant-Time Auth & TAR Cap** | `5/10` | `FLASH` | `constantTimeEqual` is synchronous, exception-free, and loops `secretBytes.length` times; `.repomixignore.cf` exempted from cap. |
| **Step 4: Regressions & Doc Sync** | `3/10` | `FLASH_LITE` | Additive test assertions + documentation alignment. |
| **Step 5: Validation, Build & Checkpoint** | `3/10` | `FLASH_LITE` | Standard lockstep build + 14-probe smoke + 16-suite regression gate. |
| **Combined Plan** | **`5/10`** | **`FLASH`** | **Flash-Only Viability: YES** (Every step `<= 5/10`, all files `< 500` lines). |

---

## 4. Optimization Hint

- Execute sequentially via **`#exec plan-20261101124000-f1f6 all`** under the Single-Action Protocol (one state-changing shell command per step, no `&&` or `;`).

---

## 5. Checkpoint Policy

- **Touched Packages:** `shared/`, `packages/edge-worker`, `packages/userscript-hud`, `packages/local-cli`.
- **Validation Gate (Sequential, Single-Action Protocol):**
  1. `npm --prefix packages/edge-worker run typecheck`
  2. `npm --prefix packages/userscript-hud run typecheck`
  3. `npm --prefix packages/local-cli run typecheck`
  4. `npm --prefix packages/edge-worker run build`
  5. `npm --prefix packages/local-cli run build`
  6. `npm --prefix packages/userscript-hud run release:patch`
  7. `node scripts/patches_and_tests/worker-smoke.mjs`
  8. `node scripts/patches_and_tests/run-regressions.mjs`
  9. `git --no-pager diff --check`
- **Commit Policy:** Stage modified files explicitly by path (`git add <paths>`), commit with `fix(bridge): harden patch parser, dedupe repo history, and cap tar stream memory`, never run `git push` or `npx wrangler deploy`.

---

## 6. Acceptance & Invariant Checklist

1. **[Parser & Harvester Parity]:** `shared/patchPayloadParser.ts` preserves `extractBalancedJsonObject`, inner-fence fallback in `parseV2PatchPayloadFromCode`, and raw JSON passthrough in `extractJsonFromResponse`; `startDomHarvester` ignores non-diff chat code blocks while `processCanvasCards()` and `convertLegacyBlocksToV2Payload` remain intact.
2. **[Repo History & Profile Scope]:** `repoHistory.ts` preserves `historyKey()` profile scoping and explicit `entry.owner` values, deduplicates existing and newly pushed entries case-insensitively, and only records on verified mix/patch/selection actions.
3. **[Constant-Time Auth & Cumulative TAR Cap]:** `verifyAuth` runs in `O(secretBytes.length)` without length short-circuiting or exceptions, and `scanTarGzipStream` enforces `MAX_TOTAL_TAR_BYTES = 24 * 1024 * 1024` while recording skipped files in `skippedFiles`.
4. **[Modularity & Regression Gate]:** All 55 active TypeScript files remain `< 500` lines, `dist/gemini-bridge.user.js` and root `gemini-bridge.user.js` are content-identical, and `worker-smoke.mjs` (14/14) + `run-regressions.mjs` (16/16) pass.