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

function assertTraceableEvidence(value) {
  const sourceIds = new Set();
  for (const source of value.sources) {
    if (!isRecord(source)
        || typeof source.id !== 'string' || !source.id
        || source.traceCallId !== source.id
        || typeof source.method !== 'string' || !source.method
        || typeof source.paramsHash !== 'string' || !/^[a-f0-9]{64}$/i.test(source.paramsHash)
        || !Array.isArray(source.fields)
        || !Number.isFinite(source.coverage)
        || !Number.isSafeInteger(source.retryCount) || source.retryCount < 0
        || typeof source.cacheStatus !== 'string'
        || typeof source.truncated !== 'boolean') {
      throw new TypeError('Evidence Pack source requires a valid traceCallId and call metadata');
    }
    if (sourceIds.has(source.id)) throw new RangeError('Evidence Pack has duplicate call IDs');
    sourceIds.add(source.id);
  }

  const metricIds = new Set();
  for (const rows of Object.values(value.leaderboards)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row) || row.status !== 'RANKED' || !Array.isArray(row.metrics)) {
        throw new TypeError('Traceable leaderboard rows must be ranked and include metrics');
      }
      let contributions = 0;
      for (const metric of row.metrics) {
        if (!isRecord(metric)
            || typeof metric.id !== 'string' || !metric.id
            || typeof metric.name !== 'string' || !metric.name
            || !Object.hasOwn(metric, 'raw')
            || !Object.hasOwn(metric, 'transformed')
            || !Object.hasOwn(metric, 'winsorized')
            || !Number.isFinite(metric.percentile)
            || !Number.isFinite(metric.originalWeight)
            || !Number.isFinite(metric.effectiveWeight)
            || !Number.isFinite(metric.contribution)
            || !Number.isFinite(metric.penalty)
            || !Number.isFinite(metric.coverage)
            || typeof metric.window !== 'string' || !metric.window
            || !Array.isArray(metric.evidenceIds)
            || metric.evidenceIds.length === 0
            || metric.evidenceIds.some((id) => !sourceIds.has(id))) {
          throw new TypeError('Evidence Pack metric lineage is dangling or incomplete');
        }
        if (metricIds.has(metric.id)) throw new RangeError('Evidence Pack metric ID is duplicated');
        metricIds.add(metric.id);
        contributions += metric.contribution;
      }
      if (!Number.isFinite(row.baseScore)
          || Math.abs(contributions - row.baseScore) > 1e-8) {
        throw new RangeError('Evidence Pack contribution sum does not match base score');
      }
      const penalty = Number(row.riskPenalty || 0);
      const expected = Math.max(0, row.baseScore - penalty);
      if (!Number.isFinite(row.score) || Math.abs(row.score - expected) > 1e-8) {
        throw new RangeError('Evidence Pack score does not match contribution sum and penalty');
      }
    }
  }

  const referencedMetrics = new Set();
  for (const conclusion of value.conclusions) {
    if (!isRecord(conclusion)
        || !Array.isArray(conclusion.metricIds) || conclusion.metricIds.length === 0
        || !Array.isArray(conclusion.evidenceIds) || conclusion.evidenceIds.length === 0
        || !Array.isArray(conclusion.pandaCalls) || conclusion.pandaCalls.length === 0
        || conclusion.metricIds.some((id) => !metricIds.has(id))
        || conclusion.pandaCalls.some((id) => !sourceIds.has(id))
        || !sameMembers(conclusion.evidenceIds, conclusion.pandaCalls)) {
      throw new RangeError('Evidence Pack conclusion lineage is dangling or incomplete');
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
  if (value.evidenceModelVersion === '2.0') assertTraceableEvidence(value);
  assertBoundedEvidence(value);
  return value;
}
