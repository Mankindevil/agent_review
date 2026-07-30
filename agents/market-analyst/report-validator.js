import {
  DATA_DATE_UNAVAILABLE,
  REPORT_DISPLAY_CAPS,
  REPORT_SECTIONS,
  dateSelectionNotice,
  truncationMarker
} from './report-renderer.js';
import { sanitizeTraceValue } from './run-trace.js';
import { validateEvidencePack } from './schemas.js';

const NUMBER_TOKEN = /(?<![A-Za-z0-9_])[-+]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][-+]?\d+)?%?(?![A-Za-z0-9_])/g;
const SYMBOL_TOKEN = /(?<![A-Za-z0-9_])(?:\d{1,6}\.[A-Za-z]{1,4}|\d{6}|[A-Za-z]{1,5}(?:\.[A-Za-z]{1,4})?)(?![A-Za-z0-9_])/g;
const SYMBOL_FIELDS = /^(?:symbol|ticker|stockCode|securityCode)$/i;
const SYMBOL_ALLOWLIST = new Set([
  'US', 'HK', 'ETF', 'JSON', 'PANDA', 'SHA', 'HTML', 'HTTP', 'HTTPS', 'ID'
]);
const MARKET_KEYS = new Set([
  'aShare', 'hongKong', 'hk', 'us', 'futures', 'funds', 'etf', 'options', 'macro'
]);
const LEADERBOARD_KEYS = [
  'hotIndustries', 'hotConcepts', 'sellPressure', 'potentialWatchlist'
];
const LEADERBOARD_ROW_FIELDS = [
  'rank', 'symbol', 'name', 'id', 'dataDate', 'score', 'baseScore',
  'weightCoverage', 'componentsUsed', 'status', 'vetoes', 'confidence',
  'constituent_count', 'coverage', 'representativeSymbols',
  'financialEvidenceDate'
];
const CONCLUSION_FIELDS = [
  'conclusion_id', 'formula', 'leaderboard', 'sourceIds', 'confidence',
  'limitations', 'metricIds', 'evidenceIds', 'pandaCalls', 'dataDate',
  'window', 'dataWindow'
];
const MAX_NARRATIVE_SECTIONS = 16;
const MAX_NARRATIVE_TEXT = 8_000;
const MAX_COMPACT_ROWS = 50;
const MAX_COMPACT_SOURCES = 200;
const MAX_COMPACT_CONCLUSIONS = 128;

function isCompactPrimitive(value) {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function pickPrimitiveFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    fields
      .filter((field) => value[field] !== undefined && isCompactPrimitive(value[field]))
      .map((field) => [field, value[field]])
  );
}

function primitiveArray(value, limit = 128) {
  return Array.isArray(value)
    ? value.filter(isCompactPrimitive).slice(0, limit)
    : undefined;
}

function projectIndex(value) {
  return pickPrimitiveFields(value, [
    'symbol', 'name', 'dataDate', 'close', 'preClose', 'changePct',
    'valuation', 'turnover', 'turnoverCny'
  ]);
}

function projectMarket(value, depth = 0) {
  const projected = pickPrimitiveFields(value, [
    'symbol', 'name', 'dataDate', 'rowCount', 'sessionRule', 'close',
    'preClose', 'changePct', 'turnover', 'turnoverCny', 'valuation',
    'advances', 'declines', 'unchanged', 'limitUp', 'limitDown'
  ]);
  if (Array.isArray(value?.indices)) {
    projected.indices = value.indices.slice(0, MAX_COMPACT_ROWS).map(projectIndex);
  }
  if (value?.breadth && typeof value.breadth === 'object' && !Array.isArray(value.breadth)) {
    projected.breadth = pickPrimitiveFields(value.breadth, [
      'advances', 'declines', 'unchanged', 'limitUp', 'limitDown',
      'onePriceLimitUp', 'onePriceLimitDown'
    ]);
  }
  if (depth === 0) {
    for (const field of ['futures', 'funds', 'etf', 'options', 'macro']) {
      if (Array.isArray(value?.[field])) {
        projected[field] = value[field].slice(0, MAX_COMPACT_ROWS).map(projectIndex);
      } else if (value?.[field] && typeof value[field] === 'object') {
        projected[field] = projectMarket(value[field], depth + 1);
      }
    }
  }
  return projected;
}

