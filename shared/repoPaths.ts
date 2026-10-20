/**
 * Repo-relative path canonicalization shared by the Edge Worker, the userscript
 * HUD and the local CLI.
 *
 * GitHub resolves `object(expression: "<oid>:<path>")` strictly: `./src/a.ts`,
 * `/src/a.ts` and `src\a.ts` are all distinct strings and every non-canonical
 * variant resolves to `null`. That null is indistinguishable from a genuinely
 * missing file and surfaces as a misleading "Target file does not exist on branch".
 */
export function normalizeRepoPath(input: string | null | undefined): string {
  return (input || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/**
 * Returns a human-readable problem description, or `null` when the path is usable.
 * Callers aggregate the string into a `LinterError` so the HUD can show an
 * actionable message instead of a bogus "file does not exist".
 */
export function findRepoPathIssue(input: string | null | undefined): string | null {
  const raw = (input || '').trim();
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
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    return `Patch path "${raw}" must be repo-relative and must not contain "." or ".." segments.`;
  }
  return null;
}
