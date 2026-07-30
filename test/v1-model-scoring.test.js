import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertV1ScoringReady,
  normalizeV1ScoringConfig,
  scoreV1ArenaCase
} from '../src/v1-model-scoring.js';

const LIVE_SECRET_ENV = 'V1_MODEL_SCORING_TEST_API_KEY';
const originalLiveSecret = process.env[LIVE_SECRET_ENV];
process.env[LIVE_SECRET_ENV] = 'test-only-secret';
test.after(() => {
  if (originalLiveSecret === undefined) delete process.env[LIVE_SECRET_ENV];
  else process.env[LIVE_SECRET_ENV] = originalLiveSecret;
});

test('defaults missing V1 scoring config to DeepSeek single-model judging', () => {
  assert.deepEqual(normalizeV1ScoringConfig(), {
    version: 'v1-model-arena/v1',
    mode: 'single',
    reviewerId: 'deepseek'
  });
});

test('accepts panel config and rejects a reviewer on panel mode', () => {
  assert.deepEqual(normalizeV1ScoringConfig({ mode: 'panel' }), {
    version: 'v1-model-arena/v1',
    mode: 'panel'
  });
  assert.throws(
    () => normalizeV1ScoringConfig({ mode: 'panel', reviewerId: 'deepseek' }),
    /reviewerId/
  );
});

test('requires every configured live reviewer seat and permits demo scoring', () => {
  assert.doesNotThrow(() => assertV1ScoringReady(
    { version: 'v1-model-arena/v1', mode: 'panel' },
    'demo',
    []
  ));

  assert.throws(
    () => assertV1ScoringReady(
      { version: 'v1-model-arena/v1', mode: 'single', reviewerId: 'deepseek' },
      'live',
      [{ id: 'deepseek', kind: 'mock' }]
    ),
    (error) => error.statusCode === 503 && /deepseek/u.test(error.message)
  );

  assert.throws(
    () => assertV1ScoringReady(
      { version: 'v1-model-arena/v1', mode: 'panel' },
      'live',
      [liveReviewer('gpt')]
    ),
    (error) => error.statusCode === 503 && /claude.*doubao.*deepseek/u.test(error.message)
  );
});

test('rejects malformed and uncredentialed custom live reviewer seats before scoring', () => {
  const config = {
    version: 'v1-model-arena/v1',
    mode: 'single',
    reviewerId: 'deepseek'
  };
  const missingSecretEnv = 'V1_MODEL_SCORING_MISSING_API_KEY';
  delete process.env[missingSecretEnv];
  const invalidReviewers = [
    { ...liveReviewer('deepseek'), kind: 'unsupported' },
    { ...liveReviewer('deepseek'), baseUrl: '' },
    { ...liveReviewer('deepseek'), model: '' },
    { ...liveReviewer('deepseek'), apiKeyEnv: '' },
    { ...liveReviewer('deepseek'), apiKeyEnv: missingSecretEnv }
  ];

  for (const reviewer of invalidReviewers) {
    assert.throws(
      () => assertV1ScoringReady(config, 'live', [reviewer]),
      (error) => error.statusCode === 503 && /deepseek/u.test(error.message)
    );
  }
  assert.doesNotThrow(() => assertV1ScoringReady(
    config,
    'live',
    [liveReviewer('deepseek')]
  ));
  assert.doesNotThrow(() => assertV1ScoringReady(
    config,
    'live',
    [liveReviewer('deepseek', { kind: 'anthropic' })]
  ));
});

test('single judge scores all successful candidates anonymously and server recomputes total', async () => {
  const seen = [];
  const result = await scoreV1ArenaCase({
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [
      { id: 'submitted', name: 'Secret Agent', output: 'answer A', mode: 'live' },
      { id: 'doubao', name: 'Doubao Agent', output: 'answer B', mode: 'live' },
      { id: 'cursor', name: 'Cursor Agent', output: 'auth failed', mode: 'failed' }
    ],
    config: { version: 'v1-model-arena/v1', mode: 'single', reviewerId: 'deepseek' },
    reviewers: [liveReviewer('deepseek', { name: 'DeepSeek', model: 'ds' })],
    evaluationMode: 'live',
    seed: 7,
    invokeJudge: async ({ prompt, candidateIds }) => {
      seen.push(prompt);
      return {
        scores: candidateIds.map((candidateId) => ({
          candidateId,
          dimensions: {
            taskConstraint: 80,
            professionalQuality: 70,
            evidenceRisk: 60,
            artifactUsability: 50
          },
          total: 1,
          rationale: 'visible quality',
          uncertainties: []
        }))
      };
    }
  });

  assert.equal(result.entries.find((item) => item.id === 'submitted').score, 70);
  assert.equal(result.entries.find((item) => item.id === 'cursor').score, 0);
  assert.equal(result.entries.find((item) => item.id === 'cursor').scoreStatus, 'execution-failed');
  assert.equal(result.judging.successfulSeats, 1);
  assert.equal(result.judging.status, 'scored');
  assert.doesNotMatch(seen[0], /Secret Agent|Doubao Agent|submitted|cursor/u);
});

