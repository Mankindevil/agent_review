import { createHash, randomUUID } from 'node:crypto';
import {
  computeDimensionConfidence,
  computeSubcriterionConfidence,
  computeTotalConfidence
} from './confidence.js';
import { finalizeDualTrack, validReplicaIdsFor } from './arena-release.js';
import { generateLockedHumor } from './humor.js';
import { RUBRIC_V1 } from './rubric.js';

const DIMENSION_IDS = ['scenarioValue', 'professionalism', 'agentCapability'];
const HUMAN_SEAT_DIMENSIONS = new Set(['scenarioValue', 'professionalism']);

export function combineScenarioOrProfessional({ model, human }) {
  return 0.4 * score(model, 'model seat') + 0.6 * score(human, 'human seat');
}

export function combineCapability({ objective, model, human }) {
  return 0.5 * score(objective, 'objective seat') +
    0.2 * score(model, 'model seat') +
    0.3 * score(human, 'human seat');
}

export function calculateAbsoluteResult(evaluation, rubric = RUBRIC_V1, options = {}) {
  assertModelLocked(evaluation);
  assertRubric(rubric);
  const modelLeaves = modelLeavesFor(evaluation);
  const humanLeaves = humanLeavesFor(evaluation);
  const dimensions = {};

  for (const dimensionId of DIMENSION_IDS) {
    const weights = rubric.dimensions[dimensionId];
    const leaves = Object.entries(weights).map(([leafId, weight]) => {
      const id = `${dimensionId}.${leafId}`;
      const objective = dimensionId === 'agentCapability'
        ? objectiveLeaf(evaluation, leafId)
        : null;
      const applicable = objective ? objective.applicable : true;
      // Multi-turn-only leaves (e.g. contextContinuity) are omitted from the
      // model panel when not applicable; do not require model/human seats.
      const model = modelLeaves.get(id) || (applicable ? null : unavailableSeat());
      const human = humanLeaves.get(id) || (applicable ? null : unavailableSeat());
      if (!model || !human) throw new TypeError(`missing resolved absolute leaf: ${id}`);
      return {
        id,
        weight,
        applicable,
        model,
        human,
        objective,
        confidence: applicable
          ? leafConfidence(evaluation, id, model, human, objective)
          : { status: 'unavailable', value: null, missingCheckIds: [] }
      };
    });
    const applicable = leaves.filter((leaf) => leaf.applicable);
    if (!applicable.length) throw new TypeError(`${dimensionId} has no applicable leaves`);
    const modelSeat = weightedMean(applicable.map((leaf) => ({
      weight: leaf.weight,
      value: leaf.model.score
    })));
    const humanSeat = weightedMean(applicable.map((leaf) => ({
      weight: leaf.weight,
      value: leaf.human.score
    })));
    const objectiveSeat = dimensionId === 'agentCapability'
      ? weightedMean(applicable.map((leaf) => ({
        weight: leaf.weight,
        value: leaf.objective.score
      })))
      : undefined;
    const scoreValue = HUMAN_SEAT_DIMENSIONS.has(dimensionId)
      ? combineScenarioOrProfessional({ model: modelSeat, human: humanSeat })
      : combineCapability({ objective: objectiveSeat, model: modelSeat, human: humanSeat });
    const confidence = computeDimensionConfidence(applicable.map((leaf) => ({
      id: leaf.id.replace('.', '_'),
      weight: leaf.weight,
      applicable: true,
      confidence: {
        status: leaf.confidence.status,
        value: leaf.confidence.value
      }
    })));
    dimensions[dimensionId] = {
      score: scoreValue,
      confidence: confidence.value,
      leaves: Object.fromEntries(leaves.map((leaf) => [leaf.id, {
        score: !leaf.applicable
          ? null
          : HUMAN_SEAT_DIMENSIONS.has(dimensionId)
            ? combineScenarioOrProfessional({
              model: leaf.model.score,
              human: leaf.human.score
            })
            : combineCapability({
              objective: leaf.objective.score,
              model: leaf.model.score,
              human: leaf.human.score
            }),
        confidence: leaf.confidence.value,
        applicable: leaf.applicable,
        missingCheckIds: leaf.confidence.missingCheckIds
      }])),
      seats: {
        model: modelSeat,
        human: humanSeat,
        ...(dimensionId === 'agentCapability' ? { objective: objectiveSeat } : {})
      },
      ...(dimensionId === 'agentCapability' ? {
        objectiveCoverage: evaluation.objectiveCapability.coverage,
        provisional: evaluation.objectiveCapability.coverage < 0.70
      } : {})
    };
  }
  const totalConfidence = computeTotalConfidence(Object.fromEntries(
    DIMENSION_IDS.map((id) => [id, {
      status: 'complete',
      value: dimensions[id].confidence
    }])
  ));
  const allLeaves = Object.values(dimensions).flatMap((dimension) =>
    Object.entries(dimension.leaves).map(([id, leaf]) => ({ id, ...leaf }))
  );
  const lockedAt = (options.now || (() => new Date().toISOString()))();
  assertIso(lockedAt, 'lock timestamp');
  return {
    status: 'locked',
    rubricVersion: rubric.version,
    dimensions,
    total: DIMENSION_IDS.reduce((sum, id) => sum + dimensions[id].score, 0) / 3,
    confidence: totalConfidence.value,
    evidenceGaps: allLeaves.filter((leaf) =>
      leaf.applicable && leaf.missingCheckIds.length > 0
    ).map((leaf) => leaf.id),
    lowConfidenceLeaves: allLeaves.filter((leaf) =>
      leaf.applicable && leaf.confidence < 0.6
    ).map((leaf) => leaf.id),
    lockedAt,
    sourceHashes: {
      rubricHash: evaluation.governance?.rubricHash ?? null,
      configHash: evaluation.governance?.configHash ?? null
    }
  };
}

