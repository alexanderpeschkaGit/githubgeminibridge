# Troubleshooting & Edge Cases (`zip-clean`)

## 1. Locked Files
If an editor or background server has locked a file, PowerShell's `.NET ZipArchive` might raise an `IOException` (`The process cannot access the file because it is being used by another process`).
- **Fix:** Stop active dev servers (`npm run dev`) or test runners before running `zip-clean`.

## 2. Long Path Names on Windows
Windows path limits (MAX_PATH = 260 characters) can sometimes affect deep folder structures.
- `zip-clean.ps1` uses .NET `[System.IO.Compression.ZipFile]` which supports long paths natively when paths are normalized.
- If you encounter a MAX_PATH issue, specify an `-OutputPath` near the drive root (e.g., `C:\temp\archive.zip`).

## 3. Accidental Inclusion of the ZIP Itself
When creating an archive inside the repository folder (e.g., `Y:\repo\archive.zip`), a naive file search might attempt to zip `archive.zip` while it is being written, causing recursion or corruption.
- `zip-clean.ps1` automatically excludes `$resolvedOutput` by comparing absolute paths before archiving, preventing this issue.

## 4. Cross-Platform ZIP Separators
Windows standard paths use backslashes (`\`), but ZIP file specifications require entry keys to use forward slashes (`/`).
- `zip-clean.ps1` explicitly converts relative paths to `/` when creating archive entries:
  ```powershell
  $entryName = $rel.Replace('\', '/')
  ```
  This ensures compatibility when opening the resulting archive on Linux, macOS, Android, or cloud servers.

## 5. Secret Protection
`git ls-files --exclude-standard` strictly obeys `.gitignore`, and `-AdditionalExcludes` now defaults to `@('*.zip', '*.tmp', '.env*', '*.pem', '*.key')`, so stray secrets are filtered even when a rule is missing from `.gitignore`.
- For other secret naming schemes (e.g. `*.p12`, `*.pfx`, `id_rsa*`), append patterns: `-AdditionalExcludes @('*.zip','*.tmp','.env*','*.pem','*.key','*.p12','id_rsa*')`.
- The exclude list is a safety net, not a replacement for ignore rules — always add the file to `.gitignore` as well.

## 6. Non-Git Fallback Enumeration
When `git ls-files` yields nothing, the script falls back to `Get-ChildItem -Recurse -File`.
- The fallback skips `.git`, `node_modules`, `dist`, `.wrangler`, `.tmp`, and every `repomix*` directory (e.g. `repomix-output/`) before `-AdditionalExcludes` runs, so it never packages dependencies, build output, local Wrangler state, or bundler dumps. Root-level runner files (`repomix.ps1`, `repomix.bat`, `repomix.config.json`) remain packaged.
- If a new heavy directory still appears in a fallback archive, add it to `$excludedDirs` in `zip-clean.ps1` or extend `-AdditionalExcludes`.
