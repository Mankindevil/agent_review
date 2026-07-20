import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredReviewers, DEFAULT_REVIEWERS, reviewAgent } from '../src/providers.js';

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
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"score":20,"dimensions":{"domainDepth":20,"workflowQuality":20,"failureHandling":20,"outputContract":20,"evaluability":20},"comment":"short","risk":"none"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await reviewAgent({ id: 'doubao', name: '豆包评审', model: 'ep-test', kind: 'openai-compatible', baseUrl: 'https://ark.example/api/v3', apiKeyEnv: 'ARK_API_KEY' }, { name: 'A', description: 'B', skills: [] }, { score: 10 }, 'live');
    assert.equal(result.score, 20);
    assert.deepEqual(requestBody.thinking, { type: 'disabled' });
    assert.equal(requestBody.max_tokens, 777);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
