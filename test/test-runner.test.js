import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTestFiles } from '../scripts/run-tests.js';

test('selectTestFiles limits automatic discovery to root test files', () => {
  assert.deepEqual(
    selectTestFiles(
      ['test/a2a.test.js', '.worktrees/old/test/a2a.test.js', 'src/a2a.js'],
      []
    ),
    ['test/a2a.test.js']
  );
  assert.deepEqual(
    selectTestFiles(['test/a.test.js'], ['test/providers.test.js']),
    ['test/providers.test.js']
  );
});
