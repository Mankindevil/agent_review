const OPERATIONS = new Set([
  'daily-market-report',
  'hot-topic-analysis',
  'sell-pressure-scan',
  'potential-watchlist',
  'inspect-run-trace'
]);
const EVIDENCE_STATUSES = new Set(['complete', 'degraded', 'skipped', 'failed']);
const REPORT_SECTION_IDS = new Set([
  'run-overview',
  'executive-summary',
  'a-share-market',
  'hot-topics',
  'sell-pressure',
  'potential-watchlist',
  'capital-transactions',
  'cross-market',
  'event-crowding-risks',
  'data-methodology',
  'trace-artifacts',
  'disclaimer'
]);
const ANALYTICAL_SECTION = Object.freeze({
  'hot-topic-analysis': 'hot-topics',
  'sell-pressure-scan': 'sell-pressure',
  'potential-watchlist': 'potential-watchlist'
});
const MAX_EVIDENCE_DEPTH = 24;
const MAX_EVIDENCE_NODES = 100_000;
const MAX_EVIDENCE_ARRAY = 10_000;
const MAX_EVIDENCE_KEYS = 2_000;
const MAX_EVIDENCE_TOP_LEVEL_KEYS = 32;
const MAX_EVIDENCE_STRING = 100_000;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function assertBoundedEvidence(root) {
  const seen = new WeakSet();
  let nodes = 0;
  const visit = (value, depth) => {
    nodes += 1;
    if (nodes > MAX_EVIDENCE_NODES || depth > MAX_EVIDENCE_DEPTH) {
      throw new RangeError('Evidence Pack exceeds safe bounds');
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Evidence Pack contains a non-finite number');
      return;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_EVIDENCE_STRING) {
        throw new RangeError('Evidence Pack exceeds safe bounds');
      }
      return;
    }
    if (typeof value !== 'object') {
      throw new TypeError('Evidence Pack contains an unsupported value');
    }
    if (seen.has(value)) throw new RangeError('Evidence Pack exceeds safe bounds');
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_EVIDENCE_ARRAY) throw new RangeError('Evidence Pack exceeds safe bounds');
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_EVIDENCE_KEYS) throw new RangeError('Evidence Pack exceeds safe bounds');
    for (const key of keys) visit(value[key], depth + 1);
  };
  visit(root, 0);
}

function sameMembers(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return [...new Set(left)].sort().join('\u0000')
    === [...new Set(right)].sort().join('\u0000');
}

const SOURCE_ROLE_METHODS = Object.freeze({
  ret1: { allowed: ['get_stock_daily', 'get_industry_constituents', 'get_concept_list', 'get_concept_constituents'], required: ['get_stock_daily'] },
  ret5: { allowed: ['get_stock_daily', 'get_industry_constituents', 'get_concept_list', 'get_concept_constituents'], required: ['get_stock_daily'] },
  breadth5: { allowed: ['get_stock_daily', 'get_industry_constituents', 'get_concept_list', 'get_concept_constituents'], required: ['get_stock_daily'] },
  turnover_heat: { allowed: ['get_stock_daily', 'get_industry_constituents', 'get_concept_list', 'get_concept_constituents'], required: ['get_stock_daily'] },
  acceleration: { allowed: ['get_stock_daily', 'get_industry_constituents', 'get_concept_list', 'get_concept_constituents'], required: ['get_stock_daily'] },
  lhb_activity: { allowed: ['get_stock_daily', 'get_industry_constituents', 'get_concept_list', 'get_concept_constituents', 'get_lhb_list'], required: ['get_stock_daily', 'get_lhb_list'] },
  downside_volume: { allowed: ['get_stock_daily'], required: ['get_stock_daily'] },
  lhb_net_sell: { allowed: ['get_lhb_detail'], required: ['get_lhb_detail'] },
  northbound_reduction: { allowed: ['get_hsgt_hold'], required: ['get_hsgt_hold'] },
  margin_contraction: { allowed: ['get_margin'], required: ['get_margin'] },
  discount_event: { allowed: ['get_block_trade', 'get_stock_shareholder_change'], required: ['get_block_trade', 'get_stock_shareholder_change'] },
  trend: { allowed: ['get_stock_daily'], required: ['get_stock_daily'] },
  theme: { allowed: ['get_industry_constituents', 'get_concept_list', 'get_concept_constituents'], requiredAny: ['get_industry_constituents', 'get_concept_constituents'] },
  quality: { allowed: ['get_fina_performance'], required: ['get_fina_performance'] },
  capital: { allowed: ['get_hsgt_hold', 'get_lhb_detail', 'get_margin', 'get_investor_activity'], requiredAny: ['get_hsgt_hold', 'get_lhb_detail', 'get_margin', 'get_investor_activity'] },
  liquidity_stability: { allowed: ['get_stock_daily'], required: ['get_stock_daily'] },
  risk_crowding: { allowed: ['get_stock_daily'], required: ['get_stock_daily'] },
  risk_extreme_volatility: { allowed: ['get_stock_daily'], required: ['get_stock_daily'] },
  risk_pledge: { allowed: ['get_stock_pledge'], required: ['get_stock_pledge'] },
  risk_unlock: { allowed: ['get_restricted_list', 'get_share_float'], required: ['get_restricted_list', 'get_share_float'] },
  risk_reduction: { allowed: ['get_stock_shareholder_change'], required: ['get_stock_shareholder_change'] },
  risk_forecast: { allowed: ['get_fina_forecast'], required: ['get_fina_forecast'] }
});

function boundedUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validWindow(value) {
  if (isRealDate(value)) return true;
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
  return Boolean(match && isRealDate(match[1]) && isRealDate(match[2]) && match[1] <= match[2]);
}

function containsFiniteNumber(value) {
  if (Number.isFinite(value)) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsFiniteNumber);
}

function assertTraceableEvidence(value) {
  const sources = new Map();
  for (const source of value.sources) {
    if (!isRecord(source)
        || typeof source.id !== 'string' || !source.id
        || source.traceCallId !== source.id
        || typeof source.method !== 'string' || !source.method
        || typeof source.paramsHash !== 'string' || !/^[a-f0-9]{64}$/i.test(source.paramsHash)
        || !Array.isArray(source.fields)
        || !boundedUnit(source.coverage)
        || !Number.isSafeInteger(source.retryCount) || source.retryCount < 0
        || typeof source.cacheStatus !== 'string'
        || typeof source.truncated !== 'boolean'
        || !['ok', 'error'].includes(source.status)) {
      throw new TypeError('Evidence Pack source requires a valid traceCallId and call metadata');
    }
    if (sources.has(source.id)) throw new RangeError('Evidence Pack has duplicate call IDs');
    sources.set(source.id, source);
  }

  const metricIds = new Set();
  const rowByMetricId = new Map();
  for (const [board, rows] of Object.entries(value.leaderboards)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row) || row.status !== 'RANKED' || !Array.isArray(row.metrics)
          || row.metrics.length === 0) {
        throw new TypeError('Traceable leaderboard rows must be ranked and include metrics');
      }
      let contributions = 0;
      let originalWeight = 0;
      let effectiveWeight = 0;
      let tracedPenalty = 0;
      for (const metric of row.metrics) {
        if (!isRecord(metric)
            || typeof metric.id !== 'string' || !metric.id
            || typeof metric.name !== 'string' || !metric.name
            || typeof metric.sourceRole !== 'string'
            || !Object.hasOwn(metric, 'raw') || !containsFiniteNumber(metric.raw)
            || !Number.isFinite(metric.transformed)
            || !Number.isFinite(metric.winsorized)
            || !Number.isFinite(metric.percentile) || metric.percentile < 0 || metric.percentile > 100
            || !boundedUnit(metric.originalWeight)
            || !boundedUnit(metric.effectiveWeight)
            || !Number.isFinite(metric.contribution)
            || !Number.isFinite(metric.penalty)
            || !boundedUnit(metric.coverage)
            || !isRealDate(metric.dataDate)
            || typeof metric.window !== 'string' || !metric.window
            || !Array.isArray(metric.evidenceIds) || metric.evidenceIds.length === 0) {
          throw new TypeError('Evidence Pack metric lineage is dangling or incomplete');
        }
        const role = SOURCE_ROLE_METHODS[metric.sourceRole];
        if (!role) throw new RangeError(`Evidence Pack metric source role is unsupported: ${metric.sourceRole}`);
        const metricSources = metric.evidenceIds.map((id) => sources.get(id));
        if (metricSources.some((source) => !source
            || source.status !== 'ok' || source.truncated
            || !/^[a-f0-9]{64}$/i.test(source.responseHash || '')
            || !Number.isSafeInteger(source.rowCount) || source.rowCount < 0
            || !isRealDate(source.dataAsOf)
            || !validWindow(source.window)
            || !role.allowed.includes(source.method))) {
          throw new RangeError('Evidence Pack metric references an unusable or irrelevant source');
        }
        const methods = new Set(metricSources.map((source) => source.method));
        if ((role.required && role.required.some((method) => !methods.has(method)))
            || (role.requiredAny && !role.requiredAny.some((method) => methods.has(method)))) {
          throw new RangeError('Evidence Pack metric source role is missing a required method');
        }
        if (metricIds.has(metric.id)) throw new RangeError('Evidence Pack metric ID is duplicated');
        metricIds.add(metric.id);
        rowByMetricId.set(metric.id, { board, row });
        contributions += metric.contribution;
        originalWeight += metric.originalWeight;
        effectiveWeight += metric.effectiveWeight;
        tracedPenalty += metric.penalty;
        if (Math.abs(metric.contribution - metric.percentile * metric.effectiveWeight) > 1e-8) {
          throw new RangeError('Evidence Pack metric contribution arithmetic is invalid');
        }
        if (metric.penalty > 0 && (
          metric.originalWeight !== 0
          || metric.effectiveWeight !== 0
          || metric.contribution !== 0
        )) {
          throw new RangeError('Evidence Pack risk penalty metric must not affect base score weights');
        }
      }
      if (!Number.isFinite(row.baseScore)
          || Math.abs(contributions - row.baseScore) > 1e-8
          || !boundedUnit(row.weightCoverage)
          || Math.abs(originalWeight - row.weightCoverage) > 1e-8
          || Math.abs(effectiveWeight - 1) > 1e-8) {
        throw new RangeError('Evidence Pack contribution or weight sum does not match base score');
      }
      const penalty = Number(row.riskPenalty || 0);
      const expected = Math.max(0, row.baseScore - penalty);
      if (!Number.isFinite(penalty) || penalty < 0
          || Math.abs(tracedPenalty - penalty) > 1e-8
          || !Number.isFinite(row.score) || Math.abs(row.score - expected) > 1e-8) {
        throw new RangeError('Evidence Pack score does not match contribution sum and penalty');
      }
    }
  }

  const referencedMetrics = new Set();
  const concludedRows = new Set();
  for (const conclusion of value.conclusions) {
    if (!isRecord(conclusion)
        || typeof conclusion.conclusion_id !== 'string' || !conclusion.conclusion_id
        || typeof conclusion.leaderboard !== 'string'
        || typeof conclusion.entryId !== 'string'
        || !Array.isArray(conclusion.metricIds) || conclusion.metricIds.length === 0
        || !Array.isArray(conclusion.evidenceIds) || conclusion.evidenceIds.length === 0
        || !Array.isArray(conclusion.pandaCalls) || conclusion.pandaCalls.length === 0
        || !Array.isArray(conclusion.sourceIds)
        || !Array.isArray(conclusion.dataDates) || conclusion.dataDates.some((item) => !isRealDate(item))
        || !Array.isArray(conclusion.windows)
        || typeof conclusion.stale !== 'boolean'
        || !Array.isArray(conclusion.missing)
        || !Array.isArray(conclusion.limitations)
        || !boundedUnit(conclusion.confidence)
        || conclusion.metricIds.some((id) => !metricIds.has(id))
        || !sameMembers(conclusion.evidenceIds, conclusion.pandaCalls)
        || !sameMembers(conclusion.sourceIds, conclusion.pandaCalls)) {
      throw new RangeError('Evidence Pack conclusion lineage is dangling or incomplete');
    }
    const scoped = conclusion.metricIds.map((id) => rowByMetricId.get(id));
    if (scoped.some((item) => item.board !== conclusion.leaderboard
        || String(item.row.symbol || item.row.id || item.row.name) !== conclusion.entryId)) {
      throw new RangeError('Evidence Pack conclusion combines unrelated ranked entries');
    }
    const row = scoped[0].row;
    const rowKey = `${conclusion.leaderboard}\u0000${conclusion.entryId}`;
    if (concludedRows.has(rowKey)) throw new RangeError('Evidence Pack ranked entry has duplicate conclusions');
    concludedRows.add(rowKey);
    if (!sameMembers(conclusion.metricIds, row.metrics.map((metric) => metric.id))) {
      throw new RangeError('Evidence Pack conclusion metric scope is incomplete');
    }
    const expectedCalls = [...new Set(row.metrics.flatMap((metric) => metric.evidenceIds))];
    if (!sameMembers(conclusion.pandaCalls, expectedCalls)) {
      throw new RangeError('Evidence Pack conclusion call scope is incomplete');
    }
    for (const id of conclusion.metricIds) referencedMetrics.add(id);
  }
  if (referencedMetrics.size !== metricIds.size
      || [...metricIds].some((id) => !referencedMetrics.has(id))) {
    throw new RangeError('Evidence Pack contains orphan metric lineage');
  }
}

