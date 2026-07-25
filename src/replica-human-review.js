import { createHash, randomUUID } from 'node:crypto';
import { median } from './statistics.js';

// Same dimension keys/weights as src/arena.js — duplicated here because the
// human replica-quality form scores the same four Arena dimensions but is a
// distinct (human, not model) work product.
const DIMENSION_KEYS = Object.freeze([
  'taskConstraint',
  'professionalQuality',
  'evidenceRisk',
  'artifactUsability'
]);
const SCORE_WEIGHTS = Object.freeze({
  taskConstraint: 0.4,
  professionalQuality: 0.3,
  evidenceRisk: 0.2,
  artifactUsability: 0.1
});

export const REPLICA_REVIEW_VISIBILITIES = Object.freeze([
  'full_blind', 'semi_blind', 'open', 'split_blind'
]);

export const DEFAULT_REPLICA_REVIEW_POLICY = Object.freeze({
  visibility: 'full_blind',
  requiredPrimaries: 1,
  forceSeparateJudges: false
});

const ARBITRATION_SPREAD_THRESHOLD = 15;

/**
 * Returns the evaluation's replica review policy, applying and persisting
 * the defaults the first time it is read if none has been set yet.
 */
export function getReplicaReviewPolicy(evaluation) {
  assertEvaluationObject(evaluation);
  if (!evaluation.governance) evaluation.governance = {};
  if (!evaluation.governance.replicaReviewPolicy) {
    evaluation.governance.replicaReviewPolicy = { ...DEFAULT_REPLICA_REVIEW_POLICY };
  }
  return { ...evaluation.governance.replicaReviewPolicy };
}

/**
 * Sets the replica review policy. Rejected once the policy is frozen, i.e.
 * once the first replica-human review has been submitted.
 */
export function setReplicaReviewPolicy(evaluation, principal, policy) {
  assertEvaluationObject(evaluation);
  const actorId = requiredId(principal?.principalId, 'actor');
  if (isReplicaReviewPolicyFrozen(evaluation)) {
    throw conflict('replica review policy is frozen after the first replica-human submission');
  }
  const normalized = normalizePolicy(policy);
  evaluation.governance = { ...evaluation.governance, replicaReviewPolicy: normalized };
  appendAudit(evaluation, 'replica-review-policy-set', actorId, normalized);
  return { ...normalized };
}

export function isReplicaReviewPolicyFrozen(evaluation) {
  return replicaHumanReviewsOf(evaluation).length > 0;
}

/**
 * Submits a replica-human review scoring `submitted` plus every valid
 * Replica Runtime with the four Arena dimensions. Open-review style: any
 * principal may submit; role defaults to `replica_primary` unless the
 * required primaries are already in and arbitration is outstanding.
 */
export function submitReplicaHumanReview(evaluation, principal, payload) {
  assertEvaluationObject(evaluation);
  const principalId = requiredId(principal?.principalId, 'reviewer');
  if (evaluation.governance?.replicaHumanLockedAt) {
    throw conflict('replica-human review is already locked');
  }
  const policy = getReplicaReviewPolicy(evaluation);
  const requiredSources = requiredSourcesFor(evaluation);
  const reviews = replicaHumanReviewsOf(evaluation);
  if (reviews.some((review) => review.principalId === principalId)) {
    throw conflict('this principal has already submitted a replica-human review');
  }
  if (policy.forceSeparateJudges && absoluteTrackHasPrincipal(evaluation, principalId)) {
    throw conflict('forceSeparateJudges forbids a principal who already submitted on the absolute human track');
  }
  const { scores, rationale } = normalizeSubmissionScores(payload, requiredSources);
  const primaries = reviews.filter((review) => review.role === 'replica_primary');
  const role = resolveSubmissionRole(reviews, primaries, requiredSources, policy);
  const review = {
    reviewId: `replica_review_${randomUUID().replaceAll('-', '')}`,
    principalId,
    role,
    status: 'submitted',
    scores,
    rationale,
    submittedAt: new Date().toISOString()
  };
  review.payloadHash = payloadHash({ scores, rationale });
  reviews.push(review);
  appendAudit(evaluation, 'replica-human-review-submitted', principalId, {
    reviewId: review.reviewId,
    role,
    payloadHash: review.payloadHash
  });
  return review;
}

/**
 * Locks the replica-human track once at least `requiredPrimaries` complete
 * primary submissions cover every required source, and (when
 * `requiredPrimaries >= 2` and any source composite spread exceeds 15) an
 * arbitrator submission has resolved the dispute. Idempotent by
 * `actor.idempotencyKey`.
 */
