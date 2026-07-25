import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveRuntimeConfig } from './runtime-config.js';
import { REPLICA_BUILD_BUDGET_V1 } from './replica-budgets.js';

const ENFORCEMENT_KEYS = Object.freeze(['wallClock', 'tokens', 'outputBytes', 'network']);
const HARD_ENFORCEMENT = Object.freeze({ wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' });
const ARTIFACT_KEYS = Object.freeze(['artifactId', 'runtimeId', 'skill', 'files', 'manifest', 'buildEvidence']);
const FILE_KEYS = Object.freeze(['path', 'mediaType', 'byteLength', 'sha256', 'content']);
const SKILL_KEYS = Object.freeze(['name', 'description', 'instructions', 'tools']);
const MANIFEST_KEYS = Object.freeze(['packageHash', 'budgetVersion', 'budgetEnforcement']);
const RESULT_KEYS = Object.freeze(['status', 'messageParts', 'artifacts', 'durationMs', 'error', 'budgetUsage', 'evidence']);
const BUDGET_USAGE_KEYS = Object.freeze(['tokens', 'outputBytes']);
const SECRET_KEY = /(?:authorization|cookie|api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|credential)/iu;
const SECRET_VALUE = /(?:https?:\/\/|\bbearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/iu;
const EXECUTABLE_EXTENSION = /\.(?:exe|com|bat|cmd|sh|ps1)$/iu;

export function createReplicaAdapter(runtime, mode, dependencies = {}) {
  const config = dependencies.config ?? resolveRuntimeConfig(runtime.id);
  const objectContexts = new WeakMap();
  const valueContexts = new Map();
  const remote = mode === 'live' && config?.kind === 'remote-http';
  const local = mode === 'live' && config?.kind === 'local-cli';

  async function health(options = {}) {
    if (!remote && !local) return healthFailure('ADAPTER_CONFIG_INVALID');
    if (remote && !validRemoteConfig(config, dependencies.env ?? process.env)) return healthFailure('ADAPTER_TRANSPORT_FAILED');
    if (local && typeof dependencies.sandbox?.assertNetworkDenied !== 'function') return healthFailure('REPLICA_ENFORCEMENT_UNPROVEN');
    try {
      const evidence = typeof dependencies.health === 'function' ? await dependencies.health(options) : null;
      if (!evidence?.ready || !isHardEnforcement(evidence.budgetEnforcement)) return healthFailure('REPLICA_ENFORCEMENT_UNPROVEN', evidence);
      return { ready: true, budgetEnforcement: { ...HARD_ENFORCEMENT } };
    } catch (error) {
      return healthFailure('HEALTH_FAILED', { message: error?.message });
    }
  }

  async function assertHardHealth(options) {
    const result = await health(options);
    if (result.ready) return result;
    throw replicaError(result.code === 'ADAPTER_TRANSPORT_FAILED' ? 'ADAPTER_TRANSPORT_FAILED' : 'REPLICA_ENFORCEMENT_UNPROVEN', 'Replica health did not prove all required hard enforcement');
  }

  return Object.freeze({
    health,
    async build(replicaPackage, buildBudget, options = {}) {
      await assertHardHealth(options);
      let payload;
      if (remote) {
        payload = await executeWithLimits(async (signal) => {
          const value = await postReplica(config, dependencies, {
            action: 'build_replica', replicaPackage, buildBudget, seed: options.seed, temperature: options.temperature,
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
          }, signal);
          await verifyPayloadLimits(dependencies, value, REPLICA_BUILD_BUDGET_V1, 'build', signal);
          return value;
        }, buildBudget, options);
      } else if (local && typeof dependencies.localBuild === 'function') {
        payload = await withFreshWorkspace(runtime.id, dependencies, (workspace) => executeWithLimits(async (signal) => {
          const value = await dependencies.localBuild({
            replicaPackage, buildBudget, idempotencyKey: options.idempotencyKey, options: { ...options, signal }, workspace, policy: localPolicy(buildBudget, dependencies.sandbox)
          });
          await verifyPayloadLimits(dependencies, value, REPLICA_BUILD_BUDGET_V1, 'build', signal);
          return value;
        }, buildBudget, options));
      } else {
        throw replicaError('BUILD_FAILED', 'Replica build adapter is not configured');
      }
      return normalizeReplicaArtifact(payload, runtime, replicaPackage?.manifest?.contentHash, REPLICA_BUILD_BUDGET_V1);
    },
    async run(replicaArtifact, testInput, logicalHandle, runBudget, options = {}) {
      const context = contextFor(logicalHandle, objectContexts, valueContexts);
      context.history = Array.isArray(logicalHandle?.history)
        ? structuredClone(logicalHandle.history)
        : [];
      try {
        await assertHardHealth(options);
        validateReplicaArtifact(replicaArtifact, runBudget);
        let payload;
        if (remote) {
          payload = await executeWithLimits(async (signal) => {
            const value = await postReplica(config, dependencies, {
              action: 'run_replica', replicaArtifact, testInput, contextHandle: remoteContext(context), runBudget, seed: options.seed, temperature: options.temperature,
              ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
            }, signal);
            await verifyPayloadLimits(dependencies, value, runBudget, 'run', signal);
            return value;
          }, runBudget, options);
        } else if (local && typeof dependencies.localRun === 'function') {
          if (!context.workspace) {
            context.workspace = await (dependencies.createWorkspace ?? mkdtemp)(path.join(tmpdir(), `replica-${runtime.id}-`));
            context.ownsWorkspace = true;
          }
          payload = await executeWithLimits(async (signal) => {
            const value = await dependencies.localRun({
              replicaArtifact, testInput, contextHandle: context, runBudget, idempotencyKey: options.idempotencyKey, options: { ...options, signal }, policy: localPolicy(runBudget, dependencies.sandbox)
            });
            await verifyPayloadLimits(dependencies, value, runBudget, 'run', signal);
            return value;
          }, runBudget, options);
        } else {
          throw replicaError('EXECUTION_BOUNDARY_NOT_STARTED', 'Replica run adapter is not configured');
        }
        const result = normalizeReplicaResult(payload, options.metadata);
        if (result.status === 'invalid-output') throw replicaError('INVALID_REPLICA_OUTPUT', result.error?.message || 'Replica returned invalid output');
        assertResultCaps(result, runBudget);
        return result;
      } catch (error) {
        await dispose(context, dependencies);
        deleteContext(logicalHandle, objectContexts, valueContexts);
        throw error;
      }
    },
    async disposeContext(logicalHandle) {
      const context = lookupContext(logicalHandle, objectContexts, valueContexts);
      if (!context) return;
      await dispose(context, dependencies);
      deleteContext(logicalHandle, objectContexts, valueContexts);
    }
  });
}

export function validateReplicaArtifact(artifact, budget, { packageHash } = {}) {
  assertExactObject(artifact, ARTIFACT_KEYS, 'Replica artifact');
  if (!nonEmpty(artifact.artifactId) || !nonEmpty(artifact.runtimeId)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact identity is invalid');
  assertSkill(artifact.skill);
  if (!Array.isArray(artifact.files) || artifact.files.length === 0) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact must contain files');
  let totalBytes = 0;
  let hasSkillFile = false;
  for (const file of artifact.files) {
    assertExactObject(file, FILE_KEYS, 'Replica artifact file');
    if (!safeRelativePath(file.path) || EXECUTABLE_EXTENSION.test(file.path)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact file path or executable is unsafe');
    if (!nonEmpty(file.mediaType) || typeof file.content !== 'string' || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact file metadata is invalid');
    const bytes = Buffer.byteLength(file.content);
    if (bytes !== file.byteLength || hash(file.content) !== file.sha256) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact file hash or byte length mismatch');
    if (containsForbidden(file.content)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact contains endpoint or authentication material');
    totalBytes += bytes;
    if (file.path === 'SKILL.md' && file.mediaType.toLowerCase().includes('markdown') && file.content.trim()) hasSkillFile = true;
  }
  if (!hasSkillFile) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact is missing Skill instructions in a non-empty SKILL.md');
  if (totalBytes > positiveBudget(REPLICA_BUILD_BUDGET_V1.maxOutputBytes)) throw replicaError('REPLICA_OUTPUT_BYTES_EXCEEDED', 'Replica artifact exceeds output byte cap');
  assertExactObject(artifact.manifest, MANIFEST_KEYS, 'Replica artifact manifest');
  if (!/^[a-f0-9]{64}$/u.test(artifact.manifest.packageHash) || artifact.manifest.budgetVersion !== 'replica-budget/v1' || !isHardEnforcement(artifact.manifest.budgetEnforcement)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact manifest or enforcement is invalid');
  if (packageHash && artifact.manifest.packageHash !== packageHash) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica artifact package hash mismatch');
  if (!plainObject(artifact.buildEvidence) || containsForbidden(artifact.buildEvidence, ['buildEvidence'])) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica build evidence contains forbidden authentication or endpoint material');
  assertUsageTokens(artifact.buildEvidence.budgetUsage, REPLICA_BUILD_BUDGET_V1);
  return artifact;
}

export function normalizeReplicaResult(value, metadata = {}) {
  const fallback = { status: 'invalid-output', messageParts: [], artifacts: [], durationMs: 0, error: { code: 'INVALID_REPLICA_OUTPUT', message: 'Replica result did not contain visible output.' }, budgetUsage: {}, evidence: {} };
  if (typeof value === 'string' && value.trim()) return { ...fallback, status: 'completed', messageParts: [{ type: 'text', text: value }], error: null, durationMs: safeInt(metadata.durationMs, 0) };
  try {
    assertExactObject(value, RESULT_KEYS, 'Replica result', ['error', 'budgetUsage', 'evidence']);
    if (!['completed', 'failed', 'timed-out', 'invalid-output'].includes(value.status)) return fallback;
    const messageParts = normalizeParts(value.messageParts);
    const artifacts = normalizeArtifacts(value.artifacts);
    const usage = normalizeBudgetUsage(value.budgetUsage);
    const result = { status: value.status, messageParts, artifacts, durationMs: safeInt(value.durationMs, safeInt(metadata.durationMs, 0)), error: value.error ?? null, budgetUsage: usage, evidence: plainObject(value.evidence) ? structuredClone(value.evidence) : {} };
    if (result.status === 'completed' && messageParts.length === 0) return { ...fallback, durationMs: result.durationMs };
    return result;
  } catch {
    return fallback;
  }
}

function normalizeReplicaArtifact(value, runtime, packageHash, budget) {
  const artifact = structuredClone(value);
  if (!plainObject(artifact)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica build did not return an artifact object');
  artifact.artifactId ??= `${runtime.id}-${randomUUID()}`;
  artifact.runtimeId = runtime.id;
  return validateReplicaArtifact(artifact, budget, { packageHash });
}

async function postReplica(config, dependencies, body, signal) {
  const headers = remoteHeaders(config, dependencies.env ?? process.env);
  let response;
  try { response = await (dependencies.fetch ?? globalThis.fetch)(config.url, { method: 'POST', headers, body: JSON.stringify(body), signal }); }
  catch (error) { throw replicaError('ADAPTER_TRANSPORT_FAILED', `Replica adapter transport failed: ${error?.message || error}`); }
  if (!response?.ok) throw replicaError('ADAPTER_TRANSPORT_FAILED', `Replica adapter returned HTTP ${response?.status ?? 'unknown'}`);
  try { return await response.json(); } catch { throw replicaError('ADAPTER_TRANSPORT_FAILED', 'Replica adapter returned invalid JSON'); }
}

async function executeWithLimits(operation, budget, options) {
  const timeoutMs = positiveBudget(options?.wallClockMs ?? budget?.wallClockMs ?? 120_000);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) abortFromCaller(); else options?.signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(replicaError('REPLICA_WALL_CLOCK_EXCEEDED', `Replica wall-clock cap ${timeoutMs}ms exceeded`)); reject(replicaError('REPLICA_WALL_CLOCK_EXCEEDED', `Replica wall-clock cap ${timeoutMs}ms exceeded`)); }, timeoutMs); })
    ]);
  } finally { clearTimeout(timer); options?.signal?.removeEventListener?.('abort', abortFromCaller); }
}

async function withFreshWorkspace(runtimeId, dependencies, operation) {
  const workspace = await (dependencies.createWorkspace ?? mkdtemp)(path.join(tmpdir(), `replica-${runtimeId}-`));
  try { return await operation(workspace); } finally { await (dependencies.removeWorkspace ?? rm)(workspace, { recursive: true, force: true }); }
}

function contextFor(handle, objects, values) {
  const existing = lookupContext(handle, objects, values);
  if (existing) return existing;
  const context = { id: randomUUID(), history: [], workspace: null, ownsWorkspace: false };
  if ((typeof handle === 'object' && handle !== null) || typeof handle === 'function') objects.set(handle, context); else values.set(handle, context);
  return context;
}
function lookupContext(handle, objects, values) { return ((typeof handle === 'object' && handle !== null) || typeof handle === 'function') ? objects.get(handle) : values.get(handle); }
function deleteContext(handle, objects, values) { if ((typeof handle === 'object' && handle !== null) || typeof handle === 'function') objects.delete(handle); else values.delete(handle); }
function remoteContext(context) { return { id: context.id, history: context.history }; }
async function dispose(context, dependencies) {
  try { if (typeof dependencies.disposeContext === 'function') await dependencies.disposeContext(context); }
  finally { if (context?.workspace && context.ownsWorkspace) { await (dependencies.removeWorkspace ?? rm)(context.workspace, { recursive: true, force: true }); context.ownsWorkspace = false; context.workspace = null; } }
}

async function verifyPayloadLimits(dependencies, payload, budget, phase, signal) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > positiveBudget(budget?.maxOutputBytes)) throw replicaError('REPLICA_OUTPUT_BYTES_EXCEEDED', 'Replica response exceeds output byte cap');
  const usage = payload?.budgetUsage ?? payload?.buildEvidence?.budgetUsage;
  assertUsageTokens(usage, undefined);
  if (typeof dependencies.trustedUsageMeter !== 'function') {
    assertUsageTokens(usage, budget);
    return;
  }
  const measured = await dependencies.trustedUsageMeter({ phase, payload, signal });
  const tokens = typeof measured === 'number' ? measured : measured?.tokens;
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw replicaError('REPLICA_TOKEN_USAGE_UNPROVEN', 'Trusted usage meter did not provide integer token telemetry');
  assertUsageTokens({ tokens }, budget);
  usage.tokens = tokens;
}
function assertResultCaps(result, budget) {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > positiveBudget(budget?.maxOutputBytes) || (result.budgetUsage.outputBytes ?? 0) > positiveBudget(budget?.maxOutputBytes)) throw replicaError('REPLICA_OUTPUT_BYTES_EXCEEDED', 'Replica result exceeds output byte cap');
  assertUsageTokens(result.budgetUsage, budget);
}
function assertSkill(skill) {
  assertExactObject(skill, SKILL_KEYS, 'Replica Skill', ['tools']);
  if (!nonEmpty(skill.name) || !nonEmpty(skill.description) || !Array.isArray(skill.instructions) || skill.instructions.length === 0 || skill.instructions.some((item) => !nonEmpty(item)) || (skill.tools !== undefined && (!Array.isArray(skill.tools) || skill.tools.some((item) => !nonEmpty(item)))) || containsForbidden(skill)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', 'Replica Skill instructions or contents are invalid');
}
function normalizeParts(parts) {
  if (!Array.isArray(parts)) throw new TypeError('parts must be an array');
  return parts.map(projectPart);
}
function projectPart(part) {
  if (!plainObject(part) || !nonEmpty(part.type)) throw new TypeError('part invalid');
  const common = ['type', 'mediaType', 'filename'];
  const required = part.type === 'text' ? ['text'] : part.type === 'data' ? ['data'] : part.type === 'raw' ? ['raw'] : part.type === 'url' ? ['url'] : null;
  if (!required) throw new TypeError('part type invalid');
  assertExactObject(part, [...common, ...required], 'Replica part', ['mediaType', 'filename']);
  for (const key of required) if (part[key] === undefined || (key !== 'data' && !nonEmpty(part[key]))) throw new TypeError('part payload invalid');
  return Object.fromEntries([...common, ...required].filter((key) => part[key] !== undefined).map((key) => [key, structuredClone(part[key])]));
}
function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw new TypeError('artifacts invalid');
  return artifacts.map((artifact) => { assertExactObject(artifact, ['name', 'parts'], 'Replica result artifact'); if (!nonEmpty(artifact.name)) throw new TypeError('artifact name'); return { name: artifact.name, parts: normalizeParts(artifact.parts) }; });
}
function normalizeBudgetUsage(usage) {
  if (usage === undefined) return {};
  assertExactObject(usage, BUDGET_USAGE_KEYS, 'Replica budget usage', BUDGET_USAGE_KEYS);
  for (const [key, value] of Object.entries(usage)) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${key} invalid`);
  return structuredClone(usage);
}
function localPolicy(budget, sandbox) { return { toolAllowlist: [...(budget?.toolAllowlist ?? [])], network: 'none', maxOutputBytes: budget?.maxOutputBytes, maxTokens: budget?.maxTokens, assertNetworkDenied: sandbox.assertNetworkDenied.bind(sandbox) }; }
function remoteHeaders(config, env) { const headers = { 'content-type': 'application/json' }; if (config.apiKeyEnv) { const key = Object.hasOwn(env ?? {}, config.apiKeyEnv) ? env[config.apiKeyEnv] : undefined; if (!nonEmpty(key)) throw replicaError('ADAPTER_TRANSPORT_FAILED', `Replica adapter credential ${config.apiKeyEnv} is unavailable`); headers.authorization = `Bearer ${key}`; } return headers; }
function validRemoteConfig(config, env) { if (!nonEmpty(config?.url)) return false; return !config.apiKeyEnv || (Object.hasOwn(env ?? {}, config.apiKeyEnv) && nonEmpty(env[config.apiKeyEnv])); }
function isHardEnforcement(value) { return plainObject(value) && Object.keys(value).length === ENFORCEMENT_KEYS.length && ENFORCEMENT_KEYS.every((key) => value[key] === 'hard'); }
function healthFailure(code, evidence = {}) { return { ready: false, code, budgetEnforcement: Object.fromEntries(ENFORCEMENT_KEYS.map((key) => [key, 'unproven'])), evidence: projectHealthEvidence(evidence) }; }
function projectHealthEvidence(evidence) { if (!plainObject(evidence) || Object.keys(evidence).length === 0) return {}; return { ready: evidence.ready === true, ...(plainObject(evidence.budgetEnforcement) ? { budgetEnforcement: structuredClone(evidence.budgetEnforcement) } : {}) }; }
function containsForbidden(value, path = []) { if (typeof value === 'string') return SECRET_VALUE.test(value); if (Array.isArray(value)) return value.some((item, index) => containsForbidden(item, [...path, String(index)])); if (plainObject(value)) return Object.entries(value).some(([key, item]) => forbiddenKey(key, path) || containsForbidden(item, [...path, key])); return false; }
function safeRelativePath(value) { return nonEmpty(value) && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value) && !value.split('/').includes('..'); }
function assertExactObject(value, allowed, label, optional = []) { if (!plainObject(value)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', `${label} must be a plain object`); const allow = new Set(allowed); for (const key of Object.keys(value)) if (!allow.has(key)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', `${label} has unknown field ${key}`); for (const key of allowed) if (!optional.includes(key) && !Object.hasOwn(value, key)) throw replicaError('UNSAFE_REPLICA_ARTIFACT', `${label} is missing ${key}`); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function safeInt(value, fallback) { return Number.isSafeInteger(value) && value >= 0 ? value : fallback; }
function positiveBudget(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
function assertUsageTokens(usage, budget) { if (!plainObject(usage) || !Object.hasOwn(usage, 'tokens') || !Number.isSafeInteger(usage.tokens) || usage.tokens < 0) throw replicaError('REPLICA_TOKEN_USAGE_UNPROVEN', 'Replica contract did not provide required audited token telemetry'); if (budget !== undefined && usage.tokens > positiveBudget(budget?.maxTokens)) throw replicaError('REPLICA_TOKEN_CAP_EXCEEDED', 'Replica audited token telemetry exceeds cap'); }
function forbiddenKey(key, path) { return !(String(key) === 'tokens' && path.join('.') === 'buildEvidence.budgetUsage') && (SECRET_KEY.test(key) || /(?:token|secret|endpoint)(?:s|url|urls)?$/iu.test(String(key))); }
function hash(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function replicaError(code, message) { const error = new Error(message); error.code = code; return error; }
