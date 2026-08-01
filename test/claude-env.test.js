import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applyArkClaudeEnv,
  applyDeepSeekClaudeEnv,
  applyLlmxClaudeEnv,
  hasClaudeCredential,
  resolveClaudeBackend,
  shouldUseArkClaude
} from '../src/claude-env.js';

test('keeps the repository Claude settings from overriding the environment key with an empty value', async () => {
  const settings = JSON.parse(await readFile('.claude/settings.json', 'utf8'));
  assert.equal(Object.hasOwn(settings.env, 'ANTHROPIC_API_KEY'), false);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://llmx.tqx.ai');
  assert.equal(settings.model, 'claude-sonnet-4-6');
});

test('maps the configured LLMX key and Claude Sonnet model into the isolated Claude Code environment', () => {
  const source = {
    CLAUDE_BACKEND: 'llmx',
    ANTHROPIC_BASE_URL: 'https://llmx.tqx.ai',
    ANTHROPIC_API_KEY: 'test-only-llmx-key',
    ANTHROPIC_MODEL: 'claude-sonnet-4-6'
  };
  const env = { ANTHROPIC_AUTH_TOKEN: 'must-not-survive' };

  assert.equal(resolveClaudeBackend(source), 'llmx');
  assert.equal(hasClaudeCredential(source), true);
  assert.equal(applyLlmxClaudeEnv(env, source), true);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://llmx.tqx.ai');
  assert.equal(env.ANTHROPIC_API_KEY, 'test-only-llmx-key');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-sonnet-4-6');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-sonnet-4-6');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'claude-sonnet-4-6');
  assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '0');
  assert.equal(env.CLAUDE_CODE_USE_FOUNDRY, '0');
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, '0');
  assert.equal(env.ENABLE_TOOL_SEARCH, 'true');
});

test('fails closed when the selected LLMX backend is missing its key, URL, or model', () => {
  for (const source of [
    { CLAUDE_BACKEND: 'llmx', ANTHROPIC_BASE_URL: 'https://llmx.tqx.ai', ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
    { CLAUDE_BACKEND: 'llmx', ANTHROPIC_API_KEY: 'key', ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
    { CLAUDE_BACKEND: 'llmx', ANTHROPIC_BASE_URL: 'https://llmx.tqx.ai', ANTHROPIC_API_KEY: 'key' }
  ]) {
    const env = {};
    assert.equal(hasClaudeCredential(source), false);
    assert.equal(applyLlmxClaudeEnv(env, source), false);
    assert.deepEqual(env, {});
  }
});

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
  const env = {
    CLAUDE_BACKEND: 'deepseek',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_CLAUDE_MODEL: 'test-model'
  };
  assert.equal(hasClaudeCredential(env), true);
  assert.equal(applyDeepSeekClaudeEnv(env), true);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-key');
  assert.equal(env.ANTHROPIC_MODEL, 'test-model');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
});

test('does not mutate Claude settings when no DeepSeek key exists', () => {
  const env = { CLAUDE_BACKEND: 'deepseek' };
  assert.equal(applyDeepSeekClaudeEnv(env), false);
  assert.deepEqual(env, { CLAUDE_BACKEND: 'deepseek' });
  assert.equal(hasClaudeCredential(env), false);
});

test('DeepSeek direct mode replaces every inherited Anthropic endpoint and credential', () => {
  const source = {
    CLAUDE_BACKEND: 'deepseek',
    DEEPSEEK_API_KEY: 'deepseek-only-key',
    DEEPSEEK_CLAUDE_MODEL: 'deepseek-only-model',
    ANTHROPIC_BASE_URL: 'https://wrong-endpoint.example',
    ANTHROPIC_AUTH_TOKEN: 'reviewer-token-must-not-leak',
    ANTHROPIC_API_KEY: 'reviewer-key-must-not-leak'
  };
  const env = {
    ANTHROPIC_BASE_URL: source.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: source.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY
  };

  assert.equal(applyDeepSeekClaudeEnv(env, source), true);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'deepseek-only-key');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-only-model');
});

test('fails closed when the explicitly selected Claude backend is incomplete or unsupported', () => {
  const incompleteArk = {
    CLAUDE_BACKEND: 'ark',
    ARK_BASE_URL: 'https://ark.example/api/v3',
    ARK_API_KEY: ' ',
    CLAUDE_ARK_MODEL: 'ep-deepseek',
    DEEPSEEK_API_KEY: 'must-not-fallback',
    ANTHROPIC_AUTH_TOKEN: 'must-not-fallback'
  };
  assert.equal(resolveClaudeBackend(incompleteArk), 'ark');
  assert.equal(shouldUseArkClaude(incompleteArk), false);
  assert.equal(hasClaudeCredential(incompleteArk), false);

  const incompleteDeepSeek = {
    CLAUDE_BACKEND: 'deepseek',
    DEEPSEEK_API_KEY: ' ',
    ANTHROPIC_API_KEY: 'must-not-fallback'
  };
  assert.equal(resolveClaudeBackend(incompleteDeepSeek), 'deepseek');
  assert.equal(hasClaudeCredential(incompleteDeepSeek), false);

  assert.equal(resolveClaudeBackend({ CLAUDE_BACKEND: 'anthropic' }), null);
  assert.equal(hasClaudeCredential({
    CLAUDE_BACKEND: 'anthropic',
    ANTHROPIC_AUTH_TOKEN: 'must-not-enable-an-unsupported-backend'
  }), false);
});
