import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCursorAuthentication } from '../src/runtime-status.js';

test('allows Cursor status enough time to refresh account authentication', async () => {
  let observedTimeout;
  const authenticated = await probeCursorAuthentication('/runtime/bin/cursor-agent', {
    env: {
      PATH: '/runtime/bin',
      CURSOR_AUTH_CONFIG_HOME: '/var/lib/agent-review/cursor-auth'
    },
    execFileImpl: async (_command, _args, options) => {
      observedTimeout = options.timeout;
      return { stdout: 'Logged in as production-reviewer\n', stderr: '' };
    },
    createWorkspace: async () => '/tmp/cursor-auth-probe',
    removeWorkspace: async () => {}
  });

  assert.equal(observedTimeout, 30_000);
  assert.equal(authenticated, true);
});