function projectScoreContributions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([key, item]) => /^[A-Za-z0-9_-]{1,64}$/.test(key) && Number.isFinite(item))
    .slice(0, 64);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function projectLeaderboardRow(row) {
  const projected = pickPrimitiveFields(row, LEADERBOARD_ROW_FIELDS);
  for (const field of ['componentsUsed', 'vetoes', 'representativeSymbols']) {
    const values = primitiveArray(row?.[field]);
    if (values) projected[field] = values;
  }
  const contributions = projectScoreContributions(row?.scoreContributions);
  if (contributions) projected.scoreContributions = contributions;
  return projected;
}

function projectConclusion(value) {
  const projected = pickPrimitiveFields(value, CONCLUSION_FIELDS);
  for (const field of [
    'sourceIds', 'limitations', 'metricIds', 'evidenceIds', 'pandaCalls'
  ]) {
    const values = primitiveArray(value?.[field]);
    if (values) projected[field] = values;
  }
  return projected;
}

export function buildCompactEvidence(evidence) {
  validateEvidencePack(evidence);
  const markets = {};
  for (const [key, value] of Object.entries(evidence.markets)) {
    if (MARKET_KEYS.has(key)) markets[key] = projectMarket(value);
  }
  const leaderboards = {};
  for (const key of LEADERBOARD_KEYS) {
    if (Array.isArray(evidence.leaderboards[key])) {
      leaderboards[key] = evidence.leaderboards[key]
        .slice(0, MAX_COMPACT_ROWS)
        .map(projectLeaderboardRow);
    }
  }
  const compact = {
    schemaVersion: evidence.schemaVersion,
    runId: evidence.runId,
    reportDate: evidence.reportDate,
    status: evidence.status,
    markets,
    universe: pickPrimitiveFields(evidence.universe, [
      'aShare', 'dailyCovered', 'preliminaryCandidates', 'fullEnrichment'
    ]),
    coverage: pickPrimitiveFields(evidence.coverage, [
      'aShareDaily', 'aShareHistorical', 'historicalActualPairs',
      'historicalExpectedPairs'
    ]),
    missingData: (evidence.missingData || []).slice(0, MAX_COMPACT_SOURCES).map((item) =>
      pickPrimitiveFields(item, [
        'section', 'method', 'status', 'coverage', 'weightRemoved', 'reason', 'error'
      ])
    ),
    metricVersion: isCompactPrimitive(evidence.metricVersion)
      ? evidence.metricVersion
      : null,
    leaderboards,
    conclusions: evidence.conclusions
      .slice(0, MAX_COMPACT_CONCLUSIONS)
      .map(projectConclusion),
    sources: evidence.sources.slice(0, MAX_COMPACT_SOURCES).map((source) => ({
      ...pickPrimitiveFields(source, [
        'id', 'method', 'dataAsOf', 'coverage', 'rowCount', 'status'
      ]),
      window: isCompactPrimitive(source.window)
        ? source.window
        : (isCompactPrimitive(source.dataWindow) ? source.dataWindow : null),
      traceSequence: isCompactPrimitive(source.traceSequence ?? source.sequence)
        ? (source.traceSequence ?? source.sequence)
        : null
    })),
    conventions: (evidence.conventions || []).slice(0, 100)
      .filter((item) => typeof item === 'string')
  };
  return sanitizeTraceValue(compact);
}

