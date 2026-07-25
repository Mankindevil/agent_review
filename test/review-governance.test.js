import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceGovernance,
  aggregateHumanReviews,
  assignHumanReviewer,
  saveHumanDraft,
  submitHumanReview
} from '../src/review-governance.js';

const leaves = [
  'scenarioValue.agentNecessity',
  'professionalism.evidenceReasoning'
];

function evaluation() {
  return {
    id: 'eval_governance',
    governance: { phase: 'waiting_model' },
    evidenceManifest: {
      items: [{ evidenceId: 'ev_1', visibility: 'judge' }]
    },
    absoluteReview: {
      modelPanel: {
        status: 'model-locked',
        primary: [0, 1, 2, 3].map((index) => ({
          reviewRunId: `model_${index}`,
          reviews: leaves.map((subcriterionId) => ({
            subcriterionId,
            score: 70,
            checkEvidence: [{
              checkId: `${subcriterionId}:check`,
              evidenceIds: ['ev_1']
            }]
          }))
        })),
        disputedSubcriterionIds: [],
        arbitration: null
      }
    },
    reviewAssignments: [],
    humanReviews: [],
    auditEvents: []
  };
}

function payload(score = 70, disposition = 'modify') {
  return {
    scores: Object.fromEntries(leaves.map((criterionId) => [criterionId, {
      score,
      evidenceIds: ['ev_1'],
      checkEvidence: [{
        checkId: `${criterionId}:check`,
        evidenceIds: ['ev_1']
      }],
      rationale: 'Evidence supports this review.',
      modelDisposition: disposition,
      overrideReason: disposition === 'overturn' ? 'The cited evidence contradicts the model conclusion.' : ''
    }]))
  };
}

test('opens human review only after four model reviews and required fifth decision', () => {
  const item = evaluation();
  assert.equal(advanceGovernance(item).governance.phase, 'human_open');

  const incomplete = evaluation();
  incomplete.absoluteReview.modelPanel.primary.pop();
  assert.throws(() => advanceGovernance(incomplete), /four|model/i);

  const fifthRequired = evaluation();
  fifthRequired.absoluteReview.modelPanel.disputedSubcriterionIds = [leaves[0]];
  assert.throws(() => advanceGovernance(fifthRequired), /fifth|arbitration|model/i);
});

test('assigns distinct primary judges, preserves assignment scopes, and validates drafts', () => {
  const item = advanceGovernance(evaluation());
  const first = assignHumanReviewer(item, { principalId: 'judge_1' }, 'primary', leaves);
  assert.deepEqual(first.criterionScope, leaves);
  assert.throws(
    () => assignHumanReviewer(item, { principalId: 'judge_1' }, 'primary', leaves),
    /primary|judge/i
  );
  const second = assignHumanReviewer(item, { principalId: 'judge_2' }, 'primary', leaves);
  assert.equal(second.role, 'primary');
  assert.throws(
    () => assignHumanReviewer(item, { principalId: 'judge_3' }, 'primary', leaves),
    /two|primary/i
  );
  const draft = saveHumanDraft(item, first, payload(), 0);
  assert.equal(draft.revision, 1);
  assert.throws(
    () => saveHumanDraft(item, first, payload(), 0),
    /revision/i
  );
  assert.throws(
    () => saveHumanDraft(item, first, {
      scores: { [leaves[0]]: payload().scores[leaves[0]] }
    }, 1),
    /every|missing|scope/i
  );
});

test('submits immutable primary reviews and triggers per-leaf arbitration above 15 points', () => {
  const item = advanceGovernance(evaluation());
  const first = assignHumanReviewer(item, { principalId: 'judge_1' }, 'primary', leaves);
  const second = assignHumanReviewer(item, { principalId: 'judge_2' }, 'primary', leaves);
  submitHumanReview(item, first, payload(50));
  submitHumanReview(item, second, payload(70));

  assert.equal(item.governance.phase, 'human_arbitration');
  assert.deepEqual(item.governance.arbitrationRequired, leaves);
  assert.throws(() => submitHumanReview(item, first, payload(50)), /submitted|immutable/i);

  const arbitrator = assignHumanReviewer(item, { principalId: 'judge_3' }, 'arbitrator', leaves);
  assert.throws(
    () => assignHumanReviewer(item, { principalId: 'judge_1' }, 'arbitrator', leaves),
    /primary|arbitrator|judge/i
  );
  submitHumanReview(item, arbitrator, payload(60));

  const aggregate = aggregateHumanReviews(item);
  assert.equal(aggregate.leaves[leaves[0]].score, 60);
  assert.equal(aggregate.leaves[leaves[1]].score, 60);
  assert.equal(item.governance.phase, 'human_open');
});

test('uses the two-value median without averaging review totals', () => {
  const item = advanceGovernance(evaluation());
  const first = assignHumanReviewer(item, { principalId: 'judge_1' }, 'primary', leaves);
  const second = assignHumanReviewer(item, { principalId: 'judge_2' }, 'primary', leaves);
  submitHumanReview(item, first, payload(60));
  submitHumanReview(item, second, payload(75));

  const aggregate = aggregateHumanReviews(item);
  assert.equal(aggregate.leaves[leaves[0]].score, 67.5);
  assert.equal(item.governance.phase, 'human_open');
});

test('rejects scores, foreign evidence, missing checks, and unsupported overturns', () => {
  const item = advanceGovernance(evaluation());
  const assignment = assignHumanReviewer(item, { principalId: 'judge_1' }, 'primary', leaves);
  for (const invalid of [
    (() => { const value = payload(); value.scores[leaves[0]].score = 101; return value; })(),
    (() => { const value = payload(); value.scores[leaves[0]].evidenceIds = ['ev_foreign']; return value; })(),
    (() => { const value = payload(); value.scores[leaves[0]].checkEvidence = []; return value; })(),
    (() => { const value = payload(70, 'overturn'); value.scores[leaves[0]].overrideReason = ''; return value; })()
  ]) {
    assert.throws(() => submitHumanReview(item, assignment, invalid), /score|evidence|check|overturn/i);
  }
});
