---
name: bundle
description: >-
  Bundle the codebase into clean AI-friendly XML chunks with a strict maximum limit of 130,000 characters per file, grouped by directory boundaries, followed by an automated character audit.
  Triggered by #bundle, /bundle, #repomix-split, /repomix-split, or requests to package the codebase into chunks.
---

# Codebase Bundling & 130k-Chunking Workflow (`#bundle`)

**Purpose:** Package the repository into clean, well-formed XML chunks using Repomix, ensuring no individual file chunk exceeds 130,000 characters. Files are grouped atomically by directory structure so that code is never sliced midway.

---

## 1. Execution Modes

### A. Default Bundling (`repomix-output/`)
Pack the codebase into the default output directory `repomix-output/`:

**PowerShell:**
```powershell
.\repomix
# or:
.\repomix.ps1
```

**CMD / Batch:**
```cmd
repomix.bat
```

**NPM:**
```powershell
npm run repomix
```

### B. Custom Destination Folder (`repomix_<name>`)
Specify a custom folder name as the first argument:

**PowerShell:**
```powershell
.\repomix v1_release
# or:
.\repomix.ps1 v1_release
```

**CMD / Batch:**
```cmd
repomix.bat v1_release
```
*Note:* The runner automatically normalizes the folder name with the `repomix_` prefix (e.g. `repomix_v1_release`), ensuring it is automatically ignored by `.gitignore` and `.repomixignore`.

### C. Additional Repomix Flags
Pass any additional Repomix CLI flags after the folder name (or as the first argument if starting with `--`):

**PowerShell:**
```powershell
.\repomix my_chunk --no-security-check
.\repomix --no-security-check
```

**CMD / Batch:**
```cmd
repomix.bat my_chunk --no-security-check
repomix.bat --no-security-check
```

---

## 2. Chunking Specifications & Architecture

- **Max Character Ceiling:** 130,000 characters per file.
- **Chunk Size Budget:** 120,000 bytes (`output.splitOutput: 120000` in `repomix.config.json`).
- **Atomic Integrity:** Top-level directory grouping ensures functions, classes, and components are never cut midway.
- **Self-Contained Chunks:** Each chunk includes a `<file_summary>`, directory structure tree, and properly closed XML tags (`</file>`, `</files>`).
- **Automated Verification:** The runner immediately executes `scripts/patches_and_tests/repomix-audit.ps1` to inspect every generated file and report character counts and `[OK] <= 130k` status.
