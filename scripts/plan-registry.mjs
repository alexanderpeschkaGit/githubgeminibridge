#!/usr/bin/env node
/**
 * Plan Registry Helper
 * Manages the ephemeral .tmp/plan-registry.json for multi-plan support.
 * The previous tracked location plans/PLAN_REGISTRY.json is migrated once.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';

const REGISTRY_PATH = join(process.cwd(), '.tmp', 'plan-registry.json');
const LEGACY_PATH = join(process.cwd(), 'plans', 'PLAN_REGISTRY.json');

function normalizeRepoPath(filePath) {
  if (typeof filePath !== 'string') return filePath;
  return filePath.replace(/\\/g, '/');
}

function loadRegistry() {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });

  if (existsSync(REGISTRY_PATH)) {
    const content = readFileSync(REGISTRY_PATH, 'utf8');
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse plan registry at ${REGISTRY_PATH}`, { cause: err });
    }
  }

  if (existsSync(LEGACY_PATH)) {
    const legacyContent = readFileSync(LEGACY_PATH, 'utf8');
    if (legacyContent.trim().length > 0) {
      let legacy;
      try {
        legacy = JSON.parse(legacyContent);
      } catch (err) {
        throw new Error(`Failed to parse legacy plan registry at ${LEGACY_PATH}`, { cause: err });
      }
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        saveRegistry(legacy);
        console.warn('[plan-registry] migrated legacy plans/PLAN_REGISTRY.json → .tmp/plan-registry.json');
        return legacy;
      }
    }
  }

  const empty = {};
  saveRegistry(empty);
  return empty;
}

function saveRegistry(registry) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  const tmpFile = `${REGISTRY_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(registry, null, 2));
  renameSync(tmpFile, REGISTRY_PATH);
}

function generatePlanId() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `plan-${timestamp}-${rand}`;
}

function register({ planId, artifactPath, scope, workflow, tier, baseSha, description }) {
  const registry = loadRegistry();
  const now = new Date().toISOString();
  registry[planId] = {
    id: planId,
    status: 'QUEUED',
    artifactPath,
    scope: scope || { files: [], packages: [] },
    workflow: workflow || '#exec',
    tier: tier || 'FLASH',
    baseSha: baseSha || null,
    description: description || '',
    owner: 'coordinator',
    createdAt: now,
    updatedAt: now,
    locks: [],
    runningBatches: []
  };
  saveRegistry(registry);
  return registry[planId];
}

function scope(planId, files) {
  const registry = loadRegistry();
  if (!registry[planId]) throw new Error(`Plan ${planId} not found`);
  const normalizedFiles = (files || []).map(f => normalizeRepoPath(f));
  registry[planId].scope = { ...(registry[planId].scope || {}), files: normalizedFiles };
  registry[planId].updatedAt = new Date().toISOString();
  saveRegistry(registry);
  return registry[planId];
}

function updateScopes() {
  // no-op: kept for API compatibility
}

// CLI
const cmd = process.argv[2];
const args = process.argv.slice(3);

if (cmd === 'generate-id') {
  console.log(generatePlanId());
} else if (cmd === 'register') {
  // register <planId> <artifactPath> <workflow> <tier> <baseSha> <description>
  const [planId, artifactPath, workflow, tier, baseSha, ...desc] = args;
  const result = register({ planId, artifactPath, workflow, tier, baseSha, description: desc.join(' ') });
  console.log(JSON.stringify(result));
} else if (cmd === 'start') {
  console.log(JSON.stringify(start(args[0])));
} else if (cmd === 'complete') {
  console.log(JSON.stringify(complete(args[0])));
} else if (cmd === 'lock') {
  const [planId, ...files] = args;
  console.log(JSON.stringify(lockFiles(planId, files)));
} else if (cmd === 'unlock' || cmd === 'release') {
  console.log(JSON.stringify(releaseLocks(args[0])));
} else if (cmd === 'abort') {
  console.log(JSON.stringify(abort(args[0])));
} else if (cmd === 'queued') {
  console.log(JSON.stringify(getQueuedPlans()));
} else if (cmd === 'get') {
  console.log(JSON.stringify(getPlan(args[0])));
} else if (cmd === 'running') {
  console.log(JSON.stringify(getRunningPlans()));
} else if (cmd === 'scope') {
  const [planId, ...files] = args;
  if (files.length === 0 && args.length === 1 && typeof args[0] === 'string' && args[0].includes(',')) {
    console.log(JSON.stringify(scope(planId, args[0].split(','))));
  } else {
    console.log(JSON.stringify(scope(planId, files)));
  }
} else if (cmd === 'update-scopes') {
  updateScopes();
  console.log(JSON.stringify({ updated: true }));
} else {
  console.log('Usage: plan-registry.mjs <generate-id|register|start|complete|lock|unlock|release|abort|queued|get|running|scope|update-scopes>');
}
