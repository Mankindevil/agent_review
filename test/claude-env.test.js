import test from 'node:test';
import assert from 'node:assert/strict';
import { applyArkClaudeEnv, applyDeepSeekClaudeEnv, hasClaudeCredential, shouldUseArkClaude } from '../src/claude-env.js';

test('prefers a configured Ark DeepSeek endpoint for Claude Code', () => {
  const env = {
    CLAUDE_BACKEND: 'ark', ARK_BASE_URL: 'https://ark.example/api/v3', ARK_API_KEY: 'ark-key',
    CLAUDE_ARK_MODEL: 'ep-deepseek'
  };
  assert.equal(shouldUseArkClaude(env), true);
  assert.equal(hasClaudeCredential(env), true);
  applyArkClaudeEnv(env, 'http://127.0.0.1:45678');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45678');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'local-ark-proxy');
  assert.equal(env.ANTHROPIC_MODEL, 'ep-deepseek');
});

test('maps a DeepSeek key into an isolated Claude Code environment', () => {
  const env = { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_CLAUDE_MODEL: 'test-model' };
  assert.equal(applyDeepSeekClaudeEnv(env), true);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-key');
  assert.equal(env.ANTHROPIC_MODEL, 'test-model');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(hasClaudeCredential(env), true);
});

test('does not mutate Claude settings when no DeepSeek key exists', () => {
  const env = {};
  assert.equal(applyDeepSeekClaudeEnv(env), false);
  assert.deepEqual(env, {});
  assert.equal(hasClaudeCredential(env), false);
});
