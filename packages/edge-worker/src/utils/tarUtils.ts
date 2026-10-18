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
