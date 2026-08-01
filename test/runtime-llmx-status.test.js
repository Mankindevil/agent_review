import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeStatus } from '../src/runtime-status.js';

test('reports a credentialed LLMX Claude Code runtime with its friendly backend name', async () => {
  const status = await getRuntimeStatus({
    env: {
      ENABLE_LOCAL_CLAUDE_CODE: 'true',
      CLAUDE_BACKEND: 'llmx',
      ANTHROPIC_BASE_URL: 'https://llmx.tqx.ai',
      ANTHROPIC_API_KEY: 'test-only-key',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6'
    },
    probeExecutableImpl: async (command) => ({
      installed: command === 'claude',
      executable: command === 'claude' ? '/opt/tools/claude' : null,
      version: command === 'claude' ? '2.1.218' : null
    }),
    probeCursorAuthImpl: async () => false,
    liveProbe: async (runtimeId) => runtimeId === 'claude-code'
  });

  assert.equal(status[0].id, 'claude-code');
  assert.equal(status[0].authenticated, true);
  assert.equal(status[0].runtimeReady, true);
  assert.match(status[0].note, /LLMX · Claude Sonnet 4\.6/u);
});
