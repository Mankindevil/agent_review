import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateModelPanel,
  arbitrationReasons,
  normalizePanelReview,
  runModelPanel
} from '../src/judge-panel.js';

const contract = {
  subcriterionIds: ['professionalism.evidenceReasoning'],
  checks: [{
    checkId: 'risk_reasoning',
    subcriterionId: 'professionalism.evidenceReasoning'
  }],
  evidenceIds: ['ev_a', 'ev_b']
};

function answer(score = 76, confidence = 0.72) {
  return {
    reviews: [{
      subcriterionId: 'professionalism.evidenceReasoning',
      score,
      confidence,
      evidenceIds: ['ev_a'],
      checkEvidence: [{
        checkId: 'risk_reasoning',
        evidenceIds: ['ev_a']
      }],
      findings: [{
        text: 'The conclusion cites the returned exposure table.',
        evidenceIds: ['ev_a']
      }],
      counterEvidence: [{
        text: 'Missing holdings are clearly disclosed.',
        evidenceIds: ['ev_b']
      }],
      uncertainties: ['No external truth is available.'],
      repairSuggestion: 'Explain the classification method.',
      conclusions: {
        taskCompleted: 'partial',
        criticalRisk: 'no'
      }
    }]
  };
}

test('normalizes one evidence-grounded entry for every applicable subcriterion and check', () => {
  const normalized = normalizePanelReview(answer(), contract, {
    reviewRunId: 'review_a'
  });

  assert.equal(normalized.reviews[0].score, 76);
  assert.equal(normalized.reviews[0].findings[0].findingId,
    'finding_review_a_professionalism_evidenceReasoning_0');
  assert.equal(Object.isFrozen(normalized), true);
});

test('rejects missing checks, unknown evidence, invalid ranges, and unverifiable internal claims', () => {
  const cases = [
    (() => {
      const value = answer();
      value.reviews[0].checkEvidence = [];
      return value;
    })(),
    (() => {
      const value = answer();
      value.reviews[0].evidenceIds = ['ev_unknown'];
      return value;
    })(),
    answer(101),
    (() => {
      const value = answer();
      value.reviews[0].findings[0].text = 'Verified that the Agent used an internal browser tool.';
      return value;
    })()
  ];
  for (const value of cases) {
    assert.throws(
      () => normalizePanelReview(value, contract, { reviewRunId: 'review_a' }),
      /check|evidence|score|internal|verified/iu
    );
  }
});

test('triggers arbitration at an inclusive 20-point range, conclusion conflict, or three low confidences', () => {
  assert.deepEqual(arbitrationReasons([40, 60, 59, 55]), ['score-range']);
  assert.deepEqual(arbitrationReasons([
    { score: 50, confidence: 0.8, conclusions: { taskCompleted: 'yes', criticalRisk: 'no' } },
    { score: 51, confidence: 0.8, conclusions: { taskCompleted: 'no', criticalRisk: 'no' } },
    { score: 52, confidence: 0.8, conclusions: { taskCompleted: 'partial', criticalRisk: 'no' } },
    { score: 53, confidence: 0.8, conclusions: { taskCompleted: 'yes', criticalRisk: 'no' } }
  ]), ['conclusion-conflict']);
  assert.deepEqual(arbitrationReasons([
    { score: 50, confidence: 0.59, conclusions: {} },
    { score: 51, confidence: 0.4, conclusions: {} },
    { score: 52, confidence: 0.1, conclusions: {} },
    { score: 53, confidence: 0.9, conclusions: {} }
  ]), ['low-confidence']);
  assert.deepEqual(arbitrationReasons([40, 59, 58, 55]), []);
});

test('runs four isolated primary reviewers and sends disputed IDs only to the arbitrator', async () => {
  const primary = [0, 1, 2, 3].map((index) => ({
    id: `p${index}`,
    identityKey: `mock:p${index}:model`
  }));
  const arbitrator = { id: 'arb', identityKey: 'mock:arb:model' };
  const prompts = [];
  const result = await runModelPanel({
    panel: { primary, arbitrator, fallbacks: [] },
    contract,
    evidencePackage: { evidenceManifest: [{ evidenceId: 'ev_a' }, { evidenceId: 'ev_b' }] },
    invoke: async (reviewer, packet) => {
      prompts.push({ reviewer: reviewer.id, packet: structuredClone(packet) });
      return answer(reviewer.id === 'p0' ? 40 : reviewer.id === 'p1' ? 60 : 55);
    }
  });

  assert.equal(result.status, 'model-locked');
  assert.equal(prompts.filter((item) => item.reviewer.startsWith('p')).length, 4);
  const arbitration = prompts.find((item) => item.reviewer === 'arb');
  assert.deepEqual(arbitration.packet.disputedSubcriterionIds,
    ['professionalism.evidenceReasoning']);
  assert.equal(JSON.stringify(arbitration.packet).includes('"score"'), false);
  assert.equal(JSON.stringify(arbitration.packet).includes('p0'), false);
});

test('aggregates medians per subcriterion instead of averaging whole answer sheets', () => {
  const primary = [40, 60, 59, 55].map((score, index) =>
    normalizePanelReview(answer(score), contract, { reviewRunId: `r${index}` })
  );
  const arbitration = normalizePanelReview(answer(58), contract, {
    reviewRunId: 'arb'
  });
  const result = aggregateModelPanel(primary, arbitration, {
    dimensions: {
      professionalism: { evidenceReasoning: 100 }
    }
  });

  assert.equal(result.subcriteria['professionalism.evidenceReasoning'].score, 58);
  assert.equal(result.dimensions.professionalism.score, 58);
});
