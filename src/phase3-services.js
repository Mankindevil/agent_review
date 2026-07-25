import { createHash, randomUUID } from 'node:crypto';
import {
  createReplicaAdapter,
  normalizeReplicaResult,
  validateReplicaArtifact
} from './replica-adapter.js';
import { resolveRuntimeConfig } from './runtime-config.js';
import { getRuntimeStatus } from './runtime-status.js';
import { buildSkill, RUNTIMES, runSkill } from './runtimes.js';

const HARD_ENFORCEMENT = Object.freeze({
  wallClock: 'hard',
  tokens: 'hard',
  outputBytes: 'hard',
  network: 'hard'
});

const HARD_HEALTH = Object.freeze({
  ready: true,
  budgetEnforcement: { ...HARD_ENFORCEMENT }
});

/**
 * Production Phase 3 wiring for V2 black-box (see
 * docs/superpowers/specs/2026-07-26-phase3-runtime-wiring-design.md).
 * Local CLI and model-api use an E1 pragmatic bridge over V1 buildSkill/runSkill.
 */
export function createPhase3Services({
  env = process.env,
  buildSkillFn = buildSkill,
  runSkillFn = runSkill,
  resolveConfig = resolveRuntimeConfig
} = {}) {
  const runtimes = RUNTIMES.filter((runtime) => resolveConfig(runtime.id, env));
  if (runtimes.length === 0) {
    return Object.freeze({ enabled: false, runtimes: [], createAdapter: () => null });
  }

  const deps = { env, buildSkillFn, runSkillFn, resolveConfig };
  return Object.freeze({
    enabled: true,
    runtimes: runtimes.map((runtime) => Object.freeze({ id: runtime.id })),
    createAdapter(runtime) {
      const meta = RUNTIMES.find((item) => item.id === runtime?.id) || runtime;
      return createPhase3Adapter(meta, deps);
    }
  });
}

/**
 * Create-time hard gate: refuse formal V2 when fewer than `minReady`
 * runtimes report runtimeReady (same source as GET /api/runtimes).
 */
export async function assertReplicaRuntimesReady({
  env = process.env,
  minReady = 1,
  getRuntimeStatusFn = getRuntimeStatus,
  statusOptions = {}
} = {}) {
  const status = await getRuntimeStatusFn({ env, ...statusOptions });
  const list = Array.isArray(status) ? status : [];
  const readyCount = list.filter((item) => item?.runtimeReady === true).length;
  if (readyCount >= minReady) return list;

  const error = new Error(
    '至少需要 1 个就绪的 Replica Runtime（Claude Code / Cursor / Doubao）才能创建正式 V2 评测'
  );
  error.statusCode = 503;
  error.responseBody = {
    error: error.message,
    code: 'REPLICA_RUNTIME_NOT_READY',
    runtimes: list.map((item) => ({
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      installed: item.installed,
      authenticated: item.authenticated,
      runtimeReady: item.runtimeReady,
      note: item.note
    }))
  };
  throw error;
}

function createPhase3Adapter(runtime, deps) {
  const config = deps.resolveConfig(runtime.id, deps.env);
  if (!config) return null;

  if (config.kind === 'remote-http') {
    return createReplicaAdapter(runtime, 'live', {
      config,
      env: deps.env,
      health: async () => HARD_HEALTH
    });
  }

  // E1 bridge for local-cli and model-api (and any other configured kind).
  return {
    health: async () => HARD_HEALTH,
    async build(replicaPackage, buildBudget, options = {}) {
      const description = replicaPackage?.agent?.description;
      if (typeof description !== 'string' || !description.trim()) {
        const error = new Error('Replica package missing agent description');
        error.code = 'BUILD_FAILED';
        throw error;
      }
      const built = await deps.buildSkillFn(runtime, description, 'live', {
        signal: options.signal,
        seed: options.seed,
        temperature: options.temperature ?? 0
      });
      const packageHash = replicaPackage.manifest.contentHash;
      const artifact = skillToReplicaArtifact(built.skill, runtime.id, packageHash);
      return validateReplicaArtifact(artifact, buildBudget, { packageHash });
    },
    async run(replicaArtifact, testInput, _logicalHandle, _runBudget, options = {}) {
      const prompt = textFromParts(testInput?.parts);
      const started = Date.now();
      const text = await deps.runSkillFn({
        runtimeId: runtime.id,
        runtime: runtime.name,
        skill: projectSkill(replicaArtifact.skill)
      }, { prompt }, 'live', {
        signal: options.signal,
        seed: options.seed,
        temperature: options.temperature ?? 0
      });
      return normalizeReplicaResult({
        status: 'completed',
        messageParts: [{ type: 'text', text: String(text ?? '') }],
        artifacts: [],
        durationMs: Math.max(0, Date.now() - started),
        error: null,
        budgetUsage: { tokens: tokenEstimate(text) },
        evidence: { source: 'phase3-bridge' }
      });
    },
    async disposeContext() {}
  };
}

export function skillToReplicaArtifact(skill, runtimeId, packageHash) {
  const projected = projectSkill(skill);
  const content = skillMarkdown(projected);
  const byteLength = Buffer.byteLength(content, 'utf8');
  return {
    artifactId: `${runtimeId}-${randomUUID()}`,
    runtimeId,
    skill: projected,
    files: [{
      path: 'SKILL.md',
      mediaType: 'text/markdown',
      content,
      byteLength,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex')
    }],
    manifest: {
      packageHash,
      budgetVersion: 'replica-budget/v1',
      budgetEnforcement: { ...HARD_ENFORCEMENT }
    },
    buildEvidence: {
      source: 'phase3-bridge',
      budgetUsage: { tokens: tokenEstimate(content) }
    }
  };
}

function projectSkill(skill) {
  return {
    name: String(skill?.name || '').trim() || 'replica-skill',
    description: String(skill?.description || '').trim() || 'Replica skill',
    instructions: Array.isArray(skill?.instructions)
      ? skill.instructions.map((item) => String(item)).filter((item) => item.trim())
      : ['Complete the supplied turn using only the package material.'],
    tools: Array.isArray(skill?.tools)
      ? skill.tools.map((item) => String(item)).filter((item) => item.trim())
      : []
  };
}

function skillMarkdown(skill) {
  const instructions = skill.instructions
    .map((step, index) => `${index + 1}. ${step}`)
    .join('\n');
  const tools = skill.tools.length
    ? skill.tools.map((tool) => `- ${tool}`).join('\n')
    : '- none';
  return `# ${skill.name}\n\n${skill.description}\n\n## Instructions\n\n${instructions}\n\n## Tools\n\n${tools}\n`;
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim() || 'Complete the current turn.';
}

function tokenEstimate(value) {
  const length = Buffer.byteLength(String(value ?? ''), 'utf8');
  return Math.max(1, Math.min(8_000, Math.ceil(length / 4)));
}
