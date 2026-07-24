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
  assert.equal(config.principalId, 'panda-market-analyst');
  assert.equal(config.port, 4190);
  assert.deepEqual(config.email.to, ['one@example.com', 'two@example.com']);
  assert.equal(config.smtp.port, 587);
  assert.equal(config.public.accessProtected, true);
  assert.equal('accessToken' in config.public, false);
  assert.equal('password' in config.public.smtp, false);
  assert.throws(
    () => marketAgentConfig({ MARKET_AGENT_PRINCIPAL_ID: 'contains spaces' }),
    /principal/i
  );
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
    schemaVersion: '1.0',
    runId: 'run-1',
    reportDate: '2026-07-23',
    status: 'complete',
    markets: {},
    conclusions: [],
    leaderboards: {},
    sources: [],
    missingData: []
  };
  assert.equal(validateEvidencePack(evidencePack), evidencePack);
  assert.throws(() => validateEvidencePack({}), /Evidence Pack/);
  assert.throws(() => validateEvidencePack({ ...evidencePack, sources: {} }), /arrays/);
  for (const invalid of [
    { ...evidencePack, schemaVersion: 1 },
    { ...evidencePack, schemaVersion: '2.0' },
    { ...evidencePack, runId: '' },
    { ...evidencePack, reportDate: '2026-02-30' },
    { ...evidencePack, status: 'completed' },
    { ...evidencePack, markets: [] },
    { ...evidencePack, leaderboards: [] },
    { ...evidencePack, missingData: {} }
  ]) {
    assert.throws(() => validateEvidencePack(invalid), /Evidence Pack/);
  }
  let deep = {};
  for (let index = 0; index < 40; index += 1) deep = { child: deep };
  assert.throws(() => validateEvidencePack({ ...evidencePack, extension: deep }), /bounds/);
});

test('reuses authoritative Panda enablement readiness and username normalization', () => {
  const config = marketAgentConfig({
    PANDA_DATA_ENABLED: 'true',
    PANDA_DATA_USERNAME: '13800000000',
    PANDA_DATA_PASSWORD: 'secret',
    PANDA_DATA_BASE_URL: '   '
  }, 'C:\\repo');
  assert.equal(config.panda.enabled, true);
  assert.equal(config.panda.ready, true);
  assert.equal(config.panda.username, '8613800000000');
  assert.equal(config.panda.baseUrl, 'http://pandadata.pandaaiquant.com');
  assert.equal(config.public.pandaReady, true);
});

test('traceable evidence rejects dangling lineage, orphan metrics, and bad sums', () => {
  const metric = {
    id: 'metric-sell-1-downside',
    name: 'downside_volume',
    raw: -0.03,
    transformed: 3,
    winsorized: 3,
    percentile: 80,
    originalWeight: 0.25,
    effectiveWeight: 1,
    contribution: 80,
    penalty: 0,
    coverage: 1,
    dataDate: '2026-07-23',
    window: '20d',
    evidenceIds: ['panda-call-1']
  };
  const pack = {
    schemaVersion: '1.0',
    evidenceModelVersion: '2.0',
    runId: 'run-1',
    reportDate: '2026-07-23',
    status: 'degraded',
    markets: {},
    leaderboards: {
      sellPressure: [{
        symbol: '000001.SZ',
        status: 'RANKED',
        score: 80,
        baseScore: 80,
        riskPenalty: 0,
        metrics: [metric]
      }]
    },
    conclusions: [{
      conclusion_id: 'sell-1',
      metricIds: [metric.id],
      evidenceIds: ['panda-call-1'],
      pandaCalls: ['panda-call-1']
    }],
    sources: [{
      id: 'panda-call-1',
      traceCallId: 'panda-call-1',
      method: 'get_stock_daily',
      paramsHash: 'a'.repeat(64),
      fields: ['close'],
      window: '20d',
      dataAsOf: '2026-07-23',
      rowCount: 20,
      coverage: 1,
      cacheStatus: 'miss',
      retryCount: 0,
      truncated: false,
      responseHash: 'b'.repeat(64),
      status: 'ok'
    }],
    missingData: [{ section: 'macro', method: 'unimplemented', status: 'NOT_IMPLEMENTED' }]
  };
  assert.equal(validateEvidencePack(pack), pack);
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      conclusions: [{ ...pack.conclusions[0], pandaCalls: ['missing-call'] }]
    }),
    /dangling|lineage/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      conclusions: [{ ...pack.conclusions[0], metricIds: [] }]
    }),
    /orphan|metric|lineage/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      leaderboards: {
        sellPressure: [{
          ...pack.leaderboards.sellPressure[0],
          baseScore: 79
        }]
      }
    }),
    /contribution|sum/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      sources: [{ ...pack.sources[0], traceCallId: '' }]
    }),
    /traceCallId|call ID/i
  );
});
