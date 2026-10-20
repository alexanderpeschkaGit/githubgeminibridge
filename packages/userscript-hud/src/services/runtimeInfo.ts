/**
 * Runtime diagnostics for the userscript bundle.
 *
 * A stale Tampermonkey install and a failing mount look identical from the outside
 * ("no HUD"), so the executing version is logged and mount failures are surfaced
 * instead of dying silently.
 */
const INIT_FAILURE_ID = 'gemini-edge-hud-init-error';

export function getRunningScriptVersion(): string {
  if (typeof GM_info === 'undefined' || !GM_info || !GM_info.script) {
    return '';
  }
  return GM_info.script.version || GM_info.script.versionString || '';
}

export function reportHudInitFailure(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[Gemini Edge HUD] Initialisation failed:', error);

  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById(INIT_FAILURE_ID)) return;

  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const version = getRunningScriptVersion();
  const box = document.createElement('div');
  box.id = INIT_FAILURE_ID;
  box.textContent = `⚡ Gemini Edge HUD${version ? ` v${version}` : ''} failed to initialise: ${message}`;
  box.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'max-width:460px',
    'padding:10px 14px',
    'border-radius:8px',
    'background:#7f1d1d',
    'color:#fff',
    'font:12px/1.5 system-ui,sans-serif',
    'box-shadow:0 6px 24px rgba(0,0,0,.45)',
    'white-space:pre-wrap'
  ].join(';');
  document.body.appendChild(box);
}
