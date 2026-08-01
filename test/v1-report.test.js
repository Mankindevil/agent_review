import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { projectV1Report, generateV1ReportPdf } from '../src/v1-report.js';

const exec = promisify(execFile);
const python = '/Users/jintingzhou/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';

export function completeV1Fixture(overrides = {}) {
  const long = `完整候选输出 SENTINEL-OUTPUT-甲：这是用于验证 PDF 不截断的完整中文研究交付物。${'包含时点、数据、方法和风险提示。'.repeat(80)}`;
  const review = { reviewer: 'OpenAI 评审', reviewerId: 'gpt', model: 'GPT-5', mode: 'live', score: 87, comment: '完整中文评语 SENTINEL-REVIEW：Card 的定位、Skill 与协议结构清晰。', risk: '仍应说明数据可用性和边界。', dimensions: { positioningClarity: 88, skillDesign: 86, protocolCoherence: 85, ioExampleQuality: 87, boundaryRiskDisclosure: 89 } };
  const entry = (id, name) => ({ id, name, mode: 'live', output: long.replace('甲', id), score: 86, scoreStatus: 'scored', dimensions: { scenarioValue: 80, professionalQuality: 88, agentCapability: 84 }, detail: { scenario: { score: 80, dimensions: { problemComplexity: 82, agentSuitability: 78 } }, professionalism: { score: 88, dimensions: { taskCompletion: 88, methodProfessionalism: 89, evidenceDataQuality: 87, riskUncertainty: 86, artifactUsability: 90 } }, capability: { status: 'succeeded', durationMs: 135000, timingScope: 'end-to-end-wall-clock', includesNetwork: true, toolObservation: 'unavailable', executionSuccessScore: 100, latencyScore: 86, capabilityScore: 95.8 } }, execution: { status: 'succeeded', durationMs: 135000, timingScope: 'end-to-end-wall-clock', includesNetwork: true, toolObservation: 'unavailable', contextUsage: [{ phase: 'panda-query', inputBytes: 1000, budgetBytes: 240000, originalRows: 2, keptRows: 2, droppedRows: 0 }] }, dataVerification: { status: 'verified', summary: '数据锚点已验证', checks: [{ id: 'anchor', label: '指数收盘', status: 'verified', expected: 4000, actual: 4000, tolerance: .01 }] }, judgeReviews: [{ reviewerName: 'OpenAI 评审', model: 'GPT-5', mode: 'live', score: 88, rationale: '完整中文席位评语。', uncertainties: ['仅基于本次公开输出。'], dimensions: { taskCompletion: 88, methodProfessionalism: 89, evidenceDataQuality: 87, riskUncertainty: 86, artifactUsability: 90 } }] });
  return {
    id: 'v1_pdf_fixture', schemaVersion: 1, status: 'completed', mode: 'live', overallMode: 'live', createdAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-01T01:00:00Z',
    agentCard: { name: '完整报告 Agent', description: '覆盖金融研究全流程的 Agent。', version: '1.0.0', protocolVersion: '1.0', skills: [{ id: 'research', name: '研究', description: '完整研究。', tags: ['金融'], examples: ['输出完整报告'] }], internalPath: 'internal-path', secret: 'agent-secret' },
    scoringConfig: { version: 'v1-model-arena/v2', mode: 'panel' }, complexity: { score: 80, verdict: '值得 Agent 化', reason: '多阶段任务', dimensions: { taskComplexity: 80 } },
    professional: { version: 'v1-card-review/v2', score: 87, mode: 'live', reviews: [review, { ...review, reviewer: 'Anthropic 评审', reviewerId: 'claude', model: 'Claude', score: 86 }, { ...review, reviewer: '豆包评审', reviewerId: 'doubao', model: 'Doubao', score: 85 }, { ...review, reviewer: 'DeepSeek 评审', reviewerId: 'deepseek', model: 'DeepSeek', score: 84 }] },
    averages: { submitted: 86, 'claude-code': 82, cursor: 79, doubao: 80 }, roast: { headline: '值得继续打磨', summary: '完整结论。' },
    builds: [{ runtime: 'Claude Code', runtimeId: 'claude-code', mode: 'live', skill: { name: '复刻 Skill', description: '完整 Skill', instructions: ['读取接口文档'], tools: ['panda-data'] }, contextUsage: [{ phase: 'skill-build', inputBytes: 500, budgetBytes: 240000 }] }],
    benchmark: ['因子研究', '组合风险'].map((name, index) => ({ case: { id: `case-${index + 1}`, name, prompt: `完整 Prompt ${name}，需要展示长段落与 JSON。`, constraints: ['不能编造'], expectedDeliverable: '完整报告' }, judging: { version: 'v1-model-arena/v2', status: 'scored', mode: 'panel', requiredSeats: 4, successfulSeats: 4, scenario: { score: 80, dimensions: { problemComplexity: 82, agentSuitability: 78 }, reviews: [{ reviewerName: 'OpenAI 评审', model: 'GPT-5', rationale: '复杂场景', dimensions: { problemComplexity: 82, agentSuitability: 78 } }] } }, dataEvidence: { status: 'verified', source: 'pandaai', fetchedAt: '2026-08-01T00:10:00Z', queries: [{ id: 'panda', label: '行情', method: 'get_index_daily', status: 'verified', params: { symbol: '000300.SH', pandaPassword: 'panda-password' }, facts: [{ close: 4000 }] }] }, entries: [entry('submitted', '提交 Agent'), entry('claude-code', 'Claude Code'), entry('cursor', 'Cursor'), entry('doubao', '豆包')] })),
    logs: [{ at: '2026-08-01T00:00:00Z', level: 'success', source: 'ARENA', phase: 'benchmark', text: '完成', detail: 'network' }],
    ...overrides
  };
}

test('strictly projects completed V1 report data without secrets', () => {
  const dto = projectV1Report(completeV1Fixture());
  const serialized = JSON.stringify(dto);
  assert.match(serialized, /完整候选输出/);
  assert.match(serialized, /完整中文评语/);
  assert.doesNotMatch(serialized, /agent-secret|panda-password|internal-path/);
  assert.throws(() => projectV1Report(completeV1Fixture({ schemaVersion: 2 })), /V1/);
  assert.throws(() => projectV1Report(completeV1Fixture({ status: 'running' })), /完成/);
});

test('generates a multi-page A4 PDF with complete Chinese sentinels', async () => {
  const dto = projectV1Report(completeV1Fixture());
  const pdf = await generateV1ReportPdf(dto, { python, timeoutMs: 60_000 });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile('tmp/pdfs/v1-report-test.pdf', pdf);
  const check = `import pdfplumber\np='tmp/pdfs/v1-report-test.pdf'\nwith pdfplumber.open(p) as f:\n t='\\n'.join((x.extract_text() or '') for x in f.pages)\n print(len(f.pages))\n print('SENTINEL-OUTPUT-submitted' in t)\n print('完整中文评语' in t)\n print(f.pages[0].width, f.pages[0].height)`;
  const { stdout } = await exec(python, ['-c', check]);
  assert.match(stdout, /^\d+\nTrue\nTrue\n595\./m);
  assert.ok(Number(stdout.split('\n')[0]) > 1);
});