export function lockReplicaHumanReview(evaluation, actor) {
  assertEvaluationObject(evaluation);
  const actorId = requiredId(actor?.principalId, 'actor');
  const key = requiredText(actor?.idempotencyKey, 'idempotency key');
  const policy = getReplicaReviewPolicy(evaluation);
  const requiredSources = requiredSourcesFor(evaluation);
  const reviews = replicaHumanReviewsOf(evaluation);
  const primaries = reviews.filter((review) => review.role === 'replica_primary');
  assertPrimariesReady(primaries, requiredSources, policy);
  assertArbitrationResolved(reviews, primaries, requiredSources, policy);

  const summary = buildLockSummary(reviews, requiredSources);
  const requestPayloadHash = payloadHash(summary);
  const existingReceipt = evaluation.governance?.replicaHumanLockReceipt;
  if (evaluation.governance?.replicaHumanLockedAt) {
    if (existingReceipt?.key === key && existingReceipt.payloadHash === requestPayloadHash) {
      return evaluation.replicaHumanReviewAggregate;
    }
    throw conflict('replica-human review is already locked with a different idempotency payload');
  }

  const lockedAt = new Date().toISOString();
  const receiptHash = payloadHash({ ...summary, lockedAt });
  const locked = deepFreeze({ ...summary, status: 'locked', lockedAt, receiptHash });

  evaluation.governance = {
    ...evaluation.governance,
    replicaHumanLockedAt: lockedAt,
    replicaHumanLockReceipt: { key, payloadHash: requestPayloadHash, receiptHash }
  };
  evaluation.replicaHumanReviewAggregate = locked;
  appendAudit(evaluation, 'replica-human-review-locked', actorId, {
    receiptHash,
    idempotencyKey: key
  });
  return locked;
}

function resolveSubmissionRole(reviews, primaries, requiredSources, policy) {
  if (primaries.length < policy.requiredPrimaries) return 'replica_primary';
  const needsArbitrator = policy.requiredPrimaries >= 2 &&
    spreadExceeds15(primaries, requiredSources) &&
    !reviews.some((review) => review.role === 'replica_arbitrator');
  return needsArbitrator ? 'replica_arbitrator' : 'replica_primary';
}

function assertPrimariesReady(primaries, requiredSources, policy) {
  if (primaries.length < policy.requiredPrimaries) {
    throw conflict(`at least ${policy.requiredPrimaries} primary replica-human submissions are required before lock`);
  }
  for (const primary of primaries) {
    if (!sameMembers(Object.keys(primary.scores), requiredSources)) {
      throw conflict('every primary replica-human submission must cover all required sources');
    }
  }
}

function assertArbitrationResolved(reviews, primaries, requiredSources, policy) {
  if (policy.requiredPrimaries < 2) return;
  if (!spreadExceeds15(primaries, requiredSources)) return;
  const arbitrator = reviews.find((review) => review.role === 'replica_arbitrator');
  if (!arbitrator || !sameMembers(Object.keys(arbitrator.scores), requiredSources)) {
    throw conflict('a replica arbitrator submission is required before lock because primary composites diverge by more than 15');
  }
}

function spreadExceeds15(primaries, requiredSources) {
  return requiredSources.some((sourceId) => {
    const totals = primaries
      .map((review) => review.scores[sourceId]?.total)
      .filter(Number.isFinite);
    if (totals.length < 2) return false;
    return Math.max(...totals) - Math.min(...totals) > ARBITRATION_SPREAD_THRESHOLD;
  });
}

function buildLockSummary(reviews, requiredSources) {
  const composites = {};
  for (const sourceId of requiredSources) {
    const totals = reviews
      .map((review) => review.scores[sourceId]?.total)
      .filter(Number.isFinite);
    if (!totals.length) throw conflict(`no replica-human score is available for ${sourceId}`);
    composites[sourceId] = median(totals);
  }
  return {
    requiredSources: [...requiredSources],
    reviewIds: reviews.map((review) => review.reviewId),
    composites
  };
}

