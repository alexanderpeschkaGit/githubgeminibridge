/**
 * Low-level TAR byte-stream parsing utilities.
 */

/**
 * Helper to concat two Uint8Arrays.
 */
export function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

/**
 * Parses a null-terminated ASCII string from a Uint8Array slice.
 */
export function parseAsciiString(buffer: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && buffer[end] !== 0) {
    end++;
  }
  let str = '';
  for (let i = start; i < end; i++) {
    str += String.fromCharCode(buffer[i]);
  }
  return str.trim();
}

/**
 * Parses an octal integer from a TAR header field.
 */
export function parseOctal(buffer: Uint8Array, start: number, length: number): number {
  const raw = parseAsciiString(buffer, start, length);
  if (!raw) return 0;
  const parsed = parseInt(raw, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Splits and parses lines from .repomixignore / .repomixignore.cf / .gitignore.
 * Strips comments starting with '#' and ignores whitespace-only lines.
 */
export function parseIgnoreLines(content: string): string[] {
  if (!content) return [];
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Checks whether a repository-relative path matches any ignore pattern.
 */
export function matchesIgnorePattern(relPath: string, patterns: string[]): boolean {
  if (!relPath || !patterns || patterns.length === 0) return false;
  const normalized = relPath.replace(/^\/+/, '');
  const segments = normalized.split('/');
  const fileName = segments[segments.length - 1];

  for (const rawPattern of patterns) {
    let pat = rawPattern.trim();
    if (!pat || pat.startsWith('#')) continue;

    const isDirOnly = pat.endsWith('/');
    if (isDirOnly) {
      pat = pat.slice(0, -1);
    }

    const isAnchored = pat.startsWith('/');
    if (isAnchored) {
      pat = pat.slice(1);
    }

    // Wildcard matching (*.csv, test_*, etc.)
    if (pat.includes('*') || pat.includes('?')) {
      const regexStr = pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(isAnchored ? `^${regexStr}$` : `(^|/)${regexStr}$`);
      if (regex.test(normalized) || (!pat.includes('/') && regex.test(fileName))) {
        return true;
      }
      continue;
    }

    // Directory match
    if (isDirOnly) {
      if (isAnchored) {
        if (normalized === pat || normalized.startsWith(pat + '/')) return true;
      } else {
        if (segments.includes(pat) || normalized.startsWith(pat + '/') || normalized.includes('/' + pat + '/')) {
          return true;
        }
      }
      continue;
    }

    // Exact or prefix match
    if (isAnchored) {
      if (normalized === pat || normalized.startsWith(pat + '/')) return true;
    } else {
      if (fileName === pat || normalized === pat || normalized.startsWith(pat + '/') || segments.includes(pat)) {
        return true;
      }
    }
  }

  return false;
}
