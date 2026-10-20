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
`git ls-files --exclude-standard` strictly obeys `.gitignore`. However, if someone forgot to add a secret file (like a newly created `.env.local` that isn't ignored yet), it might get picked up.
- Use `-AdditionalExcludes @('*.env*', '*.pem', '*.key')` or add the file to `.gitignore` first.
