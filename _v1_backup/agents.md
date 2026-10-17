# AGENTS.md — Gemini-to-GitHub Bridge

## Project Context
Gemini-to-GitHub Bridge is a two-tier developer utility enabling 1-click commits and code patch synchronization from browser-based LLM chats (Google Gemini and Google AI Studio) directly into GitHub repositories:
1. **Frontend Layer (`gemini-bridge.user.js`)**: A browser userscript (Tampermonkey / Violentmonkey) running on `gemini.google.com` and `aistudio.google.com`. It scans LLM code blocks, detects file paths & diff blocks, provides an in-chat commit modal/button, and dispatches JSON payloads to the Cloudflare Worker.
2. **Backend Edge Worker (`cf-gemini-git-bridge/`)**: A serverless Cloudflare Worker written in TypeScript. It handles authentication, resolves target branch HEAD OIDs to prevent race conditions, applies in-memory Search/Replace patches against current GitHub blobs, enforces strict guardrails against LLM placeholder text, and performs atomic multi-file commits via GitHub GraphQL API v4 (`createCommitOnBranch`).

## Codebase Structure
- `gemini-bridge.user.js`: Browser userscript (DOM scanners, diff parser, configuration modal, API dispatch).
- `README.md`: Central documentation for installation, configuration, and API specifications.
- `cf-gemini-git-bridge/`: Cloudflare Worker directory.
  - `wrangler.jsonc`: Cloudflare Worker configuration (`compatibility_date >= 2026-08-04`).
  - `package.json` / `tsconfig.json`: Dependencies and TypeScript config.
  - `src/index.ts`: Worker entry point, routing (`/health`, `/push`, `/commit`, `/graphql`), CORS handling, and authentication.
  - `src/github.ts`: GitHub GraphQL API operations (HEAD resolution, blob fetching, atomic commits).
  - `src/patch.ts`: Search/replace block parser, multi-strategy line matching (exact, normalized CRLF/LF, relaxed trimmed), and LLM placeholder guardrails.
  - `src/encoding.ts`: UTF-8 to Base64 encoding utilities.
  - `src/types.ts`: TypeScript interfaces for payloads, environments, and commit structures.

## Endpoints & Authentication
- **Health Check (`GET /` or `GET /health`)**:
  - Public endpoint returning `{ status: "ok", service: "gemini-git-bridge", version: "1.0.0", hasBridgeSecret: boolean, hasGithubToken: boolean }`.
- **Commit Relay (`POST /push`, `POST /commit`, `POST /api/commit`, `POST /`)**:
  - Authenticated via `Authorization: Bearer <BRIDGE_SECRET>` or header `x-bridge-secret: <BRIDGE_SECRET>`.
  - Body parameters: `repo` (`"owner/repo"`), `targetBranch` (default: `"main"`), `commitMessage`, `changes[]` (supports `search`/`replace`, `patches[]`, or full `content`), and `deletions[]`.
  - Verifies target branch HEAD commit OID (`expectedHeadOid`).
  - Applies patches in-memory and pushes atomically via GitHub GraphQL `createCommitOnBranch`.
- **GraphQL Proxy (`POST /graphql`)**:
  - Authenticated proxy for arbitrary GitHub GraphQL queries/mutations.

## Developer Rules for AI Agents
- **Path Awareness**: The Cloudflare Worker source code and config reside in `cf-gemini-git-bridge/`. All worker commands (e.g. `npx wrangler deploy`, `npm install`) must be run inside `cf-gemini-git-bridge/`.
- **No Local State**: The worker runs at the Cloudflare Edge. Do not introduce local file-system dependencies, SQLite databases, or stateful worker memory.
- **Security First**: Never log, expose, or echo `GITHUB_TOKEN` or `BRIDGE_SECRET` in API responses, console logs, or client-side UI error messages.
- **Hard Guardrail**: Strictly maintain the validation in `patch.ts` that rejects any payload or file content containing LLM placeholder comments (e.g., `// ... existing code ...`, `// ... rest of code ...`, `<!-- ... existing code ... -->`).
- **Patch Preference**: For modifying existing files, always prefer targeted `search`/`replace` patches over full-file overwrites to prevent accidental code truncation.