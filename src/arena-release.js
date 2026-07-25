import { createHash, randomUUID } from 'node:crypto';
import { collapseCubeToScoreCells, mergeHumanJudgesIntoCube } from './arena-cube-merge.js';
import { runAnonymousArena as runAnonymousArenaDefault } from './arena.js';
import {
  bootstrapReplicaAdvantage as bootstrapReplicaAdvantageDefault,
  median
} from './statistics.js';
import { classifyDualTrackRating as classifyDualTrackRatingDefault } from './rating.js';

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Runs the anonymous model Arena over the sealed Replica materials and
 * stores the raw per-judge scoring cube on `evaluation.replicaArena`. This
 * does NOT require the absolute result to be locked (see the parallel
 * dual-track design): the sealed Replica track scores independently of the
 * absolute human review track. Idempotent — a second call is a no-op once
 * the cube is present.
 */
export async function runSealedModelArena(evaluation, services = {}) {
  assertEvaluationObject(evaluation);
  if (evaluation.replicaArena?.status !== 'sealed') {
    throw conflict('the Replica Arena must be sealed before running the model Arena');
  }
  if (Array.isArray(evaluation.replicaArena.modelScoringCube)) return evaluation;

  const now = services.now || (() => new Date().toISOString());
  const validReplicaIds = validReplicaIdsFor(evaluation.replicaArena);
  if (validReplicaIds.length === 0) {
    evaluation.replicaArena = {
      ...evaluation.replicaArena,
      modelScoringCube: [],
      modelArenaValidReplicaIds: [],
      modelArenaRanAt: now()
    };
    return evaluation;
  }

  const runAnonymousArena = services.runAnonymousArena || runAnonymousArenaDefault;
  const materials = await loadSealedArenaMaterials(evaluation, validReplicaIds, services);
  const arena = await runAnonymousArena({
    ...(services.arenaOptions || {}),
    ...materials,
    evaluation,
    replicaArena: evaluation.replicaArena,
    validReplicaIds
  });
  const modelScoringCube = Array.isArray(arena?.scoringCube) ? arena.scoringCube : arena?.scoreCells;
  if (!Array.isArray(modelScoringCube) || modelScoringCube.length === 0) {
    throw new Error('sealed model Arena must produce a non-empty scoring cube');
  }
  evaluation.replicaArena = {
    ...evaluation.replicaArena,
    modelScoringCube,
    modelArenaValidReplicaIds: [...validReplicaIds],
    modelArenaRanAt: now()
  };
  return evaluation;
}

/**
 * Finalizes the dual-track rating: merges the sealed model Arena cube with
 * any locked replica-human judge channels, bootstraps the Δ/Δc advantage,
 * classifies the rating, and transitions governance to `final`. Succeeds
 * only when the absolute result is locked AND (the replica-human track is
 * locked OR there are no valid Replicas to score). Idempotent by
 * `actor.idempotencyKey`.
 */
export async function finalizeDualTrack(evaluation, services = {}, actor = {}) {
  assertEvaluationObject(evaluation);
  assertAbsoluteLock(evaluation);
  const actorId = requiredText(actor?.principalId, 'actor identity');
  const key = requiredText(actor?.idempotencyKey, 'idempotency key');

  const validReplicaIds = validReplicaIdsFor(evaluation.replicaArena || {});
  assertReplicaTrackGate(evaluation, validReplicaIds);

  const receipt = evaluation.governance?.dualTrackFinalizeReceipt;
  if (evaluation.governance?.dualTrackFinalizedAt) {
    if (receipt?.key === key) {
      return { replica: evaluation.resultV2.replica, rating: evaluation.resultV2.rating };
    }
    throw conflict('dual-track finalize is already complete with a different idempotency key');
  }

  const outcome = validReplicaIds.length === 0
    ? unavailableOutcome()
    : await finalizeWithValidReplicas(evaluation, validReplicaIds, services);

  const now = services.now || (() => new Date().toISOString());
  const finalizedAt = now();
  assertIso(finalizedAt, 'dual-track finalize timestamp');

  evaluation.replicaArena = {
    ...evaluation.replicaArena,
    status: outcome.released ? 'released' : 'unavailable',
    ...(outcome.released ? { releasedAt: finalizedAt } : {})
  };
  evaluation.resultV2 = {
    ...evaluation.resultV2,
    replica: outcome.replica,
    rating: outcome.rating
  };
  evaluation.governance = {
    ...evaluation.governance,
    ...(outcome.released ? { replicaReleasedAt: finalizedAt } : {}),
    dualTrackFinalizedAt: finalizedAt,
    dualTrackFinalizeReceipt: {
      key,
      payloadHash: hash(canonical({ replica: outcome.replica, rating: outcome.rating }))
    }
  };
  transitionToFinal(evaluation, finalizedAt, outcome.released);
  appendAudit(evaluation, 'dual-track-finalized', actorId, {
    idempotencyKey: key,
    replicaStatus: outcome.replica.status,
    ratingCode: outcome.rating.code ?? null
  });
  return { replica: outcome.replica, rating: outcome.rating };
}

