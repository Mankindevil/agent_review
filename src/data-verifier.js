import { createHash } from 'node:crypto';

const INDEX_ANCHORS = [
  { pattern: /沪深\s*300|CSI\s*300/i, name: '沪深 300', symbol: '000300.SH' },
  { pattern: /中证\s*500|CSI\s*500/i, name: '中证 500', symbol: '000905.SH' },
  { pattern: /上证指数|上证综指/i, name: '上证指数', symbol: '000001.SH' },
  { pattern: /深证成指/i, name: '深证成指', symbol: '399001.SZ' },
  { pattern: /创业板指/i, name: '创业板指', symbol: '399006.SZ' }
];

export function normalizeTestCases(cases) {
  return cases.slice(0, 5).map((testCase, caseIndex) => {
    const normalized = { ...testCase, name: String(testCase.name || `案例 ${caseIndex + 1}`), prompt: String(testCase.prompt || '').trim() };
    if (testCase.dataQueries === undefined) return normalized;
    if (!Array.isArray(testCase.dataQueries) || testCase.dataQueries.length > 3) throw inputError(`用例 ${caseIndex + 1} 的 dataQueries 必须是最多 3 项的数组`);
    normalized.dataQueries = testCase.dataQueries.map((query, queryIndex) => normalizeQuery(query, queryIndex, true));
    return normalized;
  });
}

export function buildDataPlan(testCase) {
  if (testCase.dataQueries?.length) return testCase.dataQueries.map((query, index) => normalizeQuery(query, index, true));
  return inferDataPlan(testCase.prompt);
}

export async function collectDataEvidence(testCase, options = {}) {
  const plan = buildDataPlan(testCase);
  if (!plan.length) return { status: 'not-configured', source: 'pandaai', fetchedAt: null, queries: [] };
  if (!options.enabled) return { status: 'disabled', source: 'pandaai', fetchedAt: null, queries: plan.map(publicPlan) };

  const queries = [];
  for (const query of plan) {
    options.signal?.throwIfAborted();
    try {
      const result = await options.query(query.method, query.params, { signal: options.signal });
      queries.push(snapshotQuery(query, result));
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      queries.push({ ...publicPlan(query), status: 'failed', error: String(error.message || error).slice(0, 500), facts: [] });
    }
  }
  const successful = queries.filter((query) => query.status === 'ready').length;
  return {
    status: successful === queries.length ? 'ready' : successful ? 'partial' : 'failed',
    source: 'pandaai',
    fetchedAt: new Date().toISOString(),
    queries
  };
}

export function verifyOutputAgainstEvidence(output, evidence) {
  if (!evidence || !['ready', 'partial'].includes(evidence.status)) return { status: 'unavailable', score: null, matched: 0, total: 0, checks: [] };
  const content = String(output || '');
  const checks = [];
  for (const query of evidence.queries || []) {
    if (query.status !== 'ready') continue;
    for (const fact of query.facts || []) {
      if (fact.status !== 'available') continue;
      const check = verifyFact(content, fact);
      if (check) checks.push({ queryId: query.id, ...check });
    }
  }
  if (!checks.length) return { status: 'not-claimed', score: null, matched: 0, total: 0, checks: [] };
  const matched = checks.filter((check) => check.status === 'matched').length;
  const mismatched = checks.filter((check) => check.status === 'mismatch').length;
  const missing = checks.filter((check) => check.status === 'missing').length;
  const score = Math.round((matched / checks.length) * 100);
  const status = mismatched ? 'contradicted' : matched === checks.length ? 'verified' : matched ? 'partial' : 'missing';
  return { status, score, matched, mismatched, missing, total: checks.length, checks };
}

