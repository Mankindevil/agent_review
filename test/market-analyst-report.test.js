import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  REPORT_SECTIONS,
  renderReport,
  renderRunDetail
} from '../agents/market-analyst/report-renderer.js';
import { validateReport } from '../agents/market-analyst/report-validator.js';
import { generateNarrative } from '../agents/market-analyst/narrative-adapter.js';

function evidence(overrides = {}) {
  return {
    schemaVersion: '1.0',
    runId: 'run-20260723',
    reportDate: '2026-07-23',
    status: 'complete',
    markets: {
      aShare: {
        dataDate: '2026-07-23',
        rowCount: 2,
        indices: [{ symbol: '000001.SH', name: '上证指数', close: 3582.3, changePct: 0.8 }],
        breadth: { advances: 3200, declines: 1800 },
        turnoverCny: 1_250_000_000_000
      },
      us: { dataDate: '2026-07-22', rowCount: 1, sessionRule: 'previous-completed-session' }
    },
    universe: { aShare: 5000, dailyCovered: 4980 },
    coverage: { aShareDaily: 0.996 },
    metricVersion: '1.0',
    leaderboards: {
      hotIndustries: [{
        rank: 1,
        id: 'industry-ai',
        name: '人工智能<script>alert(1)</script>',
        dataDate: '2026-07-23',
        score: 88.5,
        confidence: 0.92,
        scoreContributions: { ret5: 31.5, breadth: 22 }
      }],
      hotConcepts: [{
        rank: 1,
        id: 'concept-chip',
        name: '芯片',
        dataDate: '2026-07-23',
        score: 81,
        confidence: 0.9,
        scoreContributions: { ret5: 28 }
      }],
      sellPressure: [{
        rank: 1,
        symbol: '000001.SZ',
        name: '平安银行',
        dataDate: '2026-07-23',
        score: 72.4,
        confidence: 0.81,
        scoreContributions: { downside_volume: 42.4, volatility: 30 },
        status: 'RANKED'
      }],
      potentialWatchlist: [{
        rank: 1,
        symbol: '600000.SH',
        name: '浦发银行',
        dataDate: '2026-07-23',
        score: 76.2,
        confidence: 0.88,
        scoreContributions: { quality: 36.2, trend: 40 },
        vetoes: [],
        status: 'RANKED'
      }]
    },
    conclusions: [{
      conclusion_id: 'conclusion_market_regime',
      formula: 'market-regime-v1',
      confidence: 0.91,
      sourceIds: ['panda-1'],
      limitations: []
    }, {
      conclusion_id: 'conclusion_watchlists',
      formula: 'watchlists-v1',
      confidence: 0.81,
      sourceIds: ['panda-1'],
      limitations: []
    }],
    sources: [{
      id: 'panda-1',
      method: 'get_stock_daily',
      dataAsOf: '2026-07-23',
      window: '2026-06-23/2026-07-23',
      coverage: 0.996,
      rowCount: 10000,
      traceSequence: 7,
      status: 'ok',
      responseHash: 'abc123'
    }],
    missingData: [],
    conventions: ['Scores are deterministic.', '仅供研究，不构成投资建议。'],
    artifacts: [
      { name: 'evidence-pack.json', sha256: 'evidence-sha256' },
      { name: 'run-trace.json', sha256: 'trace-sha256' }
    ],
    detailUrl: 'https://reports.example.test/runs/run-20260723',
    ...overrides
  };
}

function successfulModelResponse(body, usage = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        model: 'narrator-1',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify(body) }
        }],
        usage
      };
    }
  };
}

