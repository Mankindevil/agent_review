import test from 'node:test';
import assert from 'node:assert/strict';
import { lockAbsoluteResult } from '../src/result-v2.js';
import { finalizeDualTrack } from '../src/arena-release.js';
import { lockReplicaHumanReview, submitReplicaHumanReview } from '../src/replica-human-review.js';
import { RUBRIC_V1 } from '../src/rubric.js';

const MODEL_SCORE = 70;
const HUMAN_SCORE = 80;
const OBJECTIVE_SCORE = 90;
const ABSOLUTE_LOCK_ACTOR = { principalId: 'admin_1', idempotencyKey: 'abs-lock-1' };
const FINALIZE_ACTOR = { principalId: 'admin_1', idempotencyKey: 'finalize-1' };

function completeEvaluation({
  runtimeSummaries = [{ runtimeId: 'alpha', validity: 'valid' }],
  repeatCount = 1
} = {}) {
  const leaves = Object.entries(RUBRIC_V1.dimensions).flatMap(([dimensionId, weights]) =>
    Object.keys(weights).map((leafId) => `${dimensionId}.${leafId}`)
  );
  const primary = Array.from({ length: 4 }, (_, index) => ({
    reviewRunId: `model_${index}`,
    reviews: leaves.map((subcriterionId) => ({
      subcriterionId,
      score: MODEL_SCORE,
      confidence: 0.8,
      checkEvidence: [{ checkId: `${subcriterionId}:check`, evidenceIds: ['ev_a'] }],
      findings: [{
        findingId: `finding_model_${index}_${subcriterionId.replace('.', '_')}_0`,
        text: 'Captured evidence supports only a partial, reusable workflow.'
      }],
      repairSuggestion: 'Make the workflow and its evidence links explicit.'
    }))
  }));
  const testRuns = Array.from({ length: repeatCount }, (_, repeatIndex) => ({
    testId: 'test_1',
    repeatIndex,
    runs: [{ response: { currentOutput: { text: `Submitted output ${repeatIndex}.`, data: null, artifacts: [] } } }]
  }));
  const turns = {};
  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    turns[`alpha:test_1:${repeatIndex}:0`] = {
      runtimeId: 'alpha',
      testId: 'test_1',
      repeatIndex,
      turnIndex: 0,
      resultCommitment: {
        evidenceId: `ev_alpha_test_1_r${repeatIndex}`,
        recordHash: 'b'.repeat(64)
      }
    };
  }
  return {
    id: 'eval_finalize_dual_track',
    governance: {
      phase: 'human_open',
      modelLockedAt: '2026-07-25T11:00:00.000Z',
      rubricHash: 'rubric-hash',
      configHash: 'config-hash'
    },
    qualification: { status: 'eligible' },
    evidenceManifest: {
      items: [{ evidenceId: 'ev_a', grade: 'A', visibility: 'public' }]
    },
    absoluteReview: {
      modelPanel: {
        status: 'model-locked',
        primary,
        disputedSubcriterionIds: [],
        arbitration: null
      }
    },
    humanReviewAggregate: {
      status: 'complete',
      leaves: Object.fromEntries(leaves.map((subcriterionId) => [
        subcriterionId,
        { status: 'resolved', score: HUMAN_SCORE, values: [HUMAN_SCORE, HUMAN_SCORE] }
      ]))
    },
    objectiveCapability: {
      status: 'complete',
      score: OBJECTIVE_SCORE,
      coverage: 0.8,
      provisional: false,
      metrics: Object.entries(RUBRIC_V1.dimensions.agentCapability).map(([id, weight]) => ({
        id,
        weight,
        applicable: true,
        coverage: 0.8,
        score: OBJECTIVE_SCORE,
        numerator: 0.9,
        denominator: 1,
        evidenceIds: ['ev_a'],
        gaps: []
      }))
    },
    reviewAssignments: [],
    humanReviews: [
      { assignmentId: 'assignment_1', judgeId: 'judge_1', role: 'primary', status: 'submitted' },
      { assignmentId: 'assignment_2', judgeId: 'judge_2', role: 'primary', status: 'submitted' }
    ],
    resultV2: {
      absolute: { status: 'model-provisional' },
      replica: { status: 'sealed' },
      rating: { status: 'pending-human' }
    },
    replicaArena: { status: 'sealed', runtimeSummaries },
    replicaHumanReviews: [],
    testPlan: {
      tests: [{ testId: 'test_1', repeatCount, input: { parts: [{ type: 'text', text: 'Evaluate this.' }] } }]
    },
    phase2Execution: { testRuns },
    replicaCheckpoint: { status: 'sealed', turns },
    auditEvents: []
  };
}

