import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertV1ScoringReady,
  capabilityScore,
  LEGACY_V1_SCORING_VERSION,
  latencyScore,
  normalizeV1ScoringConfig,
  scoreV1ArenaCase,
  V1_SCORING_VERSION
} from '../src/v1-model-scoring.js';

const LIVE_SECRET_ENV = 'V1_MODEL_SCORING_TEST_API_KEY';
const originalLiveSecret = process.env[LIVE_SECRET_ENV];
process.env[LIVE_SECRET_ENV] = 'test-only-secret';
test.after(() => {
  if (originalLiveSecret === undefined) delete process.env[LIVE_SECRET_ENV];
  else process.env[LIVE_SECRET_ENV] = originalLiveSecret;
});

test('defaults new V1 scoring config to the v2 arena contract', () => {
  assert.deepEqual(normalizeV1ScoringConfig(), {
    version: 'v1-model-arena/v2',
    mode: 'single',
    reviewerId: 'deepseek'
  });
});

test('accepts panel config and rejects a reviewer on panel mode', () => {
  assert.deepEqual(normalizeV1ScoringConfig({ mode: 'panel' }), {
    version: 'v1-model-arena/v2',
    mode: 'panel'
  });
  assert.throws(
    () => normalizeV1ScoringConfig({ mode: 'panel', reviewerId: 'deepseek' }),
    /reviewerId/
  );
});

test('preserves explicitly persisted v1 configurations for historical retries', () => {
  assert.deepEqual(normalizeV1ScoringConfig({
    version: 'v1-model-arena/v1',
    mode: 'single',
    reviewerId: 'deepseek'
  }), {
    version: LEGACY_V1_SCORING_VERSION,
    mode: 'single',
    reviewerId: 'deepseek'
  });
  assert.equal(V1_SCORING_VERSION, 'v1-model-arena/v2');
});

test('derives latency and capability from server-side execution records at exact boundaries', () => {
  assert.equal(latencyScore(60_000), 100);
  assert.equal(latencyScore(330_000), 50);
  assert.equal(latencyScore(600_000), 0);
  assert.equal(capabilityScore({ status: 'failed', durationMs: 1 }), 0);
  assert.equal(capabilityScore({ status: 'succeeded', durationMs: 60_000 }), 100);
  assert.equal(capabilityScore({ status: 'succeeded', durationMs: 600_000 }), 70);
});

test('rejects missing or malformed authoritative execution durations instead of fabricating a capability score', async () => {
  for (const durationMs of [undefined, null, -1, '60000']) {
    await assert.rejects(
      scoreV1ArenaCase({
        testCase: { name: '日报', prompt: '生成日报' },
        entries: [{
          id: 'submitted',
          name: 'Agent',
          output: '结果',
          mode: 'live',
          execution: durationMs === undefined
            ? { status: 'succeeded' }
            : { status: 'succeeded', durationMs }
        }],
        config: { version: V1_SCORING_VERSION, mode: 'single', reviewerId: 'gpt' },
        reviewers: [liveReviewer('gpt')],
        evaluationMode: 'live',
        seed: 31,
        invokeJudge: async ({ candidateIds }) => v2JudgeResponse(candidateIds)
      }),
      /authoritative execution.*durationMs/u
    );
  }
  await assert.rejects(
    scoreV1ArenaCase({
      testCase: { name: '日报', prompt: '生成日报' },
      entries: [{ id: 'submitted', name: 'Agent', output: '结果', mode: 'live' }],
      config: { version: V1_SCORING_VERSION, mode: 'single', reviewerId: 'gpt' },
      reviewers: [liveReviewer('gpt')],
      evaluationMode: 'live',
      seed: 32
    }),
    /authoritative execution/u
  );
  assert.equal(capabilityScore({ status: 'succeeded', durationMs: 0 }), 100);
});

