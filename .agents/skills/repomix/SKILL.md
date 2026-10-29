---
name: repomix
description: >-
  Pack and split the codebase into AI-friendly context chunks with a strict maximum limit of 130,000 characters per file, semantically partitioned by directory boundaries, followed by an automated character audit.
  Triggered by #repomix, /repomix, #bundle, /bundle, #repomix-split, /repomix-split, or requests to bundle or split the repository.
---

# Repomix Codebase Chunking & Bundler Workflow

Pack the repository into semantically partitioned chunks with a strict maximum limit of **130,000 characters per chunk** (`repomix-output/bundle.*.txt`), designed for LLM context windows, multi-agent analysis, or external AI platforms.

## Core Architecture & 130k Partitioning Strategy

> [!IMPORTANT] **Two different limits — do not confuse them.** The `#repomix` / `#bundle` CLI workflow below targets **130,000 characters per chunk** for generic LLM context. The **edge-worker's own** RepoMix generator (`packages/edge-worker/src/modules/mixChunker.ts`) is stricter because it feeds the Gemini Web UI: `DEFAULT_MAX_CHUNK_CHARS = 85_000`, `HARD_GEMINI_CHAR_LIMIT = 100_000`, `MAX_GEMINI_PARTS = 10`. Never raise those constants to the 130k CLI budget. When a repository needs more than 10 parts, the worker omits whole files deterministically, reports `MixTruncation`, and warns in the HUD; file contents are never compressed or truncated for patch fidelity.

1. **Semantic Grouping (Preserving Code Context):**
   Repomix uses top-level directory boundaries to group files logically. A single file or function is **never sliced down the middle** across chunks.
2. **Buffer Margin for 130,000 Characters:**
   `splitOutput` is set to `120000` (bytes). This 10,000-character safety margin accounts for XML wrapping, file headers, directory trees, and token metrics, ensuring the final files remain strictly `<= 130,000 characters`.
3. **Automated Audit:**
   Every bundling run must be verified by counting characters per generated chunk and confirming each stays `<= 130,000`. This repository ships no audit script; use the inline check in Option A.

---

## Execution Protocols

### Option A: Standard Full-Repository Packaging (Interactive or Direct)

From PowerShell or Terminal:

```powershell
# Non-interactive execution (safe for agent automation, no pause prompts)
npx --yes repomix --non-interactive
```

Or run via explicit CLI commands:

```powershell
# 1. Clean previous chunks
if (Test-Path repomix-output) { Remove-Item -Recurse -Force repomix-output\* }

# 2. Run Repomix with an explicit 120kb split budget
npx --yes repomix --split-output 120kb --output "repomix-output/bundle.txt"

# 3. Strict character audit (verifies <= 130,000 characters per chunk)
Get-ChildItem repomix-output\bundle*.txt | ForEach-Object {
  $len = (Get-Content $_.FullName -Raw).Length
  "{0,-40} {1,8} chars  {2}" -f $_.Name, $len, $(if ($len -le 130000) { '[OK] <= 130k' } else { '[FAIL] > 130k' })
}
```

---

### Option B: Unified Agent Rules & Documentation Bundle

When you only need to pack agent instructions, workflows, project rules, and architecture docs into a single, compact XML file without source code:

```powershell
npx --yes repomix --include "agents.md,.agents/**/*.md,plans/**/*.md,REPOMIX_INSTRUCTIONS.md" --output "repomix-output/agents.xml"
```

This outputs `repomix-output/agents.xml` containing `agents.md`, `.agents/WORKFLOWS.md`, `.agents/rules/*.md`, `.agents/skills/**/*.md`, and related architectural documentation.

---

### Option C: Custom CLI Split Overrides

To override target chunk limits on the fly:

```powershell
# Split with a specific size limit (e.g. 100kb chunks)
npx --yes repomix --split-output 100kb --output "repomix-output/custom.txt"

# Token-optimized compressed mode with splitting
npx --yes repomix --split-output 120kb --compress --remove-comments --output "repomix-output/bundle-compressed.txt"
```

---

### Option D: Custom Destination Folder & Flag Passthrough

> [!NOTE] This repository does **not** ship `repomix.ps1` / `repomix.bat` runners or a `repomix.config.json`. Use the `npx` form below; it needs no local install and no runner script.

```powershell
# Named output folder (keep the repomix_ prefix so .gitignore can exclude it)
npx --yes repomix --output "repomix_my_chunk/bundle.txt"

# Any additional Repomix CLI flags pass straight through
npx --yes repomix --no-security-check
```

Add `repomix_*/` to `.gitignore` before creating ad-hoc bundles so they never pollute Git status.

---

## Configuration Reference (`repomix.config.json`)

This repository has no committed `repomix.config.json`; pass flags on the CLI instead. If you add one, this is the calibrated shape:

```json
{
  "$schema": "https://raw.githubusercontent.com/yamadashy/repomix/main/repomix.config.schema.json",
  "output": {
    "filePath": "repomix-output/bundle.txt",
    "style": "xml",
    "splitOutput": 120000,
    "parsableStyle": true,
    "removeComments": false,
    "removeEmptyLines": false,
    "topFilesLength": 5
  },
  "ignore": {
    "useGitignore": true,
    "useDefaultPatterns": true,
    "customPatterns": [
      "scripts/patches_and_tests/**",
      "plans/**",
      "*.zip",
      "*bundle*.txt",
      "repomix-output/**",
      "repomix-output*",
      "_v1_backup/**",
      "cf-gemini-git-bridge/**"
    ]
  },
  "security": {
    "enableSecurityCheck": true
  }
}
```

> [!WARNING] `_v1_backup/` and `cf-gemini-git-bridge/` are read-only legacy trees. Always exclude them from bundles so the model never proposes edits there.

---

## Verification & Audit Checklist

After running the bundler, always verify:
1. **File Count & Naming:** Check `repomix-output/` contains sequential files (`bundle.1.txt`, `bundle.2.txt`, ...).
2. **Character Count Gate:** Confirm the audit table in the terminal outputs `[OK] <= 130k` for all chunks.
3. **Context Integrity:** Ensure key files (such as `packages/edge-worker/src/`, `shared/`, `gemini-bridge.user.js`, etc.) are captured without truncation.
4. **Security Check:** Confirm no secrets, API keys, or `.env` entries were bundled.
