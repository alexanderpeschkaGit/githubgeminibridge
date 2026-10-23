# Plan 10 — RepoMix hard part-size enforcement

## Objective

Fix the reproducible case where RepoMix emits split `.txt` parts larger than
Gemini's absolute 100,000-character limit. Recent-commit metadata remains
opt-in and must not be the only tested source of overhead.

## Execution metadata

- Complexity: 6/10
- Tier: FLASH
- Scope: one serial batch; `mixChunker.ts`, focused regression, edge-worker
  architecture rule.
- Do not commit, push, deploy, modify generated bundles, or change unrelated
  project state.

## Confirmed reproduction and root cause

An input with 5,000 files whose paths were about 175 characters each produced
ten parts, with several between 185,000 and 293,000 characters. This reproduced
both with metadata off and on.

When the initial partition creates more than ten buckets, the chunker merges
adjacent buckets without measuring their serialized output. The later
`fitPart` attempts to trim file entries, but for continuation parts their
`file_tree` still lists every path. It can therefore return an oversized XML
document even after dropping every file. The existing hard-limit regression
does not exercise large path-list overhead.

## Implementation batch

1. Add executable regressions using many long paths, in both metadata-off and
   metadata-on cases. Assert measured final output sizes, file accounting and
   explicit resolution when the ten-part limit cannot preserve all content.
2. Partition based on serialized overhead, including continuation tree paths
   and XML envelopes. Do not merge buckets in a way that bypasses the absolute
   ceiling.
3. Make the final serialized-size check a hard output invariant for single and
   multi-part responses. If complete output cannot fit within ten conforming
   parts, fail explicitly rather than returning oversized or silently
   truncated success output.
4. Keep metadata capped and confined to Part 1; preserve ordinary inputs,
   atomic file boundaries, `.txt` naming, stats, and the ten-part maximum.
5. Update the edge-worker architecture rule to state that each complete
   serialized part is validated and that the ten-part limit cannot override
   the hard ceiling.

## Validation gate

- Run the focused hard-limit regression.
- Run `test-recent-commits-opt-in.mjs`.
- Run edge-worker TypeScript check and `worker-smoke.mjs`.
- Run `git diff --check`.
- Report the largest measured part size and whether output was explicitly
  rejected when the 10-part limit made complete safe output impossible.
- Confirm active TypeScript files remain below 500 lines.