test('deterministic report contains the 12 contract sections and traceable rows', () => {
  const pack = evidence();
  const report = renderReport(pack);

  for (const section of REPORT_SECTIONS) {
    assert.match(report.markdown, new RegExp(`^## ${section.title}$`, 'm'));
    assert.match(report.html, new RegExp(`id="${section.id}"`));
  }
  assert.equal(REPORT_SECTIONS.length, 12);
  for (const row of [
    ...pack.leaderboards.hotIndustries,
    ...pack.leaderboards.hotConcepts,
    ...pack.leaderboards.sellPressure,
    ...pack.leaderboards.potentialWatchlist
  ]) {
    assert.match(report.markdown, new RegExp(row.dataDate));
    assert.match(report.markdown, new RegExp(String(row.confidence)));
    for (const contribution of Object.values(row.scoreContributions)) {
      assert.match(report.markdown, new RegExp(String(contribution)));
    }
  }
  assert.match(report.markdown, /get_stock_daily.*2026-07-23.*2026-06-23\/2026-07-23.*0\.996.*7/);
  assert.match(report.markdown, /evidence-sha256/);
  assert.match(report.markdown, /https:\/\/reports\.example\.test\/runs\/run-20260723/);
  assert.match(report.html, /id="conclusion_market_regime"/);
  assert.doesNotMatch(report.html, /<script>/);
  assert.match(report.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.deepEqual(validateReport({ evidence: pack, markdown: report.markdown }), { valid: true });
});

test('degraded report title and body identify every missing Panda method', () => {
  const pack = evidence({
    status: 'degraded',
    missingData: [
      { section: 'capital', method: 'get_lhb_list', status: 'UNAVAILABLE' },
      { section: 'macro', method: 'get_macro_data', status: 'UNAVAILABLE' }
    ]
  });
  const report = renderReport(pack);
  assert.match(report.text.split('\n')[0], /数据不完整/);
  assert.match(report.text, /get_lhb_list/);
  assert.match(report.text, /get_macro_data/);
  assert.deepEqual(validateReport({ evidence: pack, markdown: report.markdown }), { valid: true });
});

test('worker-shaped rows never invent unavailable component values', () => {
  const pack = evidence({
    leaderboards: {
      ...evidence().leaderboards,
      sellPressure: [{
        symbol: '000001.SZ',
        name: '平安银行',
        dataDate: '2026-07-23',
        score: 72.4,
        confidence: 0.81,
        componentsUsed: ['downside_volume', 'volatility'],
        status: 'RANKED'
      }]
    }
  });
  const report = renderReport(pack);
  assert.match(
    report.markdown,
    /componentsUsed:downside_volume, volatility, finalScore:72\.4/
  );
  assert.doesNotMatch(report.markdown, /downside_volume:—|volatility:—/);
});

test('report bounds untrusted cell text', () => {
  const pack = evidence({
    leaderboards: {
      ...evidence().leaderboards,
      hotIndustries: [{
        ...evidence().leaderboards.hotIndustries[0],
        name: '超'.repeat(20_000)
      }]
    }
  });
  const report = renderReport(pack);
  assert.match(report.markdown, /\\\[TRUNCATED\\\]/);
  assert.match(report.html, /\[TRUNCATED\]/);
  assert.ok(report.markdown.length < 100_000);
  assert.ok(report.html.length < 100_000);
});

test('report renders every producer-bounded leaderboard row', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    rank: index + 1,
    symbol: `${String(index + 1).padStart(6, '0')}.SZ`,
    name: `证券${index + 1}`,
    dataDate: '2026-07-23',
    score: 75 - index,
    confidence: 0.8,
    scoreContributions: { final: 75 - index },
    status: 'RANKED'
  }));
  const pack = evidence({
    leaderboards: { ...evidence().leaderboards, sellPressure: rows }
  });
  const report = renderReport(pack);
  assert.match(report.markdown, /000025\.SZ/);
  assert.deepEqual(validateReport({ evidence: pack, markdown: report.markdown }), { valid: true });
});