function narrativeSections(narrative) {
  const sections = Array.isArray(narrative) ? narrative : narrative.sections;
  if (!Array.isArray(sections)) throw new TypeError('narrative.sections must be an array');
  if (sections.length > MAX_NARRATIVE_SECTIONS) throw new RangeError('narrative has too many sections');
  return sections;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertRankClaims(evidence, text) {
  for (const rows of Object.values(evidence.leaderboards || {})) {
    if (!Array.isArray(rows)) continue;
    rows.forEach((row, index) => {
      const symbol = row.symbol;
      if (!symbol || !text.toUpperCase().includes(String(symbol).toUpperCase())) return;
      const rank = row.rank ?? index + 1;
      const escaped = escapeRegExp(symbol);
      const after = text.match(
        new RegExp(`${escaped}[^。；;\\n]{0,40}(?:排名\\s*(?:第\\s*)?|第\\s*)(\\d+)\\s*(?:名)?`, 'i')
      );
      const before = text.match(
        new RegExp(`(?:排名\\s*(?:第\\s*)?|第\\s*)(\\d+)\\s*(?:名)?[^。；;\\n]{0,40}${escaped}`, 'i')
      );
      const claimed = after?.[1] ?? before?.[1];
      if (claimed !== undefined && Number(claimed) !== Number(rank)) {
        throw new RangeError(
          `unsupported rank claim for ${symbol}: ${claimed}; evidence rank is ${rank}`
        );
      }
    });
  }
}

function canonicalNumber(token) {
  const value = String(token);
  const percentage = value.endsWith('%');
  const number = Number(percentage ? value.slice(0, -1) : value);
  if (!Number.isFinite(number)) return null;
  const normalized = percentage ? number / 100 : number;
  return Object.is(normalized, -0) ? '0' : normalized.toString();
}

function numericAllowlist(value) {
  return new Set(
    (JSON.stringify(value).match(NUMBER_TOKEN) || [])
      .map(canonicalNumber)
      .filter((item) => item !== null)
  );
}

function knownSymbols(value) {
  const symbols = new Set();
  const visit = (value, key = '') => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (SYMBOL_FIELDS.test(key)) symbols.add(value.toUpperCase());
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    for (const [childKey, item] of Object.entries(value)) visit(item, childKey);
  };
  visit(value);
  return symbols;
}

function symbolTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(SYMBOL_TOKEN)) {
    const token = match[0];
    const next = text[match.index + token.length];
    if (/^a$/i.test(token) && /^\s*股/.test(text.slice(match.index + token.length))) continue;
    tokens.push(token);
  }
  return tokens;
}

function conclusionScope(compact, ids) {
  const idSet = new Set(ids);
  const conclusions = compact.conclusions.filter((item) => idSet.has(item.conclusion_id));
  const boardKeys = new Set();
  const sourceIds = new Set();
  for (const conclusion of conclusions) {
    for (const board of String(conclusion.leaderboard || '').split(',')) {
      if (board.trim()) boardKeys.add(board.trim());
    }
    for (const sourceId of conclusion.sourceIds || []) sourceIds.add(sourceId);
  }
  return {
    reportDate: compact.reportDate,
    status: compact.status,
    conclusions,
    leaderboards: Object.fromEntries(
      [...boardKeys]
        .filter((key) => compact.leaderboards[key])
        .map((key) => [key, compact.leaderboards[key]])
    ),
    sources: compact.sources.filter((source) => sourceIds.has(source.id))
  };
}

export function validateNarrative(evidence, narrative, options = {}) {
  validateEvidencePack(evidence);
  if (narrative === undefined || narrative === null) return { valid: true };
  // Deterministic report rendering owns fallback mode; empty model prose is allowed.
  if (typeof narrative.fallbackReason === 'string' && narrative.fallbackReason.trim()) {
    return { valid: true };
  }
  const compact = options.compactEvidence || buildCompactEvidence(evidence);
  const sections = narrativeSections(narrative);
  if (sections.length === 0 || !sections.some((section) => section?.id === 'executive-summary')) {
    throw new RangeError('narrative requires an executive-summary section');
  }
  const conclusionIds = new Set(compact.conclusions.map((item) => item?.conclusion_id));
  const sectionIds = new Set(REPORT_SECTIONS.map((section) => section.id));
  const allowedNumbers = numericAllowlist(compact);
  const symbols = knownSymbols(compact);

  for (const section of sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new TypeError('narrative section must be an object');
    }
    if (!sectionIds.has(section.id)) {
      throw new RangeError(`unknown narrative section: ${section.id}`);
    }
    if (!Array.isArray(section.conclusionIds) || section.conclusionIds.length === 0) {
      throw new TypeError('narrative section requires conclusionIds');
    }
    for (const id of section.conclusionIds) {
      if (!conclusionIds.has(id)) throw new RangeError(`unknown conclusion ID: ${id}`);
    }
    if (typeof section.text !== 'string' || !section.text.trim()) {
      throw new TypeError('narrative section text is required');
    }
    if (section.text.length > MAX_NARRATIVE_TEXT) {
      throw new RangeError('narrative section text is too long');
    }
    const scope = conclusionScope(compact, section.conclusionIds);
    const scopedNumbers = numericAllowlist(scope);
    const scopedSymbols = knownSymbols(scope);
    for (const token of section.text.match(NUMBER_TOKEN) || []) {
      const normalized = canonicalNumber(token);
      if (normalized === null || !allowedNumbers.has(normalized)) {
        throw new RangeError(`unsupported numeric token: ${token}`);
      }
      if (!scopedNumbers.has(normalized)) {
        throw new RangeError(`numeric fact is outside referenced conclusion scope: ${token}`);
      }
    }
    for (const token of symbolTokens(section.text)) {
      const normalized = token.toUpperCase();
      if (!symbols.has(normalized) && !SYMBOL_ALLOWLIST.has(normalized)) {
        throw new RangeError(`unsupported symbol: ${token}`);
      }
      if (
        symbols.has(normalized)
        && !scopedSymbols.has(normalized)
        && !SYMBOL_ALLOWLIST.has(normalized)
      ) {
        throw new RangeError(`symbol fact is outside referenced conclusion scope: ${token}`);
      }
    }
    assertRankClaims(scope, section.text);
  }
  return { valid: true };
}

