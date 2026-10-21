import type { HudDomElements } from './hudStylesAndDom';
import { buildUpdateUrl, checkForScriptUpdate } from '../services/updateChecker';

const TRANSIENT_MESSAGE_MS = 6_000;

type BannerTone = 'update' | 'ok' | 'error';

interface BannerAction {
  label: string;
  url: string;
  persistent: boolean;
}

/**
 * Surfaces the self-update state inside the panel. The raw-URL button only opens
 * Tampermonkey's install page — updates are never triggered programmatically.
 */
export function initHudUpdateBanner(dom: HudDomElements): void {
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let installUrl = '';

  const hide = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    installUrl = '';
    dom.updateBanner.style.display = 'none';
  };

  const show = (message: string, tone: BannerTone, action?: BannerAction) => {
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
    if (!action || !action.persistent) {
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
      if (!info) return;

      if (info.hasUpdate) {
        show(
          `⬆ HUD v${info.latestVersion} is available (running v${info.currentVersion}).`,
          'update',
          {
            label: `⬆ Install v${info.latestVersion}`,
            url: buildUpdateUrl(info.latestVersion),
            persistent: true,
          }
        );
      } else if (force) {
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