test('report caps large valid collections with explicit validated truncation markers', () => {
  const rows = Array.from({ length: 55 }, (_, index) => ({
    rank: index + 1,
    symbol: `${String(index + 1).padStart(6, '0')}.SZ`,
    name: `证券${index + 1}`,
    dataDate: '2026-07-23',
    score: 100 - index,
    confidence: 0.8,
    scoreContributions: { final: 100 - index },
    status: 'RANKED'
  }));
  const sources = Array.from({ length: 205 }, (_, index) => ({
    id: `panda-call-${String(index + 1).padStart(3, '0')}`,
    method: `get_dataset_${index + 1}`,
    dataAsOf: '2026-07-23',
    rowCount: index + 1,
    status: 'ok'
  }));
  const conclusions = Array.from({ length: 130 }, (_, index) => ({
    conclusion_id: `conclusion_${index + 1}`,
    formula: 'bounded-v1',
    confidence: 0.8,
    sourceIds: [sources[index].id],
    limitations: []
  }));
  const missingData = Array.from({ length: 205 }, (_, index) => ({
    section: 'data-methodology',
    method: `missing_method_${index + 1}`,
    status: 'missing',
    error: 'unavailable'
  }));
  const pack = evidence({
    status: 'degraded',
    leaderboards: { ...evidence().leaderboards, sellPressure: rows },
    sources,
    conclusions,
    missingData,
    artifacts: Array.from({ length: 55 }, (_, index) => ({
      name: `artifact-${index + 1}.json`,
      sha256: `hash-${index + 1}`
    })),
    conventions: Array.from({ length: 105 }, (_, index) => `convention-${index + 1}`)
  });
  const report = renderReport(pack);
  assert.match(report.markdown, /TRUNCATED:leaderboard:5/);
  assert.match(report.markdown, /TRUNCATED:sources:5/);
  assert.match(report.markdown, /TRUNCATED:conclusions:2/);
  assert.match(report.markdown, /TRUNCATED:missing-data:5/);
  assert.match(report.markdown, /TRUNCATED:artifacts:5/);
  assert.match(report.markdown, /TRUNCATED:conventions:5/);
  assert.doesNotMatch(report.markdown, /000051\.SZ/);
  assert.deepEqual(validateReport({ evidence: pack, markdown: report.markdown }), { valid: true });
  assert.throws(
    () => validateReport({
      evidence: pack,
      markdown: report.markdown.replace('TRUNCATED:missing-data:5', 'marker-removed')
    }),
    /truncation marker/i
  );
  assert.throws(
    () => validateReport({
      evidence: pack,
      markdown: report.markdown.replace('TRUNCATED:conventions:5', 'marker-removed')
    }),
    /truncation marker/i
  );
});

test('missing row and source dates remain explicitly unavailable', () => {
  const { dataDate: _rowDate, ...rowWithoutDate } = evidence().leaderboards.sellPressure[0];
  const { dataAsOf: _sourceDate, ...sourceWithoutDate } = evidence().sources[0];
  const pack = evidence({
    leaderboards: {
      ...evidence().leaderboards,
      sellPressure: [rowWithoutDate]
    },
    sources: [sourceWithoutDate]
  });
  const report = renderReport(pack);
  const rowLine = report.markdown.split('\n').find((line) => line.includes('000001.SZ'));
  const sourceLine = report.markdown.split('\n').find((line) => line.includes('get_stock_daily'));
  assert.match(rowLine, /数据日期不可用/);
  assert.match(sourceLine, /数据日期不可用/);
  assert.deepEqual(validateReport({ evidence: pack, markdown: report.markdown }), { valid: true });
});

test('missing artifact metadata is reported without synthesizing a hash', () => {
  const pack = evidence();
  delete pack.artifacts;
  const report = renderReport(pack);
  assert.match(report.markdown, /evidence-pack\.json.*未记录/);
  assert.doesNotMatch(report.markdown, /evidence-pack\.json.*[a-f0-9]{64}/);
});

test('report validation rejects unsupported narrative numbers and stock symbols', () => {
  const pack = evidence();
  assert.throws(
    () => validateReport({
      evidence: pack,
      markdown: renderReport(pack).markdown,
      narrative: {
        sections: [{
          id: 'executive-summary',
          conclusionIds: ['conclusion_market_regime'],
          text: '000001.SZ 上涨 999.9%'
        }]
      }
    }),
    /unsupported numeric token/
  );
  assert.throws(
    () => validateReport({
      evidence: pack,
      markdown: renderReport(pack).markdown,
      narrative: {
        sections: [{
          id: 'executive-summary',
          conclusionIds: ['conclusion_market_regime'],
          text: 'AAPL 表现活跃'
        }]
      }
    }),
    /unsupported symbol/
  );
  assert.throws(
    () => validateReport({
      evidence: pack,
      markdown: renderReport(pack).markdown,
      narrative: {
        sections: [{
          id: 'executive-summary',
          conclusionIds: ['conclusion_watchlists'],
          text: '600000.SH 排名 2'
        }]
      }
    }),
    /rank claim|scope/
  );
});