function normalizeQuery(query, index, requiredDefault) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw inputError(`dataQueries[${index}] 必须是对象`);
  const method = String(query.method || '').trim();
  if (!method) throw inputError(`dataQueries[${index}] 缺少 method`);
  if (!query.params || typeof query.params !== 'object' || Array.isArray(query.params)) throw inputError(`dataQueries[${index}].params 必须是对象`);
  if (query.facts !== undefined && (!Array.isArray(query.facts) || query.facts.length > 10)) throw inputError(`dataQueries[${index}].facts 必须是最多 10 项的数组`);
  return {
    id: String(query.id || `data-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64),
    label: String(query.label || method).slice(0, 120),
    method,
    params: structuredClone(query.params),
    minRows: positiveInteger(query.minRows, 1),
    requiredFields: stringArray(query.requiredFields, 30),
    facts: (query.facts || []).map((fact, factIndex) => normalizeFact(fact, factIndex, requiredDefault))
  };
}

function normalizeFact(fact, index, requiredDefault) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact) || !String(fact.field || '').trim()) throw inputError(`facts[${index}] 必须声明 field`);
  const where = fact.where === 'first' || fact.where === 'last' || (fact.where && typeof fact.where === 'object' && !Array.isArray(fact.where)) ? structuredClone(fact.where) : 'last';
  return {
    label: String(fact.label || fact.field).slice(0, 120),
    field: String(fact.field).trim(),
    where,
    aliases: stringArray(fact.aliases, 10),
    tolerance: finiteNumber(fact.tolerance),
    multiplier: finiteNumber(fact.multiplier) ?? 1,
    unit: String(fact.unit || '').slice(0, 20),
    required: fact.required === undefined ? requiredDefault : fact.required === true
  };
}

function inferDataPlan(prompt) {
  const text = String(prompt || '');
  const endDate = extractEndDate(text);
  if (!endDate) return [];
  const plans = [];
  for (const anchor of INDEX_ANCHORS) {
    if (!anchor.pattern.test(text)) continue;
    plans.push(autoMarketQuery('get_index_daily', anchor.name, anchor.symbol, endDate, plans.length));
  }
  const stockSymbols = [...new Set(text.match(/\b\d{6}\.(?:SH|SZ|BJ)\b/gi) || [])].slice(0, 2);
  for (const symbol of stockSymbols) plans.push(autoMarketQuery('get_stock_daily', symbol.toUpperCase(), symbol.toUpperCase(), endDate, plans.length));
  return plans.slice(0, 3);
}

function autoMarketQuery(method, label, symbol, endDate, index) {
  const compactEnd = endDate.replaceAll('-', '');
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 14);
  const compactStart = start.toISOString().slice(0, 10).replaceAll('-', '');
  return normalizeQuery({
    id: `auto-${method}-${index + 1}`,
    label: `${label}期末行情锚点`,
    method,
    params: { symbol: [symbol], start_date: compactStart, end_date: compactEnd, fields: [] },
    minRows: 1,
    requiredFields: ['date', 'symbol', 'close'],
    facts: [{
      label: `${label}期末收盘`, field: 'close', where: 'last',
      aliases: [`${label}收盘`, '基准收盘', '收盘点位', '期末收盘', 'close'],
      tolerance: 0.01, required: false
    }]
  }, index, false);
}

function snapshotQuery(query, result) {
  const rows = Array.isArray(result?.data) ? result.data : result?.data && typeof result.data === 'object' ? [result.data] : [];
  const fields = [...new Set(rows.flatMap((row) => row && typeof row === 'object' ? Object.keys(row) : []))].sort();
  const missingFields = query.requiredFields.filter((field) => !fields.includes(field));
  const rowCount = Number.isFinite(result?.rowCount) ? result.rowCount : rows.length;
  const qualityPassed = rowCount >= query.minRows && !missingFields.length;
  const sortedRows = [...rows].sort(compareRowsByDate);
  return {
    ...publicPlan(query),
    status: qualityPassed ? 'ready' : 'invalid',
    rowCount,
    returnedRows: rows.length,
    truncated: result?.truncated === true,
    fields,
    missingFields,
    fingerprint: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    sample: sortedRows.slice(-5),
    facts: query.facts.map((fact) => resolveFact(fact, sortedRows))
  };
}

function resolveFact(fact, rows) {
  let row;
  if (fact.where === 'first') row = rows[0];
  else if (fact.where === 'last') row = rows.at(-1);
  else row = rows.find((candidate) => Object.entries(fact.where).every(([key, value]) => String(valueAt(candidate, key)) === String(value)));
  const rawValue = valueAt(row, fact.field);
  if (rawValue === undefined || rawValue === null) return { ...fact, status: 'unavailable' };
  const value = typeof rawValue === 'number' ? rawValue * fact.multiplier : rawValue;
  return { ...fact, status: 'available', value, sourceDate: row?.date ?? row?.nature_date ?? null, sourceSymbol: row?.symbol ?? null };
}

function verifyFact(content, fact) {
  const alias = fact.aliases.find((candidate) => content.toLowerCase().includes(candidate.toLowerCase()));
  if (fact.aliases.length && !alias) {
    return fact.required ? { label: fact.label, status: 'missing', expected: fact.value, unit: fact.unit, sourceDate: fact.sourceDate } : null;
  }
  if (!fact.required && !alias) return null;
  if (typeof fact.value === 'number') {
    const source = alias ? textAround(content, alias) : content;
    const candidates = numericValues(source);
    if (!candidates.length) return { label: fact.label, status: 'missing', expected: fact.value, unit: fact.unit, sourceDate: fact.sourceDate };
    const tolerance = fact.tolerance ?? Math.max(Math.abs(fact.value) * 0.001, 0.01);
    const closest = candidates.reduce((best, value) => Math.abs(value - fact.value) < Math.abs(best - fact.value) ? value : best, candidates[0]);
    const status = Math.abs(closest - fact.value) <= tolerance ? 'matched' : 'mismatch';
    return { label: fact.label, status, expected: fact.value, observed: closest, tolerance, unit: fact.unit, sourceDate: fact.sourceDate };
  }
  const matched = content.toLowerCase().includes(String(fact.value).toLowerCase());
  return { label: fact.label, status: matched ? 'matched' : 'mismatch', expected: fact.value, unit: fact.unit, sourceDate: fact.sourceDate };
}

function publicPlan(query) {
  return { id: query.id, label: query.label, method: query.method, params: query.params, minRows: query.minRows, requiredFields: query.requiredFields };
}

function extractEndDate(text) {
  const dates = [...text.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)]
    .map((match) => `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`)
    .filter((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
  return dates.at(-1) || null;
}

function compareRowsByDate(left, right) {
  return String(left?.date ?? left?.nature_date ?? '').localeCompare(String(right?.date ?? right?.nature_date ?? ''));
}

function valueAt(object, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], object);
}

function textAround(content, alias) {
  const index = content.toLowerCase().indexOf(alias.toLowerCase());
  return content.slice(Math.max(0, index - 20), index + alias.length + 100);
}

function numericValues(text) {
  return [...String(text).matchAll(/[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g)]
    .map((match) => Number(match[0].replaceAll(',', '').replace('%', '')))
    .filter(Number.isFinite);
}

function stringArray(value, limit) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw inputError('字段必须是字符串数组');
  return value.slice(0, limit).map((item) => String(item).trim()).filter(Boolean);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inputError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
