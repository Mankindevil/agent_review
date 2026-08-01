import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V1_REVIEWER_IDS } from './v1-model-scoring.js';
import { RUNTIMES } from './runtimes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = path.join(root, 'scripts', 'render-v1-report.py');
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_XREF_ENTRIES = 100_000;
const MAX_PAGE_TREE_DEPTH = 64;
const MAX_PAGE_TREE_NODES = 100_000;
const MAX_PDF_OBJECT_BYTES = 1024 * 1024;
const MAX_PDF_TOKENS = MAX_XREF_ENTRIES * 4;
const PUBLIC_PANDA_PARAM_KEYS = [
  'symbol', 'symbols', 'code', 'codes', 'ts_code', 'index_code', 'index_codes',
  'start_date', 'end_date', 'begin_date', 'trade_date', 'date', 'cal_date',
  'fields', 'factor', 'factors', 'industry', 'industry_code', 'exchange',
  'is_open', 'adj', 'freq', 'period', 'report_date', 'ann_date', 'market',
  'currency', 'indicator', 'type', 'asset', 'asset_type', 'limit', 'offset'
];
const PUBLIC_FACT_KEYS = ['label', 'field', 'aliases', 'tolerance', 'multiplier', 'unit', 'required', 'status', 'value', 'sourceDate', 'sourceSymbol'];
const CREDENTIAL_SELECTOR_KEY = /(?:api)?key|auth(?:orization)?|bearer|credential|secret|password|token|cookie|session/iu;

export function projectV1Report(evaluation) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) throw new TypeError('评测记录不存在');
  if (evaluation.schemaVersion !== 1) throw new RangeError('仅支持完整 V1 评测报告');
  if (evaluation.status !== 'completed') throw new RangeError('仅已完成的 V1 评测可下载报告');
  assertCompleteV1Report(evaluation);
  const agentCard = projectCard(evaluation.agentCard);
  return {
    reportVersion: 'v1-complete-report/1',
    generatedAt: new Date().toISOString(),
    evaluation: strings(evaluation, ['id', 'createdAt', 'updatedAt', 'completedAt', 'mode', 'overallMode', 'status', 'stage']),
    agentCard,
    scoring: {
      scoringConfig: projectScoringConfig(evaluation.scoringConfig),
      complexity: scoreObject(evaluation.complexity),
      professional: projectProfessional(evaluation.professional),
      averages: numbers(evaluation.averages, ['submitted', 'claude-code', 'cursor', 'doubao']),
      roast: projectRoast(evaluation.roast)
    },
    builds: array(evaluation.builds).map(projectBuild),
    benchmark: array(evaluation.benchmark).map(projectRound),
    logs: array(evaluation.logs).map((log) => ({
      ...strings(log, ['at', 'level', 'source', 'phase', 'text', 'detail', 'mode']),
      ...numbers(log, ['durationMs'])
    }))
  };
}

export async function generateV1ReportPdf(dto, options = {}) {
  if (!dto || dto.reportVersion !== 'v1-complete-report/1') throw new TypeError('报告 DTO 无效');
  const input = Buffer.from(JSON.stringify(dto), 'utf8');
  if (input.length > MAX_INPUT_BYTES) throw reportError(413, '报告内容超过生成器输入上限');
  const python = options.python || process.env.REPORT_PDF_PYTHON || process.env.PANDA_DATA_PYTHON || '.venv/bin/python';
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxPdfBytes = Math.min(MAX_PDF_BYTES, positiveInteger(options.maxPdfBytes, MAX_PDF_BYTES));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(python, [renderer], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { reject(reportError(503, `PDF 生成器不可用：${safeError(error)}`)); return; }
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reportError(504, 'PDF 报告生成超时'));
    }, timeoutMs);
    child.once('error', (error) => finish(reportError(503, `PDF 生成器不可用：${safeError(error)}`)));
    child.stderr.on('data', (chunk) => { if (stderr.length < 4_000) stderr += Buffer.from(chunk).toString('utf8'); });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.length > maxPdfBytes) {
        child.kill('SIGKILL');
        finish(reportError(502, 'PDF 报告超过输出上限'));
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(reportError(502, `PDF 生成失败：${sanitizeStderr(stderr) || `退出码 ${code}`}`));
      if (!isStructurallyValidPdf(stdout)) return finish(reportError(502, 'PDF 生成器返回了无效或不完整内容'));
      finish(null, stdout);
    });
    child.stdin.once('error', (error) => finish(reportError(503, `PDF 生成器输入失败：${safeError(error)}`)));
    child.stdin.end(input);
  });
}