function assertReportContract(evidence, markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new TypeError('markdown report is required');
  }
  for (const section of REPORT_SECTIONS) {
    if (!markdown.includes(`## ${section.title}`)) {
      throw new RangeError(`report missing section: ${section.title}`);
    }
  }
  if (!markdown.includes(evidence.reportDate)) {
    throw new RangeError('report missing absolute report date');
  }
  if (!markdown.includes('本报告仅供研究与信息交流，不构成投资建议')) {
    throw new RangeError('report missing research-only disclaimer');
  }
  const selectionNotice = dateSelectionNotice(evidence.dateSelection);
  if (selectionNotice && !markdown.includes(selectionNotice)) {
    throw new RangeError('report missing date fallback notice');
  }
  if (evidence.status === 'degraded') {
    if (!markdown.includes('数据不完整')) {
      throw new RangeError('degraded report missing completeness label');
    }
    for (const item of (evidence.missingData || []).slice(0, REPORT_DISPLAY_CAPS.missingData)) {
      if (item?.method && !markdown.includes(item.method)) {
        throw new RangeError(`degraded report missing method: ${item.method}`);
      }
    }
  }
  if ((evidence.missingData || []).length > REPORT_DISPLAY_CAPS.missingData) {
    const marker = truncationMarker(
      'missing-data',
      evidence.missingData.length - REPORT_DISPLAY_CAPS.missingData
    );
    if (!markdown.includes(marker)) throw new RangeError(`report missing truncation marker: ${marker}`);
  }
  if ((evidence.conventions || []).length > REPORT_DISPLAY_CAPS.conventions) {
    const marker = truncationMarker(
      'conventions',
      evidence.conventions.length - REPORT_DISPLAY_CAPS.conventions
    );
    if (!markdown.includes(marker)) throw new RangeError(`report missing truncation marker: ${marker}`);
  }
  const reportLines = markdown.split('\n');
  for (const rows of Object.values(evidence.leaderboards || {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows.slice(0, REPORT_DISPLAY_CAPS.leaderboardRows)) {
      const dataDate = row.dataDate || DATA_DATE_UNAVAILABLE;
      const identity = row.symbol || row.id || row.name;
      const line = reportLines.find((item) =>
        item.startsWith('|') && identity !== undefined
        && item.includes(String(identity)) && item.includes(String(dataDate))
      );
      if (!line) throw new RangeError(`leaderboard row missing identity: ${identity}`);
      for (const required of [dataDate, row.confidence, row.score]) {
        if (required !== undefined && required !== null && !line.includes(String(required))) {
          throw new RangeError(`leaderboard row missing traceable value: ${required}`);
        }
      }
      for (const contribution of Object.values(row.scoreContributions || {})) {
        if (contribution !== undefined && contribution !== null
            && !line.includes(String(contribution))) {
          throw new RangeError(`leaderboard row missing score contribution: ${contribution}`);
        }
      }
    }
    if (rows.length > REPORT_DISPLAY_CAPS.leaderboardRows) {
      const marker = truncationMarker(
        'leaderboard',
        rows.length - REPORT_DISPLAY_CAPS.leaderboardRows
      );
      if (!markdown.includes(marker)) throw new RangeError(`report missing truncation marker: ${marker}`);
    }
  }
  const riskRowCount = Object.values(evidence.leaderboards || {}).reduce(
    (total, rows) => total + (Array.isArray(rows)
      ? rows.filter((row) => Array.isArray(row?.vetoes) && row.vetoes.length).length
      : 0),
    0
  );
  if (riskRowCount > REPORT_DISPLAY_CAPS.riskRows) {
    const marker = truncationMarker('risk-rows', riskRowCount - REPORT_DISPLAY_CAPS.riskRows);
    if (!markdown.includes(marker)) throw new RangeError(`report missing truncation marker: ${marker}`);
  }
  for (const source of evidence.sources.slice(0, REPORT_DISPLAY_CAPS.sources)) {
    const callIdentity = source.traceSequence ?? source.sequence ?? source.id;
    const line = reportLines.find((item) =>
      item.startsWith('|')
      && source.method !== undefined
      && item.includes(String(source.method))
      && callIdentity !== undefined
      && callIdentity !== null
      && item.includes(String(callIdentity))
    );
    if (!line) throw new RangeError(`report missing source method: ${source.method}`);
    const values = [
      source.dataAsOf || DATA_DATE_UNAVAILABLE,
      source.window || source.dataWindow,
      source.coverage,
      source.rowCount,
      callIdentity,
      source.status
    ];
    for (const value of values) {
      if (value !== undefined && value !== null && !line.includes(String(value))) {
        throw new RangeError(`report source lineage missing value: ${value}`);
      }
    }
  }
  if (evidence.sources.length > REPORT_DISPLAY_CAPS.sources) {
    const marker = truncationMarker('sources', evidence.sources.length - REPORT_DISPLAY_CAPS.sources);
    if (!markdown.includes(marker)) throw new RangeError(`report missing truncation marker: ${marker}`);
  }
  for (const conclusion of evidence.conclusions.slice(0, REPORT_DISPLAY_CAPS.conclusions)) {
    const line = reportLines.find((item) =>
      item.startsWith('|') && conclusion.conclusion_id !== undefined
      && item.includes(String(conclusion.conclusion_id))
    );
    if (!line) {
      throw new RangeError(`report missing conclusion lineage: ${conclusion.conclusion_id}`);
    }
    for (const value of [conclusion.formula, conclusion.confidence]) {
      if (value !== undefined && value !== null && !line.includes(String(value))) {
        throw new RangeError(`report conclusion lineage missing value: ${value}`);
      }
    }
  }
  if (evidence.conclusions.length > REPORT_DISPLAY_CAPS.conclusions) {
    const marker = truncationMarker(
      'conclusions',
      evidence.conclusions.length - REPORT_DISPLAY_CAPS.conclusions
    );
    if (!markdown.includes(marker)) throw new RangeError(`report missing truncation marker: ${marker}`);
  }
  for (const artifact of (evidence.artifacts || []).slice(0, REPORT_DISPLAY_CAPS.artifacts)) {
    const hash = artifact.sha256 || artifact.hash;
    if (hash && !markdown.includes(String(hash))) {
      throw new RangeError(`report missing artifact hash: ${artifact.name || hash}`);
    }
  }
  if ((evidence.artifacts || []).length > REPORT_DISPLAY_CAPS.artifacts) {
    const marker = truncationMarker(
      'artifacts',
      evidence.artifacts.length - REPORT_DISPLAY_CAPS.artifacts
    );
    if (!markdown.includes(marker)) throw new RangeError(`report missing truncation marker: ${marker}`);
  }
  if (evidence.detailUrl && !markdown.includes(evidence.detailUrl)) {
    throw new RangeError('report missing configured protected detail link');
  }
}

export function validateReport({ evidence, markdown, narrative } = {}) {
  validateEvidencePack(evidence);
  assertReportContract(evidence, markdown);
  validateNarrative(evidence, narrative);
  return { valid: true };
}