function evidenceVault() {
  return {
    async get(evidenceId) {
      return {
        payload: {
          result: {
            messageParts: [{ type: 'text', text: `Replica output for ${evidenceId}.` }],
            artifacts: []
          }
        }
      };
    },
    async put(record) { return record; }
  };
}

function humanReplicaScores(submitted, replicaAlpha) {
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
    }
  };
}

test('lock absolute leaves rating unsettled when a sealed valid Replica still needs replica-human review', async () => {
  const evaluation = completeEvaluation();
  lockAbsoluteResult(evaluation, undefined, ABSOLUTE_LOCK_ACTOR);

  assert.equal(evaluation.governance.phase, 'absolute_locked');
  assert.equal(evaluation.resultV2.rating.status, 'pending-human');
  assert.equal(Object.hasOwn(evaluation.governance, 'dualTrackFinalizedAt'), false);

  await assert.rejects(
    finalizeDualTrack(evaluation, {}, FINALIZE_ACTOR),
    /replica-human/i
  );
  assert.notEqual(evaluation.governance.phase, 'final');
});

test('finalize merges the human judge channel, changing Δc relative to the model-only cube', async () => {
  const evaluation = completeEvaluation({ repeatCount: 2 });
  lockAbsoluteResult(evaluation, undefined, ABSOLUTE_LOCK_ACTOR);

  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, humanReplicaScores(95, 40));
  lockReplicaHumanReview(evaluation, { principalId: 'admin_1', idempotencyKey: 'replica-lock-1' });

  const modelCube = [
    { testId: 'test_1', repeatIndex: 0, judgeId: 'gpt', scores: { submitted: 80, 'replica:alpha': 60 } },
    { testId: 'test_1', repeatIndex: 1, judgeId: 'gpt', scores: { submitted: 70, 'replica:alpha': 50 } }
  ];
  const result = await finalizeDualTrack(evaluation, {
    evidenceVault: evidenceVault(),
    runAnonymousArena: async () => ({ scoringCube: modelCube })
  }, FINALIZE_ACTOR);

  // Model-only: submittedMedian=median(80,70)=75, replicaMedian=median(60,50)=55, delta=20.
  // Merged with the human channel (95/40 broadcast onto both cells):
  // submittedMedian=median(87.5,82.5)=85, replicaMedian=median(50,45)=47.5, delta=37.5.
  assert.equal(result.replica.submittedMedian, 85);
  assert.equal(result.replica.delta, 37.5);
  assert.notEqual(result.replica.delta, 20);
  assert.equal(evaluation.governance.phase, 'final');
  assert.equal(evaluation.resultV2.replica.status, 'released');
});

test('no valid Replicas finalize directly to 待复刻 without requiring replica-human review', async () => {
  const evaluation = completeEvaluation({
    runtimeSummaries: [{ runtimeId: 'alpha', validity: 'invalid-infrastructure' }]
  });
  lockAbsoluteResult(evaluation, undefined, ABSOLUTE_LOCK_ACTOR);

  const result = await finalizeDualTrack(evaluation, {}, FINALIZE_ACTOR);

  assert.deepEqual(result.rating, {
    status: 'pending-replica',
    code: 'PENDING_REPLICA',
    label: '待复刻'
  });
  assert.equal(result.replica.status, 'unavailable');
  assert.equal(evaluation.governance.phase, 'final');
  assert.equal(evaluation.replicaArena.status, 'unavailable');
});

test('finalize gate: refuses before the absolute lock', async () => {
  const evaluation = completeEvaluation();
  await assert.rejects(
    finalizeDualTrack(evaluation, {}, FINALIZE_ACTOR),
    /absolute.*locked/i
  );
});

test('finalize gate: refuses while a valid Replica still needs a replica-human lock', async () => {
  const evaluation = completeEvaluation();
  lockAbsoluteResult(evaluation, undefined, ABSOLUTE_LOCK_ACTOR);
  await assert.rejects(
    finalizeDualTrack(evaluation, {}, FINALIZE_ACTOR),
    /replica-human/i
  );
  assert.equal(evaluation.governance.phase, 'absolute_locked');
});

test('finalize is idempotent for the same idempotency key and rejects a different one', async () => {
  const evaluation = completeEvaluation({
    runtimeSummaries: [{ runtimeId: 'alpha', validity: 'invalid-infrastructure' }]
  });
  lockAbsoluteResult(evaluation, undefined, ABSOLUTE_LOCK_ACTOR);

  const first = await finalizeDualTrack(evaluation, {}, FINALIZE_ACTOR);
  const second = await finalizeDualTrack(evaluation, {}, FINALIZE_ACTOR);
  assert.deepEqual(first, second);

  await assert.rejects(
    finalizeDualTrack(evaluation, {}, { ...FINALIZE_ACTOR, idempotencyKey: 'finalize-2' }),
    /idempotency|payload|complete/i
  );
});
