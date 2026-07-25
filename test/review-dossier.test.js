import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAbsoluteReviewDossier,
  buildReplicaReviewDossier,
  flattenOutputText,
  truncateText
} from '../src/review-dossier.js';

function absoluteEvaluationFixture() {
  return {
    governance: { phase: 'human_open' },
    absoluteReview: {
      modelPanel: {
        status: 'model-locked',
        dimensions: {
          scenarioValue: { score: 75 },
          professionalism: { score: 80 },
          agentCapability: { score: 85 }
        },
        primary: [
          {
            reviewRunId: 'primary_0_gpt',
            name: 'GPT',
            reviews: [
              {
                subcriterionId: 'professionalism.evidenceReasoning',
                score: 78,
                confidence: 0.8,
                findings: [{ findingId: 'f1', text: 'Seat 0 leaf 1 finding.' }]
              },
              {
                subcriterionId: 'professionalism.communicationQuality',
                score: 72,
                confidence: 0.7,
                findings: [{ findingId: 'f2', text: 'Seat 0 leaf 2 finding.' }]
              }
            ]
          },
          {
            reviewRunId: 'primary_1_claude',
            name: 'Claude',
            reviews: [
              {
                subcriterionId: 'professionalism.evidenceReasoning',
                score: 81,
                confidence: 0.9,
                findings: [{ findingId: 'f3', text: 'Seat 1 leaf 1 finding.' }]
              },
              {
                subcriterionId: 'professionalism.communicationQuality',
                score: 79,
                confidence: 0.85,
                findings: [{ findingId: 'f4', text: 'Seat 1 leaf 2 finding.' }]
              }
            ]
          }
        ]
      }
    }
  };
}

function sealedReplicaEvaluationFixture() {
  return {
    id: 'eval_replica_dossier',
    governance: { replicaHumanPhase: 'replica_human_open' },
    qualification: { status: 'eligible' },
    replicaArena: {
      status: 'sealed',
      runtimeSummaries: [{ runtimeId: 'alpha', validity: 'valid', displayName: 'Secret Runtime' }]
    },
    testPlan: {
      tests: [{
        testId: 'test_1',
        title: 'Baseline case',
        repeatCount: 1,
        input: { parts: [{ type: 'text', text: 'Evaluate this.' }] }
      }]
    },
    phase2Execution: {
      testRuns: [{
        testId: 'test_1',
        repeatIndex: 0,
        runs: [{ response: { currentOutput: { text: 'Submitted output.', data: null, artifacts: [] } } }]
      }]
    },
    replicaCheckpoint: {
      status: 'sealed',
      turns: {
        'alpha:test_1:0:0': {
          runtimeId: 'alpha',
          testId: 'test_1',
          repeatIndex: 0,
          turnIndex: 0,
          resultCommitment: { evidenceId: 'ev_alpha_test_1', recordHash: 'b'.repeat(64) }
        }
      }
    }
  };
}

test('buildAbsoluteReviewDossier projects leaf seats with scores and findings', () => {
  const dossier = buildAbsoluteReviewDossier(absoluteEvaluationFixture());

  assert.ok(dossier);
  assert.deepEqual(dossier.dimensions, {
    scenarioValue: { score: 75 },
    professionalism: { score: 80 },
    agentCapability: { score: 85 }
  });
  assert.equal(dossier.leaves.length, 2);
  assert.equal(dossier.leaves[0].subcriterionId, 'professionalism.evidenceReasoning');
  assert.equal(dossier.leaves[1].subcriterionId, 'professionalism.communicationQuality');
  assert.deepEqual(dossier.leaves[0].seats, [
    {
      seatId: 'primary_0_gpt',
      name: 'GPT',
      score: 78,
      confidence: 0.8,
      finding: 'Seat 0 leaf 1 finding.'
    },
    {
      seatId: 'primary_1_claude',
      name: 'Claude',
      score: 81,
      confidence: 0.9,
      finding: 'Seat 1 leaf 1 finding.'
    }
  ]);
  assert.equal(dossier.leaves[1].seats[0].score, 72);
  assert.equal(dossier.leaves[1].seats[1].finding, 'Seat 1 leaf 2 finding.');
});

