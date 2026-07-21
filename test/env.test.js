import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyEnv, loadFallbackEnv, parseEnvText } from '../src/env.js';

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

test('fallback env fills missing values without replacing branch-specific settings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-roast-env-'));
  const fallbackFile = path.join(directory, 'shared.env');
  await writeFile(fallbackFile, 'OPENAI_API_KEY=shared-key\nPANDA_DATA_ENABLED=false\n', 'utf8');
  const target = { ENV_FALLBACK_FILE: fallbackFile, PANDA_DATA_ENABLED: 'true' };

  try {
    const result = await loadFallbackEnv(target);
    assert.equal(result.loaded, true);
    assert.equal(target.OPENAI_API_KEY, 'shared-key');
    assert.equal(target.PANDA_DATA_ENABLED, 'true');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
