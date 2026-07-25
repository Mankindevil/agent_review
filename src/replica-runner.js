import { createReplicaPackage } from './replica-package.js';
import { REPLICA_BUILD_BUDGET_V1, REPLICA_RUN_BUDGET_V1 } from './replica-budgets.js';
import { classifyReplicaFailure } from './replica-failures.js';
import { normalizeReplicaResult, validateReplicaArtifact } from './replica-adapter.js';
import {
  canonicalJson,
  createEvidenceManifestItem,
  createEvidenceRecord,
  redactEvidence
} from './evidence.js';
import { inputForTurn } from './test-plan.js';

const HARD_ENFORCEMENT = Object.freeze({
  wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard'
});

/**
 * Builds one temporary Skill per configured runtime.  Only the public package
 * crosses the adapter boundary; test plans and submitted execution material do
 * not.
 */
export async function buildReplicas(options = {}) {
  const runtimes = requiredArray(options.runtimes, 'runtimes');
  const evidenceVault = requiredObject(options.evidenceVault, 'evidenceVault');
  const now = options.now || (() => new Date().toISOString());
  const createId = options.createId || defaultId;
  const replicaPackage = (options.createReplicaPackage || createReplicaPackage)(
    options.agentCard,
    options.agentExamples,
    {
      rubricVersion: requiredString(options.rubricVersion, 'rubricVersion'),
      generatedAt: options.generatedAt || now(),
      ...(options.packageOptions || {})
    }
  );
  const packageHash = replicaPackage.manifest.contentHash;
  const sealedManifestItems = [];
  const records = [];
  const summaries = [];

  for (const runtime of runtimes) {
    const runtimeId = requiredString(runtime?.id, 'runtime.id');
    const adapter = resolveAdapter(options, runtime);
    if (!adapter) {
      const summary = invalidRuntime(runtimeId, 'invalid-infrastructure', {
        code: 'ADAPTER_CONFIG_INVALID'
      });
      await attachFailureEvidence(summary, { evidenceVault, createId, now, runtimeId, error: { code: 'ADAPTER_CONFIG_INVALID' } });
      summaries.push(summary);
      await checkpoint(options, { phase: 'build', runtimeId, validity: summary.validity });
      continue;
    }
    let health;
    try {
      health = await adapter.health({ phase: 'replica-build' });
    } catch (error) {
      const summary = invalidRuntime(runtimeId, 'invalid-infrastructure', error);
      await attachFailureEvidence(summary, { evidenceVault, createId, now, runtimeId, error });
      summaries.push(summary);
      await checkpoint(options, { phase: 'build', runtimeId, validity: summary.validity });
      continue;
    }
    if (!isHardHealthy(health)) {
      const summary = invalidRuntime(runtimeId, 'invalid-infrastructure', {
        code: health?.code || 'REPLICA_ENFORCEMENT_UNPROVEN'
      }, health);
      await attachFailureEvidence(summary, { evidenceVault, createId, now, runtimeId, error: { code: summary.failureCategory }, health });
      summaries.push(summary);
      await checkpoint(options, { phase: 'build', runtimeId, validity: summary.validity });
      continue;
    }
    try {
      // Do not add test plans, credentials, submitted outputs, or metadata.
      const artifact = await adapter.build(
        structuredClone(replicaPackage),
        REPLICA_BUILD_BUDGET_V1,
        buildOptions(options, runtimeId)
      );
      validateReplicaArtifact(artifact, REPLICA_BUILD_BUDGET_V1, { packageHash });
      const evidence = await persistEvidence({
        evidenceVault,
        createId,
        now,
        runtimeId,
        runId: createId('run'),
        testId: 'replica_evidence',
        payload: { phase: 'build', runtimeId, artifact, health },
        secrets: options.secrets
      });
      records.push(evidence.record);
      sealedManifestItems.push(evidence.manifestItem);
      const summary = {
        runtimeId,
        validity: 'pending-first-run',
        artifact: structuredClone(artifact),
        artifactEvidenceIds: [evidence.record.evidenceId],
        failureCategory: null
      };
      summaries.push(summary);
      await checkpoint(options, { phase: 'build', runtimeId, validity: summary.validity, evidenceIds: summary.artifactEvidenceIds });
    } catch (error) {
      const classification = classifyReplicaFailure(error, {
        ready: true,
        artifactValid: false,
        executionStarted: false
      });
      const summary = invalidRuntime(
        runtimeId,
        classification.source === 'replica-infrastructure'
          ? 'invalid-build'
          : 'attribution-pending',
        error,
        health
      );
      await attachFailureEvidence(summary, { evidenceVault, createId, now, runtimeId, error, health });
      summaries.push(summary);
      await checkpoint(options, { phase: 'build', runtimeId, validity: summary.validity, evidenceIds: summary.artifactEvidenceIds });
    }
  }

  return {
    packageHash,
    replicaPackage,
    runtimes: summaries,
    evidenceIds: records.map((record) => record.evidenceId),
    sealedManifestItems
  };
}

