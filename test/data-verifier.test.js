import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDataPlan, collectDataEvidence, normalizeTestCases, verifyOutputAgainstEvidence } from '../src/data-verifier.js';
import { judgeOutput } from '../src/scoring.js';

const explicitCase = {
  name: '指数锚点',
  prompt: '报告期末收盘点位',
  dataQueries: [{
    id: 'index-close', label: '指数日线', method: 'get_index_daily',
    params: { symbol: ['000300.SH'], start_date: '20250101', end_date: '20250110', fields: [] },
    requiredFields: ['date', 'symbol', 'close'],
    facts: [{ label: '沪深 300 期末收盘', field: 'close', where: 'last', aliases: ['期末收盘'], tolerance: 0.01 }]
  }]
};

test('infers a bounded PandaAI index anchor from a dated financial prompt', () => {
  const plan = buildDataPlan({ prompt: '回测沪深 300，样本期 2019-01-01 至 2024-12-31。' });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].method, 'get_index_daily');
  assert.deepEqual(plan[0].params.symbol, ['000300.SH']);
  assert.equal(plan[0].params.end_date, '20241231');
  assert.equal(plan[0].facts[0].required, false);
});

test('validates declarative data query limits before an evaluation starts', () => {
  assert.throws(() => normalizeTestCases([{ prompt: 'x', dataQueries: [{}, {}, {}, {}] }]), (error) => error.statusCode === 400);
  assert.throws(() => normalizeTestCases([{ prompt: 'x', dataQueries: [{ method: 'get_index_daily', params: [] }] }]), /params 必须是对象/);
});

test('locks a compact snapshot and resolves facts from date-sorted rows', async () => {
  const [testCase] = normalizeTestCases([explicitCase]);
  const evidence = await collectDataEvidence(testCase, {
    enabled: true,
    query: async () => ({
      provider: 'pandaai', method: 'get_index_daily', rowCount: 2, truncated: false,
      data: [
        { symbol: '000300.SH', date: '20250110', close: 11.3 },
        { symbol: '000300.SH', date: '20250109', close: 11.1 }
      ]
    })
  });
  assert.equal(evidence.status, 'ready');
  assert.equal(evidence.queries[0].sample.length, 2);
  assert.equal(evidence.queries[0].facts[0].value, 11.3);
  assert.equal(evidence.queries[0].fingerprint.length, 64);
});

test('distinguishes verified, contradicted and missing output facts', async () => {
  const [testCase] = normalizeTestCases([explicitCase]);
  const evidence = await collectDataEvidence(testCase, {
    enabled: true,
    query: async () => ({ rowCount: 1, data: [{ symbol: '000300.SH', date: '20250110', close: 11.3 }] })
  });
  const verified = verifyOutputAgainstEvidence('期末收盘为 11.30 点。', evidence);
  const contradicted = verifyOutputAgainstEvidence('期末收盘为 12.30 点。', evidence);
  const missing = verifyOutputAgainstEvidence('没有可用行情。', evidence);
  assert.equal(verified.status, 'verified');
  assert.equal(contradicted.status, 'contradicted');
  assert.equal(missing.status, 'missing');
  assert.ok(judgeOutput('报告行情', '数据来源明确，期末收盘为 11.30 点。', 'same', verified).dimensions.dataEvidence > judgeOutput('报告行情', '数据来源明确，期末收盘为 12.30 点。', 'same', contradicted).dimensions.dataEvidence);
});

test('does not penalize an unclaimed automatic anchor', async () => {
  const testCase = { prompt: '回测沪深 300，截止 2025-01-10。' };
  const evidence = await collectDataEvidence(testCase, {
    enabled: true,
    query: async () => ({ rowCount: 1, data: [{ symbol: '000300.SH', date: '20250110', close: 3934.91 }] })
  });
  const verification = verifyOutputAgainstEvidence('按历史成分完成回测，未报告指数点位。', evidence);
  assert.equal(verification.status, 'not-claimed');
  assert.equal(verification.score, null);
});
