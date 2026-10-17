import type {
  LinterError,
  WorkerPatchResponse,
  HudConfig,
  HudState
} from '../types';
import { injectPromptText } from '../dom/injector';

/**
 * Maximum number of automated self-healing turns before stopping and requiring manual review.
 */
export const MAX_SELF_HEALING_RETRIES = 3;

/**
 * Builds a structured #solve self-healing prompt targeting all collected preflight & syntax errors.
 */
export function buildSelfHealingPrompt(
  errors: LinterError[],
  repo: string,
  branch: string,
  headOid: string,
  retryAttempt: number
): string {
  const formattedErrors = errors
    .map((err, idx) => {
      const loc = err.line ? (err.column ? `:${err.line}:${err.column}` : `:${err.line}`) : '';
      const snippet = err.codeSnippet ? `\n   > ${err.codeSnippet}` : '';
      return `${idx + 1}. [Stage: ${err.stage}] ${err.file}${loc} — ${err.message}${snippet}`;
    })
    .join('\n');

  return `#solve Linter & Preflight Self-Healing Loop (Retry ${retryAttempt}/${MAX_SELF_HEALING_RETRIES})

The previous patch for repository "${repo}" on branch "${branch}" was rejected during Edge-Worker preflight validation.
Expected HEAD commit: "${headOid}".

Aggregated Preflight Errors (${errors.length}):
${formattedErrors}

Fix Instructions:
1. Fix ALL listed syntax and rule errors in a single cohesive response.
2. Hard Guardrail: NEVER use placeholder comments like "// ... existing code ...", "/* remaining code */", or "# ... existing code ...". Always provide complete search/replace blocks or full file content.
3. Provide your correction as a single valid JSON codeblock matching the GeminiPatchPayload schema:
\`\`\`json
{
  "commitMessage": "fix: resolve preflight linter errors (retry ${retryAttempt})",
  "patches": [
    {
      "path": "path/to/file.ext",
      "action": "modify",
      "blocks": [
        {
          "search": "exact string to replace",
          "replace": "replacement string"
        }
      ]
    }
  ]
}
\`\`\`
`;
}

/**
 * Evaluates whether the self-healing auto-retry loop should trigger.
 */
export function shouldTriggerSelfHealing(
  response: WorkerPatchResponse,
  autoPilot: boolean,
  currentRetryCount: number
): { trigger: boolean; nextRetryCount: number; reason: string } {
  if (response.status === 'COMMITTED') {
    return {
      trigger: false,
      nextRetryCount: 0,
      reason: 'COMMITTED_SUCCESS'
    };
  }

  if (response.status !== 'PREFLIGHT_FAILED') {
    return {
      trigger: false,
      nextRetryCount: currentRetryCount,
      reason: 'STATUS_NOT_PREFLIGHT_FAILED'
    };
  }

  if (!Array.isArray(response.errors) || response.errors.length === 0) {
    return {
      trigger: false,
      nextRetryCount: currentRetryCount,
      reason: 'NO_ERRORS_REPORTED'
    };
  }

  if (currentRetryCount >= MAX_SELF_HEALING_RETRIES) {
    return {
      trigger: false,
      nextRetryCount: currentRetryCount,
      reason: 'MAX_RETRIES_EXCEEDED'
    };
  }

  if (!autoPilot) {
    return {
      trigger: false,
      nextRetryCount: currentRetryCount,
      reason: 'AUTOPILOT_DISABLED'
    };
  }

  return {
    trigger: true,
    nextRetryCount: currentRetryCount + 1,
    reason: 'PREFLIGHT_FAILED_AUTO_RETRY'
  };
}

/**
 * Executes a single turn of the automated self-healing loop:
 * checks conditions, constructs the structured prompt, and injects it into the LLM chat.
 */
export function executeSelfHealingTurn(
  response: WorkerPatchResponse,
  cfg: HudConfig,
  state: HudState,
  autoSubmit = true
): { triggered: boolean; nextRetryCount: number; prompt?: string; reason: string } {
  const evalResult = shouldTriggerSelfHealing(response, cfg.autoPilot, state.retryCount);

  if (!evalResult.trigger) {
    return {
      triggered: false,
      nextRetryCount: evalResult.nextRetryCount,
      reason: evalResult.reason
    };
  }

  const prompt = buildSelfHealingPrompt(
    response.errors || [],
    cfg.repo,
    cfg.branch,
    state.headOid,
    evalResult.nextRetryCount
  );

  injectPromptText(prompt, autoSubmit);

  return {
    triggered: true,
    nextRetryCount: evalResult.nextRetryCount,
    prompt,
    reason: evalResult.reason
  };
}
