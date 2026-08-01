import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = path.join(root, 'scripts', 'render-v1-report.py');
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;

export function projectV1Report(evaluation) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) throw new TypeError('评测记录不存在');
  if (evaluation.schemaVersion === 2) throw new RangeError('仅支持 V1 评测报告');
  if (evaluation.status !== 'completed') throw new RangeError('仅已完成的 V1 评测可下载报告');
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
      roast: strings(evaluation.roast, ['headline', 'summary', 'rationale'])
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
      if (stdout.length > MAX_PDF_BYTES) {
        child.kill('SIGKILL');
        finish(reportError(502, 'PDF 报告超过输出上限'));
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(reportError(502, `PDF 生成失败：${sanitizeStderr(stderr) || `退出码 ${code}`}`));
      if (!stdout.subarray(0, 5).equals(Buffer.from('%PDF-'))) return finish(reportError(502, 'PDF 生成器返回了无效内容'));
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
  return {
    case: { ...strings(round?.case, ['id', 'name', 'prompt', 'expectedDeliverable']), constraints: stringArray(round?.case?.constraints) },
    judging: projectJudging(round?.judging),
    dataEvidence: projectDataEvidence(round?.dataEvidence),
    entries: array(round?.entries).map((entry) => ({
      ...strings(entry, ['id', 'name', 'mode', 'output', 'scoreStatus']), ...numbers(entry, ['score', 'judgeSeed']),
      dimensions: numbers(entry?.dimensions, ['scenarioValue', 'professionalQuality', 'agentCapability', 'taskConstraint', 'evidenceRisk', 'artifactUsability']),
      detail: projectDetail(entry?.detail), execution: projectExecution(entry?.execution),
      dataVerification: projectDataVerification(entry?.dataVerification),
      judgeReviews: array(entry?.judgeReviews).map(projectJudgeReview)
    }))
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
function projectDataEvidence(value) { return value ? { ...strings(value, ['status', 'source', 'fetchedAt']), queries: array(value.queries).map((query) => ({ ...strings(query, ['id', 'label', 'method', 'status', 'error']), params: publicJson(query?.params), facts: publicJson(query?.facts) })) } : null; }
function projectDataVerification(value) { return value ? { ...strings(value, ['status', 'summary']), checks: array(value.checks).map((check) => ({ ...strings(check, ['id', 'label', 'status', 'reason']), ...numbers(check, ['expected', 'actual', 'tolerance']) })) } : null; }
function projectJudgeReview(value) { return { ...strings(value, ['reviewerId', 'reviewerName', 'reviewer', 'model', 'mode', 'status', 'rationale', 'error']), ...numbers(value, ['score', 'total']), dimensions: numbers(value?.dimensions, ['problemComplexity', 'agentSuitability', 'taskCompletion', 'methodProfessionalism', 'evidenceDataQuality', 'riskUncertainty', 'artifactUsability', 'taskConstraint', 'professionalQuality', 'evidenceRisk']), uncertainties: stringArray(value?.uncertainties) }; }
function projectScoringConfig(value) { return strings(value, ['version', 'mode', 'reviewerId']); }
function strings(value, keys) { return Object.fromEntries(keys.filter((key) => typeof value?.[key] === 'string').map((key) => [key, value[key]])); }
function numbers(value, keys) { return Object.fromEntries(keys.filter((key) => Number.isFinite(value?.[key])).map((key) => [key, value[key]])); }
function bools(value, keys) { return Object.fromEntries(keys.filter((key) => typeof value?.[key] === 'boolean').map((key) => [key, value[key]])); }
function scoreObject(value) { return { ...strings(value, ['verdict', 'reason']), ...numbers(value, ['score']), dimensions: numbers(value?.dimensions, ['taskComplexity', 'dataDependency', 'workflowDepth', 'agentNecessity', 'reproducibility']) }; }
function array(value) { return Array.isArray(value) ? value : []; }
function stringArray(value) { return array(value).filter((item) => typeof item === 'string'); }
function publicJson(value) { return value === undefined ? undefined : sanitizeJson(value); }
function sanitizeJson(value) { if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value; if (Array.isArray(value)) return value.map(sanitizeJson); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/(password|secret|token|authorization|credential|internal)/iu.test(key)).map(([key, item]) => [key, sanitizeJson(item)])); return String(value); }
function positiveInteger(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function safeError(error) { return String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 300); }
function sanitizeStderr(value) { return String(value || '').replace(/[\r\n]+/g, ' ').replace(/(?:password|secret|token|authorization|credential)\s*[=:]\s*\S+/giu, '[REDACTED]').slice(0, 500); }
function reportError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