function projectCard(card) {
  return {
    ...strings(card, ['name', 'description', 'version', 'protocolVersion', 'url', 'preferredTransport']),
    supportedInterfaces: array(card?.supportedInterfaces).map((value) => strings(value, ['url', 'protocolBinding', 'protocolVersion'])),
    capabilities: bools(card?.capabilities, ['streaming', 'pushNotifications']),
    defaultInputModes: stringArray(card?.defaultInputModes),
    defaultOutputModes: stringArray(card?.defaultOutputModes),
    skills: array(card?.skills).map((skill) => ({
      ...strings(skill, ['id', 'name', 'description']), tags: stringArray(skill?.tags), examples: stringArray(skill?.examples)
    }))
  };
}

function projectProfessional(value) {
  return {
    ...strings(value, ['version', 'mode']), ...numbers(value, ['score']),
    dimensions: numbers(value?.dimensions, ['positioningClarity', 'skillDesign', 'protocolCoherence', 'ioExampleQuality', 'boundaryRiskDisclosure']),
    reviews: array(value?.reviews).map((review) => ({
      ...strings(review, ['reviewerId', 'reviewer', 'model', 'version', 'mode', 'comment', 'risk', 'error']), ...numbers(review, ['score']),
      dimensions: numbers(review?.dimensions, ['positioningClarity', 'skillDesign', 'protocolCoherence', 'ioExampleQuality', 'boundaryRiskDisclosure'])
    }))
  };
}

function projectBuild(value) {
  return {
    ...strings(value, ['runtime', 'runtimeId', 'mode', 'error']),
    skill: value?.skill ? { ...strings(value.skill, ['name', 'description']), instructions: stringArray(value.skill.instructions), tools: stringArray(value.skill.tools) } : null,
    contextUsage: array(value?.contextUsage).map(projectContextUsage)
  };
}

function projectRound(round) {
  const entries = array(round?.entries).map(projectEntry);
  return {
    case: { ...strings(round?.case, ['id', 'name', 'prompt', 'expectedDeliverable']), constraints: stringArray(round?.case?.constraints) },
    judging: projectJudging(round?.judging),
    dataEvidence: projectDataEvidence(round?.dataEvidence),
    entries,
    ranking: [...entries]
      .sort((left, right) => (Number.isFinite(right.score) ? right.score : -Infinity) - (Number.isFinite(left.score) ? left.score : -Infinity))
      .map((entry, index) => ({ ...strings(entry, ['id', 'name']), ...numbers(entry, ['score']), rank: index + 1 }))
  };
}

function projectEntry(entry) {
  return {
    ...strings(entry, ['id', 'name', 'mode', 'output', 'scoreStatus']), ...numbers(entry, ['score', 'judgeSeed']),
    dimensions: numbers(entry?.dimensions, ['scenarioValue', 'professionalQuality', 'agentCapability', 'taskConstraint', 'evidenceRisk', 'artifactUsability']),
    detail: projectDetail(entry?.detail), execution: projectExecution(entry?.execution),
    dataVerification: projectDataVerification(entry?.dataVerification),
    judgeReviews: array(entry?.judgeReviews).map(projectJudgeReview)
  };
}