test('buildAbsoluteReviewDossier returns undefined when absolute review is not open', () => {
  const evaluation = absoluteEvaluationFixture();
  evaluation.governance.phase = 'model_review';
  assert.equal(buildAbsoluteReviewDossier(evaluation), undefined);

  evaluation.governance.phase = 'human_open';
  evaluation.absoluteReview.modelPanel.primary = [];
  assert.equal(buildAbsoluteReviewDossier(evaluation), undefined);
});

test('buildReplicaReviewDossier projects anonymous case sources without delta fields', async () => {
  const evaluation = sealedReplicaEvaluationFixture();
  const evidenceVault = {
    get: async (evidenceId) => ({
      payload: {
        result: {
          messageParts: [{ type: 'text', text: 'Replica output for the desk.' }]
        }
      }
    }),
    put: async () => {}
  };

  const dossier = await buildReplicaReviewDossier(evaluation, { evidenceVault });

  assert.ok(dossier.cases);
  assert.equal(dossier.cases.length, 1);
  assert.equal(dossier.cases[0].testId, 'test_1');
  assert.equal(dossier.cases[0].title, 'Baseline case');
  assert.equal(dossier.cases[0].prompt, 'Evaluate this.');
  assert.deepEqual(
    dossier.cases[0].sources.map((source) => source.sourceId),
    ['submitted', 'replica:alpha']
  );
  assert.equal(dossier.cases[0].sources[0].text, 'Submitted output.');
  assert.equal(dossier.cases[0].sources[1].text, 'Replica output for the desk.');
  assert.equal(dossier.cases[0].sources[0].truncated, false);
  assert.equal(Object.hasOwn(dossier, 'error'), false);
  assert.equal(JSON.stringify(dossier).includes('conservativeDelta'), false);
  assert.equal(JSON.stringify(dossier).includes('Secret Runtime'), false);
  assert.equal(JSON.stringify(dossier).includes('displayName'), false);
});

test('buildReplicaReviewDossier returns undefined when replica-human track is not open', async () => {
  const evaluation = sealedReplicaEvaluationFixture();
  evaluation.governance.replicaHumanPhase = 'replica_human_pending';
  assert.equal(
    await buildReplicaReviewDossier(evaluation, { evidenceVault: { get: async () => ({}), put: async () => {} } }),
    undefined
  );

  evaluation.governance.replicaHumanPhase = 'replica_human_open';
  evaluation.governance.replicaHumanLockedAt = '2026-07-26T01:00:00.000Z';
  assert.equal(
    await buildReplicaReviewDossier(evaluation, { evidenceVault: { get: async () => ({}), put: async () => {} } }),
    undefined
  );
});

test('truncateText marks long source text as truncated', () => {
  const longText = 'x'.repeat(4001);
  const result = truncateText(longText, 4000);

  assert.equal(result.text.length, 4000);
  assert.equal(result.truncated, true);
  assert.equal(truncateText('short').truncated, false);
});

test('flattenOutputText joins messageParts text', () => {
  assert.equal(
    flattenOutputText({
      messageParts: [
        { type: 'text', text: 'Line one.' },
        { type: 'text', text: 'Line two.' }
      ]
    }),
    'Line one.\nLine two.'
  );
  assert.equal(flattenOutputText({ text: 'Plain text output.' }), 'Plain text output.');
});

test('buildReplicaReviewDossier returns error object when sealed materials cannot load', async () => {
  const evaluation = sealedReplicaEvaluationFixture();
  delete evaluation.testPlan;

  const dossier = await buildReplicaReviewDossier(evaluation, {
    evidenceVault: { get: async () => ({}), put: async () => {} }
  });

  assert.equal(Object.hasOwn(dossier, 'cases'), false);
  assert.match(dossier.error, /test plan/i);
});
