import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAbsoluteResult,
  combineCapability,
  combineScenarioOrProfessional,
  lockAbsoluteResult,
  lockAndReleaseAbsoluteResult
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

test('locks only a server-calculated absolute result despite a caller-supplied total', () => {
  const evaluation = completeEvaluation();
  const result = calculateAbsoluteResult(evaluation, RUBRIC_V1, {
    now: () => '2026-07-25T12:00:00.000Z'
  });
  const actor = { principalId: 'admin_1', idempotencyKey: 'absolute-lock-1' };

  const locked = lockAbsoluteResult(evaluation, { ...result, total: 0 }, actor);
  assert.equal(locked.status, 'locked');
  assert.equal(locked.total, 235 / 3);
  assert.equal(locked.resultHash.length, 64);
  assert.equal(evaluation.governance.phase, 'absolute_locked');
  assert.equal(evaluation.governance.absoluteLockedAt, locked.lockedAt);
  assert.equal(evaluation.governance.resultHash, locked.resultHash);
  assert.equal(evaluation.resultV2.absolute, locked);
  assert.equal(evaluation.auditEvents.at(-1).type, 'absolute-result-locked');
  assert.throws(() => {
    locked.dimensions.scenarioValue.score = 0;
  }, TypeError);

  assert.throws(
    () => lockAbsoluteResult(evaluation, { ...result, total: 1 }, actor),
    /idempotency|payload|lock/i
  );
  assert.throws(
    () => lockAbsoluteResult(evaluation, result, {
      ...actor,
      idempotencyKey: 'absolute-lock-2'
    }),
    /idempotency|payload|lock/i
  );
});

test('redistributes objective seat weights when an objective metric is not applicable', () => {
  const evaluation = completeEvaluation();
  const [notApplicable, changed] = evaluation.objectiveCapability.metrics;
  notApplicable.applicable = false;
  notApplicable.score = null;
  changed.score = 60;

  const result = calculateAbsoluteResult(evaluation, RUBRIC_V1);
  const applicableWeight = Object.values(RUBRIC_V1.dimensions.agentCapability)
    .reduce((sum, weight) => sum + weight, 0) - notApplicable.weight;
  const expectedObjective = (
    60 * changed.weight +
    evaluation.objectiveCapability.metrics.slice(2)
      .reduce((sum, metric) => sum + metric.score * metric.weight, 0)
  ) / applicableWeight;

  assert.equal(result.dimensions.agentCapability.seats.objective, expectedObjective);
  assert.equal(
    result.dimensions.agentCapability.leaves['agentCapability.testSuccess'].applicable,
    false
  );
});

test('includes compiled checks without evidence in final evidence gaps', () => {
  const evaluation = completeEvaluation();
  for (const run of evaluation.absoluteReview.modelPanel.primary) {
    run.reviews[0].checkEvidence[0].evidenceIds = [];
    run.reviews[0].checkEvidence.push({
      checkId: 'compiled-but-uncited',
      evidenceIds: []
    });
  }
  for (const review of evaluation.humanReviews) {
    review.scores = {
      'scenarioValue.agentNecessity': {
        checkEvidence: [{ checkId: 'compiled-but-uncited', evidenceIds: [] }]
      }
    };
  }

  const result = calculateAbsoluteResult(evaluation, RUBRIC_V1);
  assert.equal(
    result.dimensions.scenarioValue.leaves['scenarioValue.agentNecessity'].confidence,
    0.46
  );
  assert.equal(result.evidenceGaps.includes('scenarioValue.agentNecessity'), true);
  assert.equal(result.lowConfidenceLeaves.includes('scenarioValue.agentNecessity'), true);
});

test('locks and releases the Replica Arena to final pending status', async () => {
  const evaluation = completeEvaluation();
  evaluation.replicaArena = { status: 'sealed', runtimeSummaries: [] };

  const result = await lockAndReleaseAbsoluteResult(evaluation, {}, {
    principalId: 'admin_1',
    idempotencyKey: 'absolute-lock-release-1'
  });

  assert.equal(result.absolute.status, 'locked');
  assert.equal(result.replica.status, 'unavailable');
  assert.equal(evaluation.governance.phase, 'final');
  assert.equal(evaluation.resultV2.rating.label, '待复刻');
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
      }],
      findings: [{
        findingId: `finding_model_${index}_${subcriterionId.replace('.', '_')}_0`,
        text: 'Captured evidence supports only a partial, reusable workflow.'
      }],
      repairSuggestion: 'Make the workflow and its evidence links explicit.'
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
