import type { HudDomElements } from './hudStylesAndDom';
import { buildUpdateUrl, checkForScriptUpdate } from '../services/updateChecker';
import { getRunningScriptVersion } from '../services/runtimeInfo';

const TRANSIENT_MESSAGE_MS = 6_000;

type BannerTone = 'update' | 'ok' | 'error';

interface BannerAction {
  label: string;
  url: string;
  version: string;
}

export interface HudUpdateBannerDeps {
  /** Injectable for the Node regression harness; defaults to the real checker. */
  check?: typeof checkForScriptUpdate;
}

/**
 * Surfaces the self-update state inside the panel. The raw-URL button only opens
 * Tampermonkey's install page — updates are never triggered programmatically.
 */
export function initHudUpdateBanner(dom: HudDomElements, deps: HudUpdateBannerDeps = {}): void {
  const check = deps.check ?? checkForScriptUpdate;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let installUrl = '';
  let installVersion = '';
  const runningVersion = getRunningScriptVersion();
  if (runningVersion) {
    dom.updateCheckBtn.title = `Check published userscript version (running v${runningVersion})`;
  }
  // The panel stylesheet starts the banner hidden; keep that state explicit so a
  // silent background check never leaves a visible empty banner behind.
  dom.updateBanner.style.display = 'none';

  const hide = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    installUrl = '';
    installVersion = '';
    dom.updateBanner.style.display = 'none';
  };

  const show = (
    message: string,
    tone: BannerTone,
    action?: BannerAction,
    persistent: boolean = false
  ) => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    installUrl = action ? action.url : '';
    installVersion = action ? action.version : '';
    dom.updateBanner.className = `hud-update-banner ${tone}`;
    dom.updateBannerText.textContent = message;
    dom.updateBannerBtn.textContent = action ? action.label : '×';
    dom.updateBannerBtn.title = action ? 'Open the Tampermonkey update page' : 'Dismiss';
    dom.updateBanner.style.display = 'flex';
    if (!persistent) {
      hideTimer = setTimeout(hide, TRANSIENT_MESSAGE_MS);
    }
  };

  dom.updateBannerBtn.addEventListener('click', () => {
    if (!installUrl) {
      hide();
      return;
    }
    const targetUrl = installUrl;
    const targetVersion = installVersion;
    // This instance keeps executing until the page reloads; leaving the banner up
    // would keep claiming an update that Tampermonkey already installed.
    hide();
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(targetUrl, '_blank', 'noopener');
    }
    show(
      targetVersion
        ? `ℹ️ Reload this page after installing v${targetVersion} to activate it.`
        : 'ℹ️ Reload this page after installing the update to activate it.',
      'ok'
    );
  });

  const runCheck = async (force: boolean) => {
    dom.updateCheckBtn.disabled = true;
    try {
      const info = await check({ force });
      if (!info) return; // throttled background check

      if (!info.currentVersion) {
        // Without GM_info the comparison is impossible; a manual click must still
        // report something instead of looking dead.
        const message = `⚠️ Running version unknown — published is v${info.latestVersion}. Reinstall the userscript if this persists.`;
        if (force) {
          show(message, 'error', undefined, true);
        } else {
          console.warn('[Gemini Edge HUD]', message);
        }
        return;
      }

      if (info.hasUpdate) {
        show(
          `⬆ HUD v${info.latestVersion} is available (running v${info.currentVersion}).`,
          'update',
          {
            label: `⬆ Install v${info.latestVersion}`,
            url: buildUpdateUrl(info.latestVersion),
            version: info.latestVersion,
          },
          true
        );
      } else if (force) {
        // A manual "up to date" stays a toast: a sticky all-clear banner would
        // outlive its usefulness and just sit in the panel.
        show(`✅ HUD is up to date (v${info.currentVersion}).`, 'ok');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[Gemini Edge HUD] Update check failed:', err);
      if (force) show(`⚠️ Update check failed: ${message}`, 'error');
    } finally {
      dom.updateCheckBtn.disabled = false;
    }
  };

  dom.updateCheckBtn.addEventListener('click', () => {
    void runCheck(true);
  });

  // Throttled background check (once per 6h); manual checks always bypass it.
  void runCheck(false);
}
