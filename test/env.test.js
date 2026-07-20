import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnv, parseEnvText } from '../src/env.js';

test('parses comments, exports, quotes and equals signs in env text', () => {
  const values = parseEnvText(`
    # comment
    PORT=4173
    export FEATURE=true # local override
    URL="https://example.com/a?x=1&y=2"
    SINGLE='keep # literal'
    MULTILINE="first\\nsecond"
    EMPTY=
  `);

  assert.deepEqual(values, {
    PORT: '4173',
    FEATURE: 'true',
    URL: 'https://example.com/a?x=1&y=2',
    SINGLE: 'keep # literal',
    MULTILINE: 'first\nsecond',
    EMPTY: ''
  });
});

test('process-style environment variables take precedence over env file values', () => {
  const target = { PORT: '9000' };
  const applied = applyEnv({ PORT: '4173', NODE_ENV: 'development' }, target);

  assert.deepEqual(target, { PORT: '9000', NODE_ENV: 'development' });
  assert.deepEqual(applied, ['NODE_ENV']);
});