export function lockAbsoluteResult(evaluation, result, actor) {
  assertModelLocked(evaluation);
  assertHumanReviewComplete(evaluation);
  const key = requiredText(actor?.idempotencyKey, 'idempotency key');
  const actorId = requiredText(actor?.principalId, 'actor identity');
  const requestPayloadHash = hash(canonical(result ?? null));
  const existing = evaluation.resultV2?.absolute;
  if (evaluation.governance?.absoluteLockedAt || existing?.status === 'locked') {
    const receipt = evaluation.governance.absoluteLockReceipt;
    if (receipt?.key === key && receipt.payloadHash === requestPayloadHash) return existing;
    throw conflict('absolute result is already locked with a different idempotency payload');
  }
  // Absolute totals are derived only from the locked evaluation record. The
  // caller-provided result remains a compatibility argument and is never used.
  const calculated = calculateAbsoluteResult(evaluation);
  const payload = canonical({ ...calculated, resultHash: undefined });
  const resultHash = hash(payload);
  const locked = deepFreeze({
    ...structuredClone(calculated),
    resultHash
  });
  evaluation.resultV2 = {
    ...(evaluation.resultV2 || {}),
    absolute: locked
  };
  evaluation.governance = {
    ...evaluation.governance,
    phase: 'absolute_locked',
    absoluteLockedAt: locked.lockedAt,
    resultHash,
    absoluteLockReceipt: { key, payloadHash: requestPayloadHash, resultHash }
  };
  appendAudit(evaluation, 'absolute-result-locked', actorId, {
    resultHash,
    idempotencyKey: key
  });
  return locked;
}

/**
 * Locks the absolute result and, only when the dual-track gate is already
 * met (the replica track is locked or there are no valid Replicas to
 * score), opportunistically finalizes the dual-track rating in the same
 * call. This function never finalizes a rating while a valid Replica still
 * needs replica-human review — see `finalizeDualTrack` for the explicit
 * gate. Kept for existing call sites; new code should call
 * `lockAbsoluteResult` and `finalizeDualTrack` directly.
 */
export async function lockAndReleaseAbsoluteResult(evaluation, services, actor) {
  const absolute = lockAbsoluteResult(evaluation, undefined, actor);
  const humor = await generateLockedHumor(evaluation, services);
  const validReplicaIds = validReplicaIdsFor(evaluation.replicaArena || {});
  const dualTrackReady = validReplicaIds.length === 0 ||
    Boolean(evaluation.governance?.replicaHumanLockedAt);
  if (dualTrackReady) {
    await finalizeDualTrack(evaluation, services, actor);
  }
  return {
    absolute,
    humor,
    replica: evaluation.resultV2.replica,
    rating: evaluation.resultV2.rating
  };
}

function unavailableSeat() {
  return { score: 0, scores: [], confidences: [], checkEvidence: [] };
}

function modelLeavesFor(evaluation) {
  const panel = evaluation.absoluteReview.modelPanel;
  const result = new Map();
  const ids = panel.primary[0].reviews.map((review) => review.subcriterionId);
  for (const id of ids) {
    const reviews = panel.primary.map((run) =>
      run.reviews.find((review) => review.subcriterionId === id)
    );
    const arbitration = panel.arbitration?.reviews?.find(
      (review) => review.subcriterionId === id
    );
    const included = arbitration ? [...reviews, arbitration] : reviews;
    result.set(id, {
      score: median(included.map((review) => score(review.score, 'model leaf score'))),
      scores: included.map((review) => review.score),
      confidences: included.map((review) => score(review.confidence, 'model confidence', 1)),
      checkEvidence: included.flatMap((review) => review.checkEvidence || [])
    });
  }
  return result;
}

