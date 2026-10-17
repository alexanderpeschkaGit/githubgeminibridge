/**
 * Chunk-based UTF-8 to Base64 encoding.
 * Processes bytes in chunks (32KB) to prevent "Maximum call stack size exceeded" errors
 * that occur with large files when using String.fromCharCode.apply on large arrays.
 */
export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const CHUNK_SIZE = 0x8000; // 32768 bytes
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Decodes Base64 string back to UTF-8 string safely.
 */
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
