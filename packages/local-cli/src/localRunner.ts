import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type {
  HybridTaskInput,
  HybridTaskResult,
  GeminiPatchPayload,
  FilePatchOperation
} from '../../../shared/types';
import { applyPatchesInMemory } from '../../edge-worker/src/modules/patchInMemory';

export interface LocalRunnerOptions {
  apiKey?: string;
  cwd?: string;
  model?: string;
  skipCommit?: boolean;
}

/**
 * Lightweight helper to load .env variables if not already set in process.env.
 */
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
    // Ignore .env read errors
  }
}

/**
 * Extracts JSON content from LLM markdown code blocks (```json ... ```).
 */
export function extractJsonFromResponse(raw: string): string {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch && jsonMatch[1]) {
    return jsonMatch[1].trim();
  }
  return trimmed;
}

/**
 * Calls Gemini REST API or SDK to generate GeminiPatchPayload.
 */
export async function callGeminiForPatch(
  prompt: string,
  contextFiles: { path: string; content: string }[],
  apiKey: string,
  model = 'gemini-2.0-flash'
): Promise<GeminiPatchPayload> {
  const fileContextString = contextFiles
    .map((f) => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const systemInstruction = `You are a high-precision code modification agent.
You must respond ONLY with a valid JSON matching the GeminiPatchPayload schema.
Do NOT include explanations outside of the JSON block.
Schema:
{
  "commitMessage": "string",
  "preflight": {
    "forbidPatterns": ["optional regex string"],
    "requireExports": { "path/to/file.ts": ["exportName"] }
  },
  "patches": [
    {
      "path": "string",
      "action": "modify" | "create" | "delete",
      "blocks": [
        {
          "search": "exact string to replace",
          "replace": "new replacement string (never use placeholders like // ... existing code ...)"
        }
      ],
      "fullContent": "full content for create or full replacement"
    }
  ]
}`;

  const userContent = `Task Prompt:\n${prompt}\n\nContext Files:\n${fileContextString}`;

  // Try dynamic import of @google/genai first, fallback to REST API
  try {
    const genaiMod = await import('@google/genai' as any).catch(() => null);
    if (genaiMod && genaiMod.GoogleGenAI) {
      const ai = new genaiMod.GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model,
        contents: `${systemInstruction}\n\n${userContent}`
      });
      const text = response.text || '';
      const jsonStr = extractJsonFromResponse(text);
      return JSON.parse(jsonStr) as GeminiPatchPayload;
    }
  } catch {
    // Fallback to REST API
  }

  // REST API Fallback
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

  const jsonText = extractJsonFromResponse(rawText);
  return JSON.parse(jsonText) as GeminiPatchPayload;
}

/**
 * Executes a local hybrid task:
 * 1. Reads target files from disk
 * 2. Asks Gemini for GeminiPatchPayload
 * 3. Applies patches in-memory and verifies with preflight linter
 * 4. Writes changes to disk and commits locally via Git
 */
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

  const targetPaths = input.targetPaths || [];
  const originalFiles: { path: string; content: string }[] = [];

  for (const relPath of targetPaths) {
    const absPath = path.resolve(cwd, relPath);
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      originalFiles.push({
        path: relPath.replace(/\\/g, '/'),
        content: fs.readFileSync(absPath, 'utf-8')
      });
    }
  }

  try {
    // 1. Get patch proposal from Gemini
    const patchPayload = await callGeminiForPatch(
      input.prompt,
      originalFiles,
      apiKey,
      options.model
    );

    // 2. Validate in-memory with preflight linter (Stage 2 & 4)
    const existingRecord: Record<string, string | null> = {};
    for (const f of originalFiles) {
      existingRecord[f.path] = f.content;
    }
    for (const patch of patchPayload.patches) {
      if (!(patch.path in existingRecord)) {
        const absPath = path.resolve(cwd, patch.path);
        existingRecord[patch.path] = fs.existsSync(absPath)
          ? fs.readFileSync(absPath, 'utf-8')
          : null;
      }
    }

    const patchResult = await applyPatchesInMemory(
      patchPayload.patches,
      existingRecord,
      patchPayload.preflight
    );

    if (patchResult.errors.length > 0) {
      return {
        mode: 'local',
        status: 'PREFLIGHT_FAILED',
        errors: patchResult.errors,
        message: `Preflight checks failed with ${patchResult.errors.length} error(s).`
      };
    }

    // 3. Write changes to disk
    const modifiedPaths: string[] = [];
    for (const item of patchResult.deletions) {
      const absPath = path.resolve(cwd, item.path);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        modifiedPaths.push(item.path);
      }
    }

    for (const item of patchResult.additions) {
      const absPath = path.resolve(cwd, item.path);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, item.content, 'utf-8');
      modifiedPaths.push(item.path);
    }

    // 4. Git commit
    let commitSha: string | undefined;
    if (!options.skipCommit && modifiedPaths.length > 0) {
      try {
        const commitMsg = patchPayload.commitMessage || `Gemini Bridge local patch for: ${input.prompt.slice(0, 50)}`;
        for (const p of modifiedPaths) {
          execSync(`git add "${p}"`, { cwd, stdio: 'pipe' });
        }
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd, stdio: 'pipe' });
        commitSha = execSync('git rev-parse HEAD', { cwd, stdio: 'pipe' }).toString().trim();
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
