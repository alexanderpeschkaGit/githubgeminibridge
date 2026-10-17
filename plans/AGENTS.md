# AGENTS.md – Architektur-Referenz & Pointer (`cloudflare_orchestrator_Bridge`)

> [!IMPORTANT] KANONISCHE HAUPTDATEI IM PROJEKT-ROOT
> Die führende System-Verfassung ist in die zentrale Root-Datei **[`agents.md`](../agents.md)** umgezogen und wird dort vom Master-Orchestrator aktiv weiterentwickelt.
>
> **Bitte lies vor jeder Aufgabe verbindlich:**
> 1. **[`agents.md`](../agents.md)** (Root): 3-Schichten-Gesamtarchitektur, Monorepo-Pfade, globale Sicherheits- & Guardrail-Gesetze, Windows/PowerShell Host-Regeln und Decision Gate.
> 2. **[`.agents/rules/edge-worker-architecture.md`](../.agents/rules/edge-worker-architecture.md)**: Spezifische Regeln für `packages/edge-worker/` (1-Subrequest Tarball-Stream mit Repomix-Filterlogik, GraphQL Batch-Read, `patcher.ts`, `linter.ts` sowie V1/V2 Endpunkt-Synchronisations-Tabelle).
> 3. **[`.agents/rules/userscript-shadow-hud.md`](../.agents/rules/userscript-shadow-hud.md)**: Spezifische Regeln für `packages/userscript-hud/` (Shadow-DOM-Isolation, `GM_xmlhttpRequest` CSP-Bypass, DOM-Injector & Harvester für Gemini und AI Studio).
> 4. **[`.agents/rules/orchestrator-protocol.md`](../.agents/rules/orchestrator-protocol.md)**: Regeln für den Master-Orchestrator, das `#solve` 4-Phasen-Protokoll, die Auktionator-Matrix und die Crash-Recovery über [`plans/STATE.md`](./STATE.md), [`plans/EXECUTION_LOG.md`](./EXECUTION_LOG.md) und [`plans/TEST_LOG.md`](./TEST_LOG.md).
> 5. **[`shared/types.ts`](../shared/types.ts)**: Verbindliche Single Source of Truth für alle TypeScript-Schnittstellen zwischen Worker und Userscript.
