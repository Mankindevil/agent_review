import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REPLICA_REVIEW_POLICY,
  getReplicaReviewPolicy,
  isReplicaReviewPolicyFrozen,
  lockReplicaHumanReview,
  setReplicaReviewPolicy,
  submitReplicaHumanReview
} from '../src/replica-human-review.js';

function sealedEvaluation({ runtimeSummaries = [{ runtimeId: 'alpha', validity: 'valid' }] } = {}) {
  return {
    id: 'eval_replica_human',
    governance: {},
    replicaArena: { status: 'sealed', runtimeSummaries },
    humanReviews: [],
    auditEvents: []
  };
}

function submissionPayload({ submitted = 80, replicaAlpha = 60, rationale } = {}) {
  const scoreFor = (total) => ({
    taskConstraint: total,
    professionalQuality: total,
    evidenceRisk: total,
    artifactUsability: total
  });
  return {
    scores: {
      submitted: scoreFor(submitted),
      'replica:alpha': scoreFor(replicaAlpha)
    },
    ...(rationale !== undefined ? { rationale } : {})
  };
}

test('policy defaults are applied and persisted the first time they are read', () => {
  const evaluation = sealedEvaluation();
  assert.equal(evaluation.governance.replicaReviewPolicy, undefined);
  const policy = getReplicaReviewPolicy(evaluation);
  assert.deepEqual(policy, DEFAULT_REPLICA_REVIEW_POLICY);
  assert.deepEqual(evaluation.governance.replicaReviewPolicy, DEFAULT_REPLICA_REVIEW_POLICY);
});

test('setReplicaReviewPolicy validates the visibility enum and field types', () => {
  const evaluation = sealedEvaluation();
  const principal = { principalId: 'admin_1' };
  assert.throws(
    () => setReplicaReviewPolicy(evaluation, principal, { visibility: 'not-real' }),
    /visibility/i
  );
  assert.throws(
    () => setReplicaReviewPolicy(evaluation, principal, { requiredPrimaries: 0 }),
    /requiredPrimaries/i
  );
  assert.throws(
    () => setReplicaReviewPolicy(evaluation, principal, { forceSeparateJudges: 'yes' }),
    /forceSeparateJudges/i
  );
  const policy = setReplicaReviewPolicy(evaluation, principal, {
    visibility: 'open',
    requiredPrimaries: 2,
    forceSeparateJudges: true
  });
  assert.deepEqual(policy, { visibility: 'open', requiredPrimaries: 2, forceSeparateJudges: true });
  assert.deepEqual(evaluation.governance.replicaReviewPolicy, policy);
});

test('policy is frozen after the first replica-human submission', () => {
  const evaluation = sealedEvaluation();
  assert.equal(isReplicaReviewPolicyFrozen(evaluation), false);
  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload());
  assert.equal(isReplicaReviewPolicyFrozen(evaluation), true);
  assert.throws(
    () => setReplicaReviewPolicy(evaluation, { principalId: 'admin_1' }, { requiredPrimaries: 2 }),
    /frozen/i
  );
});

test('submit requires scores for submitted plus every valid replica and recomputes the total server-side', () => {
  const evaluation = sealedEvaluation();
  const review = submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload({
    submitted: 80,
    replicaAlpha: 60
  }));
  assert.equal(review.role, 'replica_primary');
  assert.equal(review.status, 'submitted');
  assert.equal(review.scores.submitted.total, 80);
  assert.equal(review.scores['replica:alpha'].total, 60);
  assert.equal(evaluation.replicaHumanReviews.length, 1);
  assert.equal(evaluation.auditEvents.at(-1).type, 'replica-human-review-submitted');
});

test('server ignores a client-supplied total and ignores invalid replicas', () => {
  const evaluation = sealedEvaluation({
    runtimeSummaries: [
      { runtimeId: 'alpha', validity: 'valid' },
      { runtimeId: 'beta', validity: 'infrastructure-failed' }
    ]
  });
  assert.throws(() => submitReplicaHumanReview(evaluation, { principalId: 'p1' }, {
    scores: {
      submitted: { taskConstraint: 10, professionalQuality: 10, evidenceRisk: 10, artifactUsability: 10, total: 999 },
      'replica:alpha': { taskConstraint: 10, professionalQuality: 10, evidenceRisk: 10, artifactUsability: 10 }
    }
  }), /total/i);
  assert.throws(() => submitReplicaHumanReview(evaluation, { principalId: 'p1' }, {
    scores: {
      submitted: { taskConstraint: 10, professionalQuality: 10, evidenceRisk: 10, artifactUsability: 10 },
      'replica:alpha': { taskConstraint: 10, professionalQuality: 10, evidenceRisk: 10, artifactUsability: 10 },
      'replica:beta': { taskConstraint: 10, professionalQuality: 10, evidenceRisk: 10, artifactUsability: 10 }
    }
  }), /required sources/i);
});

test('rejects a duplicate submission from the same principal', () => {
  const evaluation = sealedEvaluation();
  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload());
  assert.throws(
    () => submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload()),
    /already submitted/i
  );
});

test('accepts an optional short rationale', () => {
  const evaluation = sealedEvaluation();
  const review = submitReplicaHumanReview(
    evaluation,
    { principalId: 'p1' },
    submissionPayload({ rationale: '  Clear win on constraint handling.  ' })
  );
  assert.equal(review.rationale, 'Clear win on constraint handling.');
});

