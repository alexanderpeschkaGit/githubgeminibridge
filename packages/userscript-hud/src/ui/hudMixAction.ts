import type { HudConfig, HudState } from '../types';
import { injectRepoMixFile, injectRepoMixParts } from '../dom/injector';
import { requestRepoMix } from '../services/workerClient';
import { setSourceHeadOid } from '../services/patchOidStore';
import type { HudDomElements } from './hudStylesAndDom';

export interface HudMixActionDeps {
  dom: HudDomElements;
  config: HudConfig;
  state: HudState;
  updateState: (partial: Partial<HudState>) => void;
}

/** Wires the "Load Repo Mix" button: stream the mix, persist the HEAD OID and inject the parts. */
export function bindMixAction({ dom, config, state, updateState }: HudMixActionDeps): void {
  dom.mixBtn.onclick = async () => {
    try {
      dom.mixBtn.disabled = true;
      dom.mixBtn.style.opacity = '0.6';
      updateState({
        status: 'MIXING',
        statusMessage: `⏳ Streaming repo mix for ${config.repo} (${config.branch})...`,
      });

      const res = await requestRepoMix(config);
      if (res.status === 'OK' && (res.parts?.length || res.xmlContent)) {
        setSourceHeadOid(config, state, res.headOid);
        state.lastMixStats = res.stats;

        let injected = false;
        const metaCommits = res.stats.recentCommitsCount
          ? ` (incl. ${res.stats.recentCommitsCount} recent commits, ${res.stats.volatileFilesCount ?? 0} volatile files)`
          : '';

        if (res.parts && res.parts.length > 1) {
          const partBreakdown = res.parts
            .map((p) => `P${p.partIndex}: ${(p.stats.charCount ?? p.xmlContent.length).toLocaleString()} chars`)
            .join(', ');
          injected = injectRepoMixParts(
            res.parts.map((p) => ({ fileName: p.fileName, xmlContent: p.xmlContent }))
          );
          updateState({
            status: 'IDLE',
            statusMessage: `✅ Loaded ${res.parts.length} parts (${res.stats.fileCount} files${metaCommits}, ~${res.stats.estimatedTokens} tokens) [${partBreakdown}]. Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}`,
          });
        } else {
          injected = injectRepoMixFile(res.xmlContent);
          const charLen = res.stats.charCount ?? res.xmlContent.length;
          updateState({
            status: 'IDLE',
            statusMessage: `✅ Loaded ${res.stats.fileCount} files${metaCommits} (${charLen.toLocaleString()} chars, ~${res.stats.estimatedTokens} tokens). Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}`,
          });
        }
      } else {
        updateState({
          status: 'ERROR',
          statusMessage: `❌ Mix error: ${res.errorMessage || 'Unknown error'}`,
        });
      }
    } catch (err: any) {
      updateState({
        status: 'ERROR',
        statusMessage: `❌ Mix error: ${err.message || String(err)}`,
      });
    } finally {
      dom.mixBtn.disabled = false;
      dom.mixBtn.style.opacity = '1';
    }
  };
}