export function validateOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('operation request must be an object');
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new RangeError(`不支持的 operation：${value.operation}`);
  }
  if (value.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    throw new TypeError('date must be YYYY-MM-DD');
  }
  const topN = value.topN === undefined ? 10 : Number(value.topN);
  if (!Number.isSafeInteger(topN) || topN < 1 || topN > 50) {
    throw new RangeError('topN must be an integer from 1 to 50');
  }
  const sections = value.sections === undefined ? [] : value.sections;
  if (!Array.isArray(sections) || sections.some((item) => typeof item !== 'string')) {
    throw new TypeError('sections must be an array of strings');
  }
  if (sections.some((item) => !REPORT_SECTION_IDS.has(item))) {
    throw new RangeError('sections contains an unsupported report section');
  }
  const analyticalSection = ANALYTICAL_SECTION[value.operation];
  if (analyticalSection && sections.some((item) => item !== analyticalSection)) {
    throw new RangeError(`sections for ${value.operation} may contain only ${analyticalSection}`);
  }
  return {
    operation: value.operation,
    ...(value.date ? { date: value.date } : {}),
    sections,
    topN
  };
}

export function validateEvidencePack(value) {
  const required = [
    'schemaVersion',
    'runId',
    'reportDate',
    'status',
    'markets',
    'conclusions',
    'leaderboards',
    'sources'
  ];
  if (!isRecord(value)) throw new TypeError('Evidence Pack must be an object');
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`Evidence Pack missing ${key}`);
  }
  if (Object.keys(value).length > MAX_EVIDENCE_TOP_LEVEL_KEYS) {
    throw new RangeError('Evidence Pack exceeds safe bounds');
  }
  if (value.schemaVersion !== '1.0') {
    throw new TypeError('Evidence Pack schemaVersion must be "1.0"');
  }
  if (value.evidenceModelVersion !== '2.0') {
    throw new TypeError('Evidence Pack evidenceModelVersion must be exactly "2.0"');
  }
  if (typeof value.runId !== 'string' || !value.runId.trim() || value.runId.length > 128) {
    throw new TypeError('Evidence Pack runId must be a nonempty bounded string');
  }
  if (!isRealDate(value.reportDate)) {
    throw new TypeError('Evidence Pack reportDate must be a real YYYY-MM-DD date');
  }
  if (!EVIDENCE_STATUSES.has(value.status)) {
    throw new TypeError('Evidence Pack status is unsupported');
  }
  if (!isRecord(value.markets) || !isRecord(value.leaderboards)) {
    throw new TypeError('Evidence Pack markets/leaderboards must be objects');
  }
  if (!Array.isArray(value.conclusions) || !Array.isArray(value.sources)
      || (value.missingData !== undefined && !Array.isArray(value.missingData))) {
    throw new TypeError('Evidence Pack conclusions/sources/missingData must be arrays');
  }
  assertTraceableEvidence(value);
  assertBoundedEvidence(value);
  return value;
}