/** Executes only one immutable current turn at a time in a per-example context. */
export async function executeReplicas(options = {}) {
  const testPlan = requiredObject(options.testPlan, 'testPlan');
  const replicas = requiredObject(options.replicas, 'replicas');
  const evidenceVault = requiredObject(options.evidenceVault, 'evidenceVault');
  const now = options.now || (() => new Date().toISOString());
  const createId = options.createId || defaultId;
  const submittedInput = options.submittedInputForTurn || inputForTurn;
  if (testPlan.defaultRepeatCount !== 3) {
    throw new TypeError('Replica execution requires exactly three planned repeats');
  }
  const results = replicas.runtimes.map((replica) => ({
    runtimeId: replica.runtimeId,
    validity: replica.validity,
    artifactEvidenceIds: [...(replica.artifactEvidenceIds || [])],
    runCount: 0,
    turnCount: 0,
    evidenceIds: [],
    failureCategory: replica.failureCategory || null,
    runs: []
  }));
  const byRuntime = new Map(results.map((item) => [item.runtimeId, item]));
  const sealedManifestItems = [];

  for (const test of requiredArray(testPlan.tests, 'testPlan.tests')) {
    const repeatCount = test.repeatCount ?? testPlan.defaultRepeatCount;
    if (repeatCount !== 3) throw new TypeError('Each Replica test requires exactly three planned repeats');
    for (let repeatIndex = 0; repeatIndex < 3; repeatIndex += 1) {
      for (const replica of replicas.runtimes) {
        const result = byRuntime.get(replica.runtimeId);
        if (!result || !['pending-first-run', 'valid'].includes(result.validity)) continue;
        const adapter = resolveAdapter(options, { id: replica.runtimeId });
        if (!adapter) {
          result.validity = 'invalid-infrastructure';
          result.failureCategory = 'ADAPTER_CONFIG_INVALID';
          continue;
        }
        const context = { id: createId('ctx'), history: [] };
        let completedCell = false;
        try {
          for (let turnIndex = 0; turnIndex < requiredArray(test.turns, 'test.turns').length; turnIndex += 1) {
            const submitted = structuredClone(submittedInput(test, turnIndex));
            const currentInput = deepFreeze(structuredClone(inputForTurn(test, turnIndex)));
            if (canonicalJson(currentInput) !== canonicalJson(submitted)) {
              throw replicaError('INPUT_PARITY_MISMATCH', 'Replica current input must equal submitted-Agent input');
            }
            let normalized;
            try {
              const output = await adapter.run(
                replica.artifact,
                currentInput,
                context,
                { ...REPLICA_RUN_BUDGET_V1, wallClockMs: test.timing?.timeoutMs },
                { seed: options.seed ?? null }
              );
              normalized = normalizeReplicaResult(output);
              if (normalized.status === 'invalid-output') {
                throw replicaError('INVALID_REPLICA_OUTPUT', normalized.error?.message);
              }
              result.validity = 'valid';
            } catch (error) {
              const failure = classifyReplicaFailure(error, {
                ready: true,
                artifactValid: true,
                executionStarted: error?.code !== 'EXECUTION_BOUNDARY_NOT_STARTED'
              });
              if (failure.scoreSemantics === 'invalidate-replica') {
                result.validity = 'invalid-infrastructure';
                result.failureCategory = failure.code;
                break;
              }
              if (failure.scoreSemantics === 'hold-for-review') {
                result.validity = 'attribution-pending';
                result.failureCategory = failure.code;
                break;
              }
              normalized = {
                status: failure.scoreSemantics === 'score-zero' ? 'failed' : 'invalid-output',
                messageParts: [], artifacts: [], durationMs: 0,
                error: { code: failure.code, message: String(error?.message || failure.code) },
                budgetUsage: {}, evidence: {}
              };
              result.validity = 'valid';
              result.failureCategory ||= failure.code;
            }
            const evidence = await persistEvidence({
              evidenceVault,
              createId,
              now,
              runtimeId: replica.runtimeId,
              runId: createId('run'),
              testId: 'replica_evidence',
              payload: { phase: 'run', runtimeId: replica.runtimeId, input: currentInput, result: normalized },
              secrets: options.secrets
            });
            sealedManifestItems.push(evidence.manifestItem);
            result.evidenceIds.push(evidence.record.evidenceId);
            result.runs.push({
              testId: test.testId, repeatIndex, turnIndex,
              status: normalized.status, evidenceId: evidence.record.evidenceId
            });
            result.turnCount += 1;
            context.history.push({ input: structuredClone(currentInput), output: structuredClone(normalized.messageParts) });
            completedCell = true;
          }
        } finally {
          try {
            await adapter.disposeContext(context);
          } catch (error) {
            result.validity = 'invalid-infrastructure';
            result.failureCategory = error?.code || 'CONTEXT_DISPOSE_FAILED';
            await attachFailureEvidence(result, { evidenceVault, createId, now, runtimeId: replica.runtimeId, error });
          }
        }
        if (completedCell && result.validity === 'valid') {
          result.runCount += 1;
        }
        await checkpoint(options, { phase: 'cell', runtimeId: replica.runtimeId, testId: test.testId, repeatIndex, validity: result.validity, runCount: result.runCount, turnCount: result.turnCount });
      }
    }
  }

  return { runtimes: results, sealedManifestItems };
}

