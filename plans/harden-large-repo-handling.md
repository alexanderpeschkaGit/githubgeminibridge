# Plan: Harden large-repo handling (tar cap observability, history normalization, health/version parity)

**Plan ID:** plan-20251101T131200-safe  
**Base SHA:** bc896f2  
**Recommended Workflow:** `#exec`  
**Recommended Execution Model:** FLASH  
**Flash-Only Viability:** YES  
**Complexity:** Low (localized, additive changes)

## Architecture & Logic

### 1) Tar cap observability (Worker)
- In `packages/edge-worker/src/modules/mixerTarScan.ts`, when cumulative cap triggers (`totalCollectedBytes + size > MAX_TOTAL_TAR_BYTES`), use a distinct reason in `skippedFiles`. Add `'stream_cap'` to the reason union.
- Keep existing marker in `fileTreeEntries` (`[SKIPPED: total mix >24MB]`) for backward compatibility.
- Ensure types in `shared/types.ts` reflect the extended union so the API contract matches.

### 2) Repo history normalization (HUD)
- In `packages/userscript-hud/src/services/storage.ts`, extend `sanitizeRepo` to strip trailing `.git` suffix (case-insensitive). This normalizes inputs from git clone URLs/paths.
- `packages/userscript-hud/src/services/repoHistory.ts` already uses `sanitizeRepo`, so deduplication will naturally handle `owner/repo` vs `owner/repo.git`. No keying logic change required.

### 3) Health/version parity (Worker)
- Verify `packages/edge-worker/src/index.ts` returns `"version": "0.80.9"` in the health response (docs and bundle already updated). Read-only check only.

## File Inventory

| File | Change | Anchor Snippet |
| :-- | :-- | :-- |
| `shared/types.ts` | Extend `skippedFiles[].reason` union to include `'stream_cap'`. | `skippedFiles?: Array<{ path: string; reason: 'too_large' \| 'ignored' \| 'over_hard_limit' \| 'would_exceed_parts'; bytes?: number; chars?: number }>` |
| `packages/edge-worker/src/modules/mixerTarScan.ts` | Update `skippedFiles` type and set reason to `'stream_cap'` on cumulative cap skip. | Line ~315-321: cumulative cap check pushing to `skippedFiles` with `reason: 'too_large'` |
| `packages/userscript-hud/src/services/storage.ts` | Strip trailing `.git` suffix in `sanitizeRepo`. | `cleaned = cleaned.replace(/\/+$/, '');` → add `.replace(/\.git$/i, '')` |
| `packages/edge-worker/src/index.ts` | Verify health version is `0.80.9` (no change expected). | Health response object |

## Risk & Complexity

| Step | Score | Tier | Notes |
| :-- | :-- | :-- | :-- |
| Types union extension | 1/10 | FLASH_LITE | Additive, backwards compatible. |
| Tar scan reason change | 2/10 | FLASH_LITE | Localized to mixerTarScan. |
| sanitizeRepo .git strip | 1/10 | FLASH_LITE | Defensive normalization. |
| Health/version verify | 1/10 | FLASH_LITE | Read-only. |

**Overall:** 5/10 — all FLASH. No high-risk refactors.

## Checkpoint Policy
- `tsc --noEmit` in `packages/edge-worker`, `packages/userscript-hud`, `shared` (as applicable)
- `node scripts/patches_and_tests/worker-smoke.mjs`
- No version bump required (already `0.80.9`). No git push.

## Acceptance & Invariant Checklist
- [ ] `skippedFiles` for stream cap uses reason `'stream_cap'` in `MixResponse` when triggered.
- [ ] `fileTreeEntries` still contains `[SKIPPED: total mix >24MB]` marker.
- [ ] Repo history deduplicates `owner/repo` and `owner/repo.git` (same entry after normalization).
- [ ] `sanitizeRepo` strips `.git` suffix case-insensitively.
- [ ] `/health` returns `"version": "0.80.9"`.
- [ ] `tsc --noEmit` passes for touched packages; `worker-smoke.mjs` passes.

## Implementation Steps (Safe Edits)

1. **shared/types.ts** - Extend reason union:
```ts
skippedFiles?: Array<{ path: string; reason: 'too_large' | 'ignored' | 'over_hard_limit' | 'would_exceed_parts' | 'stream_cap'; bytes?: number; chars?: number }>;
```

2. **packages/edge-worker/src/modules/mixerTarScan.ts** - Update types and cap handling:
```ts
const skippedFiles: Array<{ path: string; reason: 'too_large' | 'stream_cap'; bytes?: number; chars?: number }> = [];
...
if (!isIgnoreConfig && totalCollectedBytes + size > MAX_TOTAL_TAR_BYTES) {
  fileTreeEntries.push(`${relPath} [SKIPPED: total mix >24MB]`);
  skippedFiles.push({ path: relPath, reason: 'stream_cap', bytes: size });
  await discardBytes(paddedSize);
  continue;
}
```

3. **packages/userscript-hud/src/services/storage.ts** - Strip `.git`:
```ts
export function sanitizeRepo(repoStr: string): string {
  let cleaned = (repoStr || '').trim();
  cleaned = cleaned.replace(/^https?:\/\/github\.com\//i, '');
  cleaned = cleaned.replace(/^git@github\.com:/i, '');
  cleaned = cleaned.replace(/https?:?$/i, '');
  cleaned = cleaned.replace(/\.git$/i, '');
  cleaned = cleaned.replace(/\/+$/, '');
  return cleaned.trim();
}
```

4. **Verify** - Confirm `/health` version in `packages/edge-worker/src/index.ts` is `0.80.9`.
