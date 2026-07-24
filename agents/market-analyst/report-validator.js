import { REPORT_SECTIONS } from './report-renderer.js';
import { validateEvidencePack } from './schemas.js';

const NUMBER_TOKEN = /(?<![A-Za-z0-9_])[-+]?\d+(?:\.\d+)?%?(?![A-Za-z0-9_])/g;
const SYMBOL_TOKEN = /\b(?:\d{6}(?:\.(?:SH|SZ|BJ))?|[A-Z]{2,5}(?:\.[A-Z]{1,4})?)\b/g;
const SYMBOL_FIELDS = /^(?:symbol|ticker|stockCode|securityCode)$/i;
const SYMBOL_ALLOWLIST = new Set(['ETF', 'JSON', 'PANDA', 'SHA', 'HTML', 'HTTP', 'HTTPS']);
const MAX_NARRATIVE_SECTIONS = 16;
const MAX_NARRATIVE_TEXT = 8_000;

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
      if (!symbol || !text.includes(symbol)) return;
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

function numericAllowlist(evidence) {
  return new Set(JSON.stringify(evidence).match(NUMBER_TOKEN) || []);
}

function knownSymbols(evidence) {
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
  visit(evidence);
  return symbols;
}

export function validateNarrative(evidence, narrative) {
  validateEvidencePack(evidence);
  if (narrative === undefined || narrative === null) return { valid: true };
  const sections = narrativeSections(narrative);
  if (sections.length === 0 || !sections.some((section) => section?.id === 'executive-summary')) {
    throw new RangeError('narrative requires an executive-summary section');
  }
  const conclusionIds = new Set(evidence.conclusions.map((item) => item?.conclusion_id));
  const sectionIds = new Set(REPORT_SECTIONS.map((section) => section.id));
  const allowedNumbers = numericAllowlist(evidence);
  const symbols = knownSymbols(evidence);

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
    for (const token of section.text.match(NUMBER_TOKEN) || []) {
      if (!allowedNumbers.has(token)) {
        throw new RangeError(`unsupported numeric token: ${token}`);
      }
    }
    for (const token of section.text.match(SYMBOL_TOKEN) || []) {
      const normalized = token.toUpperCase();
      if (!symbols.has(normalized) && !SYMBOL_ALLOWLIST.has(normalized)) {
        throw new RangeError(`unsupported symbol: ${token}`);
      }
    }
    assertRankClaims(evidence, section.text);
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
  if (evidence.status === 'degraded') {
    if (!markdown.includes('数据不完整')) {
      throw new RangeError('degraded report missing completeness label');
    }
    for (const item of evidence.missingData || []) {
      if (item?.method && !markdown.includes(item.method)) {
        throw new RangeError(`degraded report missing method: ${item.method}`);
      }
    }
  }
  const reportLines = markdown.split('\n');
  for (const rows of Object.values(evidence.leaderboards || {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const dataDate = row.dataDate || evidence.markets?.aShare?.dataDate || evidence.reportDate;
      const identity = row.symbol || row.id || row.name;
      const line = reportLines.find((item) =>
        item.startsWith('|') && identity !== undefined && item.includes(String(identity))
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
  }
  for (const source of evidence.sources) {
    const line = reportLines.find((item) =>
      item.startsWith('|') && source.method !== undefined
      && item.includes(String(source.method))
    );
    if (!line) throw new RangeError(`report missing source method: ${source.method}`);
    const values = [
      source.dataAsOf,
      source.window || source.dataWindow,
      source.coverage,
      source.rowCount,
      source.traceSequence ?? source.sequence ?? source.id,
      source.status
    ];
    for (const value of values) {
      if (value !== undefined && value !== null && !line.includes(String(value))) {
        throw new RangeError(`report source lineage missing value: ${value}`);
      }
    }
  }
  for (const conclusion of evidence.conclusions) {
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
  for (const artifact of evidence.artifacts || []) {
    const hash = artifact.sha256 || artifact.hash;
    if (hash && !markdown.includes(String(hash))) {
      throw new RangeError(`report missing artifact hash: ${artifact.name || hash}`);
    }
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