/** Converts internal build/run state to the immutable Phase 3 sealed envelope. */
export async function sealReplicaArena(options = {}) {
  const built = requiredObject(options.built, 'built');
  const executed = requiredObject(options.executed, 'executed');
  const runByRuntime = new Map(requiredArray(executed.runtimes, 'executed.runtimes').map((item) => [item.runtimeId, item]));
  const runtimeSummaries = requiredArray(built.runtimes, 'built.runtimes').map((build) => {
    const run = runByRuntime.get(build.runtimeId);
    return {
      runtimeId: build.runtimeId,
      validity: run?.validity || build.validity,
      artifactEvidenceIds: [...(build.artifactEvidenceIds || [])],
      runCount: run?.runCount || 0,
      turnCount: run?.turnCount || 0,
      failureCategory: run?.failureCategory || build.failureCategory || null
    };
  });
  return {
    status: 'sealed',
    sealVersion: 'replica-arena-seal/v1',
    packageHash: requiredString(options.packageHash || built.packageHash, 'packageHash'),
    runtimeSummaries,
    encryptedArenaEvidenceIds: [...(options.encryptedArenaEvidenceIds || [
      ...(built.evidenceIds || []),
      ...requiredArray(executed.runtimes, 'executed.runtimes').flatMap((item) => item.evidenceIds || [])
    ])],
    releasedAt: null
  };
}

export function sealedReplicaProjection(replicaArena) {
  const summaries = Array.isArray(replicaArena?.runtimeSummaries) ? replicaArena.runtimeSummaries : [];
  return {
    status: replicaArena?.status || 'disabled',
    validReplicaCount: summaries.filter((item) => item.validity === 'valid').length,
    pendingAttributionCount: summaries.filter((item) => item.validity === 'attribution-pending').length
  };
}

async function persistEvidence({ evidenceVault, createId, now, runtimeId, runId, testId, turnIndex, repeatIndex, payload, secrets }) {
  const record = createEvidenceRecord({
    evidenceId: createId('ev'), runId, grade: 'C', kind: 'agent-output', testId,
    ...(turnIndex === undefined ? {} : { turnIndex }),
    ...(repeatIndex === undefined ? {} : { repeatIndex }),
    capturedAt: now(), payload: structuredClone(payload)
  });
  await evidenceVault.put(record);
  const manifestItem = createEvidenceManifestItem(record, {
    summary: 'Replica evidence sealed',
    visibility: 'admin', secrets: secrets || []
  });
  return { record, manifestItem };
}

function invalidRuntime(runtimeId, validity, error, health = null) {
  const classification = classifyReplicaFailure(error, { ready: health?.ready === true });
  return {
    runtimeId, validity, artifact: null, artifactEvidenceIds: [],
    failureCategory: classification.code
  };
}
async function attachFailureEvidence(summary, { evidenceVault, createId, now, runtimeId, error, health }) {
  try {
    const evidence = await persistEvidence({
      evidenceVault, createId, now, runtimeId,
      runId: createId('run'), testId: 'replica_evidence',
      payload: { phase: 'failure', runtimeId, error: { code: error?.code || 'UNKNOWN_REPLICA_FAILURE', message: String(error?.message || '') }, health }
    });
    summary.artifactEvidenceIds.push(evidence.record.evidenceId);
  } catch {
    summary.failureCategory = 'PLATFORM_STORAGE_FAILED';
    summary.validity = 'invalid-infrastructure';
  }
}
async function checkpoint(options, value) { await options.checkpoint?.(structuredClone(value)); }
function resolveAdapter(options, runtime) {
  if (typeof options.createAdapter === 'function') return options.createAdapter(runtime);
  if (options.adapters instanceof Map) return options.adapters.get(runtime.id);
  return options.adapters?.[runtime.id] || null;
}
function isHardHealthy(value) {
  return value?.ready === true && canonicalJson(value.budgetEnforcement) === canonicalJson(HARD_ENFORCEMENT);
}
function buildOptions(options, runtimeId) {
  return { seed: options.seed ?? null, temperature: options.temperature ?? 0, runtimeId };
}
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function requiredArray(value, name) { if (!Array.isArray(value)) throw new TypeError(`${name} is required`); return value; }
function requiredObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is required`); return value; }
function requiredString(value, name) { if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`); return value; }
function defaultId(prefix = 'id') { return `${prefix}_${crypto.randomUUID()}`; }
function replicaError(code, message) { return Object.assign(new Error(message), { code }); }
