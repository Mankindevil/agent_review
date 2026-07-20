import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredReviewers, DEFAULT_REVIEWERS } from '../src/providers.js';

const names = ['MODEL_REVIEWERS_JSON', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'REVIEW_MODEL_OPENAI', 'REVIEW_MODEL_ANTHROPIC', 'REVIEW_MODEL_DEEPSEEK'];
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
  assert.equal(configuredReviewers(), DEFAULT_REVIEWERS);
});

test('builds three independent reviewers from the compatible gateway env', () => {
  delete process.env.MODEL_REVIEWERS_JSON;
  process.env.OPENAI_BASE_URL = 'https://llmx.tqx.ai/v1';
  process.env.OPENAI_API_KEY = 'test-only-key';
  process.env.REVIEW_MODEL_OPENAI = 'g5.4';
  process.env.REVIEW_MODEL_ANTHROPIC = 'cs4.6';
  process.env.REVIEW_MODEL_DEEPSEEK = 'dkc';
  const reviewers = configuredReviewers();
  assert.deepEqual(reviewers.map((reviewer) => reviewer.model), ['g5.4', 'cs4.6', 'dkc']);
  assert.equal(reviewers.every((reviewer) => reviewer.baseUrl === 'https://llmx.tqx.ai/v1'), true);
  assert.equal(reviewers.every((reviewer) => reviewer.apiKeyEnv === 'OPENAI_API_KEY'), true);
});
