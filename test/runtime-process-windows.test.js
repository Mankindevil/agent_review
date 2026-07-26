import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeCliSpawn, runLocalCliProcess } from '../src/runtime-process.js';

test('Windows .exe invocations avoid cmd.exe shell so multiline -p survives', () => {
  const prompt = 'line1\n你正在参加 description-only\n{"name":"x"}';
  const spawn = normalizeCliSpawn(
    'C:\\\\tools\\\\claude.exe',
    ['-p', prompt, '--output-format', 'json'],
    { platform: 'win32', env: { SystemRoot: 'C:\\\\Windows' } }
  );
  assert.equal(spawn.shell, false);
  assert.equal(spawn.command, 'C:\\\\tools\\\\claude.exe');
  assert.equal(spawn.args[1], prompt);
  assert.ok(spawn.args.includes('--output-format'));
});

test('Windows .cmd shims prefer sibling PowerShell -File without shell', () => {
  const ps1 = path.join('C:', 'Users', 'x', 'cursor-agent', 'cursor-agent.ps1');
  const cmd = path.join('C:', 'Users', 'x', 'cursor-agent', 'cursor-agent.cmd');
  const spawn = normalizeCliSpawn(
    cmd,
    ['-p', 'hello\nworld', '--trust', '--force'],
    {
      platform: 'win32',
      env: { SystemRoot: 'C:\\\\Windows' },
      existsSyncImpl: (candidate) => candidate === ps1
    }
  );
  assert.equal(spawn.shell, false);
  assert.match(spawn.command, /powershell\.exe$/i);
  assert.deepEqual(spawn.args.slice(0, 5), [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    ps1
  ]);
  assert.equal(spawn.args[5], '-p');
  assert.equal(spawn.args[6], 'hello\nworld');
});

test('runLocalCliProcess forwards normalized Windows spawn options', async () => {
  const calls = [];
  class FakeChild {
    constructor() {
      this.stdout = { on() {} };
      this.stderr = { on() {} };
      this.pid = 42;
    }

    once(event, handler) {
      if (event === 'close') queueMicrotask(() => handler(0, null));
    }

    kill() {}
  }

  await runLocalCliProcess(
    'C:\\\\tools\\\\claude.exe',
    ['-p', 'a\nb', '--trust'],
    {
      cwd: 'C:\\\\tmp',
      env: { PATH: 'C:\\\\tools', SystemRoot: 'C:\\\\Windows' },
      timeoutMs: 1000,
      platform: 'win32',
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return new FakeChild();
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args[1], 'a\nb');
});
