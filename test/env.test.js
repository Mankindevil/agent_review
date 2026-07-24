import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('environment example documents the complete market analyst contract safely', async () => {
  const text = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const values = parseEnvText(text);
  const required = [
    'PANDA_DATA_ENABLED',
    'PANDA_DATA_USERNAME',
    'PANDA_DATA_PASSWORD',
    'PANDA_DATA_BASE_URL',
    'PANDA_DATA_PYTHON',
    'PANDA_DATA_TIMEOUT_MS',
    'MARKET_AGENT_HOST',
    'MARKET_AGENT_PORT',
    'MARKET_AGENT_PUBLIC_BASE_URL',
    'MARKET_AGENT_ACCESS_TOKEN',
    'MARKET_AGENT_PRINCIPAL_ID',
    'MARKET_AGENT_ALLOW_INSECURE_LOOPBACK',
    'MARKET_REPORT_TIMEZONE',
    'MARKET_REPORT_STATE_DIR',
    'MARKET_REPORT_EMAIL_TO',
    'MARKET_REPORT_EMAIL_FROM',
    'MARKET_REPORT_SMTP_HOST',
    'MARKET_REPORT_SMTP_PORT',
    'MARKET_REPORT_SMTP_SECURE',
    'MARKET_REPORT_SMTP_STARTTLS',
    'MARKET_REPORT_SMTP_USERNAME',
    'MARKET_REPORT_SMTP_PASSWORD',
    'MARKET_REPORT_SEND_FAILURE_ALERTS',
    'MARKET_REPORT_MODEL_ENABLED',
    'MARKET_REPORT_MODEL',
    'MARKET_REPORT_MODEL_PRICING_JSON',
    'MARKET_REPORT_RETENTION_DAYS',
    'MARKET_REPORT_CACHE_DAYS',
    'MARKET_REPORT_MIN_LIQUIDITY_CNY',
    'MARKET_SMOKE_REPORT_DATE',
    'MARKET_SMOKE_STATE_DIR',
    'MARKET_SMOKE_EMAIL_TO'
  ];
  for (const name of required) {
    assert.ok(Object.hasOwn(values, name), `${name} is documented`);
  }
  for (const name of [
    'PANDA_DATA_USERNAME',
    'PANDA_DATA_PASSWORD',
    'MARKET_AGENT_PUBLIC_BASE_URL',
    'MARKET_AGENT_ACCESS_TOKEN',
    'MARKET_REPORT_EMAIL_TO',
    'MARKET_REPORT_EMAIL_FROM',
    'MARKET_REPORT_SMTP_HOST',
    'MARKET_REPORT_SMTP_USERNAME',
    'MARKET_REPORT_SMTP_PASSWORD',
    'MARKET_REPORT_MODEL_PRICING_JSON',
    'MARKET_SMOKE_REPORT_DATE',
    'MARKET_SMOKE_STATE_DIR',
    'MARKET_SMOKE_EMAIL_TO'
  ]) {
    assert.equal(values[name], '', `${name} must not contain a committed value`);
  }
  assert.equal(values.PANDA_DATA_ENABLED, 'false');
  assert.equal(values.MARKET_AGENT_HOST, '127.0.0.1');
  assert.equal(values.MARKET_AGENT_PRINCIPAL_ID, 'panda-market-analyst');
  assert.equal(values.MARKET_AGENT_ALLOW_INSECURE_LOOPBACK, 'false');
  assert.equal(values.MARKET_REPORT_TIMEZONE, 'Asia/Shanghai');
});
