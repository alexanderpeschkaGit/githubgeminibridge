import type { HudDomElements } from './hudStylesAndDom';
import { buildUpdateUrl, checkForScriptUpdate } from '../services/updateChecker';
import { getRunningScriptVersion } from '../services/runtimeInfo';

const TRANSIENT_MESSAGE_MS = 6_000;

type BannerTone = 'update' | 'ok' | 'error';

interface BannerAction {
  label: string;
  url: string;
}

/**
 * Surfaces the self-update state inside the panel. The raw-URL button only opens
 * Tampermonkey's install page — updates are never triggered programmatically.
 */
export function initHudUpdateBanner(dom: HudDomElements): void {
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let installUrl = '';
  const runningVersion = getRunningScriptVersion();
  if (runningVersion) {
    dom.updateCheckBtn.title = `Check published userscript version (running v${runningVersion})`;
  }

  const hide = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    installUrl = '';
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
    window.open(installUrl, '_blank', 'noopener');
  });

  const runCheck = async (force: boolean) => {
    dom.updateCheckBtn.disabled = true;
    try {
      const info = await checkForScriptUpdate({ force });
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
          },
          true
        );
      } else if (force) {
        // A 6 s toast is easy to miss right after clicking, so a manual result stays put.
        show(`✅ HUD is up to date (v${info.currentVersion}).`, 'ok', undefined, true);
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
