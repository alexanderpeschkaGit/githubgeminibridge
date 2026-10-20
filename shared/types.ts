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
export interface MixPart {
  partIndex: number;          // 1-basierter Index (z.B. 1, 2, 3)
  totalParts: number;         // Gesamtanzahl der Chunks
  fileName: string;           // z.B. "repo-mix.part1.xml"
  xmlContent: string;         // Vollständiges, valides XML für diesen Part
  stats: {
    fileCount: number;
    estimatedTokens: number;
    charCount: number;
  };
}

export interface MixRequest {
  repo: string;              // Format: "owner/repository"
  branch: string;            // z.B. "main"
  includePaths?: string[];   // Optionaler Subpfad-Filter (z.B. ["src/", "shared/"])
  persistToGitHub?: boolean; // Speichert Mix optional nach /_context/repo-mix.xml
  maxChunkChars?: number;    // Maximale Zeichenanzahl pro Part (Standard: 85_000, unterhalb 100k Gemini-Limit)
  maxChunkBytes?: number;    // Maximale Byte-Größe pro Part (Standard: 512_000 ~500 KB)
  maxChunkTokens?: number;   // Maximale geschätzte Tokens pro Part (Standard: 125_000)
  splitOutput?: boolean;     // Ob Chunking aktiviert werden soll (Standard: true wenn Budget überschritten)
  includeRecentCommits?: boolean; // Opt-in (default: false): fetch & include recent commit metadata and volatile file summaries
  recentCommitsCount?: number;   // Number of recent commits to analyze (default: 3, max: 5)
}

export interface MixResponse {
  status: "OK" | "ERROR";
  headOid: string;           // Voller 40-stelliger Commit-SHA als Basis für Folgebefehle
  xmlContent: string;        // Strukturierter XML-Kontext (Part 1 oder Gesamtmix für Abwärtskompatibilität)
  parts?: MixPart[];         // Aufgeteilte Parts für Multi-File Ingestion bei großen Repos
  isChunked?: boolean;       // Zeigt an, ob der Output in mehrere Parts gesplittet wurde
  stats: {
    fileCount: number;
    estimatedTokens: number;
    charCount?: number;
    recentCommitsCount?: number;
    volatileFilesCount?: number;
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
  targetBranch?: string;          // Optional: abweichender Zielbranch (z.B. "feature/xyz" oder "gemini/patch-1")
  expectedTargetHeadOid?: string; // Optionaler, vom Source-OID getrennter Target-Branch Concurrency-Token
  createBranchIfNeeded?: boolean; // Default true: legt targetBranch an, falls nicht vorhanden
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
  newHeadOid?: string;         // Effektiver Branch-HEAD nach Commit/No-op; Fehler-OIDs dienen nur Diagnose
  commitUrl?: string;
  errors?: LinterError[];      // Aggregierte Fehlerliste für Auto-Retry in Gemini
  errorMessage?: string;
  targetBranch?: string;          // Der tatsächlich verwendete Zielbranch
  createdBranch?: boolean;        // True, falls der Branch frisch erzeugt wurde
  pullRequestUrl?: string;        // GitHub Compare/PR-Link (z.B. https://github.com/owner/repo/compare/base...target?expand=1)
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

// ==========================================
// 5. HYBRID ROUTING & WEBHOOK (Stage 5)
// ==========================================
export * from './hybridTypes';
