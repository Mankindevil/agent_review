import { createHash, randomUUID } from 'node:crypto';
import { runAnonymousArena as runAnonymousArenaDefault } from './arena.js';
import {
  bootstrapReplicaAdvantage as bootstrapReplicaAdvantageDefault,
  median
} from './statistics.js';
import { classifyDualTrackRating as classifyDualTrackRatingDefault } from './rating.js';

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Releases the counterfactual Replica comparison only after Phase 4 has
 * committed an immutable absolute result. The absolute result is reused by
 * reference and never recalculated from Replica evidence.
 */
export function releaseReplicaArena(evaluation, services = {}) {
  assertAbsoluteLock(evaluation);
  if (evaluation.replicaArena?.status === 'released') return evaluation;
  if (evaluation.replicaArena?.status !== 'sealed') {
    throw new Error('Replica Arena must be sealed before it can be released');
  }
  return releaseSealedArena(evaluation, services);
}

async function releaseSealedArena(evaluation, services) {
  const now = services.now || (() => new Date().toISOString());
  const releasedAt = now();
  assertIso(releasedAt, 'replica release timestamp');
  const absolute = evaluation.resultV2.absolute;
  const validReplicaIds = validReplicaIdsFor(evaluation.replicaArena);
  const next = {
    ...evaluation,
    governance: {
      ...evaluation.governance,
      replicaReleasedAt: releasedAt
    },
    replicaArena: {
      ...evaluation.replicaArena,
      releasedAt
    },
    resultV2: {
      ...evaluation.resultV2,
      // The Phase 4 immutable absolute score must never be copied,
      // recomputed, or mixed with counterfactual Replica measurements.
      absolute
    }
  };

  if (validReplicaIds.length === 0) {
    next.replicaArena.status = 'unavailable';
    next.resultV2.replica = { status: 'unavailable' };
    next.resultV2.rating = {
      status: 'pending-replica',
      code: 'PENDING_REPLICA',
      label: '待复刻'
    };
    transitionToFinal(next, releasedAt, false);
    return next;
  }

  const runAnonymousArena =
    services.runAnonymousArena || runAnonymousArenaDefault;
  const bootstrapReplicaAdvantage =
    services.bootstrapReplicaAdvantage || bootstrapReplicaAdvantageDefault;
  const classifyDualTrackRating =
    services.classifyDualTrackRating || classifyDualTrackRatingDefault;
  const materials = await loadSealedArenaMaterials(
    evaluation,
    validReplicaIds,
    services
  );
  const arena = await runAnonymousArena({
    ...(services.arenaOptions || {}),
    ...materials,
    evaluation,
    replicaArena: evaluation.replicaArena,
    validReplicaIds
  });
  const scoringCube = Array.isArray(arena?.scoringCube)
    ? arena.scoringCube
    : arena?.scoreCells;
  const advantage = bootstrapReplicaAdvantage(
    scoringCube,
    validReplicaIds,
    services.bootstrapOptions || {}
  );
  if (advantage?.status !== 'ready') {
    throw new Error('valid Replica Arena must produce a ready advantage');
  }
  const rating = classifyDualTrackRating({
    eligibilityStatus: evaluation.qualification?.status,
    absoluteTotal: absolute.total,
    scenarioScore: absolute.dimensions.scenarioValue.score,
    objectiveCoverage: absolute.dimensions.agentCapability.objectiveCoverage,
    replicaAdvantage: advantage
  });

  next.replicaArena.status = 'released';
  next.resultV2.replica = releasedReplica(
    advantage,
    validReplicaIds,
    scoringCube,
    rating
  );
  next.resultV2.rating = rating;
  transitionToFinal(next, releasedAt, true);
  return next;
}

function transitionToFinal(evaluation, at, replicaReleased) {
  const from = evaluation.governance.phase;
  if (replicaReleased) {
    appendPhaseTransition(evaluation, from, 'replica_released', at);
    appendPhaseTransition(evaluation, 'replica_released', 'final', at);
  } else {
    appendPhaseTransition(evaluation, from, 'final', at);
  }
  evaluation.governance.phase = 'final';
}

function appendPhaseTransition(evaluation, from, to, at) {
  if (!Array.isArray(evaluation.auditEvents)) evaluation.auditEvents = [];
  const previousEventHash = evaluation.auditEvents.at(-1)?.eventHash || null;
  const event = {
    eventId: `audit_${randomUUID().replaceAll('-', '')}`,
    type: 'governance-phase-transition',
    actorId: 'system',
    at,
    payloadHash: hash(canonical({ from, to })),
    previousEventHash
  };
  event.eventHash = hash(canonical(event));
  evaluation.auditEvents.push(event);
}

async function loadSealedArenaMaterials(evaluation, validReplicaIds, services) {
  const testPlan = evaluation.testPlan;
  if (!testPlan || !Array.isArray(testPlan.tests)) {
    throw new TypeError('sealed Replica release requires the committed test plan');
  }
  const evidenceVault = services.evidenceVault ||
    services.evidenceVaultFactory?.(evaluation.id);
  if (!evidenceVault || typeof evidenceVault.get !== 'function' ||
    typeof evidenceVault.put !== 'function') {
    throw new TypeError('sealed Replica release requires an encrypted evidenceVault');
  }
  const submittedOutputs = submittedOutputsFor(evaluation.phase2Execution);
  const replicas = await replicaOutputsFor(
    evaluation.replicaCheckpoint,
    validReplicaIds,
    evidenceVault
  );
  return { testPlan, submittedOutputs, replicas, evidenceVault };
}

