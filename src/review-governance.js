import { createHash, randomUUID } from 'node:crypto';

const PHASES = new Set([
  'waiting_model', 'human_open', 'human_arbitration', 'absolute_locked',
  'replica_released', 'final'
]);
const ROLES = new Set(['primary', 'arbitrator']);

export function advanceGovernance(evaluation) {
  assertEvaluation(evaluation);
  const panel = evaluation.absoluteReview?.modelPanel;
  if (!modelReviewComplete(panel)) {
    throw conflict('four valid model reviews and required fifth-model decisions are required');
  }
  if (evaluation.governance.phase === 'waiting_model') {
    transition(evaluation, 'human_open', 'system');
  }
  return evaluation;
}

export function assignHumanReviewer(evaluation, principal, role, scope) {
  assertEvaluation(evaluation);
  const judgeId = requiredId(principal?.principalId, 'judge');
  if (!ROLES.has(role)) throw validation('unsupported reviewer role');
  advanceGovernance(evaluation);
  const leaves = applicableLeaves(evaluation);
  const expectedScope = role === 'primary'
    ? leaves
    : arbitrationLeaves(evaluation);
  if (role === 'primary' && evaluation.governance.phase !== 'human_open') {
    throw conflict('primary assignments are unavailable during arbitration');
  }
  if (role === 'arbitrator' && evaluation.governance.phase !== 'human_arbitration') {
    throw conflict('arbitrator assignments require human arbitration');
  }
  if (!sameMembers(scope, expectedScope)) {
    throw validation('assignment scope must contain every and only applicable leaf');
  }
  const assignments = assignmentsOf(evaluation);
  if (role === 'primary' && assignments.filter(
    (assignment) => assignment.role === 'primary' && assignment.status !== 'recused'
  ).length >= 2) {
    throw conflict('only two primary reviewers may be assigned');
  }
  if (assignments.some((assignment) =>
    assignment.judgeId === judgeId && assignment.role === 'primary'
  )) {
    throw conflict('a judge cannot hold two primary assignments');
  }
  if (role === 'arbitrator' && assignments.some((assignment) =>
    assignment.judgeId === judgeId && assignment.role === 'primary'
  )) {
    throw conflict('a primary judge cannot arbitrate the same evaluation');
  }
  const assignment = {
    assignmentId: `assignment_${randomUUID().replaceAll('-', '')}`,
    evaluationId: evaluation.id,
    judgeId,
    role,
    criterionScope: [...expectedScope],
    status: 'assigned',
    assignedAt: new Date().toISOString(),
    submittedAt: null,
    revision: 0
  };
  assignments.push(assignment);
  appendAudit(evaluation, 'review-assigned', judgeId, {
    assignmentId: assignment.assignmentId,
    role,
    criterionScope: assignment.criterionScope
  });
  return assignment;
}

export function saveHumanDraft(evaluation, assignment, payload, expectedRevision) {
  const current = assertAssignment(evaluation, assignment);
  if (current.status === 'submitted') throw conflict('submitted reviews are immutable');
  if (current.status === 'recused') throw conflict('recused assignments cannot be drafted');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
    throw conflict('assignment revision conflict');
  }
  const scores = normalizeScores(evaluation, current, payload);
  const reviews = reviewsOf(evaluation);
  const existing = reviews.find((review) => review.assignmentId === current.assignmentId);
  const review = {
    reviewId: existing?.reviewId || `review_${randomUUID().replaceAll('-', '')}`,
    assignmentId: current.assignmentId,
    judgeId: current.judgeId,
    role: current.role,
    status: 'draft',
    rubricVersion: 'a2a-black-box-v1',
    scores,
    submittedAt: null,
    payloadHash: payloadHash({ scores })
  };
  replaceReview(reviews, review);
  current.status = 'draft';
  current.revision += 1;
  appendAudit(evaluation, 'review-drafted', current.judgeId, {
    assignmentId: current.assignmentId,
    revision: current.revision,
    payloadHash: review.payloadHash
  });
  return current;
}

export function submitHumanReview(evaluation, assignment, payload) {
  const current = assertAssignment(evaluation, assignment);
  if (current.status === 'submitted') throw conflict('submitted reviews are immutable');
  if (current.status === 'recused') throw conflict('recused assignments cannot be submitted');
  const scores = normalizeScores(evaluation, current, payload);
  const reviews = reviewsOf(evaluation);
  const review = {
    reviewId: reviews.find((item) => item.assignmentId === current.assignmentId)?.reviewId ||
      `review_${randomUUID().replaceAll('-', '')}`,
    assignmentId: current.assignmentId,
    judgeId: current.judgeId,
    role: current.role,
    status: 'submitted',
    rubricVersion: 'a2a-black-box-v1',
    scores,
    submittedAt: new Date().toISOString(),
    payloadHash: payloadHash({ scores })
  };
  replaceReview(reviews, review);
  current.status = 'submitted';
  current.submittedAt = review.submittedAt;
  current.revision += 1;
  appendAudit(evaluation, 'review-submitted', current.judgeId, {
    assignmentId: current.assignmentId,
    payloadHash: review.payloadHash
  });
  aggregateHumanReviews(evaluation);
  return review;
}