test('report validation accepts known conclusion IDs and evidence-only narrative', () => {
  const pack = evidence();
  assert.deepEqual(validateReport({
    evidence: pack,
    markdown: renderReport(pack).markdown,
    narrative: {
      sections: [{
        id: 'executive-summary',
        conclusionIds: ['conclusion_market_regime'],
        text: '报告日为 2026-07-23，置信度为 0.91。'
      }]
    }
  }), { valid: true });
});

test('report validation rejects missing source lineage and disclaimer text', () => {
  const pack = evidence();
  const markdown = renderReport(pack).markdown;
  assert.throws(
    () => validateReport({
      evidence: pack,
      markdown: markdown.replaceAll('get_stock_daily', 'removed_method')
    }),
    /source|method/i
  );
  assert.throws(
    () => validateReport({
      evidence: pack,
      markdown: markdown.replace(
        '本报告仅供研究与信息交流，不构成投资建议、收益承诺或价格预测。观察名单不代表买卖建议。',
        'removed disclaimer'
      )
    }),
    /disclaimer/i
  );
});

test('narrative adapter sends only compact evidence and normalizes model usage', async () => {
  const pack = evidence({ privateCredential: 'must-not-leave-process' });
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return successfulModelResponse({
      sections: [{
        id: 'executive-summary',
        conclusionIds: ['conclusion_market_regime'],
        text: '报告日为 2026-07-23，置信度为 0.91。'
      }]
    }, {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 5 }
    });
  };
  const result = await generateNarrative(pack, {
    enabled: true,
    baseUrl: 'https://model.example.test/v1',
    apiKey: 'secret-key',
    name: 'narrator-1'
  }, { fetchImpl });

  assert.equal(request.url, 'https://model.example.test/v1/chat/completions');
  assert.deepEqual(request.body.tools, undefined);
  assert.equal(request.body.response_format.type, 'json_object');
  assert.equal(request.body.max_tokens, 1200);
  assert.doesNotMatch(JSON.stringify(request.body), /must-not-leave-process/);
  assert.deepEqual(result.sections[0].conclusionIds, ['conclusion_market_regime']);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 30);
  assert.equal(result.usage.reasoningTokens, 5);
  assert.equal(result.usage.cachedTokens, 20);
  assert.equal(result.usage.totalTokens, 150);
  assert.equal(result.usage.cost, null);
  assert.match(result.usage.pricingUnavailableReason, /pricing/i);
  assert.match(result.usage.responseSha256, /^[a-f0-9]{64}$/);
});

