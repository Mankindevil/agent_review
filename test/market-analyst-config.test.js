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
  assert.equal(config.model.name, 'deepseek-v4-pro[1m]');
  assert.throws(
    () => marketAgentConfig({ MARKET_AGENT_PRINCIPAL_ID: 'contains spaces' }),
    /principal/i
  );
});

test('market narrative model defaults to DeepSeek V4 Pro over Ark credentials', () => {
  const config = marketAgentConfig({
    MARKET_REPORT_MODEL_ENABLED: 'true',
    REVIEW_MODEL_DEEPSEEK: 'ep-deepseek-v4-pro',
    ARK_BASE_URL: 'https://ark.example.com/api/v3',
    ARK_API_KEY: 'ark-secret',
    OPENAI_BASE_URL: 'https://llmx.example.com/v1',
    OPENAI_API_KEY: 'openai-secret',
    REVIEW_MODEL_OPENAI: 'g5.4'
  }, 'C:\\repo');
  assert.equal(config.model.enabled, true);
  assert.equal(config.model.name, 'ep-deepseek-v4-pro');
  assert.equal(config.model.baseUrl, 'https://ark.example.com/api/v3');
  assert.equal(config.model.apiKey, 'ark-secret');
});

test('market narrative model honors explicit market overrides and non-DeepSeek OpenAI routes', () => {
  const overridden = marketAgentConfig({
    MARKET_REPORT_MODEL: 'ep-deepseek-v4-pro',
    MARKET_REPORT_BASE_URL: 'https://market-proxy.example.com/v1',
    MARKET_REPORT_API_KEY: 'market-secret',
    REVIEW_MODEL_DEEPSEEK: 'ep-deepseek-v4-pro',
    ARK_BASE_URL: 'https://ark.example.com/api/v3',
    ARK_API_KEY: 'ark-secret'
  }, 'C:\\repo');
  assert.equal(overridden.model.baseUrl, 'https://market-proxy.example.com/v1');
  assert.equal(overridden.model.apiKey, 'market-secret');

  const openaiRoute = marketAgentConfig({
    MARKET_REPORT_MODEL: 'g5.4',
    OPENAI_BASE_URL: 'https://llmx.example.com/v1',
    OPENAI_API_KEY: 'openai-secret',
    ARK_BASE_URL: 'https://ark.example.com/api/v3',
    ARK_API_KEY: 'ark-secret'
  }, 'C:\\repo');
  assert.equal(openaiRoute.model.name, 'g5.4');
  assert.equal(openaiRoute.model.baseUrl, 'https://llmx.example.com/v1');
  assert.equal(openaiRoute.model.apiKey, 'openai-secret');
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
    evidenceModelVersion: '2.0',
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
  assert.throws(
    () => validateEvidencePack(Object.fromEntries(
      Object.entries(evidencePack).filter(([key]) => key !== 'evidenceModelVersion')
    )),
    /evidenceModelVersion|2\.0/
  );
  assert.throws(
    () => validateEvidencePack({ ...evidencePack, evidenceModelVersion: '2.1' }),
    /evidenceModelVersion|2\.0/
  );
  let deep = {};
  for (let index = 0; index < 40; index += 1) deep = { child: deep };
  assert.throws(() => validateEvidencePack({ ...evidencePack, extension: deep }), /bounds/);
});

test('reuses authoritative Panda enablement readiness and username normalization', () => {
  const config = marketAgentConfig({
    PANDA_DATA_ENABLED: 'true',
    PANDA_DATA_USERNAME: '13800000000',
    PANDA_DATA_PASSWORD: 'secret',
    PANDA_DATA_BASE_URL: '   ',
    PANDA_DATA_PYTHON: 'C:\\python\\python.exe',
    PANDA_DATA_TIMEOUT_MS: '12345',
    PANDA_DATA_MAX_ROWS: '321'
  }, 'C:\\repo');
  assert.equal(config.panda.enabled, true);
  assert.equal(config.panda.ready, true);
  assert.equal(config.panda.username, '8613800000000');
  assert.equal(config.panda.baseUrl, 'http://pandadata.pandaaiquant.com');
  assert.equal(config.python, config.panda.python);
  assert.equal(config.workerTimeoutMs, config.panda.timeoutMs * 10);
  assert.equal(config.panda.maxRows, 321);
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
    sourceRole: 'downside_volume',
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
        weightCoverage: 0.25,
        riskPenalty: 0,
        metrics: [metric]
      }]
    },
    conclusions: [{
      conclusion_id: 'sell-1',
      leaderboard: 'sellPressure',
      entryId: '000001.SZ',
      metricIds: [metric.id],
      evidenceIds: ['panda-call-1'],
      pandaCalls: ['panda-call-1'],
      sourceIds: ['panda-call-1'],
      dataDates: ['2026-07-23'],
      windows: ['20d'],
      stale: false,
      missing: [],
      limitations: [],
      confidence: 1
    }],
    sources: [{
      id: 'panda-call-1',
      traceCallId: 'panda-call-1',
      method: 'get_stock_daily',
      paramsHash: 'a'.repeat(64),
      fields: ['close'],
      window: '2026-07-01/2026-07-23',
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
  const riskMetric = {
    id: 'metric-potential-1-risk-crowding',
    name: 'risk_crowding',
    raw: { turnoverHeat: 3.5 },
    transformed: 3.5,
    winsorized: 3.5,
    percentile: 100,
    originalWeight: 0,
    effectiveWeight: 0,
    contribution: 0,
    penalty: 5,
    coverage: 1,
    dataDate: '2026-07-23',
    window: '20d',
    sourceRole: 'risk_crowding',
    evidenceIds: ['panda-call-1']
  };
  const packWithRiskLineage = {
    ...pack,
    leaderboards: {
      sellPressure: [{
        ...pack.leaderboards.sellPressure[0],
        riskPenalty: 5,
        score: 75,
        metrics: [metric, riskMetric]
      }]
    },
    conclusions: [{
      ...pack.conclusions[0],
      metricIds: [metric.id, riskMetric.id]
    }]
  };
  assert.equal(validateEvidencePack(packWithRiskLineage), packWithRiskLineage);
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
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      sources: [{
        ...pack.sources[0],
        status: 'error',
        responseHash: null
      }]
    }),
    /usable|successful|source/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      sources: [{ ...pack.sources[0], truncated: true }]
    }),
    /usable|truncat|source/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      sources: [{ ...pack.sources[0], dataAsOf: '2026-02-30' }]
    }),
    /date|source/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      sources: [{ ...pack.sources[0], method: 'get_margin' }]
    }),
    /role|method|source/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      leaderboards: {
        sellPressure: [{
          ...pack.leaderboards.sellPressure[0],
          metrics: [{
            ...metric,
            effectiveWeight: 0.9,
            contribution: 72
          }],
          baseScore: 72,
          score: 72
        }]
      }
    }),
    /weight|sum/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      leaderboards: {
        sellPressure: [{
          ...pack.leaderboards.sellPressure[0],
          metrics: [{
            ...metric,
            percentile: 120,
            contribution: 120
          }],
          baseScore: 120,
          score: 120
        }]
      }
    }),
    /percentile|range|metric/i
  );
  assert.throws(
    () => validateEvidencePack({
      ...pack,
      leaderboards: {
        sellPressure: [{
          ...pack.leaderboards.sellPressure[0],
          riskPenalty: 5,
          score: 75
        }]
      }
    }),
    /penalty|risk|lineage/i
  );
});
