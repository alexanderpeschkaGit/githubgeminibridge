export * from '../../../shared/types';
import type { GeminiPatchPayload, CommitRequest, LinterError, MixPart } from '../../../shared/types';

export interface HudConfig {
  workerUrl: string;
  workerSecret: string;
  owner: string;
  repo: string;
  branch: string;
  targetBranch?: string;
  includePaths: string[];
  autoPilot: boolean;
  persistToGitHub: boolean;
  maxChunkChars: number;
  includeRecentCommits: boolean;
}

export interface HarvestedPatch {
  id: string;
  mode: 'v2_json' | 'v1_search_replace';
  commitMessage: string;
  payload: GeminiPatchPayload;
  legacyPayload?: CommitRequest;
  timestamp: string;
}

export type HudStatus =
  | 'IDLE'
  | 'MIXING'
  | 'PATCHING'
  | 'COMMITTED'
  | 'PREFLIGHT_FAILED'
  | 'GIT_CONFLICT'
  | 'ERROR';

export interface HudState {
  /** Source branch OID returned by /api/mix; never overwritten by target-only commits. */
  headOid: string;
  targetHeadOid: string;
  targetHeadBranch: string;
  lastMixStats: {
    fileCount: number;
    estimatedTokens: number;
    recentCommitsCount?: number;
    volatileFilesCount?: number;
  } | null;
  status: HudStatus;
  statusMessage: string;
  retryCount: number;
  lastErrors: LinterError[];
  harvestedPatches: HarvestedPatch[];
  continuationQueue: MixPart[];
}

// Tampermonkey & Trusted Types Ambient Declarations
declare global {
  interface Window {
    trustedTypes?: {
      createPolicy: (
        name: string,
        rules: {
          createHTML?: (s: string) => string;
          createScript?: (s: string) => string;
          createScriptURL?: (s: string) => string;
        }
      ) => {
        createHTML: (s: string) => string;
      };
      defaultPolicy?: {
        createHTML: (s: string) => string;
      };
    };
  }

  function GM_getValue<T = string>(key: string, defaultValue?: T): T;
  function GM_setValue<T = string>(key: string, value: T): void;
  function GM_notification(options: { title?: string; text: string; timeout?: number }): void;
  function GM_addStyle(css: string): HTMLStyleElement;
  const GM_info:
    | { script?: { name?: string; version?: string; versionString?: string } }
    | undefined;

  interface GMXmlHttpRequestHeaders {
    [key: string]: string;
  }

  interface GMXmlHttpRequestResponse {
    status: number;
    statusText: string;
    responseText: string;
    responseHeaders: string;
  }

  interface GMXmlHttpRequestOptions {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
    url: string;
    headers?: GMXmlHttpRequestHeaders;
    data?: string;
    timeout?: number;
    onload?: (response: GMXmlHttpRequestResponse) => void;
    onerror?: (error: any) => void;
    ontimeout?: () => void;
  }

  function GM_xmlhttpRequest(options: GMXmlHttpRequestOptions): any;

  namespace GM {
    function xmlHttpRequest(options: GMXmlHttpRequestOptions): Promise<GMXmlHttpRequestResponse>;
  }
}