test('narrative compact projection removes nested private fields and sanitizes values', async () => {
  const pack = evidence({
    markets: {
      ...evidence().markets,
      aShare: {
        ...evidence().markets.aShare,
        privateCredential: 'nested-market-secret',
        macro: {
          valuation: 18.2,
          internalNote: 'deep-market-secret'
        },
        indices: [{
          symbol: '000001.SH',
          name: '上证指数',
          close: 3582.3,
          contact: 'alice.private@example.com',
          sourceUrl: 'https://user:pass@example.com/private'
        }]
      }
    },
    universe: {
      ...evidence().universe,
      password: 'nested-universe-secret'
    },
    coverage: {
      ...evidence().coverage,
      privateToken: 'nested-coverage-secret'
    },
    leaderboards: {
      ...evidence().leaderboards,
      sellPressure: evidence().leaderboards.sellPressure.map((row) => ({
        ...row,
        apiKey: 'nested-row-secret'
      }))
    },
    conclusions: evidence().conclusions.map((item) => ({
      ...item,
      authorization: 'Bearer nested-conclusion-secret'
    })),
    conventions: [
      '联系人 alice.private@example.com',
      'authorization=Bearer nested-convention-secret'
    ]
  });
  let requestBody;
  const result = await generateNarrative(pack, {
    enabled: true,
    baseUrl: 'https://model.example.test/v1',
    apiKey: 'model-key',
    name: 'narrator-1'
  }, {
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return successfulModelResponse({
        sections: [{
          id: 'executive-summary',
          conclusionIds: ['conclusion_market_regime'],
          text: '报告日为 2026-07-23，置信度为 0.91。'
        }]
      }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }
  });

  assert.equal(result.sections.length, 1);
  const serialized = JSON.stringify(requestBody);
  for (const secret of [
    'nested-market-secret',
    'deep-market-secret',
    'nested-universe-secret',
    'nested-coverage-secret',
    'nested-row-secret',
    'nested-conclusion-secret',
    'nested-convention-secret',
    'alice.private@example.com',
    'user:pass@'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const compact = JSON.parse(requestBody.messages[1].content);
  assert.equal(compact.markets.aShare.privateCredential, undefined);
  assert.equal(compact.universe.password, undefined);
  assert.equal(compact.coverage.privateToken, undefined);
  assert.equal(compact.leaderboards.sellPressure[0].apiKey, undefined);
  assert.equal(compact.conclusions[0].authorization, undefined);
});

test('narrative facts use exact compact evidence with exponent and case-insensitive symbols', async () => {
  const pack = evidence({
    leaderboards: {
      ...evidence().leaderboards,
      sellPressure: [{
        rank: 1,
        symbol: 'X',
        name: '样本证券',
        dataDate: '2026-07-23',
        score: 72.4,
        confidence: 0.81,
        scoreContributions: { final: 72.4 },
        status: 'RANKED'
      }, {
        rank: 2,
        symbol: 'F',
        name: '单字母证券',
        dataDate: '2026-07-23',
        score: 71,
        confidence: 0.8,
        scoreContributions: { final: 71 },
        status: 'RANKED'
      }, {
        rank: 3,
        symbol: '0700.HK',
        name: '港股样本',
        dataDate: '2026-07-23',
        score: 70,
        confidence: 0.79,
        scoreContributions: { final: 70 },
        status: 'RANKED'
      }]
    },
    conclusions: evidence().conclusions.map((item) =>
      item.conclusion_id === 'conclusion_watchlists'
        ? { ...item, leaderboard: 'sellPressure' }
        : item
    )
  });
  const config = {
    enabled: true, baseUrl: 'https://model.test/v1', apiKey: 'key', name: 'narrator-1'
  };
  const call = (text, conclusionIds = ['conclusion_watchlists']) =>
    generateNarrative(pack, config, {
      fetchImpl: async () => successfulModelResponse({
        sections: [{ id: 'executive-summary', conclusionIds, text }]
      }, { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 })
    });

  const equivalent = await call('x 得分为 7.24e1。');
  assert.equal(equivalent.sections.length, 1);
  assert.equal((await call('f 得分为 +71.0。')).sections.length, 1);
  assert.equal((await call('0700.hk 得分为 7e1。')).sections.length, 1);

  const unknownLowercase = await call('aapl 得分为 72.4。');
  assert.deepEqual(unknownLowercase.sections, []);
  assert.match(unknownLowercase.fallbackReason, /symbol/i);

  const scientificFabrication = await call('X 上涨 1e99。');
  assert.deepEqual(scientificFabrication.sections, []);
  assert.match(scientificFabrication.fallbackReason, /numeric/i);

  const outsideConclusion = await call(
    '600000.SH 得分为 76.2。',
    ['conclusion_market_regime']
  );
  assert.deepEqual(outsideConclusion.sections, []);
  assert.match(outsideConclusion.fallbackReason, /referenced conclusion|scope/i);

  const outsideMarketScope = await call(
    '000001.SH 收于 3582.3。',
    ['conclusion_watchlists']
  );
  assert.deepEqual(outsideMarketScope.sections, []);
  assert.match(outsideMarketScope.fallbackReason, /referenced conclusion|scope/i);
});

test('narrative pricing produces exact cost only with a versioned pricing table', async () => {
  const pack = evidence();
  const fetchImpl = async () => successfulModelResponse({
    sections: [{
      id: 'executive-summary',
      conclusionIds: ['conclusion_market_regime'],
      text: '报告日为 2026-07-23。'
    }]
  }, { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 });

  const unversioned = await generateNarrative(pack, {
    enabled: true, baseUrl: 'https://model.test/v1', apiKey: 'key', name: 'narrator-1',
    pricing: { inputPerMillion: 2, outputPerMillion: 8, currency: 'USD' }
  }, { fetchImpl });
  assert.equal(unversioned.usage.cost, null);

  const versioned = await generateNarrative(pack, {
    enabled: true, baseUrl: 'https://model.test/v1', apiKey: 'key', name: 'narrator-1',
    pricing: {
      version: 'prices-2026-07-01',
      inputPerMillion: 2,
      outputPerMillion: 8,
      currency: 'USD'
    }
  }, { fetchImpl });
  assert.equal(versioned.usage.pricingVersion, 'prices-2026-07-01');
  assert.equal(versioned.usage.cost, 6);
  assert.equal(versioned.usage.currency, 'USD');

  const invalidCachedRate = await generateNarrative(pack, {
    enabled: true, baseUrl: 'https://model.test/v1', apiKey: 'key', name: 'narrator-1',
    pricing: {
      version: 'prices-2026-07-01',
      inputPerMillion: 2,
      outputPerMillion: 8,
      cachedInputPerMillion: -5,
      currency: 'USD'
    }
  }, { fetchImpl });
  assert.equal(invalidCachedRate.usage.cost, null);
  assert.match(invalidCachedRate.usage.pricingUnavailableReason, /rate|pricing/i);

  const nonFiniteCachedRate = await generateNarrative(pack, {
    enabled: true, baseUrl: 'https://model.test/v1', apiKey: 'key', name: 'narrator-1',
    pricing: {
      version: 'prices-2026-07-01',
      inputPerMillion: 2,
      outputPerMillion: 8,
      cachedInputPerMillion: 'Infinity',
      currency: 'USD'
    }
  }, { fetchImpl });
  assert.equal(nonFiniteCachedRate.usage.cost, null);
});

test('invalid model claims fall back without changing deterministic conclusions', async () => {
  const pack = evidence();
  const result = await generateNarrative(pack, {
    enabled: true, baseUrl: 'https://model.test/v1', apiKey: 'key', name: 'narrator-1'
  }, {
    fetchImpl: async () => successfulModelResponse({
      sections: [{
        id: 'executive-summary',
        conclusionIds: ['invented-conclusion'],
        text: '600000.SH 得分为 999'
      }]
    }, { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 })
  });
  assert.deepEqual(result.sections, []);
  assert.match(result.fallbackReason, /conclusion|numeric/i);
  assert.equal(result.usage.totalTokens, 20);

  const empty = await generateNarrative(pack, {
    enabled: true, baseUrl: 'https://model.test/v1', apiKey: 'key', name: 'narrator-1'
  }, {
    fetchImpl: async () => successfulModelResponse(
      { sections: [] },
      { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    )
  });
  assert.deepEqual(empty.sections, []);
  assert.match(empty.fallbackReason, /executive-summary|required/i);

  const disabled = await generateNarrative(pack, { enabled: false }, {
    fetchImpl: async () => { throw new Error('must not call'); }
  });
  assert.deepEqual(disabled.sections, []);
  assert.match(disabled.fallbackReason, /disabled/i);
});

test('narrative adapter rejects an oversized response before JSON parsing', async () => {
  let jsonCalled = false;
  const result = await generateNarrative(evidence(), {
    enabled: true, baseUrl: 'https://model.test/v1', apiKey: 'key', name: 'narrator-1'
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return 'x'.repeat(300_000);
      },
      async json() {
        jsonCalled = true;
        throw new Error('unbounded JSON parser was called');
      }
    })
  });
  assert.equal(jsonCalled, false);
  assert.deepEqual(result.sections, []);
  assert.match(result.fallbackReason, /safe bounds|too large/i);
});

