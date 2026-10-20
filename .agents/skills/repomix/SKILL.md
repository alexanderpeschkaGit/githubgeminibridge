---
name: repomix
description: >-
  Pack and split the codebase into AI-friendly context chunks with a strict maximum limit of 130,000 characters per file, semantically partitioned by directory boundaries, followed by an automated character audit.
  Triggered by #repomix, /repomix, or requests to bundle or split the repository.
---

# Repomix Codebase Chunking & Bundler Workflow

Pack the repository into semantically partitioned chunks with a strict maximum limit of **130,000 characters per chunk** (`repomix-output/bundle.*.txt`), designed for LLM context windows, multi-agent analysis, or external AI platforms.

## Core Architecture & 130k Partitioning Strategy

1. **Semantic Grouping (Preserving Code Context):**
   Repomix uses top-level directory boundaries to group files logically. A single file or function is **never sliced down the middle** across chunks.
2. **Buffer Margin for 130,000 Characters:**
   In `repomix.config.json`, `splitOutput` is set to `120000` (bytes). This 10,000-character safety margin accounts for XML wrapping, file headers, directory trees, and token metrics, ensuring the final files remain strictly `<= 130,000 characters`.
3. **Automated Audit:**
   Every bundling run is immediately verified by `scripts/patches_and_tests/repomix-audit.ps1`, reporting the exact character count, byte size, and pass/fail status per chunk.

---

## Execution Protocols

### Option A: Standard Full-Repository Packaging (Interactive or Direct)

From PowerShell or Terminal:

```powershell
# Non-interactive execution (safe for agent automation, no pause prompts)
.\repomix.bat --non-interactive
```

Or execute via npm:

```powershell
npm run repomix -- --non-interactive
```

Or run via explicit CLI commands:

```powershell
# 1. Clean previous chunks
if (Test-Path repomix-output) { Remove-Item -Recurse -Force repomix-output\* }

# 2. Run Repomix using the calibrated repomix.config.json
npx --yes repomix

# 3. Execute strict character audit (verifies <= 130,000 characters)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches_and_tests\repomix-audit.ps1
```

---

### Option B: Unified Agent Rules & Documentation Bundle

When you only need to pack agent instructions, workflows, project rules, and architecture docs into a single, compact XML file without source code:

```powershell
npm run repomix:agents
# or directly:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches_and_tests\repomix-agents.ps1
```

This outputs `repomix-output.xml` containing `AGENTS.md`, `.agents/WORKFLOWS.md`, `.agents/rules/*.md`, `.agents/skills/**/*.md`, and related architectural documentation.

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

## Configuration Reference (`repomix.config.json`)

The workspace configuration controls the packaging behavior:

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
      "repomix-output*"
    ]
  },
  "security": {
    "enableSecurityCheck": true
  }
}
```

---

## Verification & Audit Checklist

After running the bundler, always verify:
1. **File Count & Naming:** Check `repomix-output/` contains sequential files (`bundle.1.txt`, `bundle.2.txt`, ...).
2. **Character Count Gate:** Confirm the audit table in the terminal outputs `[OK] <= 130k` for all chunks.
3. **Context Integrity:** Ensure key files (such as `src/`, `server.ts`, etc.) are captured without truncation.
4. **Security Check:** Confirm no secrets, API keys, or `.env` entries were bundled.
