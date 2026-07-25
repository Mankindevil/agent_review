import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLockedHumor,
  validateHumorItems
} from '../src/humor.js';

const LEAF_ID = 'scenarioValue.agentNecessity';
const FINDING = {
  findingId: 'finding_model_1_scenarioValue_agentNecessity_0',
  text: 'The captured evidence does not show a reusable multi-turn workflow.'
};

test('refuses humor generation before the absolute result is locked', async () => {
  await assert.rejects(
    generateLockedHumor(unlockedEvaluation(), {}),
    /absolute result.*locked/i
  );
});

test('rejects humor items with an unknown leaf or finding', () => {
  assert.throws(() => validateHumorItems([{
    subcriterionId: 'unknown.leaf',
    findingIds: [FINDING.findingId],
    line: 'The captured evidence needs a clearer workflow.'
  }], lockedFindings()), /unknown.*subcriterion/i);

  assert.throws(() => validateHumorItems([{
    subcriterionId: LEAF_ID,
    findingIds: ['finding_unknown'],
    line: 'The captured evidence needs a clearer workflow.'
  }], lockedFindings()), /unknown.*finding/i);
});

test('rejects new numbers, proper nouns, tools, and score changes', () => {
  const invalidLines = [
    'The captured evidence needs 42 more workflow steps.',
    'Tesla has a clearer workflow than this.',
    'The browser tool would make the workflow reusable.',
    'Raise the score by 10 points.'
  ];

  for (const line of invalidLines) {
    assert.throws(() => validateHumorItems([{
      subcriterionId: LEAF_ID,
      findingIds: [FINDING.findingId],
      line
    }], lockedFindings()), /unsupported|score/i);
  }
});

test('requires exactly one grounded line for every applicable leaf', () => {
  assert.throws(() => validateHumorItems([], lockedFindings()), /exactly one/i);

  assert.throws(() => validateHumorItems([{
    subcriterionId: LEAF_ID,
    findingIds: [FINDING.findingId],
    line: 'The captured evidence needs a clearer workflow.'
  }, {
    subcriterionId: LEAF_ID,
    findingIds: [FINDING.findingId],
    line: 'The captured evidence needs a clearer workflow.'
  }], lockedFindings()), /exactly one|duplicate/i);
});

test('falls back to a source-grounded neutral line after guard rejection', async () => {
  const evaluation = lockedEvaluation();
  const humor = await generateLockedHumor(evaluation, {
    now: () => '2026-07-25T13:00:00.000Z',
    generateHumor: async () => ({
      modelIdentity: 'humor-model',
      items: [{
        subcriterionId: LEAF_ID,
        findingIds: [FINDING.findingId],
        line: 'Tesla would raise this score by 10 points.'
      }]
    })
  });

  assert.equal(humor.modelIdentity, 'fallback');
  assert.equal(humor.sourceResultHash, 'a'.repeat(64));
  assert.equal(humor.generatedAt, '2026-07-25T13:00:00.000Z');
  assert.match(humor.items[0].line, /captured evidence/u);
  assert.equal(evaluation.resultV2.absolute.resultHash, 'a'.repeat(64));
  assert.equal(evaluation.resultV2.humor, humor);
});

function lockedFindings() {
  return [{
    subcriterionId: LEAF_ID,
    sourceFindings: [FINDING],
    repairSuggestion: 'Make the workflow reusable.'
  }];
}

function lockedEvaluation() {
  return {
    governance: { absoluteLockedAt: '2026-07-25T12:00:00.000Z' },
    resultV2: {
      absolute: {
        status: 'locked',
        resultHash: 'a'.repeat(64),
        dimensions: {
          scenarioValue: {
            leaves: {
              [LEAF_ID]: { applicable: true }
            }
          },
          professionalism: { leaves: {} },
          agentCapability: { leaves: {} }
        }
      }
    },
    absoluteReview: {
      modelPanel: {
        primary: [{
          reviews: [{
            subcriterionId: LEAF_ID,
            findings: [FINDING],
            repairSuggestion: 'Make the workflow reusable.'
          }]
        }]
      }
    }
  };
}

function unlockedEvaluation() {
  const evaluation = lockedEvaluation();
  evaluation.governance.absoluteLockedAt = null;
  evaluation.resultV2.absolute.status = 'model-provisional';
  return evaluation;
}