test('narrative adapter applies and clears its own request deadline', async () => {
  const started = Date.now();
  const result = await generateNarrative(evidence(), {
    enabled: true,
    baseUrl: 'https://model.test/v1',
    apiKey: 'key',
    name: 'narrator-1',
    timeoutMs: 20
  }, {
    fetchImpl: async () => new Promise((resolve) => {
      setTimeout(() => resolve(successfulModelResponse({
        sections: [{
          id: 'executive-summary',
          conclusionIds: ['conclusion_market_regime'],
          text: '报告日为 2026-07-23，置信度为 0.91。'
        }]
      }, { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 })), 100);
    })
  });
  assert.deepEqual(result.sections, []);
  assert.match(result.fallbackReason, /timeout|deadline/i);
  assert.ok(Date.now() - started < 80);
});

test('narrative adapter combines caller cancellation with its own deadline', async () => {
  const caller = new AbortController();
  let requestSignal;
  const pending = generateNarrative(evidence(), {
    enabled: true,
    baseUrl: 'https://model.test/v1',
    apiKey: 'key',
    name: 'narrator-1',
    timeoutMs: 5_000
  }, {
    signal: caller.signal,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true
        });
      });
    }
  });
  caller.abort(new Error('caller cancelled'));
  const result = await pending;
  assert.notEqual(requestSignal, caller.signal);
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(result.sections, []);
  assert.match(result.fallbackReason, /caller cancelled/);
});

