import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAbsoluteResult,
  combineCapability,
  combineScenarioOrProfessional,
  lockAbsoluteResult
} from '../src/result-v2.js';
import { RUBRIC_V1 } from '../src/rubric.js';

const MODEL_SCORE = 70;
const HUMAN_SCORE = 80;
const OBJECTIVE_SCORE = 90;

test('combines fixed score seats without trusting client totals', () => {
  assert.equal(
    combineScenarioOrProfessional({ model: MODEL_SCORE, human: HUMAN_SCORE }),
    76
  );
  assert.equal(
    combineCapability({
      objective: OBJECTIVE_SCORE,
      model: MODEL_SCORE,
      human: HUMAN_SCORE
    }),
    83
  );

  const result = calculateAbsoluteResult(completeEvaluation(), RUBRIC_V1);
  assert.equal(result.dimensions.scenarioValue.score, 76);
  assert.equal(result.dimensions.professionalism.score, 76);
  assert.equal(result.dimensions.agentCapability.score, 83);
  assert.equal(result.total, 235 / 3);
  assert.equal(Object.hasOwn(result, 'replica'), false);
  assert.equal(result.dimensions.agentCapability.objectiveCoverage, 0.8);
  assert.equal(result.dimensions.agentCapability.provisional, false);
});

test('locks a canonical absolute result once and rejects a different idempotent payload', () => {
  const evaluation = completeEvaluation();
  const result = calculateAbsoluteResult(evaluation, RUBRIC_V1, {
    now: () => '2026-07-25T12:00:00.000Z'
  });
  const actor = { principalId: 'admin_1', idempotencyKey: 'absolute-lock-1' };

  const locked = lockAbsoluteResult(evaluation, result, actor);
  assert.equal(locked.status, 'locked');
  assert.equal(locked.resultHash.length, 64);
  assert.equal(evaluation.governance.phase, 'absolute_locked');
  assert.equal(evaluation.governance.absoluteLockedAt, result.lockedAt);
  assert.equal(evaluation.governance.resultHash, locked.resultHash);
  assert.equal(evaluation.resultV2.absolute, locked);
  assert.equal(evaluation.auditEvents.at(-1).type, 'absolute-result-locked');
  assert.throws(() => {
    locked.dimensions.scenarioValue.score = 0;
  }, TypeError);

  assert.strictEqual(lockAbsoluteResult(evaluation, result, actor), locked);
  assert.throws(
    () => lockAbsoluteResult(evaluation, { ...result, total: 0 }, actor),
    /idempotency|payload|lock/i
  );
});

test('refuses an absolute lock until the model and human seats are complete', () => {
  const evaluation = completeEvaluation();
  const result = calculateAbsoluteResult(evaluation, RUBRIC_V1);

  evaluation.humanReviewAggregate.status = 'arbitration-required';
  assert.throws(
    () => lockAbsoluteResult(evaluation, result, {
      principalId: 'admin_1',
      idempotencyKey: 'absolute-lock-1'
    }),
    /human|arbitration|complete/i
  );
});

function completeEvaluation() {
  const leaves = Object.entries(RUBRIC_V1.dimensions).flatMap(([dimensionId, weights]) =>
    Object.keys(weights).map((leafId) => `${dimensionId}.${leafId}`)
  );
  const primary = Array.from({ length: 4 }, (_, index) => ({
    reviewRunId: `model_${index}`,
    reviews: leaves.map((subcriterionId) => ({
      subcriterionId,
      score: MODEL_SCORE,
      confidence: 0.8,
      checkEvidence: [{
        checkId: `${subcriterionId}:check`,
        evidenceIds: ['ev_a']
      }]
    }))
  }));
  return {
    id: 'eval_result_v2',
    governance: {
      phase: 'human_open',
      modelLockedAt: '2026-07-25T11:00:00.000Z',
      rubricHash: 'rubric-hash',
      configHash: 'config-hash'
    },
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
    reviewAssignments: [
      { assignmentId: 'assignment_1', judgeId: 'judge_1', role: 'primary', status: 'submitted' },
      { assignmentId: 'assignment_2', judgeId: 'judge_2', role: 'primary', status: 'submitted' }
    ],
    humanReviews: [
      { assignmentId: 'assignment_1', judgeId: 'judge_1', role: 'primary', status: 'submitted' },
      { assignmentId: 'assignment_2', judgeId: 'judge_2', role: 'primary', status: 'submitted' }
    ],
    resultV2: {
      absolute: { status: 'model-provisional' },
      replica: { status: 'sealed' },
      rating: { status: 'pending-human' }
    },
    auditEvents: []
  };
}