/**
 * Deprecated compatibility helper. Use `finalizeDualTrack` directly for new
 * call sites. Only succeeds once both tracks are ready — it never finalizes
 * a rating from the absolute lock alone while a valid Replica still needs
 * replica-human review.
 */
export async function releaseReplicaArena(evaluation, services = {}) {
  assertAbsoluteLock(evaluation);
  if (evaluation.replicaArena?.status === 'released' || evaluation.replicaArena?.status === 'unavailable') {
    return evaluation;
  }
  if (evaluation.replicaArena?.status !== 'sealed') {
    throw new Error('Replica Arena must be sealed before it can be released');
  }
  const validReplicaIds = validReplicaIdsFor(evaluation.replicaArena);
  assertReplicaTrackGate(evaluation, validReplicaIds);
  const actor = {
    principalId: 'system',
    idempotencyKey: `legacy-release:${requiredText(evaluation.id, 'evaluation.id')}`
  };
  await finalizeDualTrack(evaluation, services, actor);
  return evaluation;
}

function unavailableOutcome() {
  return {
    replica: { status: 'unavailable' },
    rating: { status: 'pending-replica', code: 'PENDING_REPLICA', label: '待复刻' },
    released: false
  };
}

async function finalizeWithValidReplicas(evaluation, validReplicaIds, services) {
  await runSealedModelArena(evaluation, services);
  const modelScoringCube = evaluation.replicaArena.modelScoringCube;
  if (!Array.isArray(modelScoringCube) || modelScoringCube.length === 0) {
    throw new Error('sealed model Arena must produce a non-empty scoring cube');
  }
  const humanReviews = humanReviewsForMerge(evaluation);
  const mergedCube = mergeHumanJudgesIntoCube(modelScoringCube, humanReviews, validReplicaIds);
  const scoreCells = collapseCubeToScoreCells(mergedCube);

  const bootstrapReplicaAdvantage = services.bootstrapReplicaAdvantage || bootstrapReplicaAdvantageDefault;
  const classifyDualTrackRating = services.classifyDualTrackRating || classifyDualTrackRatingDefault;
  const advantage = bootstrapReplicaAdvantage(
    scoreCells,
    validReplicaIds,
    services.bootstrapOptions || {}
  );
  if (advantage?.status !== 'ready') {
    throw new Error('valid Replica Arena must produce a ready advantage');
  }
  const absolute = evaluation.resultV2.absolute;
  const rating = classifyDualTrackRating({
    eligibilityStatus: evaluation.qualification?.status,
    absoluteTotal: absolute.total,
    scenarioScore: absolute.dimensions.scenarioValue.score,
    objectiveCoverage: absolute.dimensions.agentCapability.objectiveCoverage,
    replicaAdvantage: advantage
  });
  return {
    replica: releasedReplica(advantage, validReplicaIds, scoreCells, rating),
    rating,
    released: true
  };
}

function humanReviewsForMerge(evaluation) {
  return (evaluation.replicaHumanReviews || [])
    .filter((review) => review?.status === 'submitted')
    .map((review) => ({
      principalId: requiredText(review.principalId, 'replicaHumanReview.principalId'),
      scores: Object.fromEntries(
        Object.entries(review.scores || {}).map(([sourceId, entry]) => [sourceId, entry.total])
      )
    }));
}

function assertReplicaTrackGate(evaluation, validReplicaIds) {
  if (validReplicaIds.length > 0 && !evaluation.governance?.replicaHumanLockedAt) {
    throw conflict('dual-track finalize requires the replica-human review to be locked while valid Replicas exist');
  }
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

function appendAudit(evaluation, type, actorId, payload) {
  if (!Array.isArray(evaluation.auditEvents)) evaluation.auditEvents = [];
  const previousEventHash = evaluation.auditEvents.at(-1)?.eventHash || null;
  const event = {
    eventId: `audit_${randomUUID().replaceAll('-', '')}`,
    type,
    actorId,
    at: new Date().toISOString(),
    payloadHash: hash(canonical(payload)),
    previousEventHash
  };
  event.eventHash = hash(canonical(event));
  evaluation.auditEvents.push(event);
  return event;
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

export function validReplicaIdsFor(replicaArena) {
  return (Array.isArray(replicaArena?.runtimeSummaries)
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
    !isIso(governance?.absoluteLockedAt) ||
    !SHA256.test(governance?.resultHash || '') ||
    !absolute ||
    absolute.status !== 'locked' ||
    absolute.resultHash !== governance.resultHash
  ) {
    throw conflict('Replica Arena release requires an immutable absolute locked result');
  }
}

function assertEvaluationObject(evaluation) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    throw new TypeError('evaluation must be an object');
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

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}
