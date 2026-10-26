import type { HudConfig, HudState } from '../types';
import { injectPromptText, injectRepoMixFile, injectRepoMixParts } from '../dom/injector';
import { requestRepoMix } from '../services/workerClient';
import { buildBatchFormulaPrompt } from '../services/batchFormula';
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

        const skipped = res.skippedFiles || [];
        const skippedNotice = skipped.length > 0
          ? ` | Skipped ${skipped.length} file(s)${skipped.length <= 3 ? ': ' + skipped.slice(0, 3).map(s => s.path.split('/').pop()).join(', ') + (skipped.length > 3 ? '...' : '') : ''} — see details (add to .repomixignore.cf or narrow includePaths)`
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
            statusMessage: `✅ Loaded ${res.parts.length} parts (${res.stats.fileCount} files${metaCommits}, ~${res.stats.estimatedTokens} tokens) [${partBreakdown}]. Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}${skippedNotice}`,
          });
        } else {
          injected = injectRepoMixFile(res.xmlContent);
          const charLen = res.stats.charCount ?? res.xmlContent.length;
          updateState({
            status: 'IDLE',
            statusMessage: `✅ Loaded ${res.stats.fileCount} files${metaCommits} (${charLen.toLocaleString()} chars, ~${res.stats.estimatedTokens} tokens). Head: ${res.headOid.slice(0, 7)}${injected ? ' (Injected into chat prompt)' : ''}${skippedNotice}`,
          });
        }
      } else {
        const skipped = res.skippedFiles || [];
        const skippedNotice = skipped.length > 0
          ? ` | Skipped ${skipped.length} file(s) (add to .repomixignore.cf or narrow includePaths)`
          : '';
        updateState({
          status: 'ERROR',
          statusMessage: `❌ Mix error: ${res.errorMessage || 'Unknown error'}${skippedNotice}`,
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

  dom.batchFormulaBtn.onclick = () => {
    const injected = injectPromptText(buildBatchFormulaPrompt(config, state), false);
    updateState({
      statusMessage: injected
        ? '📋 Injected optimal V2 Batch Formula into chat prompt.'
        : '❌ Could not find the chat prompt input to inject the Batch Formula.',
    });
  };
}
