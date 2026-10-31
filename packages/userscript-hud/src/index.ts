import { mountShadowHud, ShadowHudController } from './ui/shadowHud';
import { startDomHarvester, stopDomHarvester } from './dom/harvester';
import { loadHudConfig } from './services/storage';
import { getRunningScriptVersion, reportHudInitFailure } from './services/runtimeInfo';

export * from './types';
export * from './services/storage';
export * from './services/repoHistory';
export * from './services/workerClient';
export * from './services/selfHealing';
export * from './dom/injector';
export * from './dom/harvester';
export * from './ui/shadowHud';

let controllerInstance: ShadowHudController | null = null;
let activeObserver: MutationObserver | null = null;

export function destroyGeminiEdgeHud(): void {
  if (activeObserver) {
    stopDomHarvester(activeObserver);
    activeObserver = null;
  }
  if (controllerInstance) {
    controllerInstance.destroy();
    controllerInstance = null;
  }
}

export function resetGeminiEdgeHud(): ShadowHudController | null {
  if (controllerInstance) {
    const { status } = controllerInstance.getState();
    if (status === 'PATCHING' || status === 'MIXING') {
      return controllerInstance;
    }
  }
  destroyGeminiEdgeHud();
  return initGeminiEdgeHud();
}

export function initGeminiEdgeHud(): ShadowHudController | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  // Prevent duplicate initialization
  if (controllerInstance) {
    return controllerInstance;
  }

  // Only run in the top window, ignore Google sub-iframes (accounts, ogs)
  if (window.top !== window.self) {
    return null;
  }

  const runningVersion = getRunningScriptVersion();

  try {
    const cfg = loadHudConfig();
    console.log(`[Gemini Edge HUD] Initializing (script v${runningVersion || 'unknown'}) with config:`, {
      workerUrl: cfg.workerUrl,
      repo: cfg.repo,
      branch: cfg.branch,
    });

    controllerInstance = mountShadowHud(undefined, {
      onSoftReset: () => {
        resetGeminiEdgeHud();
      },
    });

    activeObserver = startDomHarvester(
      (patch) => {
        controllerInstance?.addHarvestedPatch(patch);
      },
      (patch) => {
        controllerInstance?.handleApplyPatch(patch);
      }
    );

    if (typeof window !== 'undefined') {
      (window as any).resetGeminiEdgeHud = resetGeminiEdgeHud;
      (window as any).destroyGeminiEdgeHud = destroyGeminiEdgeHud;
    }
  } catch (error) {
    reportHudInitFailure(error);
    return null;
  }

  console.log(`⚡ [Gemini Edge HUD] Successfully mounted v${runningVersion || 'unknown'} in Shadow DOM.`);
  return controllerInstance;
}

// Auto-run if in browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initGeminiEdgeHud());
  } else {
    initGeminiEdgeHud();
  }
}
