import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { probeExecutable } from '../src/runtime-status.js';

test('resolves Windows .cmd shims via PATHEXT when the bare name is missing', async () => {
  if (process.platform !== 'win32') return;

  const seen = [];
  const result = await probeExecutable('cursor-agent', {
    env: {
      PATH: 'C:\\tools\\bin',
      PATHEXT: '.COM;.EXE;.BAT;.CMD'
    },
    accessImpl: async (candidate) => {
      seen.push(candidate);
      if (candidate.toLowerCase().endsWith('cursor-agent.cmd')) return;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    execFileImpl: async (command) => {
      assert.match(command.toLowerCase(), /cursor-agent\.cmd$/i);
      return { stdout: '2026.07.23-test\n', stderr: '' };
    },
    createWorkspace: async () => 'C:\\tmp\\probe',
    removeWorkspace: async () => {}
  });

  assert.equal(result.installed, true);
  assert.equal(result.version, '2026.07.23-test');
  assert.equal(
    result.executable.toLowerCase(),
    path.join('C:\\tools\\bin', 'cursor-agent.cmd').toLowerCase()
  );
  assert.ok(seen.some((item) => item.toLowerCase().endsWith('cursor-agent.cmd')));
});
