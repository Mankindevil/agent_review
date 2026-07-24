import test from 'node:test';
import assert from 'node:assert/strict';
import { marketAgentConfig } from '../agents/market-analyst/config.js';
import { validateEvidencePack, validateOperation } from '../agents/market-analyst/schemas.js';

test('builds non-secret market agent configuration with Shanghai defaults', () => {
  const config = marketAgentConfig({
    PANDA_DATA_PYTHON: 'python-test',
    MARKET_AGENT_ACCESS_TOKEN: 'secret',
    MARKET_REPORT_EMAIL_TO: 'one@example.com,two@example.com',
    MARKET_REPORT_SMTP_HOST: 'smtp.example.com',
    MARKET_REPORT_SMTP_PORT: '587',
    MARKET_REPORT_SMTP_USERNAME: 'mailer',
    MARKET_REPORT_SMTP_PASSWORD: 'mail-secret'
  }, 'C:\\repo');
  assert.equal(config.timezone, 'Asia/Shanghai');
  assert.equal(config.port, 4190);
  assert.deepEqual(config.email.to, ['one@example.com', 'two@example.com']);
  assert.equal(config.smtp.port, 587);
  assert.equal(config.public.accessProtected, true);
  assert.equal('accessToken' in config.public, false);
  assert.equal('password' in config.public.smtp, false);
});

test('accepts declared operations and rejects arbitrary Panda methods', () => {
  assert.deepEqual(validateOperation({
    operation: 'daily-market-report',
    date: '2026-07-23',
    topN: 10
  }), { operation: 'daily-market-report', date: '2026-07-23', sections: [], topN: 10 });
  assert.throws(() => validateOperation({ operation: 'get_stock_daily' }), /不支持的 operation/);
  assert.throws(() => validateOperation({ operation: 'daily-market-report', topN: 500 }), /topN/);
});

test('requires evidence pack fields and array evidence collections', () => {
  const evidencePack = {
    schemaVersion: 1,
    runId: 'run-1',
    reportDate: '2026-07-23',
    status: 'completed',
    markets: {},
    conclusions: [],
    leaderboards: {},
    sources: []
  };
  assert.equal(validateEvidencePack(evidencePack), evidencePack);
  assert.throws(() => validateEvidencePack({}), /Evidence Pack/);
  assert.throws(() => validateEvidencePack({ ...evidencePack, sources: {} }), /arrays/);
});
