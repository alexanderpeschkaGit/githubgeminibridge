import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  HybridTaskInput,
  HybridTaskResult,
  GeminiPatchPayload,
  FilePatchOperation
} from '../../../shared/types';
import { applyPatchesInMemory } from '../../edge-worker/src/modules/patchInMemory';
import { findRepoPathIssue, normalizeRepoPath } from '../../../shared/repoPaths';
export { applyPatchesInMemory };
import { extractJsonFromResponse, parseV2PatchPayloadFromCode } from '../../../shared/patchPayloadParser';
export { extractJsonFromResponse };

export interface LocalRunnerOptions {
  apiKey?: string;
  cwd?: string;
  model?: string;
  skipCommit?: boolean;
  allowHeadMismatch?: boolean;
  strictHeadCheck?: boolean;
  expectedHeadOid?: string;
}

export function loadEnvFile(cwd: string): void {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const raw = fs.readFileSync(envPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {
  }
}

export async function callGeminiForPatch(
  prompt: string,
  contextFiles: { path: string; content: string }[],
  apiKey: string,
  model = 'gemini-2.0-flash'
): Promise<GeminiPatchPayload> {
  const fileContextString = contextFiles
    .map((f) => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const systemInstruction = `You are a high-precision code modification agent.\nYou must respond ONLY with a valid JSON matching the GeminiPatchPayload schema.\nDo NOT include explanations outside of the JSON block.\nSchema:\n{\n  "commitMessage": "string",\n  "preflight": {\n    "forbidPatterns": ["optional regex string"],\n    "requireExports": { "path/to/file.ts": ["exportName"] }\n  },\n  "patches": [\n    {\n      "path": "string",\n      "action": "modify" | "create" | "delete",\n      "blocks": [\n        {\n          "search": "exact string to replace",\n          "replace": "new replacement string (never use placeholders like // ... existing code ...)"\n        }\n      ],\n      "fullContent": "full content for create or full replacement"\n    }\n  ]\n}`;

  const userContent = `Task Prompt:\n${prompt}\n\nContext Files:\n${fileContextString}`;

  try {
    const genaiMod = await import('@google/genai' as any).catch(() => null);
    if (genaiMod && genaiMod.GoogleGenAI) {
      const ai = new genaiMod.GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model,
        contents: `${systemInstruction}\n\n${userContent}`
      });
      const text = response.text || '';
      const parsed = parseV2PatchPayloadFromCode(text);
      if (parsed) return parsed;
      const jsonStr = extractJsonFromResponse(text);
      return JSON.parse(jsonStr) as GeminiPatchPayload;
    }
  } catch {
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemInstruction}\n\n${userContent}` }]
        }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!rawText) {
    throw new Error('Gemini API returned empty response');
  }

  const parsed = parseV2PatchPayloadFromCode(rawText);
  if (parsed) return parsed;
  const jsonText = extractJsonFromResponse(rawText);
  return JSON.parse(jsonText) as GeminiPatchPayload;
}

function getLocalHeadOid(cwd: string): { oid?: string; branch?: string; isDetached?: boolean; error?: string } {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd, stdio: 'pipe' }).toString().trim();
    const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: 'pipe' }).toString().trim();
    if (!/^[0-9a-f]{40}$/i.test(oid)) {
      return { error: 'Unable to resolve local HEAD OID' };
    }
    return { oid: oid.toLowerCase(), branch: branch || undefined, isDetached: branch === '' };
  } catch (err: any) {
    return { error: err.message || 'Not a git repository or git not available' };
  }
}

export async function runLocalHybridTask(
  input: HybridTaskInput,
  options: LocalRunnerOptions = {}
): Promise<HybridTaskResult> {
  const cwd = options.cwd || process.cwd();
  loadEnvFile(cwd);

  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      mode: 'local',
      status: 'ERROR',
      message: 'GEMINI_API_KEY is not set in environment or options.'
    };
  }

  const strictHeadCheck = options.strictHeadCheck !== false;
  const expectedHeadOid = options.expectedHeadOid ? options.expectedHeadOid.trim().toLowerCase() : undefined;
  if (strictHeadCheck && expectedHeadOid && /^[0-9a-f]{40}$/.test(expectedHeadOid)) {
    const local = getLocalHeadOid(cwd);
    if (local.oid && local.oid !== expectedHeadOid) {
      if (!options.allowHeadMismatch) {
        return {
          mode: 'local',
          status: 'LOCAL_HEAD_MISMATCH',
          localHeadOid: local.oid,
          expectedHeadOid: expectedHeadOid,
          message: `Local HEAD "${local.oid}" does not match expected HEAD "${expectedHeadOid}" for branch "${input.branch}".`,
          suggestions: [
            `git fetch origin ${input.branch}`,
            `git checkout -B ${input.branch} origin/${input.branch}`,
            local.isDetached ? `git checkout ${input.branch} (or create/switch to a branch)` : `git stash push -u -m "wip-before-bridge"`,
            `Then generate a new RepoMix from the updated branch.`
          ]
        };
      }
    }
  }

  const targetPaths = input.targetPaths || [];
  const originalFiles: { path: string; content: string }[] = [];

  for (const relPath of targetPaths) {
    const pathIssue = findRepoPathIssue(relPath);
    if (pathIssue) {
      return { mode: 'local', status: 'ERROR', message: pathIssue };
    }
    const normalizedRelPath = normalizeRepoPath(relPath);
    const absPath = path.resolve(cwd, normalizedRelPath);
    const resolvedCwd = path.resolve(cwd);
    if (!absPath.startsWith(resolvedCwd + path.sep) && absPath !== resolvedCwd) {
      return { mode: 'local', status: 'ERROR', message: `Path traversal detected: "${relPath}" escapes repository root.` };
    }
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      originalFiles.push({ path: normalizedRelPath, content: fs.readFileSync(absPath, 'utf-8') });
    }
  }

  try {
    const patchPayload = await callGeminiForPatch(input.prompt, originalFiles, apiKey, options.model);

    const existingRecord: Record<string, string | null> = {};
    for (const f of originalFiles) {
      existingRecord[f.path] = f.content;
    }
    for (const patch of patchPayload.patches) {
      const pathIssue = findRepoPathIssue(patch.path);
      if (pathIssue) {
        return { mode: 'local', status: 'ERROR', message: pathIssue };
      }
      const normalizedPatchPath = normalizeRepoPath(patch.path);
      const absPath = path.resolve(cwd, normalizedPatchPath);
      const resolvedCwd = path.resolve(cwd);
      if (!absPath.startsWith(resolvedCwd + path.sep) && absPath !== resolvedCwd) {
        return { mode: 'local', status: 'ERROR', message: `Path traversal detected: "${patch.path}" escapes repository root.` };
      }
      if (!(normalizedPatchPath in existingRecord)) {
        existingRecord[normalizedPatchPath] = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : null;
      }
      (patch as FilePatchOperation).path = normalizedPatchPath;
    }

    const patchResult = await applyPatchesInMemory(patchPayload.patches, existingRecord, patchPayload.preflight);

    if (patchResult.errors.length > 0) {
      return {
        mode: 'local',
        status: 'PREFLIGHT_FAILED',
        errors: patchResult.errors,
        message: `Preflight checks failed with ${patchResult.errors.length} error(s).`
      };
    }

    const modifiedPaths: string[] = [];
    for (const item of patchResult.deletions) {
      const pathIssue = findRepoPathIssue(item.path);
      if (pathIssue) {
        return { mode: 'local', status: 'ERROR', message: pathIssue };
      }
      const normalized = normalizeRepoPath(item.path);
      const absPath = path.resolve(cwd, normalized);
      const resolvedCwd = path.resolve(cwd);
      if (!absPath.startsWith(resolvedCwd + path.sep) && absPath !== resolvedCwd) {
        return { mode: 'local', status: 'ERROR', message: `Path traversal detected: "${item.path}" escapes repository root.` };
      }
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        modifiedPaths.push(normalized);
      }
    }

    for (const item of patchResult.additions) {
      const pathIssue = findRepoPathIssue(item.path);
      if (pathIssue) {
        return { mode: 'local', status: 'ERROR', message: pathIssue };
      }
      const normalized = normalizeRepoPath(item.path);
      const absPath = path.resolve(cwd, normalized);
      const resolvedCwd = path.resolve(cwd);
      if (!absPath.startsWith(resolvedCwd + path.sep) && absPath !== resolvedCwd) {
        return { mode: 'local', status: 'ERROR', message: `Path traversal detected: "${item.path}" escapes repository root.` };
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, item.content, 'utf-8');
      modifiedPaths.push(normalized);
    }

    let commitSha: string | undefined;
    if (!options.skipCommit && modifiedPaths.length > 0) {
      try {
        const commitMsg = patchPayload.commitMessage || `Gemini Bridge local patch for: ${input.prompt.slice(0, 50)}`;
        execFileSync('git', ['add', '--', ...modifiedPaths], { cwd, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', commitMsg], { cwd, stdio: 'pipe' });
        commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: 'pipe' }).toString().trim();
      } catch (gitErr: any) {
        return {
          mode: 'local',
          status: 'SUCCESS',
          message: `Files written to disk, but git commit failed: ${gitErr.message}`
        };
      }
    }

    return {
      mode: 'local',
      status: 'SUCCESS',
      commitSha,
      message: `Successfully applied local patch (${modifiedPaths.length} file(s) modified).`
    };
  } catch (err: any) {
    return {
      mode: 'local',
      status: 'ERROR',
      message: err.message || 'Unknown error occurred during local execution',
      errors: [err]
    };
  }
}
