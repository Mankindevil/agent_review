import test from 'node:test';
import assert from 'node:assert/strict';

const runtimeConfigModule = await import('../src/runtime-config.js').catch(() => ({}));

test('uses one strict adapter schema and never accepts remote local-cli execution', () => {
  const { resolveRuntimeConfig } = runtimeConfigModule;
  assert.equal(typeof resolveRuntimeConfig, 'function');

  const bypass = {
    RUNTIME_ADAPTERS_JSON: JSON.stringify({
      cursor: { kind: 'local-cli', command: 'attacker-controlled' }
    }),
    ENABLE_LOCAL_CURSOR_AGENT: 'false'
  };
  assert.equal(resolveRuntimeConfig('cursor', bypass), null);

  bypass.ENABLE_LOCAL_CURSOR_AGENT = 'true';
  assert.deepEqual(resolveRuntimeConfig('cursor', bypass), {
    source: 'local',
    kind: 'local-cli',
    command: 'cursor-agent'
  });
});

test('malformed or invalid remote configuration falls back consistently', () => {
  const { resolveRuntimeConfig } = runtimeConfigModule;
  assert.equal(typeof resolveRuntimeConfig, 'function');

  assert.equal(resolveRuntimeConfig('claude-code', {
    RUNTIME_ADAPTERS_JSON: '{"claude-code":',
    ENABLE_LOCAL_CLAUDE_CODE: 'true'
  })?.command, 'claude');

  const ark = resolveRuntimeConfig('doubao', {
    RUNTIME_ADAPTERS_JSON: JSON.stringify({
      doubao: { kind: 'remote-http', url: 'ftp://invalid.example' }
    }),
    ARK_BASE_URL: 'https://ark.example/api/v3',
    ARK_API_KEY: 'ark-key',
    REVIEW_MODEL_DOUBAO: 'ep-doubao'
  });
  assert.equal(ark?.source, 'builtin');
  assert.equal(ark?.kind, 'model-api');
});

test('keeps remote enablement independent from own-property authentication', () => {
  const { resolveRuntimeConfig, runtimeConfigAuthenticated } = runtimeConfigModule;
  assert.equal(typeof resolveRuntimeConfig, 'function');
  assert.equal(typeof runtimeConfigAuthenticated, 'function');

  const inherited = Object.create({ RUNTIME_TEST_KEY: 'prototype-must-not-count' });
  inherited.RUNTIME_ADAPTERS_JSON = JSON.stringify({
    cursor: {
      kind: 'remote-http',
      url: 'https://runtime.example/cursor',
      apiKeyEnv: 'RUNTIME_TEST_KEY'
    }
  });
  const config = resolveRuntimeConfig('cursor', inherited);
  assert.equal(config?.source, 'remote');
  assert.equal(config?.kind, 'remote-http');
  assert.equal(runtimeConfigAuthenticated(config, inherited), false);

  inherited.RUNTIME_TEST_KEY = 'own-secret';
  assert.equal(runtimeConfigAuthenticated(config, inherited), true);
});

test('requires an explicit supported kind for remote adapters', () => {
  const { resolveRuntimeConfig } = runtimeConfigModule;
  assert.equal(typeof resolveRuntimeConfig, 'function');
  for (const adapter of [
    { url: 'https://runtime.example/cursor' },
    { kind: 'unknown', url: 'https://runtime.example/cursor' },
    { kind: 'remote-http', url: 'not-a-url' },
    { kind: 'model-api', baseUrl: 'https://runtime.example/v1', apiKeyEnv: 'KEY', model: '' }
  ]) {
    const config = resolveRuntimeConfig('cursor', {
      RUNTIME_ADAPTERS_JSON: JSON.stringify({ cursor: adapter })
    });
    assert.equal(config, null, JSON.stringify(adapter));
  }
});