export function aggregateHumanReviews(evaluation) {
  assertEvaluation(evaluation);
  const leaves = applicableLeaves(evaluation);
  const submitted = reviewsOf(evaluation).filter((review) => review.status === 'submitted');
  const primary = submitted.filter((review) => review.role === 'primary');
  const aggregate = { leaves: {}, status: 'pending' };
  if (primary.length < 2) {
    evaluation.humanReviewAggregate = aggregate;
    return aggregate;
  }
  if (new Set(primary.map((review) => review.judgeId)).size !== primary.length) {
    throw conflict('primary reviewers must be distinct');
  }
  const disputes = [];
  for (const criterionId of leaves) {
    const values = primary
      .map((review) => review.scores[criterionId]?.score)
      .filter(Number.isFinite);
    if (values.length !== 2) continue;
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > 15) {
      disputes.push(criterionId);
      aggregate.leaves[criterionId] = { status: 'arbitration-required', values, spread };
      continue;
    }
    aggregate.leaves[criterionId] = { status: 'resolved', values, spread, score: median(values) };
  }
  if (disputes.length) {
    const prior = evaluation.governance.arbitrationRequired || [];
    evaluation.governance.arbitrationRequired = disputes;
    if (!sameMembers(prior, disputes)) {
      appendAudit(evaluation, 'human-arbitration-triggered', 'system', { criterionScope: disputes });
    }
    if (evaluation.governance.phase !== 'human_arbitration') {
      transition(evaluation, 'human_arbitration', 'system');
    }
    const arbitrators = submitted.filter((review) => review.role === 'arbitrator');
    for (const criterionId of disputes) {
      const value = arbitrators
        .map((review) => review.scores[criterionId]?.score)
        .find(Number.isFinite);
      if (Number.isFinite(value)) {
        const primaryValues = primary.map((review) => review.scores[criterionId].score);
        aggregate.leaves[criterionId] = {
          status: 'resolved',
          values: [...primaryValues, value],
          spread: Math.max(...primaryValues) - Math.min(...primaryValues),
          score: median([...primaryValues, value])
        };
      }
    }
    if (disputes.every((criterionId) => aggregate.leaves[criterionId].status === 'resolved')) {
      evaluation.governance.arbitrationRequired = [];
      transition(evaluation, 'human_open', 'system');
      aggregate.status = 'complete';
    } else {
      aggregate.status = 'arbitration-required';
    }
  } else {
    aggregate.status = 'complete';
  }
  evaluation.humanReviewAggregate = aggregate;
  return aggregate;
}

export function recuseHumanReviewer(evaluation, assignment) {
  const current = assertAssignment(evaluation, assignment);
  if (current.status === 'submitted') throw conflict('submitted reviews are immutable');
  current.status = 'recused';
  current.revision += 1;
  appendAudit(evaluation, 'review-recused', current.judgeId, {
    assignmentId: current.assignmentId
  });
  return current;
}

export function assignmentEtag(assignment) {
  return `W/"assignment:${assignment.assignmentId}:${assignment.revision}"`;
}

function modelReviewComplete(panel) {
  if (!panel || panel.status !== 'model-locked' || !Array.isArray(panel.primary) ||
      panel.primary.length !== 4) return false;
  const leaves = panel.primary[0]?.reviews?.map((review) => review.subcriterionId) || [];
  if (!leaves.length || new Set(leaves).size !== leaves.length) return false;
  if (!panel.primary.every((run) => Array.isArray(run.reviews) &&
      sameMembers(run.reviews.map((review) => review.subcriterionId), leaves))) return false;
  const disputed = Array.isArray(panel.disputedSubcriterionIds)
    ? panel.disputedSubcriterionIds
    : [];
  return disputed.length === 0 || (panel.arbitration &&
    sameMembers(panel.arbitration.reviews?.map((review) => review.subcriterionId), disputed));
}

function applicableLeaves(evaluation) {
  const leaves = evaluation.absoluteReview?.modelPanel?.primary?.[0]?.reviews
    ?.map((review) => review.subcriterionId) || [];
  if (!leaves.length) throw validation('no applicable model review leaves');
  return leaves;
}

function arbitrationLeaves(evaluation) {
  const leaves = evaluation.governance?.arbitrationRequired || [];
  if (!leaves.length) throw conflict('no leaves require human arbitration');
  return leaves;
}

