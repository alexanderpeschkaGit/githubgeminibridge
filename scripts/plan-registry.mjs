#!/usr/bin/env node
/**
 * Plan Registry Helper
 * Manages plans/PLAN_REGISTRY.json for multi-plan support
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const REGISTRY_PATH = join(process.cwd(), 'plans', 'PLAN_REGISTRY.json');

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    writeFileSync(REGISTRY_PATH, JSON.stringify({}, null, 2));
    return {};
  }
  const content = readFileSync(REGISTRY_PATH, 'utf8');
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse plan registry at ${REGISTRY_PATH}`, { cause: err });
  }
}

function saveRegistry(registry) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
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

function update(planId, updates) {
  const registry = loadRegistry();
  if (!registry[planId]) throw new Error(`Plan ${planId} not found`);
  registry[planId] = { ...registry[planId], ...updates, updatedAt: new Date().toISOString() };
  saveRegistry(registry);
  return registry[planId];
}

function start(planId) {
  return update(planId, { status: 'RUNNING' });
}

function complete(planId) {
  return update(planId, { status: 'COMPLETED', locks: [] });
}

function abort(planId) {
  return update(planId, { status: 'ABORTED', locks: [] });
}

function lockFiles(planId, files) {
  const registry = loadRegistry();
  // Check for conflicts
  for (const [id, plan] of Object.entries(registry)) {
    if (id === planId) continue;
    if (plan.status === 'RUNNING') {
      const conflict = (files || []).filter(f => (plan.locks || []).includes(f));
      if (conflict.length > 0) {
        throw new Error(`File lock conflict with ${id}: ${conflict.join(', ')}`);
      }
    }
  }
  if (!registry[planId]) throw new Error(`Plan ${planId} not found`);
  registry[planId].locks = [...new Set([...(registry[planId].locks || []), ...(files || [])])];
  registry[planId].updatedAt = new Date().toISOString();
  saveRegistry(registry);
  return registry[planId];
}

function releaseLocks(planId) {
  return update(planId, { locks: [] });
}

function getPlan(planId) {
  const registry = loadRegistry();
  return registry[planId] || null;
}

function getRunningPlans() {
  const registry = loadRegistry();
  return Object.values(registry).filter(p => p.status === 'RUNNING');
}

function getQueuedPlans() {
  const registry = loadRegistry();
  return Object.values(registry).filter(p => p.status === 'QUEUED');
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
} else if (cmd === 'get') {
  console.log(JSON.stringify(getPlan(args[0])));
} else if (cmd === 'running') {
  console.log(JSON.stringify(getRunningPlans()));
} else {
  console.log('Usage: plan-registry.mjs <generate-id|register|start|complete|lock|get|running>');
}
