import type { WorkerEnv } from './types';

// ==========================================
// 1. EXECUTION MODE & HYBRID ROUTING
// ==========================================
export type ExecutionMode = 'local' | 'worker';

export interface HybridTaskInput {
  prompt: string;
  repo: string;                 // Format: "owner/repository"
  branch: string;               // e.g. "main"
  targetPaths?: string[];       // Subpath filters or files to include
  issueOrPrNumber?: number;     // Optional issue/PR number for status commenting
}

export interface HybridTaskResult {
  mode: ExecutionMode;
  status: 'SUCCESS' | 'PREFLIGHT_FAILED' | 'ERROR';
  commitSha?: string;
  errors?: any[];
  message?: string;
}

// ==========================================
// 2. HYBRID WORKER ENVIRONMENT CONTRACTS
// ==========================================
export interface HybridWorkerEnv extends WorkerEnv {
  EXECUTION_MODE?: ExecutionMode;
  ENVIRONMENT?: string;
  GEMINI_API_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
}

// ==========================================
// 3. GITHUB WEBHOOK CONTRACTS (Pure Webhook Events)
// ==========================================
export interface GitHubWebhookSender {
  login: string;
  id?: number;
  type?: string;
}

export interface GitHubWebhookRepository {
  name: string;
  full_name: string;
  owner: {
    login: string;
    id?: number;
  };
  default_branch?: string;
  private?: boolean;
  html_url?: string;
}

export interface GitHubWebhookIssue {
  number: number;
  title: string;
  body?: string | null;
  comments_url: string;
  html_url: string;
  user?: GitHubWebhookSender;
}

export interface GitHubWebhookPullRequest {
  number: number;
  title: string;
  body?: string | null;
  comments_url: string;
  html_url: string;
  head?: {
    ref: string;
    sha: string;
  };
  base?: {
    ref: string;
    sha: string;
  };
  user?: GitHubWebhookSender;
}

export interface GitHubWebhookComment {
  id: number;
  body: string;
  user: GitHubWebhookSender;
  html_url?: string;
  created_at?: string;
}

export interface GitHubWebhookPayload {
  action?: string;
  issue?: GitHubWebhookIssue;
  pull_request?: GitHubWebhookPullRequest;
  comment?: GitHubWebhookComment;
  repository?: GitHubWebhookRepository;
  sender?: GitHubWebhookSender;
}
