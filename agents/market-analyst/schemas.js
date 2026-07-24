const OPERATIONS = new Set([
  'daily-market-report',
  'hot-topic-analysis',
  'sell-pressure-scan',
  'potential-watchlist',
  'inspect-run-trace'
]);

export function validateOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('operation request must be an object');
  if (!OPERATIONS.has(value.operation)) throw new RangeError(`涓嶆敮鎸佺殑 operation: ${value.operation}`);
  if (value.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new TypeError('date must be YYYY-MM-DD');
  const topN = value.topN === undefined ? 10 : Number(value.topN);
  if (!Number.isSafeInteger(topN) || topN < 1 || topN > 50) throw new RangeError('topN must be an integer from 1 to 50');
  const sections = value.sections === undefined ? [] : value.sections;
  if (!Array.isArray(sections) || sections.some((item) => typeof item !== 'string')) throw new TypeError('sections must be an array of strings');
  return { operation: value.operation, ...(value.date ? { date: value.date } : {}), sections, topN };
}

export function validateEvidencePack(value) {
  const required = ['schemaVersion', 'runId', 'reportDate', 'status', 'markets', 'conclusions', 'leaderboards', 'sources'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Evidence Pack must be an object');
  for (const key of required) if (!(key in value)) throw new TypeError(`Evidence Pack 缂哄皯 ${key}`);
  if (!Array.isArray(value.conclusions) || !Array.isArray(value.sources)) throw new TypeError('Evidence Pack conclusions/sources must be arrays');
  return value;
}