function normalizeSubmissionScores(payload, requiredSources) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw validation('review payload must be an object');
  }
  const rawScores = payload.scores;
  if (!rawScores || typeof rawScores !== 'object' || Array.isArray(rawScores)) {
    throw validation('review payload must contain scores');
  }
  if (!sameMembers(Object.keys(rawScores), requiredSources)) {
    throw validation('scores must contain every and only the required sources');
  }
  const scores = {};
  for (const sourceId of requiredSources) {
    const entry = rawScores[sourceId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw validation(`scores.${sourceId} must be an object`);
    }
    for (const forbidden of ['total', 'weight', 'weights']) {
      if (Object.hasOwn(entry, forbidden)) throw validation(`client-supplied ${forbidden} is forbidden`);
    }
    const dimensionKeys = Object.keys(entry).filter((key) => key !== 'rationale');
    if (!sameMembers(dimensionKeys, DIMENSION_KEYS)) {
      throw validation(`scores.${sourceId} must contain every Arena dimension`);
    }
    const dimensions = {};
    for (const key of DIMENSION_KEYS) {
      const value = entry[key];
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw validation(`scores.${sourceId}.${key} must be a finite 0-100 number`);
      }
      dimensions[key] = value;
    }
    if (entry.rationale !== undefined && typeof entry.rationale !== 'string') {
      throw validation(`scores.${sourceId}.rationale must be a string`);
    }
    scores[sourceId] = {
      dimensions,
      total: weightedTotal(dimensions),
      ...(typeof entry.rationale === 'string' ? { rationale: entry.rationale.trim() } : {})
    };
  }
  let rationale = '';
  if (payload.rationale !== undefined) {
    if (typeof payload.rationale !== 'string') throw validation('rationale must be a string');
    rationale = payload.rationale.trim();
  }
  return { scores, rationale };
}

function weightedTotal(dimensions) {
  return Number(DIMENSION_KEYS.reduce(
    (total, key) => total + dimensions[key] * SCORE_WEIGHTS[key],
    0
  ).toFixed(6));
}

function requiredSourcesFor(evaluation) {
  const replicaArena = evaluation?.replicaArena;
  if (!replicaArena || replicaArena.status !== 'sealed') {
    throw conflict('replica-human review requires a sealed Replica Arena');
  }
  const validReplicaIds = validReplicaIdsFor(replicaArena);
  return ['submitted', ...validReplicaIds.map((runtimeId) => `replica:${runtimeId}`)];
}

function validReplicaIdsFor(replicaArena) {
  const summaries = Array.isArray(replicaArena.runtimeSummaries) ? replicaArena.runtimeSummaries : [];
  return summaries
    .filter((summary) => summary?.validity === 'valid' && typeof summary.runtimeId === 'string')
    .map((summary) => summary.runtimeId);
}

function absoluteTrackHasPrincipal(evaluation, principalId) {
  return (evaluation.humanReviews || []).some((review) =>
    review.judgeId === principalId && review.status === 'submitted'
  );
}

function normalizePolicy(policy) {
  const input = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
  const visibility = input.visibility ?? DEFAULT_REPLICA_REVIEW_POLICY.visibility;
  if (!REPLICA_REVIEW_VISIBILITIES.includes(visibility)) {
    throw validation('unsupported replica review visibility');
  }
  const requiredPrimaries = input.requiredPrimaries ?? DEFAULT_REPLICA_REVIEW_POLICY.requiredPrimaries;
  if (!Number.isSafeInteger(requiredPrimaries) || requiredPrimaries < 1) {
    throw validation('requiredPrimaries must be a positive integer');
  }
  const forceSeparateJudges = input.forceSeparateJudges ?? DEFAULT_REPLICA_REVIEW_POLICY.forceSeparateJudges;
  if (typeof forceSeparateJudges !== 'boolean') {
    throw validation('forceSeparateJudges must be a boolean');
  }
  return { visibility, requiredPrimaries, forceSeparateJudges };
}

function replicaHumanReviewsOf(evaluation) {
  if (!Array.isArray(evaluation.replicaHumanReviews)) evaluation.replicaHumanReviews = [];
  return evaluation.replicaHumanReviews;
}

function appendAudit(evaluation, type, actorId, payload) {
  if (!Array.isArray(evaluation.auditEvents)) evaluation.auditEvents = [];
  const previousEventHash = evaluation.auditEvents.at(-1)?.eventHash || null;
  const event = {
    eventId: `audit_${randomUUID().replaceAll('-', '')}`,
    type,
    actorId,
    at: new Date().toISOString(),
    payloadHash: payloadHash(payload),
    previousEventHash
  };
  event.eventHash = payloadHash(event);
  evaluation.auditEvents.push(event);
  return event;
}

function payloadHash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sameMembers(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((item) => expected.includes(item));
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value) throw validation(`${label} identity is required`);
  return value;
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value) throw validation(`${field} is required`);
  return value;
}

function assertEvaluationObject(evaluation) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    throw validation('evaluation must be an object');
  }
}

function validation(message) {
  return Object.assign(new TypeError(message), { statusCode: 422 });
}

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}
