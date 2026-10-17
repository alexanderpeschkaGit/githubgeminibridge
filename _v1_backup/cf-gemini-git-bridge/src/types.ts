export interface Env {
  BRIDGE_SECRET: string;
  GITHUB_TOKEN: string;
}

export interface PatchItem {
  search: string;
  replace: string;
}

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
