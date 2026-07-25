import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configuredArenaReviewers,
  configuredReviewPanel,
  configuredReviewers,
  DEFAULT_REVIEWERS,
  normalizeProfessionalReview,
  requestJson,
  requestReviewerWithFallback,
  reviewAgent
} from '../src/providers.js';

const names = ['MODEL_REVIEWERS_JSON', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ARK_BASE_URL', 'ARK_API_KEY', 'REVIEW_MODEL_OPENAI', 'REVIEW_MODEL_ANTHROPIC', 'REVIEW_MODEL_DOUBAO', 'REVIEW_MODEL_DEEPSEEK', 'MODEL_REVIEW_TIMEOUT_MS', 'MODEL_REVIEW_MAX_TOKENS'];
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

test.after(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

test('keeps demo reviewers until the gateway key is configured', () => {
  delete process.env.MODEL_REVIEWERS_JSON;
  process.env.OPENAI_BASE_URL = 'https://llmx.tqx.ai/v1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ARK_API_KEY;
  assert.equal(configuredReviewers(), DEFAULT_REVIEWERS);
});

test('enables Ark reviewers independently while LLMX stays in demo mode', () => {
  delete process.env.MODEL_REVIEWERS_JSON;
  delete process.env.OPENAI_API_KEY;
  process.env.ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
  process.env.ARK_API_KEY = 'test-only-ark-key';
  const reviewers = configuredReviewers();
  assert.deepEqual(reviewers.map((reviewer) => reviewer.kind), ['mock', 'mock', 'openai-compatible', 'openai-compatible']);
  assert.deepEqual(reviewers.slice(2).map((reviewer) => reviewer.apiKeyEnv), ['ARK_API_KEY', 'ARK_API_KEY']);
});

test('builds four independent reviewers from LLMX and Ark gateway env', () => {
  delete process.env.MODEL_REVIEWERS_JSON;
  process.env.OPENAI_BASE_URL = 'https://llmx.tqx.ai/v1';
  process.env.OPENAI_API_KEY = 'test-only-key';
  process.env.ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
  process.env.ARK_API_KEY = 'test-only-ark-key';
  process.env.REVIEW_MODEL_OPENAI = 'g5.4';
  process.env.REVIEW_MODEL_ANTHROPIC = 'cs4.6';
  process.env.REVIEW_MODEL_DOUBAO = 'ep-20260720110725-5rbml';
  process.env.REVIEW_MODEL_DEEPSEEK = 'ep-20260708162855-pcf9x';
  const reviewers = configuredReviewers();
  assert.deepEqual(reviewers.map((reviewer) => reviewer.model), ['g5.4', 'cs4.6', 'ep-20260720110725-5rbml', 'ep-20260708162855-pcf9x']);
  assert.deepEqual(reviewers.map((reviewer) => reviewer.baseUrl), ['https://llmx.tqx.ai/v1', 'https://llmx.tqx.ai/v1', 'https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3']);
  assert.deepEqual(reviewers.map((reviewer) => reviewer.apiKeyEnv), ['OPENAI_API_KEY', 'OPENAI_API_KEY', 'ARK_API_KEY', 'ARK_API_KEY']);
});

test('disables deep thinking and caps output for the Doubao short-form review', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  process.env.ARK_API_KEY = 'test-only-ark-key';
  process.env.MODEL_REVIEW_TIMEOUT_MS = '9000';
  process.env.MODEL_REVIEW_MAX_TOKENS = '777';
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"score":20,"dimensions":{"researchRigor":20,"dataDiscipline":20,"backtestIntegrity":20,"riskCompliance":20,"reproducibility":20},"comment":"short","risk":"none"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await reviewAgent({ id: 'doubao', name: '豆包评审', model: 'ep-test', kind: 'openai-compatible', baseUrl: 'https://ark.example/api/v3', apiKeyEnv: 'ARK_API_KEY' }, { name: 'A', description: 'B', skills: [] }, { score: 10 }, 'live', undefined, { seed: 73021, temperature: 0 });
    assert.equal(result.score, 20);
    assert.deepEqual(requestBody.thinking, { type: 'disabled' });
    assert.equal(requestBody.max_tokens, 777);
    assert.equal(requestBody.seed, 73021);
    assert.equal(requestBody.temperature, 0);
    assert.equal(result.seed, 73021);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects reviewer payloads that violate the scoring contract', () => {
  const valid = { score: 80, dimensions: { researchRigor: 80, dataDiscipline: 80, backtestIntegrity: 80, riskCompliance: 80, reproducibility: 80 }, comment: 'clear', risk: 'known' };
  assert.equal(normalizeProfessionalReview(valid).score, 80);
  assert.throws(() => normalizeProfessionalReview({ ...valid, score: 130 }), /0–100/);
  assert.throws(() => normalizeProfessionalReview({ ...valid, dimensions: { ...valid.dimensions, reproducibility: '80' } }), /0–100/);
  assert.throws(() => normalizeProfessionalReview({ ...valid, comment: '' }), /comment/);
});

test('configures exactly four primary reviewers and one distinct arbitrator', () => {
  const reviewer = (id, model) => ({
    id,
    name: id,
    kind: 'openai-compatible',
    baseUrl: `https://${id}.models.example/v1`,
    model,
    apiKeyEnv: `${id.toUpperCase()}_KEY`
  });
  const env = {
    A_KEY: 'secret-a',
    B_KEY: 'secret-b',
    C_KEY: 'secret-c',
    D_KEY: 'secret-d',
    E_KEY: 'secret-e',
    MODEL_REVIEW_PANEL_JSON: JSON.stringify({
      version: 'panel-v1',
      primary: [
        reviewer('a', 'model-a'),
        reviewer('b', 'model-b'),
        reviewer('c', 'model-c'),
        reviewer('d', 'model-d')
      ],
      arbitrator: reviewer('e', 'model-e'),
      fallbacks: []
    })
  };

  const panel = configuredReviewPanel(env);
  assert.equal(panel.primary.length, 4);
  assert.equal(panel.arbitrator.id, 'e');
  assert.equal(new Set([
    ...panel.primary.map((item) => item.identityKey),
    panel.arbitrator.identityKey
  ]).size, 5);
  assert.equal(JSON.stringify(panel).includes('secret-a'), false);
});

test('fails closed for duplicate identities, literal secrets, or incomplete live panels', () => {
  const base = {
    id: 'same',
    name: 'same',
    kind: 'openai-compatible',
    baseUrl: 'https://models.example/v1',
    model: 'model-a',
    apiKeyEnv: 'MODEL_KEY'
  };
  const makeEnv = (primary, arbitrator) => ({
    MODEL_KEY: 'configured',
    MODEL_REVIEW_PANEL_JSON: JSON.stringify({
      version: 'panel-v1',
      primary,
      arbitrator,
      fallbacks: []
    })
  });

  assert.throws(
    () => configuredReviewPanel(makeEnv(
      [base, base, { ...base, id: 'c' }, { ...base, id: 'd' }],
      { ...base, id: 'e' }
    )),
    /distinct|duplicate|identity/iu
  );
  assert.throws(
    () => configuredReviewPanel(makeEnv(
      [0, 1, 2, 3].map((index) => ({
        ...base,
        id: `p${index}`,
        baseUrl: `https://p${index}.example/v1`,
        apiKey: 'literal-secret'
      })),
      { ...base, id: 'e', baseUrl: 'https://e.example/v1' }
    )),
    /literal|apiKey/iu
  );
  assert.throws(
    () => configuredReviewPanel(makeEnv([base], { ...base, id: 'e' })),
    /four|4|primary/iu
  );
});

test('provides five deterministic mock identities when no live panel is configured', () => {
  const panel = configuredReviewPanel({});
  assert.equal(panel.mode, 'demo');
  assert.equal(panel.primary.length, 4);
  assert.equal(panel.arbitrator.kind, 'mock');
  assert.equal(new Set([
    ...panel.primary.map((item) => item.identityKey),
    panel.arbitrator.identityKey
  ]).size, 5);
});

test('arena reuses exactly the frozen primary panel identities and excludes arbitration', () => {
  const reviewer = (id, model) => ({
    id,
    name: id,
    kind: 'openai-compatible',
    baseUrl: `https://${id}.models.example/v1`,
    model,
    apiKeyEnv: `${id.toUpperCase()}_KEY`
  });
  const env = {
    A_KEY: 'a', B_KEY: 'b', C_KEY: 'c', D_KEY: 'd', E_KEY: 'e', FALLBACK_KEY: 'f',
    MODEL_REVIEW_PANEL_JSON: JSON.stringify({
      version: 'panel-v1',
      primary: ['a', 'b', 'c', 'd'].map((id) => reviewer(id, `model-${id}`)),
      arbitrator: reviewer('e', 'model-e'),
      fallbacks: [reviewer('fallback', 'model-f')]
    })
  };

  const panel = configuredReviewPanel(env);
  const arena = configuredArenaReviewers(env);
  assert.deepEqual(arena, panel.primary);
  assert.equal(arena.some((item) => item.id === 'e' || item.id === 'fallback'), false);
  assert.equal(Object.isFrozen(arena), true);
});

test('requestJson uses the shared live adapter and caller sampling limits', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.PANEL_TEST_KEY = 'test-secret';
  try {
    const result = await requestJson({
      id: 'panel',
      name: 'Panel',
      kind: 'openai-compatible',
      baseUrl: 'https://models.example/v1',
      model: 'model-v1',
      apiKeyEnv: 'PANEL_TEST_KEY'
    }, 'system', 'prompt', undefined, {
      seed: 77,
      temperature: 0,
      maxTokens: 4321
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(body.max_tokens, 4321);
    assert.equal(body.seed, 77);
  } finally {
    delete process.env.PANEL_TEST_KEY;
    globalThis.fetch = originalFetch;
  }
});

test('retries the same reviewer before using one pre-registered fallback', async () => {
  const calls = [];
  const result = await requestReviewerWithFallback({
    reviewer: { id: 'primary' },
    fallbacks: [{ id: 'fallback' }],
    maxSameReviewerAttempts: 2,
    invoke: async (reviewer) => {
      calls.push(reviewer.id);
      if (calls.length < 3) throw new Error('temporary failure');
      return { ok: true };
    }
  });

  assert.deepEqual(calls, ['primary', 'primary', 'fallback']);
  assert.equal(result.reviewer.id, 'fallback');
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.failures.length, 2);
});
