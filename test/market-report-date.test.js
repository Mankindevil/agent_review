import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarketReportDate } from '../agents/market-analyst/report-date.js';

function fakePanda(responses) {
  return async (method, params = {}) => {
    const configured = responses[method];
    const data = method === 'get_trade_list'
      && configured
      && !Array.isArray(configured)
      ? configured[params.date]
      : configured;
    return {
      data,
      rowCount: Array.isArray(data) ? data.length : null,
      method,
      provider: 'pandaai',
      truncated: false
    };
  };
}

test('explicit dates remain strict and do not query Panda', async () => {
  const calls = [];
  const result = await resolveMarketReportDate({
    explicitDate: '2026-07-30',
    now: new Date('2026-07-30T05:00:00Z'),
    query: async (...args) => calls.push(args)
  });
  assert.deepEqual(result, {
    requestedDate: '2026-07-30',
    effectiveDate: '2026-07-30',
    mode: 'explicit',
    reason: null
  });
  assert.deepEqual(calls, []);
});

test('an implicit intraday request uses the previous completed trading day', async () => {
  const query = fakePanda({
    get_last_trade_date: '20260730',
    get_prev_trade_date: '20260729',
    get_trade_list: [{ symbol: '000001.SZ', date: '20260729' }]
  });
  const result = await resolveMarketReportDate({
    now: new Date('2026-07-30T05:00:00Z'),
    query
  });
  assert.equal(result.effectiveDate, '2026-07-29');
  assert.equal(result.reason, 'REQUEST_DATE_NOT_COMPLETED');
});

test('an implicit weekend request uses Panda latest trading day', async () => {
  const query = fakePanda({
    get_last_trade_date: '20260724',
    get_trade_list: [{ symbol: '000001.SZ', date: '20260724' }]
  });
  const result = await resolveMarketReportDate({
    now: new Date('2026-07-26T04:00:00Z'),
    query
  });
  assert.equal(result.effectiveDate, '2026-07-24');
});

test('a completed candidate with no universe data falls back once', async () => {
  const query = fakePanda({
    get_last_trade_date: '20260730',
    get_prev_trade_date: '20260729',
    get_trade_list: {
      '20260730': [],
      '20260729': [{ symbol: '000001.SZ', date: '20260729' }]
    }
  });
  const result = await resolveMarketReportDate({
    now: new Date('2026-07-30T08:30:00Z'),
    query
  });
  assert.equal(result.effectiveDate, '2026-07-29');
  assert.equal(result.reason, 'REQUEST_DATE_DATA_UNAVAILABLE');
});

test('rejects an empty or malformed latest trading date', async () => {
  for (const latest of ['', '2026-07-30', '20260230']) {
    await assert.rejects(
      () => resolveMarketReportDate({
        now: new Date('2026-07-30T08:30:00Z'),
        query: fakePanda({ get_last_trade_date: latest })
      }),
      /invalid latest trading date/i
    );
  }
});

test('rejects a future latest trading date', async () => {
  await assert.rejects(
    () => resolveMarketReportDate({
      now: new Date('2026-07-30T08:30:00Z'),
      query: fakePanda({ get_last_trade_date: '20260731' })
    }),
    /future latest trading date/i
  );
});

test('rejects when both the candidate and predecessor have no universe data', async () => {
  await assert.rejects(
    () => resolveMarketReportDate({
      now: new Date('2026-07-30T08:30:00Z'),
      query: fakePanda({
        get_last_trade_date: '20260730',
        get_prev_trade_date: '20260729',
        get_trade_list: { '20260730': [], '20260729': [] }
      })
    }),
    /universe data unavailable/i
  );
});