test('report and run detail escape Panda and model text while preserving lineage', () => {
  const pack = evidence({
    detailUrl: 'javascript:alert(1)',
    leaderboards: {
      ...evidence().leaderboards,
      hotIndustries: [{
        ...evidence().leaderboards.hotIndustries[0],
        name: '[click](javascript:alert(1))'
      }]
    }
  });
  const narrative = {
    sections: [{
      id: 'sell-pressure',
      conclusionIds: ['conclusion_market_regime'],
      text: '<script>alert("model")</script>'
    }]
  };
  const report = renderReport(pack, narrative);
  assert.doesNotMatch(report.html, /<script>/);
  assert.match(report.html, /&lt;script&gt;alert\(&quot;model&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(report.html, /href="javascript:/);
  assert.doesNotMatch(report.markdown, /\[click\]\(javascript:/);

  const detail = renderRunDetail({
    run: {
      id: 'run-20260723',
      status: '<img src=x onerror=alert(1)>',
      artifacts: [{ name: 'market-report.html', sha256: '<artifact-hash>' }]
    },
    evidence: pack,
    trace: {
      steps: [{ sequence: 1, skillId: 'daily-market-report', tool: 'panda-market-worker' }],
      workerEvents: [{
        sequence: 2, method: 'get_stock_daily<script>', durationMs: 21, rowCount: 10,
        cache: 'hit', retries: 0
      }],
      modelUsage: [{ provider: 'openai-compatible', totalTokens: 150, cost: 0.001 }],
      emailAttempts: [{ status: 'sent', recipients: ['j***@example.com'] }],
      conclusionLineage: [{
        conclusionId: 'trace-only-conclusion',
        formula: 'trace-formula-v1',
        pandaCalls: ['panda-call-001'],
        dataDate: '2026-07-23'
      }]
    }
  });
  assert.doesNotMatch(detail, /<img src=x|<script>/);
  assert.match(detail, /get_stock_daily&lt;script&gt;/);
  assert.match(detail, /conclusion_market_regime/);
  assert.match(detail, /trace-only-conclusion/);
  assert.match(detail, /market-report\.html/);
});

test('browser detail UI requests all protected artifacts with one in-memory bearer token', async () => {
  const script = await readFile(
    new URL('../agents/market-analyst/public/run-detail.js', import.meta.url),
    'utf8'
  );
  const page = await readFile(
    new URL('../agents/market-analyst/public/run-detail.html', import.meta.url),
    'utf8'
  );
  assert.match(page, /type="password"/);
  assert.match(script, /\/report/);
  assert.match(script, /\/evidence/);
  assert.match(script, /\/trace/);
  assert.match(script, /Authorization.*Bearer/s);
  assert.doesNotMatch(`${page}\n${script}`, /localStorage|sessionStorage/);
});

test('browser detail UI bounds and validates each artifact while preserving partial results', async () => {
  const script = await readFile(
    new URL('../agents/market-analyst/public/run-detail.js', import.meta.url),
    'utf8'
  );
  assert.match(script, /headers\.get\(['"]content-length['"]\)/);
  assert.match(script, /\.getReader\(\)/);
  assert.match(script, /\.arrayBuffer\(\)/);
  assert.match(script, /validateArtifactShape/);
  assert.match(script, /Promise\.allSettled/);
  assert.match(script, /加载失败/);
  assert.match(script, /\.slice\(0,\s*MAX_DETAIL_ROWS\)\.map/);
  assert.match(script, /token\s*=\s*['"]/);
  assert.doesNotMatch(
    script,
    /decodeURIComponent\(\s*new URLSearchParams/
  );
});
