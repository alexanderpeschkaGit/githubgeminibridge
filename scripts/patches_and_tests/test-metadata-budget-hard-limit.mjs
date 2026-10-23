import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'packages/edge-worker/node_modules/esbuild'));

const HEAD_OID = 'abcdef0123456789abcdef0123456789abcdef01';

const chunkerBuild = await esbuild.build({
  entryPoints: [path.join(ROOT, 'packages/edge-worker/src/modules/mixChunker.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const chunkerUrl = `data:text/javascript;base64,${Buffer.from(chunkerBuild.outputFiles[0].text).toString('base64')}`;
const {
  buildChunkedMixXml,
  capRecentCommitsText,
  HARD_GEMINI_CHAR_LIMIT,
  MAX_RECENT_COMMITS_CHARS,
  RECENT_COMMITS_TRUNCATION_MARKER,
  DEFAULT_MAX_CHUNK_CHARS,
  MAX_GEMINI_PARTS,
} = await import(chunkerUrl);

const SKIP_MARKER = '[SKIPPED: exceeds 100k part limit]';

function makeHugeMetadata(commitCount = 8000) {
  const lines = ['<recent_commits>'];
  for (let i = 0; i < commitCount; i++) {
    lines.push(`  <commit hash="h${i}" date="2026-10-20" author="Dev" title="feat: change ${i}">`);
    lines.push(`    <title>feat: change ${i}</title>`);
    lines.push('  </commit>');
  }
  lines.push('</recent_commits>');
  return lines.join('\n');
}

function makeInput(files, options = {}) {
  return {
    owner: 'acme',
    repo: 'repo',
    branch: 'main',
    headOid: HEAD_OID,
    fileTreeEntries: files.map((f) => f.path),
    files,
    ...options,
  };
}

function padFiles(count, size, prefix = 'src/mod') {
  return Array.from({ length: count }, (_, i) => ({
    path: `${prefix}${i}.ts`,
    content: `// file ${i}\n` + 'X'.repeat(size),
  }));
}

function makeLongPathFiles(count) {
  return Array.from({ length: count }, (_, i) => ({
    path: `src/${'long-directory-name/'.repeat(8)}${String(i).padStart(5, '0')}.ts`,
    content: `export const file${i} = ${i};\n`,
  }));
}

function measuredParts(result) {
  if (Array.isArray(result.parts) && result.parts.length > 0) {
    return result.parts.map((p) => ({
      name: p.fileName,
      length: p.xmlContent.length,
      declared: p.stats.charCount,
      content: p.xmlContent,
    }));
  }
  return [{ name: 'single', length: result.xmlContent.length, declared: result.stats.charCount, content: result.xmlContent }];
}

function assertConforming(label, result, worstCase) {
  const parts = measuredParts(result);
  for (const part of parts) {
    assert.equal(part.length, part.declared, `${label}: ${part.name} stats.charCount matches measured length`);
    assert.ok(
      part.length <= HARD_GEMINI_CHAR_LIMIT,
      `${label}: ${part.name} must stay <= ${HARD_GEMINI_CHAR_LIMIT} chars, measured ${part.length}`
    );
  }
  worstCase.push({ label, maxPartChars: Math.max(...parts.map((p) => p.length)), partCount: parts.length });
  return parts;
}

const worstCase = [];

// --- Unit: capRecentCommitsText is deterministic and visible ---
{
  assert.equal(capRecentCommitsText(undefined), '', 'absent metadata caps to empty string');
  assert.equal(capRecentCommitsText(''), '', 'empty metadata caps to empty string');
  assert.equal(capRecentCommitsText('   \n  '), '', 'whitespace-only metadata caps to empty string');

  const small = '<recent_commits>ok</recent_commits>';
  assert.equal(capRecentCommitsText(small, 1000), small, 'metadata inside the cap is untouched');

  const raw = makeHugeMetadata(50);
  const capped = capRecentCommitsText(raw, 500);
  assert.ok(capped.length <= 500, `capped metadata respects the limit, got ${capped.length}`);
  assert.ok(capped.endsWith(RECENT_COMMITS_TRUNCATION_MARKER), 'capped metadata ends with the truncation marker');
  assert.ok(raw.startsWith(capped.split('\n')[0]), 'capped metadata preserves the leading line');
  assert.ok(capped.split('\n').slice(0, -1).every((line) => line.trim() === '' || raw.includes(line)), 'capped metadata keeps complete source lines');
  assert.equal(capRecentCommitsText(raw, 0), '', 'zero budget drops metadata deterministically');
  console.log('PASS: capRecentCommitsText is deterministic and visibly marked');
}

// --- Case 1: very large recent-commit metadata yields no oversized part ---
{
  const metadata = makeHugeMetadata();
  assert.ok(metadata.length > 500_000, 'fixture metadata is realistically large');
  const files = padFiles(3, 30_000);
  const result = buildChunkedMixXml(makeInput(files, { recentCommitsText: metadata }));
  const parts = assertConforming('huge metadata', result, worstCase);
  assert.ok(parts.length >= 2, 'huge metadata forces the multi-part path');
  assert.ok(
    parts[0].content.includes(RECENT_COMMITS_TRUNCATION_MARKER),
    'Part 1 carries the visible metadata truncation marker'
  );
  const metadataSection = parts[0].content.slice(
    parts[0].content.indexOf('<recent_commits>'),
    parts[0].content.indexOf('</recent_commits>') + '</recent_commits>'.length
  );
  assert.ok(
    metadataSection.length <= MAX_RECENT_COMMITS_CHARS,
    `Part 1 metadata is capped to ${MAX_RECENT_COMMITS_CHARS} chars, measured ${metadataSection.length}`
  );
  assert.equal(result.stats.fileCount, 3, 'all conforming files are still emitted');
  console.log(`PASS: huge recent-commit metadata is capped (Part 1 = ${parts[0].length} chars)`);
}

// --- Case 2: a user budget above the hard limit cannot raise the ceiling ---
{
  const files = padFiles(4, 60_000);
  const result = buildChunkedMixXml(makeInput(files, { maxChunkChars: 500_000 }));
  const parts = assertConforming('maxChunkChars=500000', result, worstCase);
  assert.ok(parts.length >= 2, 'oversized repo still splits despite the oversized user budget');
  assert.equal(result.stats.fileCount, 4, 'no file is dropped when the clamp alone resolves the budget');
  assert.ok(!result.xmlContent.includes(SKIP_MARKER), 'no skip annotation is needed for the clamp-only case');
  assert.ok(
    result.parts.every((p) => p.fileName.startsWith('repo-mix.part') && p.fileName.endsWith('.txt')),
    'part naming stays repo-mix.partN.txt'
  );
  console.log(`PASS: maxChunkChars=500000 is clamped to ${HARD_GEMINI_CHAR_LIMIT} (${parts.length} parts, max ${Math.max(...parts.map((p) => p.length))})`);
}

// --- Case 3: pathogenic single-file oversize fails explicitly instead of silently dropping it ---
{
  const file = {
    path: 'src/oversized.ts',
    content: 'export const x = ' + 'X'.repeat(150_000) + ';\n',
  };
  assert.throws(
    () => buildChunkedMixXml(makeInput([file])),
    /cannot preserve 1 file\(s\).*character limit/i,
    'oversized single files fail explicitly rather than silently disappearing from the output'
  );
  console.log('PASS: oversized single file fails explicitly instead of silently dropping data');
}

// --- Case 3b: pathological metadata + indivisible files reject impossible complete output ---
{
  const metadata = makeHugeMetadata(12_000);
  const files = padFiles(12, 60_000);
  assert.throws(
    () => buildChunkedMixXml(makeInput(files, { recentCommitsText: metadata, maxChunkChars: 500_000 })),
    new RegExp(`more than ${MAX_GEMINI_PARTS} parts`),
    'indivisible files that cannot fit within ten parts fail instead of being silently dropped'
  );
  console.log(`PASS: pathological metadata + large files explicitly reject output beyond ${MAX_GEMINI_PARTS} parts`);
}

// --- Case 3c: long continuation file trees are included in the measured size ---
{
  const files = makeLongPathFiles(1_500);
  const result = buildChunkedMixXml(makeInput(files));
  const parts = assertConforming('long paths without metadata', result, worstCase);
  assert.ok(parts.length > 1 && parts.length <= MAX_GEMINI_PARTS, 'long paths split into conforming parts');
  assert.equal(result.stats.fileCount, files.length, 'all long-path files are preserved without metadata');
  assert.equal(
    result.parts.reduce((count, part) => count + part.stats.fileCount, 0),
    files.length,
    'per-part file accounting includes every long-path file'
  );
  console.log(`PASS: long paths without metadata preserve ${files.length} files (${parts.length} parts)`);
}

// --- Case 3c: metadata remains opt-in, capped, and confined to Part 1 with long paths ---
{
  const files = makeLongPathFiles(1_500);
  const result = buildChunkedMixXml(makeInput(files, { recentCommitsText: makeHugeMetadata() }));
  const parts = assertConforming('long paths with metadata', result, worstCase);
  assert.ok(parts.length > 1 && parts.length <= MAX_GEMINI_PARTS, 'metadata does not bypass the part limit');
  assert.equal(result.stats.fileCount, files.length, 'all long-path files are preserved with metadata');
  assert.ok(parts[0].content.includes(RECENT_COMMITS_TRUNCATION_MARKER), 'Part 1 visibly marks capped metadata');
  const metadataSection = parts[0].content.slice(
    parts[0].content.indexOf('<recent_commits>'),
    parts[0].content.indexOf('</recent_commits>') + '</recent_commits>'.length
  );
  assert.ok(metadataSection.length <= MAX_RECENT_COMMITS_CHARS, 'Part 1 metadata remains within its cap');
  assert.ok(
    parts.slice(1).every((part) => !part.content.includes('<recent_commits>')),
    'continuation parts do not repeat metadata'
  );
  console.log(`PASS: long paths with capped Part 1 metadata preserve ${files.length} files (${parts.length} parts)`);
}

// --- Case 3d: the ten-part guardrail rejects long-path output that cannot fit completely ---
{
  for (const metadata of [undefined, makeHugeMetadata()]) {
    const files = makeLongPathFiles(5_000);
    assert.throws(
      () => buildChunkedMixXml(makeInput(files, { recentCommitsText: metadata })),
      new RegExp(`more than ${MAX_GEMINI_PARTS} parts`),
      `5,000 long paths ${metadata ? 'with' : 'without'} metadata must fail explicitly`
    );
  }
  console.log(`PASS: long-path output beyond ${MAX_GEMINI_PARTS} parts is rejected with and without metadata`);
}

// --- Case 4a: normal small input keeps single-part behavior and stats ---
{
  const files = padFiles(2, 1_200);
  files[0].path = 'src/a.ts';
  files[1].path = 'src/b.ts';
  const result = buildChunkedMixXml(makeInput(files));
  const parts = assertConforming('small single part', result, worstCase);
  assert.equal(parts.length, 1, 'small repo stays a single part');
  assert.equal(result.isChunked, false, 'small repo is not chunked');
  assert.equal(result.parts, undefined, 'small repo exposes no parts array');
  assert.equal(result.stats.fileCount, 2, 'small repo reports both files');
  assert.equal(result.stats.charCount, result.xmlContent.length, 'small repo stats charCount matches content');
  assert.equal(result.stats.estimatedTokens, Math.ceil(result.xmlContent.length / 4), 'small repo estimatedTokens unchanged');
  assert.ok(!result.xmlContent.includes('part="1"'), 'single part keeps the part-less repository attribute');
  assert.ok(!result.xmlContent.includes(SKIP_MARKER), 'small repo has no skip marker');
  assert.ok(!result.xmlContent.includes(RECENT_COMMITS_TRUNCATION_MARKER), 'small repo has no truncation marker');
  console.log(`PASS: small input keeps the single-part contract (${result.xmlContent.length} chars)`);
}

// --- Case 4b: normal multi-part behavior, naming and stats are unchanged ---
{
  const files = padFiles(3, 35_000);
  files[0].path = 'src/a.ts';
  files[1].path = 'src/b.ts';
  files[2].path = 'src/c.ts';
  const result = buildChunkedMixXml(makeInput(files));
  const parts = assertConforming('normal multi part', result, worstCase);
  assert.equal(result.isChunked, true, 'normal multi-part repo is chunked');
  assert.ok(parts.length >= 2, 'normal multi-part repo splits');
  assert.ok(
    parts.every((p) => p.length <= DEFAULT_MAX_CHUNK_CHARS),
    `normal parts respect the ${DEFAULT_MAX_CHUNK_CHARS}-char target budget`
  );
  assert.deepEqual(
    result.parts.map((p) => p.fileName),
    result.parts.map((_, i) => `repo-mix.part${i + 1}.txt`),
    'normal part naming is unchanged'
  );
  assert.equal(result.stats.fileCount, 3, 'normal multi-part repo reports all files');
  assert.equal(
    result.stats.charCount,
    result.parts.reduce((acc, p) => acc + p.xmlContent.length, 0),
    'normal multi-part stats charCount is the sum of parts'
  );
  assert.ok(result.parts[0].xmlContent.includes('src/a.ts') && result.parts[0].xmlContent.includes('src/c.ts'), 'Part 1 keeps the master file_tree');
  console.log(`PASS: normal multi-part behavior is unchanged (${parts.length} parts)`);
}

// --- Case 5: splitOutput=false still honours the ceiling (metadata truncation instead of overflow) ---
{
  const metadata = makeHugeMetadata();
  const files = padFiles(2, 46_000);
  const result = buildChunkedMixXml(makeInput(files, { recentCommitsText: metadata, splitOutput: false }));
  const parts = assertConforming('splitOutput=false with metadata', result, worstCase);
  assert.ok(
    result.xmlContent.length <= HARD_GEMINI_CHAR_LIMIT,
    `splitOutput=false content stays <= ${HARD_GEMINI_CHAR_LIMIT}, measured ${result.xmlContent.length}`
  );
  assert.equal(result.stats.fileCount, 2, 'splitOutput=false keeps every file when truncating metadata is enough');
  assert.ok(!result.xmlContent.includes(SKIP_MARKER), 'splitOutput=false needs no skip marker here');
  assert.ok(
    result.isChunked === false ? parts.length === 1 : parts.length >= 2,
    'splitOutput=false either keeps one conforming part or splits explicitly'
  );
  console.log(`PASS: splitOutput=false never overflows (${parts.length} part(s), max ${Math.max(...parts.map((p) => p.length))})`);
}

// --- Case 6: splitOutput=false cannot silently drop files to satisfy the ceiling ---
{
  const files = padFiles(2, 60_000);
  const result = buildChunkedMixXml(makeInput(files, { splitOutput: false }));
  const parts = assertConforming('splitOutput=false oversized', result, worstCase);
  assert.equal(result.isChunked, true, 'a payload that cannot fit one part is partitioned instead of truncated');
  assert.ok(parts.length >= 2, 'oversized single-part request is partitioned');
  assert.equal(result.stats.fileCount, 2, 'no file is dropped when splitting can preserve it');
  assert.ok(!result.xmlContent.includes(SKIP_MARKER), 'no skip annotation is needed when splitting preserves content');
  console.log('PASS: splitOutput=false never returns an oversized or content-dropping single part');
}

console.log('\nMeasured worst-case part sizes:');
for (const entry of worstCase) {
  console.log(`  ${entry.label}: max ${entry.maxPartChars} chars across ${entry.partCount} part(s)`);
}

const globalMax = Math.max(...worstCase.map((w) => w.maxPartChars));
assert.ok(globalMax <= HARD_GEMINI_CHAR_LIMIT, `global worst case ${globalMax} <= ${HARD_GEMINI_CHAR_LIMIT}`);

console.log('\nMetadata budget & hard-limit regression: PASS');