function projectJudging(value) {
  return {
    ...strings(value, ['version', 'status', 'mode', 'reviewerId']), ...numbers(value, ['requiredSeats', 'successfulSeats']),
    seats: array(value?.seats).map((seat) => strings(seat, ['reviewerId', 'reviewerName', 'model', 'mode', 'status', 'failure'])),
    scenario: value?.scenario ? {
      dimensions: numbers(value.scenario.dimensions, ['problemComplexity', 'agentSuitability']), ...numbers(value.scenario, ['score']),
      reviews: array(value.scenario.reviews).map(projectJudgeReview)
    } : null
  };
}

function projectDetail(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    scenario: value.scenario ? { dimensions: numbers(value.scenario.dimensions, ['problemComplexity', 'agentSuitability']), ...numbers(value.scenario, ['score']) } : null,
    professionalism: value.professionalism ? { dimensions: numbers(value.professionalism.dimensions, ['taskCompletion', 'methodProfessionalism', 'evidenceDataQuality', 'riskUncertainty', 'artifactUsability']), ...numbers(value.professionalism, ['score']) } : null,
    capability: value.capability ? { ...strings(value.capability, ['status', 'timingScope', 'toolObservation']), ...bools(value.capability, ['includesNetwork']), ...numbers(value.capability, ['durationMs', 'executionSuccessScore', 'latencyScore', 'capabilityScore']) } : null
  };
}