test('v2 returns a scored empty arena without calling a judge', async () => {
  let calls = 0;
  const result = await scoreV1ArenaCase({
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [],
    config: { version: V1_SCORING_VERSION, mode: 'single', reviewerId: 'gpt' },
    reviewers: [liveReviewer('gpt')],
    evaluationMode: 'live',
    seed: 33,
    invokeJudge: async () => {
      calls += 1;
      throw new Error('must not be called');
    }
  });

  assert.equal(calls, 0);
  assert.equal(result.status, 'scored');
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.judging.scenario.reviews, []);
});

test('v2 retains capability details when no judge seat succeeds', async () => {
  const result = await scoreV1ArenaCase({
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [{ id: 'submitted', name: 'Agent', output: '结果', mode: 'live', execution: { status: 'succeeded', durationMs: 60_000 } }],
    config: { version: V1_SCORING_VERSION, mode: 'single', reviewerId: 'gpt' },
    reviewers: [liveReviewer('gpt')],
    evaluationMode: 'live',
    seed: 34,
    invokeJudge: async () => { throw new Error('judge unavailable'); }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.entries[0].scoreStatus, 'model-failed');
  assert.equal(result.entries[0].detail.capability.capabilityScore, 100);
  assert.deepEqual(result.judging.scenario.reviews, []);
});

test('v2 panel shares scenario judgement, recomputes 20/60/20 totals, and omits execution metadata from judges', async () => {
  const seen = [];
  const result = await scoreV1ArenaCase({
    testCase: { name: '因子研究', prompt: '计算 Rank IC', constraints: ['使用月频数据'] },
    entries: [
      {
        id: 'submitted-runtime-id',
        name: 'Secret Agent Name',
        output: '候选 A：给出月频 Rank IC 与分组回测。',
        mode: 'live',
        execution: { status: 'succeeded', durationMs: 330_000 },
        durationMs: 330_000,
        dataVerification: { secret: 'DATA_VERIFICATION_SENTINEL' }
      },
      {
        id: 'claude-runtime-id',
        name: 'Claude Runtime Name',
        output: '候选 B：给出因子定义和限制说明。',
        mode: 'live',
        execution: { status: 'succeeded', durationMs: 60_000 }
      },
      {
        id: 'failed-runtime-id',
        name: 'Failed Runtime Name',
        output: '执行失败。',
        mode: 'failed',
        execution: { status: 'failed', durationMs: 1 }
      }
    ],
    config: { version: V1_SCORING_VERSION, mode: 'panel' },
    reviewers: ['gpt', 'claude', 'doubao', 'deepseek'].map((id) => liveReviewer(id)),
    evaluationMode: 'live',
    seed: 73,
    invokeJudge: async ({ prompt, candidateIds }) => {
      seen.push(prompt);
      return v2JudgeResponse(candidateIds, { providerProse: 'ignored provider prose' });
    }
  });

  const first = result.entries.find((entry) => entry.id === 'submitted-runtime-id');
  const second = result.entries.find((entry) => entry.id === 'claude-runtime-id');
  const failed = result.entries.find((entry) => entry.id === 'failed-runtime-id');
  assert.equal(result.status, 'scored');
  assert.equal(first.score, 76);
  assert.equal(second.score, 79);
  assert.deepEqual(first.dimensions, {
    scenarioValue: 70,
    professionalQuality: 75,
    agentCapability: 85
  });
  assert.deepEqual(second.dimensions, {
    scenarioValue: 70,
    professionalQuality: 75,
    agentCapability: 100
  });
  assert.equal(first.detail.scenario.score, 70);
  assert.equal(first.detail.professionalism.score, 75);
  assert.equal(first.detail.capability.executionSuccessScore, 100);
  assert.equal(first.detail.capability.latencyScore, 50);
  assert.equal(first.detail.capability.capabilityScore, 85);
  assert.deepEqual(first.detail.scenario, second.detail.scenario);
  assert.equal(result.judging.scenario.reviews.length, 4);
  assert.equal(first.judgeReviews.length, 4);
  assert.equal(failed.score, 0);
  assert.equal(failed.scoreStatus, 'execution-failed');
  assert.equal(failed.dimensions, null);
  assert.equal(failed.detail.capability.capabilityScore, 0);
  assert.equal(failed.detail.scenario, null);
  assert.equal(failed.detail.professionalism, null);
  assert.equal(first.judgeReviews[0].providerProse, undefined);
  assert.equal(result.judging.scenario.reviews[0].providerProse, undefined);
  for (const prompt of seen) {
    assert.doesNotMatch(prompt, /Secret Agent Name|Claude Runtime Name|submitted-runtime-id|claude-runtime-id|failed-runtime-id|DATA_VERIFICATION_SENTINEL|durationMs|execution|latency|runtime/i);
  }
});

test('v2 rejects unknown scoring dimensions instead of accepting provider-generated fields', async () => {
  const result = await scoreV1ArenaCase({
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [{ id: 'submitted', name: 'Agent', output: '结果', mode: 'live', execution: { status: 'succeeded', durationMs: 1 } }],
    config: { version: V1_SCORING_VERSION, mode: 'single', reviewerId: 'gpt' },
    reviewers: [liveReviewer('gpt')],
    evaluationMode: 'live',
    seed: 12,
    invokeJudge: async ({ candidateIds }) => ({
      ...v2JudgeResponse(candidateIds),
      scores: candidateIds.map((candidateId) => ({
        ...v2JudgeResponse([candidateId]).scores[0],
        candidateId,
        dimensions: {
          taskCompletion: 90,
          methodProfessionalism: 80,
          evidenceDataQuality: 70,
          riskUncertainty: 60,
          artifactUsability: 50,
          inventedDimension: 100
        }
      }))
    })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.entries[0].score, null);
  assert.equal(result.entries[0].scoreStatus, 'model-failed');
});

test('v2 hard-zeros an execution status failure even when a legacy mode is stale', async () => {
  const result = await scoreV1ArenaCase({
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [
      { id: 'ok', name: 'OK', output: '可见结果', mode: 'live', execution: { status: 'succeeded', durationMs: 60_000 } },
      { id: 'failed', name: 'Stale mode', output: '错误文本', mode: 'live', execution: { status: 'failed', durationMs: 1 } }
    ],
    config: { version: V1_SCORING_VERSION, mode: 'single', reviewerId: 'gpt' },
    reviewers: [liveReviewer('gpt')],
    evaluationMode: 'live',
    seed: 13,
    invokeJudge: async ({ candidateIds }) => v2JudgeResponse(candidateIds)
  });

  const failed = result.entries.find((entry) => entry.id === 'failed');
  assert.equal(result.entries.find((entry) => entry.id === 'ok').score, 79);
  assert.equal(failed.score, 0);
  assert.equal(failed.scoreStatus, 'execution-failed');
  assert.equal(failed.judgeReviews.length, 0);
});

test('legacy v1 ignores execution status and keeps its original mode-based failure predicate', async () => {
  const result = await scoreV1ArenaCase({
    testCase: { name: '日报', prompt: '生成日报' },
    entries: [{
      id: 'legacy-live',
      name: 'Legacy Agent',
      output: '旧版输出',
      mode: 'live',
      execution: { status: 'failed', durationMs: 1 }
    }],
    config: { version: LEGACY_V1_SCORING_VERSION, mode: 'single', reviewerId: 'gpt' },
    reviewers: [liveReviewer('gpt')],
    evaluationMode: 'live',
    seed: 14,
    invokeJudge: async ({ candidateIds }) => ({
      scores: candidateIds.map((candidateId) => ({
        candidateId,
        dimensions: {
          taskConstraint: 80,
          professionalQuality: 70,
          evidenceRisk: 60,
          artifactUsability: 50
        },
        total: 70,
        rationale: '历史评分继续按旧规则处理。',
        uncertainties: []
      }))
    })
  });

  assert.equal(result.status, 'scored');
  assert.equal(result.entries[0].score, 70);
  assert.equal(result.entries[0].scoreStatus, 'scored');
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
    invokeJudge: async ({ system, prompt, candidateIds }) => {
      seen.push({ system, prompt });
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
          rationale: '可见输出质量清晰。',
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
  assert.doesNotMatch(seen[0].prompt, /Secret Agent|Doubao Agent|submitted|cursor/u);
  assert.match(seen[0].system, /rationale.*uncertainties.*简体中文/su);
  assert.match(seen[0].prompt, /评语文本必须使用简体中文/u);
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
    rationale: 'gpt 评语。',
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

test('rejects an English-only public rationale instead of publishing an English review', async () => {
  const result = await scoreV1ArenaCase({
    testCase: { name: '因子研究', prompt: '报告 Rank IC' },
    entries: [{ id: 'submitted', name: 'Agent', output: '结果', mode: 'live' }],
    config: { version: 'v1-model-arena/v1', mode: 'single', reviewerId: 'deepseek' },
    reviewers: [liveReviewer('deepseek')],
    evaluationMode: 'live',
    seed: 11,
    invokeJudge: async ({ candidateIds }) => ({
      scores: candidateIds.map((candidateId) => ({
        candidateId,
        dimensions: {
          taskConstraint: 70,
          professionalQuality: 70,
          evidenceRisk: 70,
          artifactUsability: 70
        },
        total: 70,
        rationale: 'This output is clear but does not contain real results.',
        uncertainties: ['The data source cannot be verified.']
      }))
    })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.entries[0].score, null);
  assert.equal(result.entries[0].scoreStatus, 'model-failed');
  assert.equal(result.entries[0].judgeReviews.length, 0);
});

test('ignores harmless extra score-item prose from OpenAI while preserving the scoring schema', async () => {
  const result = await scoreV1ArenaCase({
    testCase: { name: '因子研究', prompt: '报告 Rank IC' },
    entries: [{ id: 'submitted', name: 'Agent', output: '结果', mode: 'live' }],
    config: { version: 'v1-model-arena/v1', mode: 'single', reviewerId: 'gpt' },
    reviewers: [liveReviewer('gpt')],
    evaluationMode: 'live',
    seed: 12,
    invokeJudge: async ({ candidateIds }) => ({
      scores: candidateIds.map((candidateId) => ({
        candidateId,
        dimensions: {
          taskConstraint: 80,
          professionalQuality: 70,
          evidenceRisk: 60,
          artifactUsability: 50
        },
        total: 70,
        rationale: '任务结构清楚，但真实数据仍不足。',
        uncertainties: ['部分外部事实无法复核。'],
        overallAssessment: 'This provider-added prose is non-scoring metadata.'
      }))
    })
  });

  assert.equal(result.status, 'scored');
  assert.equal(result.entries[0].score, 70);
  assert.equal(result.entries[0].judgeReviews[0].overallAssessment, undefined);
  assert.equal(result.entries[0].judgeReviews[0].rationale, '任务结构清楚，但真实数据仍不足。');
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
          rationale: `${reviewer.id} 评语。`,
          uncertainties: []
        }))
      };
    }
  };
}

function v2JudgeResponse(candidateIds, extras = {}) {
  return {
    scenario: {
      dimensions: { problemComplexity: 80, agentSuitability: 60 },
      rationale: '该任务包含多阶段研究，但部分步骤可固定化。',
      uncertainties: [],
      ...extras
    },
    scores: candidateIds.map((candidateId) => ({
      candidateId,
      dimensions: {
        taskCompletion: 90,
        methodProfessionalism: 80,
        evidenceDataQuality: 70,
        riskUncertainty: 60,
        artifactUsability: 50
      },
      rationale: '方法完整且结果可复核。',
      uncertainties: [],
      ...extras
    }))
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
