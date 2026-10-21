/**
 * Self-update detection for the userscript bundle.
 *
 * Tampermonkey checks `@updateURL` on its own schedule (~24h, not controllable from
 * the script), so a published release can stay invisible for a whole day even though
 * the raw URL already serves a higher `@version`. The HUD therefore reads the
 * published metadata block itself and can show an explicit, clickable update.
 */
import { getRunningScriptVersion } from './runtimeInfo';
import { getStoredValue, setStoredValue } from './storage';

export const SCRIPT_SOURCE_URL =
  'https://raw.githubusercontent.com/alexanderpeschkaGit/githubgeminibridge/main/gemini-bridge.user.js';

const LAST_CHECK_KEY = 'script_update_last_check';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15_000;

export interface ScriptUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

/** Reads `@version` from the `==UserScript==` metadata block. */
export function parseUserscriptVersion(source: string): string {
  const block = (source || '').match(/\/\/\s*==UserScript==\r?\n([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!block) return '';
  const version = block[1].match(/^\/\/\s*@version\s+(\S+)\s*$/m);
  return version ? version[1].trim() : '';
}

/** Numeric segment comparison; > 0 means `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const toParts = (value: string) =>
    (value || '')
      .trim()
      .split(/[.+-]/)
      .map((part) => {
        const parsed = parseInt(part, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });

  const left = toParts(a);
  const right = toParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Install/update page URL; the version query also defeats the raw CDN cache. */
export function buildUpdateUrl(version: string): string {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : '';
  return `${SCRIPT_SOURCE_URL}${suffix}`;
}

export function isUpdateCheckDue(nowMs: number = Date.now()): boolean {
  const last = parseInt(getStoredValue(LAST_CHECK_KEY, '0'), 10);
  if (!Number.isFinite(last) || last <= 0) return true;
  return nowMs - last >= CHECK_INTERVAL_MS;
}

function readText(url: string): Promise<string> {
  if (typeof GM_xmlhttpRequest === 'function') {
    return new Promise<string>((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: CHECK_TIMEOUT_MS,
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status} while fetching the published userscript`));
          }
        },
        onerror: () => reject(new Error('Network error while checking the published userscript')),
        ontimeout: () => reject(new Error('Update check timed out')),
      });
    });
  }

  if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') {
    return GM.xmlHttpRequest({
      method: 'GET',
      url,
      timeout: CHECK_TIMEOUT_MS,
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    }).then((res) => {
      if (res.status >= 200 && res.status < 300) return res.responseText;
      throw new Error(`HTTP ${res.status} while fetching the published userscript`);
    });
  }

  if (typeof fetch === 'function') {
    return fetch(url, { cache: 'no-store' }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} while fetching the published userscript`);
      return res.text();
    });
  }

  return Promise.reject(new Error('No supported HTTP client found for the update check'));
}

export async function fetchLatestScriptVersion(): Promise<string> {
  // raw.githubusercontent.com caches for ~5 minutes; the timestamp busts that.
  const source = await readText(`${SCRIPT_SOURCE_URL}?t=${Date.now()}`);
  const version = parseUserscriptVersion(source);
  if (!version) throw new Error('Published userscript has no valid @version metadata block');
  return version;
}

/**
 * Returns `null` when the check is throttled or the running version is unknown
 * (e.g. the Node test harness). Errors are propagated for caller-side reporting.
 */
export async function checkForScriptUpdate(
  options: { force?: boolean } = {}
): Promise<ScriptUpdateInfo | null> {
  const currentVersion = getRunningScriptVersion();
  if (!currentVersion) return null;
  if (!options.force && !isUpdateCheckDue()) return null;

  const latestVersion = await fetchLatestScriptVersion();
  // Only a successful read may reset the throttle, otherwise offline users would
  // stay silent for hours after one failed attempt.
  setStoredValue(LAST_CHECK_KEY, String(Date.now()));

  return {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
  };
}