function projectExecution(value) { return value ? { ...strings(value, ['status', 'timingScope', 'toolObservation', 'failureStage']), ...bools(value, ['includesNetwork']), ...numbers(value, ['durationMs']), contextUsage: array(value.contextUsage).map(projectContextUsage) } : null; }
function projectContextUsage(value) { return { ...strings(value, ['phase', 'query', 'queryMethod', 'status', 'warning']), ...numbers(value, ['inputBytes', 'budgetBytes', 'originalRows', 'keptRows', 'droppedRows', 'truncatedRows', 'rowCount']) }; }
function projectDataEvidence(value) { return value ? { ...strings(value, ['status', 'source', 'fetchedAt']), queries: array(value.queries).map((query) => ({ ...strings(query, ['id', 'label', 'method', 'status', 'error', 'fingerprint']), ...numbers(query, ['minRows', 'rowCount', 'returnedRows']), ...bools(query, ['truncated']), requiredFields: stringArray(query?.requiredFields), fields: stringArray(query?.fields), missingFields: stringArray(query?.missingFields), params: projectDataParams(query?.params), facts: array(query?.facts).map(projectFact) })) } : null; }
function projectDataParams(value) { return Object.fromEntries(PUBLIC_PANDA_PARAM_KEYS.filter((key) => isPublicDataValue(value?.[key])).map((key) => [key, projectDataValue(value[key])])); }
function projectFact(value) {
  const aliases = stringArray(value?.aliases);
  const where = projectFactSelector(value?.where);
  return {
    ...strings(value, PUBLIC_FACT_KEYS), ...numbers(value, ['tolerance', 'multiplier', 'value']), ...bools(value, ['required']),
    ...(where === 'first' || where === 'last' || where?.length ? { where } : {}), ...(aliases.length ? { aliases } : {})
  };
}
function projectFactSelector(value) {
  if (value === 'first' || value === 'last') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.entries(value)
    .filter(([field, expected]) => isPublicFactSelectorField(field) && isPublicDataValue(expected))
    .slice(0, 10)
    .map(([field, expected]) => ({ field, expected: projectDataValue(expected) }));
}
function isPublicFactSelectorField(value) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(value) && !CREDENTIAL_SELECTOR_KEY.test(value);
}
function isPublicDataValue(value) { return typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value) || Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'boolean' || Number.isFinite(item)); }
function projectDataValue(value) { return Array.isArray(value) ? [...value] : value; }
function projectDataVerification(value) { return value ? { ...strings(value, ['status', 'summary']), ...numbers(value, ['score', 'matched', 'mismatched', 'missing', 'total']), checks: array(value.checks).map((check) => ({ ...strings(check, ['id', 'queryId', 'label', 'status', 'reason', 'unit', 'sourceDate']), ...numbers(check, ['expected', 'actual', 'observed', 'tolerance']) })) } : null; }
function projectJudgeReview(value) { return { ...strings(value, ['reviewerId', 'reviewerName', 'reviewer', 'model', 'mode', 'status', 'rationale', 'error']), ...numbers(value, ['score', 'total']), dimensions: numbers(value?.dimensions, ['problemComplexity', 'agentSuitability', 'taskCompletion', 'methodProfessionalism', 'evidenceDataQuality', 'riskUncertainty', 'artifactUsability', 'taskConstraint', 'professionalQuality', 'evidenceRisk']), uncertainties: stringArray(value?.uncertainties) }; }
function projectScoringConfig(value) { return strings(value, ['version', 'mode', 'reviewerId']); }
function projectRoast(value) { return { ...strings(value, ['headline', 'summary', 'rationale']), ...numbers(value, ['deltaClaude', 'deltaDoubao', 'professionalAverage']), tier: value?.tier ? strings(value.tier, ['code', 'label', 'stamp', 'tone']) : null }; }
function strings(value, keys) { return Object.fromEntries(keys.filter((key) => typeof value?.[key] === 'string').map((key) => [key, value[key]])); }
function numbers(value, keys) { return Object.fromEntries(keys.filter((key) => Number.isFinite(value?.[key])).map((key) => [key, value[key]])); }
function bools(value, keys) { return Object.fromEntries(keys.filter((key) => typeof value?.[key] === 'boolean').map((key) => [key, value[key]])); }
function scoreObject(value) { return { ...strings(value, ['verdict', 'reason']), ...numbers(value, ['score']), dimensions: numbers(value?.dimensions, ['taskComplexity', 'dataDependency', 'workflowDepth', 'agentNecessity', 'reproducibility']) }; }
function array(value) { return Array.isArray(value) ? value : []; }
function stringArray(value) { return array(value).filter((item) => typeof item === 'string'); }
function positiveInteger(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function safeError(error) { return String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 300); }
function sanitizeStderr(value) { return String(value || '').replace(/[\r\n]+/g, ' ').replace(/(?:password|secret|token|authorization|credential)\s*[=:]\s*\S+/giu, '[REDACTED]').slice(0, 500); }
function reportError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function isStructurallyValidPdf(pdf) {
  if (!Buffer.isBuffer(pdf) || pdf.length < 32 || !pdf.subarray(0, Math.min(pdf.length, 1024)).includes(Buffer.from('%PDF-'))) return false;
  const tail = pdf.subarray(Math.max(0, pdf.length - 4096)).toString('latin1');
  const startxref = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/u);
  if (!startxref) return false;
  const offset = Number(startxref[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= pdf.length) return false;
  return hasTraditionalPdfStructure(pdf, offset);
}
function hasTraditionalPdfStructure(pdf, xrefOffset) {
  const source = pdf.toString('latin1');
  if (!source.startsWith('xref', xrefOffset)) return false;
  let cursor = xrefOffset + 4;
  const offsets = new Map();
  let entryCount = 0;
  while (true) {
    const line = nextPdfLine(source, cursor);
    if (!line) return false;
    cursor = line.end;
    if (!line.text) continue;
    if (line.text === 'trailer') break;
    const subsection = line.text.match(/^(\d+)\s+(\d+)$/u);
    if (!subsection) return false;
    const first = Number(subsection[1]);
    const count = Number(subsection[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 1 || count > MAX_XREF_ENTRIES || entryCount + count > MAX_XREF_ENTRIES) return false;
    entryCount += count;
    for (let index = 0; index < count; index += 1) {
      const entry = nextPdfLine(source, cursor);
      if (!entry) return false;
      cursor = entry.end;
      const match = entry.text.match(/^(\d{10})\s+(\d{5})\s+([nf])\s*$/u);
      if (!match) return false;
      if (match[3] === 'n') offsets.set(`${first + index}:${Number(match[2])}`, Number(match[1]));
    }
  }
  if (!entryCount || offsets.size > MAX_XREF_ENTRIES) return false;
  const trailer = parsePdfDictionary(source.slice(cursor, cursor + 64 * 1024));
  const root = trailer?.Root;
  if (!isPdfReference(root) || !Number.isSafeInteger(trailer?.Size) || trailer.Size < 2) return false;
  const readDictionary = createPdfDictionaryReader(source, offsets);
  const catalog = readDictionary(root);
  if (!catalog || catalog.Type !== 'Catalog' || !isPdfReference(catalog.Pages)) return false;
  return validatePageTree(readDictionary, catalog.Pages);
}
function nextPdfLine(source, start) {
  if (start > source.length) return null;
  const endOfLine = source.indexOf('\n', start);
  const end = endOfLine < 0 ? source.length : endOfLine + 1;
  return { text: source.slice(start, endOfLine < 0 ? source.length : endOfLine).replace(/\r$/u, '').trim(), end };
}
function createPdfDictionaryReader(source, offsets) {
  const orderedOffsets = [...new Set(offsets.values())]
    .filter((offset) => Number.isSafeInteger(offset) && offset >= 0)
    .sort((left, right) => left - right);
  const followingOffset = new Map();
  for (let index = 0; index + 1 < orderedOffsets.length; index += 1) followingOffset.set(orderedOffsets[index], orderedOffsets[index + 1]);
  const cache = new Map();
  return (reference) => {
    if (!isPdfReference(reference)) return null;
    const key = `${reference.objectNumber}:${reference.generation}`;
    if (cache.has(key)) return cache.get(key);
    const offset = offsets.get(key);
    const dictionary = pdfDictionaryAt(source, offset, followingOffset.get(offset), reference);
    cache.set(key, dictionary);
    return dictionary;
  };
}
function pdfDictionaryAt(source, offset, nextOffset, reference) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= source.length) return null;
  const limit = Math.min(source.length, offset + MAX_PDF_OBJECT_BYTES, Number.isSafeInteger(nextOffset) && nextOffset > offset ? nextOffset : source.length);
  if (limit <= offset) return null;
  const header = new RegExp(`^${reference.objectNumber}\\s+${reference.generation}\\s+obj\\b`, 'u');
  const headerMatch = source.slice(offset, Math.min(limit, offset + 64)).match(header);
  if (!headerMatch) return null;
  const dictionaryStart = skipPdfWhitespaceAndComments(source, offset + headerMatch[0].length, limit);
  const dictionary = pdfDictionaryBounds(source, dictionaryStart, limit);
  if (!dictionary || dictionary.start !== dictionaryStart) return null;
  const endobjStart = skipPdfWhitespaceAndComments(source, dictionary.end, limit);
  const endobjEnd = endobjStart + 'endobj'.length;
  if (endobjEnd >= limit || !source.startsWith('endobj', endobjStart) || !isPdfTokenBoundary(source[endobjEnd])) return null;
  return parseCompletePdfDictionary(source.slice(dictionary.start, dictionary.end));
}
function validatePageTree(readDictionary, rootReference) {
  const visitedPages = new Set();
  let visitedNodes = 0;
  const walk = (reference, parentReference, depth) => {
    if (depth > MAX_PAGE_TREE_DEPTH || visitedNodes >= MAX_PAGE_TREE_NODES) return null;
    const key = `${reference.objectNumber}:${reference.generation}`;
    if (visitedPages.has(key)) return null;
    visitedPages.add(key);
    visitedNodes += 1;
    const dictionary = readDictionary(reference);
    if (!dictionary) return null;
    if (dictionary.Type === 'Page') {
      return parentReference && samePdfReference(dictionary.Parent, parentReference) ? 1 : null;
    }
    if (dictionary.Type !== 'Pages' || !Array.isArray(dictionary.Kids) || !dictionary.Kids.length || !Number.isSafeInteger(dictionary.Count) || dictionary.Count < 1) return null;
    if (parentReference ? !samePdfReference(dictionary.Parent, parentReference) : Object.hasOwn(dictionary, 'Parent')) return null;
    let count = 0;
    for (const child of dictionary.Kids) {
      if (!isPdfReference(child)) return null;
      const childCount = walk(child, reference, depth + 1);
      if (!Number.isSafeInteger(childCount)) return null;
      count += childCount;
      if (count > MAX_PAGE_TREE_NODES) return null;
    }
    return count === dictionary.Count ? count : null;
  };
  return Number.isSafeInteger(walk(rootReference, null, 0));
}
function parsePdfDictionary(source) {
  const dictionary = pdfDictionarySource(source);
  if (!dictionary) return null;
  return parseCompletePdfDictionary(dictionary);
}
function parseCompletePdfDictionary(dictionary) {
  const tokens = pdfTokens(dictionary);
  if (!tokens) return null;
  const parsed = parsePdfValue(tokens, 0);
  return parsed?.value?.kind === 'dictionary' && parsed.index === tokens.length ? parsed.value.entries : null;
}
function pdfDictionarySource(source) {
  const start = source.indexOf('<<');
  if (start < 0) return null;
  const dictionary = pdfDictionaryBounds(source, start, source.length);
  return dictionary ? source.slice(dictionary.start, dictionary.end) : null;
}
function pdfDictionaryBounds(source, start, limit) {
  if (start < 0 || start + 2 > limit || !source.startsWith('<<', start)) return null;
  let depth = 0;
  let literalDepth = 0;
  for (let index = start; index < limit; index += 1) {
    const character = source[index];
    if (literalDepth) {
      if (character === '\\') { if (index + 1 >= limit) return null; index += 1; }
      else if (character === '(') literalDepth += 1;
      else if (character === ')') literalDepth -= 1;
      continue;
    }
    if (character === '%') { while (index < limit && source[index] !== '\n' && source[index] !== '\r') index += 1; continue; }
    if (character === '(') { literalDepth = 1; continue; }
    if (index + 2 <= limit && source.startsWith('<<', index)) { depth += 1; index += 1; continue; }
    if (index + 2 <= limit && source.startsWith('>>', index)) {
      depth -= 1;
      index += 1;
      if (!depth) return { start, end: index + 1 };
      if (depth < 0) return null;
    }
  }
  return null;
}
function skipPdfWhitespaceAndComments(source, start, limit) {
  let index = start;
  while (index < limit) {
    if (isPdfWhitespace(source.charCodeAt(index))) { index += 1; continue; }
    if (source[index] !== '%') break;
    while (index < limit && source[index] !== '\n' && source[index] !== '\r') index += 1;
  }
  return index;
}
function isPdfWhitespace(code) { return code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32; }
function isPdfTokenBoundary(character) { return character !== undefined && (isPdfWhitespace(character.charCodeAt(0)) || /[%()<>{}\[\]\/]/u.test(character)); }
function pdfTokens(source) {
  const tokens = [];
  const append = (token) => {
    if (tokens.length >= MAX_PDF_TOKENS) return false;
    tokens.push(token);
    return true;
  };
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === '%') { while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1; continue; }
    if (source.startsWith('<<', index) || source.startsWith('>>', index)) { if (!append({ kind: source.slice(index, index + 2) })) return null; index += 2; continue; }
    if (character === '[' || character === ']') { if (!append({ kind: character })) return null; index += 1; continue; }
    if (character === '<') {
      const end = source.indexOf('>', index + 1);
      if (end < 0) return null;
      if (!append({ kind: 'string' })) return null;
      index = end + 1; continue;
    }
    if (character === '(') {
      let depth = 1; index += 1;
      while (index < source.length && depth) { if (source[index] === '\\') index += 2; else { if (source[index] === '(') depth += 1; if (source[index] === ')') depth -= 1; index += 1; } }
      if (depth) return null;
      if (!append({ kind: 'string' })) return null;
      continue;
    }
    if (character === '/') {
      let end = index + 1; while (end < source.length && !/[\s\[\]<>()/]/u.test(source[end])) end += 1;
      if (!append({ kind: 'name', value: source.slice(index + 1, end) })) return null;
      index = end; continue;
    }
    let end = index + 1; while (end < source.length && !/[\s\[\]<>()/]/u.test(source[end])) end += 1;
    if (!append({ kind: 'word', value: source.slice(index, end) })) return null;
    index = end;
  }
  return tokens;
}
function parsePdfValue(tokens, index) {
  const token = tokens[index];
  if (!token) return null;
  if (token.kind === '<<') {
    const entries = Object.create(null);
    let cursor = index + 1;
    while (tokens[cursor]?.kind !== '>>') {
      const key = tokens[cursor];
      if (!key || key.kind !== 'name') return null;
      const parsed = parsePdfValue(tokens, cursor + 1);
      if (!parsed) return null;
      entries[key.value] = parsed.value;
      cursor = parsed.index;
    }
    return { value: { kind: 'dictionary', entries }, index: cursor + 1 };
  }
  if (token.kind === '[') {
    const values = [];
    let cursor = index + 1;
    while (tokens[cursor]?.kind !== ']') {
      const parsed = parsePdfValue(tokens, cursor);
      if (!parsed) return null;
      values.push(parsed.value);
      cursor = parsed.index;
    }
    return { value: values, index: cursor + 1 };
  }
  if (token.kind === 'name') return { value: token.value, index: index + 1 };
  if (token.kind === 'string') return { value: null, index: index + 1 };
  if (token.kind !== 'word') return null;
  if (/^\d+$/u.test(token.value) && /^\d+$/u.test(tokens[index + 1]?.value || '') && tokens[index + 2]?.value === 'R') {
    return { value: { kind: 'reference', objectNumber: Number(token.value), generation: Number(tokens[index + 1].value) }, index: index + 3 };
  }
  if (/^-?\d+$/u.test(token.value)) return { value: Number(token.value), index: index + 1 };
  return { value: token.value, index: index + 1 };
}
function isPdfReference(value) { return value?.kind === 'reference' && Number.isSafeInteger(value.objectNumber) && Number.isSafeInteger(value.generation); }
function samePdfReference(left, right) { return isPdfReference(left) && isPdfReference(right) && left.objectNumber === right.objectNumber && left.generation === right.generation; }
function assertCompleteV1Report(evaluation) {
  const card = evaluation.agentCard;
  if (!nonBlank(card?.name) || !nonBlank(card?.description) || !Array.isArray(card?.skills)) throw new RangeError('完整 V1 报告缺少必需 Agent Card 内容');
  if (!nonBlank(evaluation.scoringConfig?.version)) throw new RangeError('完整 V1 报告缺少评分配置');
  const reviewerIds = expectedReviewers(evaluation);
  if (!reviewerIds || !hasExactIdentifiers(evaluation.professional?.reviews, reviewerIds, (review) => review?.reviewerId)) throw new RangeError('完整 V1 报告缺少完整 Card 评审席位');
  const candidateIds = ['submitted', ...RUNTIMES.map((runtime) => runtime.id)];
  if (!Array.isArray(evaluation.benchmark) || !evaluation.benchmark.length || evaluation.benchmark.some((round) => !nonBlank(round?.case?.name) || !nonBlank(round?.case?.prompt) || !hasExactIdentifiers(round?.entries, candidateIds, (entry) => entry?.id))) throw new RangeError('完整 V1 报告缺少完整 CASE 候选集');
}
function expectedReviewers(evaluation) {
  if (evaluation.reviewPlan === undefined) return V1_REVIEWER_IDS;
  if (!Array.isArray(evaluation.reviewPlan) || !evaluation.reviewPlan.length) return null;
  const ids = evaluation.reviewPlan.map((reviewer) => reviewer?.id);
  return ids.every(nonBlank) && new Set(ids).size === ids.length ? ids : null;
}
function hasExactIdentifiers(records, expectedIds, getIdentifier) {
  if (!Array.isArray(records) || records.length !== expectedIds.length) return false;
  const actual = records.map(getIdentifier);
  return actual.every((id) => typeof id === 'string') && new Set(actual).size === actual.length && expectedIds.every((id) => actual.includes(id));
}
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