function submittedOutputsFor(execution) {
  if (!Array.isArray(execution?.testRuns)) {
    throw new TypeError('sealed Replica release requires submitted test outputs');
  }
  return execution.testRuns.map((testRun) => {
    const lastRun = testRun?.runs?.at(-1);
    return {
      testId: requiredText(testRun?.testId, 'submitted test output testId'),
      repeatIndex: requiredRepeatIndex(testRun?.repeatIndex),
      ...toArenaOutput(lastRun?.response?.currentOutput, 'submitted test output')
    };
  });
}

async function replicaOutputsFor(checkpoint, validReplicaIds, evidenceVault) {
  if (checkpoint?.status !== 'sealed' || !checkpoint.turns) {
    throw new TypeError('sealed Replica release requires replica checkpoint evidence');
  }
  const outputsByRuntime = new Map(validReplicaIds.map((runtimeId) => [runtimeId, []]));
  const latestTurns = new Map();
  for (const turn of Object.values(checkpoint.turns)) {
    if (!outputsByRuntime.has(turn?.runtimeId)) continue;
    const key = `${turn.runtimeId}:${turn.testId}:${turn.repeatIndex}`;
    if (!latestTurns.has(key) || turn.turnIndex > latestTurns.get(key).turnIndex) {
      latestTurns.set(key, turn);
    }
  }
  for (const turn of latestTurns.values()) {
    const commitment = turn.resultCommitment;
    if (!commitment?.evidenceId || !commitment?.recordHash) {
      throw new TypeError('Replica turn checkpoint is missing its evidence commitment');
    }
    const record = await evidenceVault.get(commitment.evidenceId, commitment.recordHash);
    outputsByRuntime.get(turn.runtimeId).push({
      testId: requiredText(turn.testId, 'Replica turn testId'),
      repeatIndex: requiredRepeatIndex(turn.repeatIndex),
      ...toArenaOutput(record?.payload?.result, 'Replica sealed output')
    });
  }
  return validReplicaIds.map((runtimeId) => ({
    runtimeId,
    validity: 'valid',
    outputs: outputsByRuntime.get(runtimeId)
  }));
}

function toArenaOutput(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is missing`);
  }
  if (Array.isArray(value.messageParts)) {
    return {
      messageParts: structuredClone(value.messageParts),
      ...(Array.isArray(value.artifacts) ? { artifacts: structuredClone(value.artifacts) } : {})
    };
  }
  const messageParts = [];
  if (typeof value.text === 'string') messageParts.push({ type: 'text', text: value.text });
  if (value.data !== null && value.data !== undefined) {
    messageParts.push({ type: 'data', data: structuredClone(value.data) });
  }
  if (messageParts.length) return { messageParts };
  throw new TypeError(`${field} has no renderable output`);
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${field} is required`);
  return value;
}

function requiredRepeatIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Replica output repeatIndex must be a non-negative integer');
  }
  return value;
}

function releasedReplica(advantage, validReplicaIds, scoringCube, rating) {
  const runtimeMedians = new Map(validReplicaIds.map((runtimeId) => [
    runtimeId,
    median(scoringCube.map((cell) => cell.scores[`replica:${runtimeId}`]))
  ]));
  return {
    status: 'released',
    submittedMedian: advantage.submittedMedian,
    runtimes: [...runtimeMedians].map(([runtimeId, median]) => ({
      runtimeId,
      valid: true,
      median
    })),
    bestBaseline: {
      runtimeId: advantage.bestReplicaId,
      median: advantage.bestReplicaMedian
    },
    delta: advantage.delta,
    conservativeDelta: advantage.conservativeDelta,
    ci95: advantage.interval,
    differenceStable: rating.differenceStable
  };
}

function validReplicaIdsFor(replicaArena) {
  return (Array.isArray(replicaArena.runtimeSummaries)
    ? replicaArena.runtimeSummaries
    : []
  ).flatMap((summary) =>
    summary?.validity === 'valid' && typeof summary.runtimeId === 'string'
      ? [summary.runtimeId]
      : []
  );
}

function assertAbsoluteLock(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') {
    throw new TypeError('evaluation is required');
  }
  const governance = evaluation.governance;
  const absolute = evaluation.resultV2?.absolute;
  if (
    governance?.phase !== 'absolute_locked' ||
    !isIso(governance.absoluteLockedAt) ||
    !SHA256.test(governance.resultHash || '') ||
    !absolute ||
    absolute.status !== 'locked' ||
    absolute.resultHash !== governance.resultHash
  ) {
    throw new Error('Replica Arena release requires an immutable absolute locked result');
  }
}

function assertIso(value, name) {
  if (!isIso(value)) throw new TypeError(`${name} must be an ISO timestamp`);
}

function isIso(value) {
  return typeof value === 'string' && new Date(value).toISOString() === value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
