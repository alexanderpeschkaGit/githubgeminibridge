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
