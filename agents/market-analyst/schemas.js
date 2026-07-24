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
  assertBoundedEvidence(value);
  return value;
}
