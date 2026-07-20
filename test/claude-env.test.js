import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDeepSeekClaudeEnv, hasClaudeCredential } from '../src/claude-env.js';

test('maps a DeepSeek key into an isolated Claude Code environment', () => {
  const env = { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_CLAUDE_MODEL: 'test-model' };
  assert.equal(applyDeepSeekClaudeEnv(env), true);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-key');
  assert.equal(env.ANTHROPIC_MODEL, 'test-model');
  assert.equal(hasClaudeCredential(env), true);
});

test('does not mutate Claude settings when no DeepSeek key exists', () => {
  const env = {};
  assert.equal(applyDeepSeekClaudeEnv(env), false);
  assert.deepEqual(env, {});
  assert.equal(hasClaudeCredential(env), false);
});