test('propagates caller cancellation after reviewer promises settle', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('caller cancelled V1 scoring'), {
    name: 'AbortError'
  });
  const scoring = scoreV1ArenaCase({
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [
      { id: 'submitted', name: 'Secret Agent', output: 'answer A', mode: 'live' }
    ],
    config: { version: 'v1-model-arena/v1', mode: 'single', reviewerId: 'deepseek' },
    reviewers: [liveReviewer('deepseek')],
    evaluationMode: 'live',
    seed: 7,
    signal: controller.signal,
    invokeJudge: async () => {
      controller.abort(reason);
      throw new Error('provider request rejected after abort');
    }
  });

  await assert.rejects(scoring, (error) => error === reason);
});

test('panel requires two successful seats and aggregates candidate totals by median', async () => {
  const result = await scoreV1ArenaCase(panelFixture({
    gpt: 80,
    claude: new Error('unavailable'),
    doubao: 60,
    deepseek: 70
  }));

  assert.equal(result.status, 'scored');
  assert.equal(result.entries[0].score, 70);
  assert.equal(result.judging.successfulSeats, 3);
});

test('panel keeps successful executions unscored when only one reviewer seat succeeds', async () => {
  const result = await scoreV1ArenaCase(panelFixture({
    gpt: 80,
    claude: new Error('unavailable'),
    doubao: new Error('unavailable'),
    deepseek: new Error('unavailable')
  }));

  assert.equal(result.status, 'failed');
  assert.equal(result.entries[0].score, null);
  assert.equal(result.entries[0].scoreStatus, 'model-failed');
  assert.equal(result.judging.successfulSeats, 1);
  assert.equal(result.judging.status, 'failed');
  assert.deepEqual(result.entries[0].judgeReviews, [{
    reviewerId: 'gpt',
    reviewerName: 'gpt',
    model: 'gpt-model',
    mode: 'live',
    status: 'scored',
    rationale: 'gpt rationale',
    uncertainties: []
  }]);
});

test('all execution failures receive zeroes without calling a judge', async () => {
  let calls = 0;
  const result = await scoreV1ArenaCase({
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [
      { id: 'submitted', name: 'Secret Agent', output: 'failed', mode: 'failed' },
      { id: 'doubao', name: 'Doubao Agent', output: 'failed', mode: 'failed' }
    ],
    config: { version: 'v1-model-arena/v1', mode: 'single', reviewerId: 'deepseek' },
    reviewers: [liveReviewer('deepseek', { name: 'DeepSeek', model: 'ds' })],
    evaluationMode: 'live',
    seed: 7,
    invokeJudge: async () => {
      calls += 1;
      throw new Error('must not be called');
    }
  });

  assert.equal(calls, 0);
  assert.equal(result.status, 'scored');
  assert.deepEqual(result.entries.map((entry) => entry.score), [0, 0]);
});

function panelFixture(outcomes) {
  return {
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [{ id: 'submitted', name: 'Secret Agent', output: 'answer A', mode: 'live' }],
    config: { version: 'v1-model-arena/v1', mode: 'panel' },
    reviewers: ['gpt', 'claude', 'doubao', 'deepseek'].map((id) =>
      liveReviewer(id)
    ),
    evaluationMode: 'live',
    seed: 7,
    invokeJudge: async ({ reviewer, candidateIds }) => {
      const outcome = outcomes[reviewer.id];
      if (outcome instanceof Error) throw outcome;
      return {
        scores: candidateIds.map((candidateId) => ({
          candidateId,
          dimensions: {
            taskConstraint: outcome,
            professionalQuality: outcome,
            evidenceRisk: outcome,
            artifactUsability: outcome
          },
          total: 0,
          rationale: `${reviewer.id} rationale`,
          uncertainties: []
        }))
      };
    }
  };
}

function liveReviewer(id, overrides = {}) {
  return {
    id,
    name: id,
    model: `${id}-model`,
    kind: 'openai-compatible',
    baseUrl: 'https://reviewer.example.test/v1',
    apiKeyEnv: LIVE_SECRET_ENV,
    ...overrides
  };
}