test('requiredPrimaries=1 locks after a single primary submission', () => {
  const evaluation = sealedEvaluation();
  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload());
  const actor = { principalId: 'admin_1', idempotencyKey: 'lock-1' };
  const locked = lockReplicaHumanReview(evaluation, actor);
  assert.equal(locked.status, 'locked');
  assert.equal(locked.composites.submitted, 80);
  assert.equal(locked.composites['replica:alpha'], 60);
  assert.equal(typeof locked.receiptHash, 'string');
  assert.equal(evaluation.governance.replicaHumanLockedAt, locked.lockedAt);
  assert.equal(evaluation.governance.absoluteLockedAt, undefined);
  assert.throws(() => {
    evaluation.replicaHumanReviewAggregate.status = 'mutated';
  }, TypeError);
});

test('lock is idempotent for the same key and rejects a different idempotency payload', () => {
  const evaluation = sealedEvaluation();
  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload());
  const actor = { principalId: 'admin_1', idempotencyKey: 'lock-1' };
  const first = lockReplicaHumanReview(evaluation, actor);
  const second = lockReplicaHumanReview(evaluation, actor);
  assert.equal(first, second);
  assert.throws(
    () => lockReplicaHumanReview(evaluation, { ...actor, idempotencyKey: 'lock-2' }),
    /idempotency|payload|lock/i
  );
});

test('lock fails before requiredPrimaries submissions are in', () => {
  const evaluation = sealedEvaluation();
  setReplicaReviewPolicy(evaluation, { principalId: 'admin_1' }, { requiredPrimaries: 2 });
  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload());
  assert.throws(
    () => lockReplicaHumanReview(evaluation, { principalId: 'admin_1', idempotencyKey: 'lock-1' }),
    /at least 2/i
  );
});

test('submit rejects once the replica-human track is locked', () => {
  const evaluation = sealedEvaluation();
  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload());
  lockReplicaHumanReview(evaluation, { principalId: 'admin_1', idempotencyKey: 'lock-1' });
  assert.throws(
    () => submitReplicaHumanReview(evaluation, { principalId: 'p2' }, submissionPayload()),
    /already locked/i
  );
});

test('forceSeparateJudges rejects a principal who already submitted on the absolute human track', () => {
  const evaluation = sealedEvaluation();
  evaluation.humanReviews.push({ judgeId: 'p1', status: 'submitted' });
  setReplicaReviewPolicy(evaluation, { principalId: 'admin_1' }, { forceSeparateJudges: true });
  assert.throws(
    () => submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload()),
    /forceSeparateJudges|separate/i
  );
});

test('forceSeparateJudges does not block a principal absent from the absolute track', () => {
  const evaluation = sealedEvaluation();
  evaluation.humanReviews.push({ judgeId: 'someone-else', status: 'submitted' });
  setReplicaReviewPolicy(evaluation, { principalId: 'admin_1' }, { forceSeparateJudges: true });
  const review = submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload());
  assert.equal(review.principalId, 'p1');
});

test('open-review style: any principal may submit and defaults to role replica_primary', () => {
  const evaluation = sealedEvaluation();
  const review = submitReplicaHumanReview(evaluation, { principalId: 'anyone' }, submissionPayload());
  assert.equal(review.role, 'replica_primary');
});

test('requiredPrimaries=2 with a >15 spread requires a replica_arbitrator submission before lock', () => {
  const evaluation = sealedEvaluation();
  setReplicaReviewPolicy(evaluation, { principalId: 'admin_1' }, { requiredPrimaries: 2 });
  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload({ submitted: 90, replicaAlpha: 60 }));
  submitReplicaHumanReview(evaluation, { principalId: 'p2' }, submissionPayload({ submitted: 70, replicaAlpha: 55 }));

  const actor = { principalId: 'admin_1', idempotencyKey: 'lock-1' };
  assert.throws(() => lockReplicaHumanReview(evaluation, actor), /arbitrator/i);

  const arbitratorReview = submitReplicaHumanReview(
    evaluation,
    { principalId: 'p3' },
    submissionPayload({ submitted: 82, replicaAlpha: 58 })
  );
  assert.equal(arbitratorReview.role, 'replica_arbitrator');

  const locked = lockReplicaHumanReview(evaluation, actor);
  assert.equal(locked.status, 'locked');
  assert.equal(locked.composites.submitted, 82);
});

test('requiredPrimaries=2 with an acceptable spread locks without an arbitrator', () => {
  const evaluation = sealedEvaluation();
  setReplicaReviewPolicy(evaluation, { principalId: 'admin_1' }, { requiredPrimaries: 2 });
  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload({ submitted: 80, replicaAlpha: 60 }));
  submitReplicaHumanReview(evaluation, { principalId: 'p2' }, submissionPayload({ submitted: 85, replicaAlpha: 62 }));

  const locked = lockReplicaHumanReview(evaluation, { principalId: 'admin_1', idempotencyKey: 'lock-1' });
  assert.equal(locked.status, 'locked');
  assert.equal(locked.composites.submitted, 82.5);
});

test('submission requires a sealed Replica Arena', () => {
  const evaluation = sealedEvaluation();
  evaluation.replicaArena = { status: 'disabled' };
  assert.throws(
    () => submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload()),
    /sealed/i
  );
});

test('does not require absolute_locked before replica-human scoring', () => {
  const evaluation = sealedEvaluation();
  evaluation.governance = { phase: 'human_open' };
  const review = submitReplicaHumanReview(evaluation, { principalId: 'p1' }, submissionPayload());
  assert.equal(review.status, 'submitted');
  const locked = lockReplicaHumanReview(evaluation, { principalId: 'admin_1', idempotencyKey: 'lock-1' });
  assert.equal(locked.status, 'locked');
  assert.equal(evaluation.governance.phase, 'human_open');
});
