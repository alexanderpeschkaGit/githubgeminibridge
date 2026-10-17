// ==========================================
// 1. WORKER ENVIRONMENT & AUTH (V2 + V1 Compatible)
// ==========================================
export interface WorkerEnv {
  GITHUB_PAT: string;       // Hinterlegt via `wrangler secret put GITHUB_PAT`
  GITHUB_TOKEN: string;     // V1 Legacy Alias für GITHUB_PAT
  WORKER_SECRET: string;    // Shared Bearer Secret zwischen Userscript und Worker
  BRIDGE_SECRET: string;    // V1 Legacy Alias für WORKER_SECRET
}

export type Env = WorkerEnv;

// ==========================================
// 2. UNTERTOOL A: MIXER (/api/mix)
// ==========================================
export interface MixRequest {
  repo: string;              // Format: "owner/repository"
  branch: string;            // z.B. "main"
  includePaths?: string[];   // Optionaler Subpfad-Filter (z.B. ["src/", "shared/"])
  persistToGitHub?: boolean; // Speichert Mix optional nach /_context/repo-mix.xml
}

export interface MixResponse {
  status: "OK" | "ERROR";
  headOid: string;           // Voller 40-stelliger Commit-SHA als Basis für Folgebefehle
  xmlContent: string;        // Strukturierter XML-Kontext (<repository><file_tree>...<file>...)
  stats: {
    fileCount: number;
    estimatedTokens: number;
  };
  persistedCommitOid?: string; // Falls persistToGitHub === true ausgeführt wurde
  errorMessage?: string;       // Fehlerbeschreibung bei status === "ERROR"
}

// ==========================================
// 3. UNTERTOOL B & C: PATCHER & LINTER (/api/patch)
// ==========================================
export interface PatchBlock {
  search: string;
  replace: string;
}

export interface FilePatchOperation {
  path: string;
  action: "modify" | "create" | "delete";
  blocks?: PatchBlock[];     // Pflicht bei action === "modify"
  fullContent?: string;      // Pflicht bei action === "create" (optional bei "modify")
}

export interface GeminiPatchPayload {
  commitMessage: string;
  preflight?: {
    forbidPatterns?: string[];                 // RegExp-Strings, z.B. ["console\\.log", ": any"]
    requireExports?: Record<string, string[]>; // z.B. { "src/auth.ts": ["useAuth"] }
  };
  patches: FilePatchOperation[];
}

export interface WorkerPatchRequest {
  repo: string;
  branch: string;
  expectedHeadOid: string;     // 40-stelliger Git-SHA für Optimistic Concurrency Control
  payload: GeminiPatchPayload;
}

export interface LinterError {
  file: string;
  stage: "SEARCH_REPLACE" | "OXC_SYNTAX" | "CUSTOM_RULE";
  line?: number;
  column?: number;
  message: string;
  codeSnippet?: string;
}

export interface WorkerPatchResponse {
  status: "COMMITTED" | "PREFLIGHT_FAILED" | "GIT_CONFLICT" | "NO_CHANGES_NEEDED" | "ERROR";
  newHeadOid?: string;         // Neuer 40-stelliger Commit-SHA nach erfolgreichem Commit
  commitUrl?: string;
  errors?: LinterError[];      // Aggregierte Fehlerliste für Auto-Retry in Gemini
  errorMessage?: string;
}

// ==========================================
// 4. V1 LEGACY COMPATIBILITY INTERFACES (/push, /commit)
// ==========================================
export type PatchItem = PatchBlock;

export interface FileChangeInput {
  path: string;
  content?: string;
  search?: string;
  replace?: string;
  patches?: PatchItem[];
  diff?: string;
}

export interface FileDeletionInput {
  path: string;
}

export interface CommitRequest {
  owner?: string;
  repo: string; // e.g. "alexanderpeschkaGit/Portfolio_VJ_Brave_V2_0" or "Portfolio_VJ_Brave_V2_0"
  branch?: string;
  baseBranch?: string;
  targetBranch?: string;
  message?: string;
  commitMessage?: string;
  files?: FileChangeInput[];
  changes?: FileChangeInput[];
  deletions?: (string | FileDeletionInput)[];
}

export interface GitHubCommitResult {
  oid: string;
  url: string;
  messageHeadline: string;
}