function humanLeavesFor(evaluation) {
  return new Map(Object.entries(evaluation.humanReviewAggregate?.leaves || [])
    .filter(([, leaf]) => leaf.status === 'resolved')
    .map(([id, leaf]) => [id, {
      score: score(leaf.score, 'human leaf score'),
      scores: Array.isArray(leaf.values) ? leaf.values : [leaf.score]
    }]));
}

function objectiveLeaf(evaluation, leafId) {
  const metric = evaluation.objectiveCapability?.metrics?.find((item) => item.id === leafId);
  if (!metric || typeof metric.applicable !== 'boolean') {
    throw new TypeError(`objective metric is incomplete: ${leafId}`);
  }
  if (!metric.applicable) return { applicable: false };
  if (!Number.isFinite(metric.score)) throw new TypeError(`objective metric is incomplete: ${leafId}`);
  return {
    applicable: true,
    score: score(metric.score, 'objective metric score'),
    evidenceIds: Array.isArray(metric.evidenceIds) ? metric.evidenceIds : []
  };
}

function leafConfidence(evaluation, id, model, human, objective) {
  const checks = new Map();
  for (const item of model.checkEvidence) {
    const ids = checks.get(item.checkId) || [];
    checks.set(item.checkId, [...ids, ...(item.evidenceIds || [])]);
  }
  for (const review of evaluation.humanReviews || []) {
    for (const item of review.scores?.[id]?.checkEvidence || []) {
      const ids = checks.get(item.checkId) || [];
      checks.set(item.checkId, [...ids, ...(item.evidenceIds || [])]);
    }
  }
  if (objective) checks.set(`objective:${id}`, objective.evidenceIds);
  const grades = new Map((evaluation.evidenceManifest?.items || []).map((item) => [
    item.evidenceId, item.grade
  ]));
  const normalizedChecks = [...checks].map(([checkId, evidenceIds]) => ({
    id: checkId.replace(/[^A-Za-z0-9_-]/gu, '_'),
    evidenceGrades: evidenceIds.map((evidenceId) => grades.get(evidenceId)).filter(Boolean)
  }));
  return {
    ...computeSubcriterionConfidence({
    stage: 'final',
    checks: normalizedChecks,
    modelScores: model.scores,
    humanScores: human.scores,
    modelConfidences: model.confidences
    }),
    missingCheckIds: normalizedChecks
      .filter((check) => check.evidenceGrades.length === 0)
      .map((check) => check.id)
  };
}

function assertModelLocked(evaluation) {
  const panel = evaluation?.absoluteReview?.modelPanel;
  if (panel?.status !== 'model-locked' || !Array.isArray(panel.primary) ||
      panel.primary.length !== 4) {
    throw conflict('four model seats must be locked before absolute result calculation');
  }
  if (!hasCompletedArbitration(panel)) {
    throw conflict('required fifth-model decisions must be complete');
  }
}

function hasCompletedArbitration(panel) {
  const disputed = panel.disputedSubcriterionIds || [];
  if (!disputed.length) return true;
  const reviews = panel.arbitration?.reviews;
  return Array.isArray(reviews) &&
    sameMembers(reviews.map((review) => review?.subcriterionId), disputed) &&
    reviews.every((review) => Number.isFinite(review.score) &&
      review.score >= 0 && review.score <= 100 &&
      Number.isFinite(review.confidence) &&
      review.confidence >= 0 && review.confidence <= 1);
}

function assertHumanReviewComplete(evaluation) {
  if (evaluation.humanReviewAggregate?.status !== 'complete' ||
      (evaluation.governance?.arbitrationRequired || []).length > 0) {
    throw conflict('human arbitration and aggregation must be complete before absolute lock');
  }
  // Human review may be skipped (synthesized from the locked model panel) or
  // finalized from a single open submission; either path already produced a
  // complete aggregate above, so no further reviewer count is required.
  if (evaluation.governance?.humanReviewSkipped === true) return;
  const submittedPrimary = (evaluation.humanReviews || []).filter((review) =>
    review.role === 'primary' && review.status === 'submitted'
  );
  if (new Set(submittedPrimary.map((review) => review.judgeId)).size < 1) {
    throw conflict('at least one completed primary human review is required');
  }
}

function assertRubric(rubric) {
  if (!rubric || rubric.version !== RUBRIC_V1.version ||
      !rubric.dimensions || !rubric.seatWeights) {
    throw new TypeError('absolute result requires a2a-black-box-v1 rubric');
  }
}

function weightedMean(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) throw new TypeError('applicable leaf weight must be positive');
  return items.reduce((sum, item) => sum + item.weight * item.value, 0) / total;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function score(value, name, maximum = 100) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be within 0..${maximum}`);
  }
  return value;
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
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  return value;
}

function assertIso(value, name) {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
}

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function sameMembers(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((item) => expected.includes(item));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
