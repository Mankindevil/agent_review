import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePythonCommand } from '../scripts/run-market-worker-tests.js';

const root = path.resolve('fixture-root');
const windowsVenv = path.join(root, '.venv', 'Scripts', 'python.exe');
const posixVenv = path.join(root, '.venv', 'bin', 'python');

test('prefers an explicit Panda Python over every discovered interpreter', () => {
  const command = resolvePythonCommand({
    env: { PANDA_DATA_PYTHON: 'C:\\Python\\panda.exe' },
    platform: 'win32',
    cwd: root,
    exists: () => true,
    commandExists: () => true
  });

  assert.equal(command, 'C:\\Python\\panda.exe');
});

test('prefers the repository virtualenv on Windows and POSIX', () => {
  assert.equal(resolvePythonCommand({
    env: {},
    platform: 'win32',
    cwd: root,
    exists: (candidate) => candidate === windowsVenv,
    commandExists: () => true
  }), windowsVenv);
  assert.equal(resolvePythonCommand({
    env: {},
    platform: 'linux',
    cwd: root,
    exists: (candidate) => candidate === posixVenv,
    commandExists: () => true
  }), posixVenv);
});

test('prefers Windows python before py and falls back to py', () => {
  assert.equal(resolvePythonCommand({
    env: {},
    platform: 'win32',
    cwd: root,
    exists: () => false,
    commandExists: (candidate) => ['python', 'py'].includes(candidate)
  }), 'python');
  assert.equal(resolvePythonCommand({
    env: {},
    platform: 'win32',
    cwd: root,
    exists: () => false,
    commandExists: (candidate) => candidate === 'py'
  }), 'py');
});

test('uses python3 on POSIX and reports a missing interpreter clearly', () => {
  assert.equal(resolvePythonCommand({
    env: {},
    platform: 'linux',
    cwd: root,
    exists: () => false,
    commandExists: (candidate) => candidate === 'python3'
  }), 'python3');
  assert.throws(
    () => resolvePythonCommand({
      env: {},
      platform: 'win32',
      cwd: root,
      exists: () => false,
      commandExists: () => false
    }),
    /PANDA_DATA_PYTHON|Python interpreter/i
  );
});