function normalizeScores(evaluation, assignment, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !payload.scores || typeof payload.scores !== 'object' || Array.isArray(payload.scores)) {
    throw validation('review payload must contain scores');
  }
  for (const forbidden of ['total', 'weight', 'weights', 'applicability', 'applicable']) {
    if (Object.hasOwn(payload, forbidden)) throw validation(`client-supplied ${forbidden} is forbidden`);
  }
  const scoreIds = Object.keys(payload.scores);
  if (!sameMembers(scoreIds, assignment.criterionScope)) {
    throw validation('scores must contain every and only assigned leaf');
  }
  const validEvidence = new Set((evaluation.evidenceManifest?.items || [])
    .filter((item) => !/(?:replica|runtime|arena)/iu.test([
      item.evidenceId, item.runId, item.kind, item.testId
    ].join(':')))
    .map((item) => item.evidenceId));
  const expectedChecks = checksByLeaf(evaluation);
  return Object.fromEntries(assignment.criterionScope.map((criterionId) => {
    const score = payload.scores[criterionId];
    if (!score || typeof score !== 'object' || Array.isArray(score) ||
        !Number.isFinite(score.score) || score.score < 0 || score.score > 100) {
      throw validation('score must be between 0 and 100');
    }
    const evidenceIds = evidenceIdsFor(score.evidenceIds, validEvidence);
    if (typeof score.rationale !== 'string' || !score.rationale.trim()) {
      throw validation('rationale is required');
    }
    if (!['affirm', 'modify', 'overturn'].includes(score.modelDisposition)) {
      throw validation('unsupported model disposition');
    }
    const checkEvidence = normalizeCheckEvidence(
      score.checkEvidence, expectedChecks.get(criterionId) || [], validEvidence
    );
    const overrideReason = typeof score.overrideReason === 'string' ? score.overrideReason.trim() : '';
    if (score.modelDisposition === 'overturn' && (!overrideReason || !evidenceIds.length)) {
      throw validation('overturn requires an override reason and evidence');
    }
    return [criterionId, {
      score: score.score,
      evidenceIds,
      checkEvidence,
      rationale: score.rationale.trim(),
      modelDisposition: score.modelDisposition,
      overrideReason
    }];
  }));
}

function checksByLeaf(evaluation) {
  const checks = new Map();
  for (const review of evaluation.absoluteReview.modelPanel.primary[0].reviews) {
    checks.set(review.subcriterionId, (review.checkEvidence || []).map((item) => item.checkId));
  }
  return checks;
}

function normalizeCheckEvidence(value, expected, allowedEvidence) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw validation('checkEvidence must contain every applicable check');
  }
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || !expected.includes(item.checkId) || seen.has(item.checkId)) {
      throw validation('checkEvidence contains an unknown or duplicate check');
    }
    seen.add(item.checkId);
    return { checkId: item.checkId, evidenceIds: evidenceIdsFor(item.evidenceIds, allowedEvidence) };
  });
}

function evidenceIdsFor(value, allowed) {
  if (!Array.isArray(value)) throw validation('evidenceIds must be an array');
  const values = [...new Set(value)];
  if (values.some((evidenceId) => typeof evidenceId !== 'string' || !allowed.has(evidenceId))) {
    throw validation('foreign or invisible evidence ID');
  }
  return values;
}

function assignmentsOf(evaluation) {
  if (!Array.isArray(evaluation.reviewAssignments)) evaluation.reviewAssignments = [];
  return evaluation.reviewAssignments;
}

function reviewsOf(evaluation) {
  if (!Array.isArray(evaluation.humanReviews)) evaluation.humanReviews = [];
  return evaluation.humanReviews;
}

function assertAssignment(evaluation, assignment) {
  assertEvaluation(evaluation);
  const current = assignmentsOf(evaluation).find((item) =>
    item.assignmentId === assignment?.assignmentId
  );
  if (!current) throw validation('assignment does not belong to this evaluation');
  return current;
}

function replaceReview(reviews, review) {
  const index = reviews.findIndex((item) => item.assignmentId === review.assignmentId);
  if (index === -1) reviews.push(review);
  else reviews[index] = review;
}

function appendAudit(evaluation, type, actorId, payload) {
  if (!Array.isArray(evaluation.auditEvents)) evaluation.auditEvents = [];
  const previous = evaluation.auditEvents.at(-1)?.eventHash || null;
  const event = {
    eventId: `audit_${randomUUID().replaceAll('-', '')}`,
    type,
    actorId,
    at: new Date().toISOString(),
    payloadHash: payloadHash(payload),
    previousEventHash: previous
  };
  event.eventHash = payloadHash(event);
  evaluation.auditEvents.push(event);
  return event;
}

function transition(evaluation, phase, actorId) {
  if (!PHASES.has(phase)) throw validation('unsupported governance phase');
  const previous = evaluation.governance?.phase;
  if (!evaluation.governance) evaluation.governance = { phase };
  else evaluation.governance.phase = phase;
  appendAudit(evaluation, 'governance-phase-transition', actorId, { from: previous, to: phase });
}

function payloadHash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
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

function assertEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== 'object' || !PHASES.has(evaluation.governance?.phase)) {
    throw validation('evaluation has an invalid governance state');
  }
}

function validation(message) {
  return Object.assign(new TypeError(message), { statusCode: 422 });
}

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}
