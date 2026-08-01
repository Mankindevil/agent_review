import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { projectV1Report, generateV1ReportPdf } from '../src/v1-report.js';
import { validateAgentCard } from '../src/a2a.js';
import { inspectRuntimeContext } from '../src/runtime-context.js';
import { scoreComplexity } from '../src/scoring.js';
import { resolveReportPython } from './report-python.js';

const exec = promisify(execFile);
const python = resolveReportPython();

function traditionalPdf(objects, root = 1) {
  const maxObject = Math.max(...Object.keys(objects).map(Number));
  let source = '%PDF-1.7\n';
  const offsets = new Map();
  for (let objectNumber = 1; objectNumber <= maxObject; objectNumber += 1) {
    const value = objects[objectNumber];
    if (!value) continue;
    const object = typeof value === 'string' ? { body: value } : value;
    const generation = object.generation ?? 0;
    offsets.set(objectNumber, { offset: Buffer.byteLength(source), generation });
    source += `${objectNumber} ${generation} obj\n${object.body}\n`;
    if (object.endobj !== false) source += 'endobj\n';
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${maxObject + 1}\n0000000000 65535 f \n`;
  for (let objectNumber = 1; objectNumber <= maxObject; objectNumber += 1) {
    source += offsets.has(objectNumber)
      ? `${String(offsets.get(objectNumber).offset).padStart(10, '0')} ${String(offsets.get(objectNumber).generation).padStart(5, '0')} n \n`
      : '0000000000 00000 f \n';
  }
  const rootReference = typeof root === 'number' ? `${root} 0` : `${root.objectNumber} ${root.generation}`;
  return `${source}trailer\n<< /Size ${maxObject + 1} /Root ${rootReference} R >>\nstartxref\n${xref}\n%%EOF`;
}
function shellPrint(pdf) { return `printf '%b' ${JSON.stringify(pdf)}`; }

async function withInjectedRendererPdf(name, pdf, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'v1-report-parser-'));
  const filename = path.join(directory, `${name}.sh`);
  await writeFile(filename, `#!/bin/sh\ncat >/dev/null\n${shellPrint(pdf)}\n`);
  await chmod(filename, 0o755);
  try {
    return await callback(filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function completeV1Fixture(overrides = {}) {
  const long = `完整候选输出 SENTINEL-OUTPUT-甲：这是用于验证 PDF 不截断的完整中文研究交付物。${'包含时点、数据、方法和风险提示。'.repeat(80)}`;
  const review = { reviewer: 'OpenAI 评审', reviewerId: 'gpt', model: 'GPT-5', modelId: 'gpt-5.4', mode: 'live', score: 87, comment: '完整中文评语 SENTINEL-REVIEW：Card 的定位、Skill 与协议结构清晰。', risk: '仍应说明数据可用性和边界。', dimensions: { positioningClarity: 88, skillDesign: 86, protocolCoherence: 85, ioExampleQuality: 87, boundaryRiskDisclosure: 89 } };
  const entry = (id, name) => ({ id, name, mode: 'live', output: long.replace('甲', id), score: 86, scoreStatus: 'scored', dimensions: { scenarioValue: 80, professionalQuality: 88, agentCapability: 84 }, detail: { scenario: { score: 80, dimensions: { problemComplexity: 82, agentSuitability: 78 } }, professionalism: { score: 88, dimensions: { taskCompletion: 88, methodProfessionalism: 89, evidenceDataQuality: 87, riskUncertainty: 86, artifactUsability: 90 } }, capability: { status: 'succeeded', durationMs: 135000, timingScope: 'end-to-end-wall-clock', includesNetwork: true, toolObservation: 'unavailable', executionSuccessScore: 100, latencyScore: 86, capabilityScore: 95.8 } }, execution: { status: 'succeeded', durationMs: 135000, timingScope: 'end-to-end-wall-clock', includesNetwork: true, toolObservation: 'unavailable', contextUsage: [{ phase: 'panda-query', inputBytes: 1000, budgetBytes: 240000, originalRows: 2, keptRows: 2, droppedRows: 0 }] }, dataVerification: { status: 'verified', summary: '数据锚点已验证', checks: [{ id: 'anchor', label: '指数收盘', status: 'verified', expected: 4000, actual: 4000, tolerance: .01 }] }, judgeReviews: [{ reviewerName: 'OpenAI 评审', model: 'GPT-5', modelId: 'gpt-5.4', mode: 'live', score: 88, rationale: '完整中文席位评语。', uncertainties: ['仅基于本次公开输出。'], dimensions: { taskCompletion: 88, methodProfessionalism: 89, evidenceDataQuality: 87, riskUncertainty: 86, artifactUsability: 90 } }] });
  return {
    id: 'v1_pdf_fixture', schemaVersion: 1, status: 'completed', mode: 'live', overallMode: 'live', createdAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-01T01:00:00Z',
    agentCard: { name: '完整报告 Agent', description: '覆盖金融研究全流程的 Agent。', version: '1.0.0', protocolVersion: '1.0', skills: [{ id: 'research', name: '研究', description: '完整研究。', tags: ['金融'], examples: ['输出完整报告'] }], internalPath: 'internal-path', secret: 'agent-secret' },
    scoringConfig: { version: 'v1-model-arena/v2', mode: 'panel' }, complexity: { score: 80, verdict: '值得 Agent 化', reason: '多阶段任务', dimensions: { taskComplexity: 80 } },
    professional: { version: 'v1-card-review/v2', score: 87, mode: 'live', reviews: [review, { ...review, reviewer: 'Anthropic 评审', reviewerId: 'claude', model: 'Claude Sonnet 4.6', modelId: 'claude-sonnet-4-6', score: 86 }, { ...review, reviewer: '豆包评审', reviewerId: 'doubao', model: 'Doubao-Seed-2.1-pro', modelId: 'ep-20260720110725-5rbml', score: 85 }, { ...review, reviewer: 'DeepSeek 评审', reviewerId: 'deepseek', model: 'DeepSeek-V4-Pro', modelId: 'ep-20260708162855-pcf9x', score: 84 }] },
    averages: { submitted: 86, 'claude-code': 82, cursor: 79, doubao: 80 }, roast: { tier: { code: 'HARD', label: '夯', stamp: '夯' }, headline: '值得继续打磨', summary: '完整结论。', deltaClaude: 4, deltaDoubao: 6, professionalAverage: 87 },
    builds: [{ runtime: 'Claude Code', runtimeId: 'claude-code', model: 'Claude Sonnet 4.6', modelId: 'claude-sonnet-4-6', mode: 'live', skill: { name: '复刻 Skill', description: '完整 Skill', instructions: ['读取接口文档'], tools: ['panda-data'] }, contextUsage: [{ phase: 'skill-build', inputBytes: 500, budgetBytes: 240000 }] }],
    benchmark: ['因子研究', '组合风险'].map((name, index) => ({ case: { id: `case-${index + 1}`, name, prompt: `完整 Prompt ${name}，需要展示长段落与 JSON。`, constraints: ['不能编造'], expectedDeliverable: '完整报告' }, judging: { version: 'v1-model-arena/v2', status: 'scored', mode: 'panel', requiredSeats: 4, successfulSeats: 4, seats: [{ reviewerId: 'gpt', reviewerName: 'OpenAI 评审', model: 'GPT-5', modelId: 'gpt-5.4', mode: 'live', status: 'succeeded' }, { reviewerId: 'claude', reviewerName: 'Anthropic 评审', model: 'Claude Sonnet 4.6', modelId: 'claude-sonnet-4-6', mode: 'live', status: 'succeeded' }, { reviewerId: 'doubao', reviewerName: '豆包评审', model: 'Doubao-Seed-2.1-pro', modelId: 'ep-20260720110725-5rbml', mode: 'live', status: 'succeeded' }, { reviewerId: 'deepseek', reviewerName: 'DeepSeek 评审', model: 'DeepSeek-V4-Pro', modelId: 'ep-20260708162855-pcf9x', mode: 'live', status: 'succeeded' }], scenario: { score: 80, dimensions: { problemComplexity: 82, agentSuitability: 78 }, reviews: [{ reviewerName: 'OpenAI 评审', model: 'GPT-5', modelId: 'gpt-5.4', rationale: '复杂场景', dimensions: { problemComplexity: 82, agentSuitability: 78 } }] } }, dataEvidence: { status: 'verified', source: 'pandaai', fetchedAt: '2026-08-01T00:10:00Z', queries: [{ id: 'panda', label: '行情', method: 'get_index_daily', status: 'verified', params: { symbol: '000300.SH', pandaPassword: 'panda-password' }, facts: [{ close: 4000 }] }] }, entries: [entry('submitted', '提交 Agent'), entry('claude-code', 'Claude Code'), entry('cursor', 'Cursor'), entry('doubao', '豆包')] })),
    logs: [{ at: '2026-08-01T00:00:00Z', level: 'success', source: 'ARENA', phase: 'benchmark', text: '完成', detail: 'network' }],
    ...overrides
  };
}

test('strictly projects only complete V1 report data without recursive secrets or unknown fields', () => {
  const fixture = completeV1Fixture();
  fixture.benchmark[0].dataEvidence.queries[0].params = {
    symbol: '000300.SH', start_date: '20250101', apiKey: 'api-key-sentinel', nested: { bearer: 'bearer-sentinel' }
  };
  fixture.benchmark[0].dataEvidence.queries[0].facts = [{
    label: '收盘', field: 'close', value: 4000, sourceDate: '20250101', unknownFact: 'unknown-fact-sentinel', credential: 'credential-sentinel'
  }];
  const dto = projectV1Report(fixture);
  const serialized = JSON.stringify(dto);
  assert.match(serialized, /完整候选输出/);
  assert.match(serialized, /完整中文评语/);
  assert.doesNotMatch(serialized, /agent-secret|panda-password|internal-path|api-key-sentinel|bearer-sentinel|unknown-fact-sentinel|credential-sentinel/);
  assert.deepEqual(dto.benchmark[0].dataEvidence.queries[0].params, { symbol: '000300.SH', start_date: '20250101' });
  assert.deepEqual(dto.benchmark[0].dataEvidence.queries[0].facts, [{ label: '收盘', field: 'close', value: 4000, sourceDate: '20250101' }]);
  assert.throws(() => projectV1Report(completeV1Fixture({ schemaVersion: 2 })), /V1/);
  assert.throws(() => projectV1Report(completeV1Fixture({ schemaVersion: 3 })), /V1/);
  assert.throws(() => projectV1Report(completeV1Fixture({ status: 'running' })), /完成/);
  assert.throws(() => projectV1Report(completeV1Fixture({ agentCard: { name: '' } })), /Card/);
  assert.throws(() => projectV1Report(completeV1Fixture({ scoringConfig: {} })), /评分配置/);
  assert.throws(() => projectV1Report(completeV1Fixture({ professional: { reviews: [] } })), /Card 评审/);
  assert.throws(() => projectV1Report(completeV1Fixture({ benchmark: [{ case: { name: '空案例', prompt: '' }, entries: [] }] })), /CASE/);
  assert.throws(() => projectV1Report(completeV1Fixture({ professional: { reviews: fixture.professional.reviews.slice(0, 3) } })), /Card 评审席位/);
  assert.throws(() => projectV1Report(completeV1Fixture({ professional: { reviews: [...fixture.professional.reviews.slice(0, 3), fixture.professional.reviews[0]] } })), /Card 评审席位/);
  assert.throws(() => projectV1Report(completeV1Fixture({ benchmark: fixture.benchmark.map((round) => ({ ...round, entries: round.entries.slice(0, 3) })) })), /候选集/);
  assert.throws(() => projectV1Report(completeV1Fixture({ benchmark: fixture.benchmark.map((round) => ({ ...round, entries: [...round.entries.slice(0, 3), round.entries[0]] })) })), /候选集/);
});

test('projects complete accepted Card fields and real scoring/context audit shapes', () => {
  const fixture = completeV1Fixture();
  fixture.agentCard = {
    ...fixture.agentCard,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/markdown'],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
      extendedAgentCard: false,
      extensions: [{ uri: 'urn:capability:trace', description: '公开能力扩展' }]
    },
    supportedInterfaces: [{
      url: 'https://agent.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: 'desk-7'
    }],
    provider: { organization: '公开机构', url: 'https://provider.example' },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: '公开授权说明' } },
    security: [{ bearer: ['read:report'] }],
    signatures: [{ protected: 'public-header', signature: 'public-signature' }],
    extensions: [{ uri: 'urn:agent:public', description: '公开 Card 扩展' }],
    skills: [{
      ...fixture.agentCard.skills[0],
      inputModes: ['application/json'],
      outputModes: ['text/markdown']
    }],
    unknownSecret: 'must-not-project'
  };
  fixture.complexity = scoreComplexity(fixture.agentCard, fixture.benchmark.map((round) => round.case));
  const context = inspectRuntimeContext('系统', '用户 Prompt', {
    scope: 'runtime-final:claude-code',
    maxInputBytes: 1000,
    warnRatio: 0.8
  }).usage;
  fixture.builds[0].contextUsage = [context];
  fixture.benchmark[0].entries[0].execution.contextUsage = [context];

  const dto = projectV1Report(fixture);
  assert.deepEqual(dto.agentCard.skills[0].inputModes, ['application/json']);
  assert.deepEqual(dto.agentCard.skills[0].outputModes, ['text/markdown']);
  assert.equal(dto.agentCard.supportedInterfaces[0].tenant, 'desk-7');
  assert.deepEqual(dto.agentCard.capabilities, fixture.agentCard.capabilities);
  assert.deepEqual(dto.agentCard.provider, fixture.agentCard.provider);
  assert.deepEqual(dto.agentCard.securitySchemes, fixture.agentCard.securitySchemes);
  assert.deepEqual(dto.agentCard.security, fixture.agentCard.security);
  assert.deepEqual(dto.agentCard.signatures, fixture.agentCard.signatures);
  assert.deepEqual(dto.agentCard.extensions, fixture.agentCard.extensions);
  assert.equal(JSON.stringify(dto).includes('must-not-project'), false);
  assert.deepEqual(dto.scoring.complexity.dimensions, fixture.complexity.dimensions);
  assert.deepEqual(dto.builds[0].contextUsage[0], {
    scope: 'runtime-final:claude-code',
    status: 'ok',
    systemBytes: 6,
    promptBytes: 13,
    inputBytes: 19,
    totalBytes: 19,
    estimatedTokens: 5,
    maxInputBytes: 1000,
    warnRatio: 0.8,
    remainingBytes: 981,
    usageRatio: 0.019
  });
  assert.deepEqual(dto.benchmark[0].entries[0].execution.contextUsage[0], dto.builds[0].contextUsage[0]);
  assert.equal(dto.scoring.professional.reviews[1].modelId, 'claude-sonnet-4-6');
  assert.equal(dto.builds[0].model, 'Claude Sonnet 4.6');
  assert.equal(dto.builds[0].modelId, 'claude-sonnet-4-6');
  assert.equal(dto.benchmark[0].judging.seats[2].modelId, 'ep-20260720110725-5rbml');
  assert.equal(dto.benchmark[0].judging.scenario.reviews[0].modelId, 'gpt-5.4');
  assert.equal(dto.benchmark[0].entries[0].judgeReviews[0].modelId, 'gpt-5.4');
});

test('accepted Card projections remove nested credential keys without losing public protocol metadata', () => {
  const fixture = completeV1Fixture();
  let accessorReads = 0;
  const extensionMetadata = {
    uri: 'urn:agent:public-metadata',
    description: '公开扩展',
    modes: ['live', 'batch'],
    nested: {
      publicFlag: true,
      apiToken: 'provider-token-secret',
      API_TOKEN: 'uppercase-token-secret',
      'pass%77ord': 'encoded-password-secret'
    }
  };
  Object.defineProperty(extensionMetadata.nested, 'computed', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'accessor-secret';
    }
  });
  const extensions = [extensionMetadata];
  Object.defineProperty(extensions, '1', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return { uri: 'urn:accessor', description: 'array-accessor-secret' };
    }
  });
  fixture.agentCard = {
    ...fixture.agentCard,
    supportedInterfaces: [{
      url: 'https://agent.example/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0', tenant: 'research'
    }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/markdown', 'application/json'],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
      extendedAgentCard: false,
      extensions: [{ uri: 'urn:capability:public', modes: ['stream', 'batch'], password: 'capability-secret' }]
    },
    provider: {
      organization: '公开机构',
      url: 'https://provider.example',
      apiToken: 'provider-secret',
      nested: { password: 'provider-nested-secret' }
    },
    securitySchemes: {
      bearer: {
        type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '公开 Bearer 说明', token: 'scheme-secret'
      },
      oauth: {
        type: 'oauth2',
        description: '公开 OAuth 说明',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://provider.example/oauth/token',
            refreshUrl: 'https://provider.example/oauth/refresh',
            scopes: { 'reports:read': '读取公开报告' },
            clientSecret: 'oauth-secret'
          }
        }
      }
    },
    security: [{ bearer: ['reports:read'] }, { oauth: ['reports:read'] }],
    signatures: [{ protected: 'public-header', signature: 'public-signature', token: 'signature-secret' }],
    extensions
  };

  const validation = validateAgentCard(fixture.agentCard);
  assert.equal(validation.valid, true, validation.errors.join('; '));
  const card = projectV1Report(fixture).agentCard;
  const serialized = JSON.stringify(card);

  assert.equal(accessorReads, 0);
  assert.deepEqual(card.provider, {
    organization: '公开机构', url: 'https://provider.example'
  });
  assert.deepEqual(card.securitySchemes, {
    bearer: {
      type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '公开 Bearer 说明'
    },
    oauth: {
      type: 'oauth2',
      description: '公开 OAuth 说明',
      flows: {
        clientCredentials: {
          tokenUrl: 'https://provider.example/oauth/token',
          refreshUrl: 'https://provider.example/oauth/refresh',
          scopes: { 'reports:read': '读取公开报告' }
        }
      }
    }
  });
  assert.deepEqual(card.security, [{ bearer: ['reports:read'] }, { oauth: ['reports:read'] }]);
  assert.deepEqual(card.signatures, [{ protected: 'public-header', signature: 'public-signature' }]);
  assert.deepEqual(card.extensions, [{
    uri: 'urn:agent:public-metadata',
    description: '公开扩展',
    modes: ['live', 'batch'],
    nested: { publicFlag: true }
  }]);
  assert.deepEqual(card.capabilities, {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
    extendedAgentCard: false,
    extensions: [{ uri: 'urn:capability:public', modes: ['stream', 'batch'] }]
  });
  assert.deepEqual(card.defaultInputModes, ['text/plain', 'application/json']);
  assert.deepEqual(card.defaultOutputModes, ['text/markdown', 'application/json']);
  assert.doesNotMatch(serialized, /provider-secret|scheme-secret|oauth-secret|signature-secret|capability-secret|uppercase-token-secret|encoded-password-secret|accessor-secret|array-accessor-secret/);
});

test('resolves report Python from explicit environment or the platform repository venv', () => {
  assert.equal(resolveReportPython({
    env: { REPORT_PDF_PYTHON: '/opt/report-python', PANDA_DATA_PYTHON: '/opt/panda-python' },
    root: '/srv/app', exists: () => false
  }), '/opt/report-python');
  assert.equal(resolveReportPython({
    env: { PANDA_DATA_PYTHON: '/opt/panda-python' }, root: '/srv/app', exists: () => false
  }), '/opt/panda-python');
  assert.equal(resolveReportPython({
    env: {}, platform: 'linux', root: '/srv/app', exists: () => true
  }), path.join('/srv/app', '.venv/bin/python'));
  assert.equal(resolveReportPython({
    env: {}, platform: 'win32', root: 'C:\\agent-review', exists: () => true
  }), path.join('C:\\agent-review', '.venv/Scripts/python.exe'));
  assert.throws(() => resolveReportPython({
    env: {}, platform: 'linux', root: '/srv/app', exists: () => false
  }), /REPORT_PDF_PYTHON|PANDA_DATA_PYTHON|\.venv/u);
});

test('projects supported object-valued data fact selectors through fixed credential-safe fields', () => {
  const fixture = completeV1Fixture();
  fixture.benchmark[0].dataEvidence.queries[0].facts = [{
    label: '期末收盘', field: 'close', where: { trade_date: '20250131', symbol: '000300.SH', apiKey: 'selector-secret', nested: { bearer: 'nested-secret' } }, value: 4000
  }];
  const fact = projectV1Report(fixture).benchmark[0].dataEvidence.queries[0].facts[0];
  assert.deepEqual(fact.where, [
    { field: 'trade_date', expected: '20250131' },
    { field: 'symbol', expected: '000300.SH' }
  ]);
  assert.doesNotMatch(JSON.stringify(fact), /selector-secret|nested-secret|apiKey|bearer/);
});

test('accepts complete custom persisted reviewer plans and rejects missing or duplicate seats', () => {
  const reviewPlan = [{ id: 'custom-primary', name: 'Custom Primary', model: 'Model A' }, { id: 'custom-fallback', name: 'Custom Fallback', model: 'Model B' }];
  const reviews = [
    { reviewerId: 'custom-primary', reviewer: 'Custom Primary', score: 91, comment: '完成' },
    { reviewerId: 'custom-fallback', reviewer: 'Custom Fallback', mode: 'failed', error: '上游超时' }
  ];
  assert.doesNotThrow(() => projectV1Report(completeV1Fixture({ reviewPlan, professional: { reviews } })));
  assert.throws(() => projectV1Report(completeV1Fixture({ reviewPlan, professional: { reviews: reviews.slice(0, 1) } })), /Card 评审席位/);
  assert.throws(() => projectV1Report(completeV1Fixture({ reviewPlan, professional: { reviews: [reviews[0], { ...reviews[0] }] } })), /Card 评审席位/);
});

test('generates a multi-page A4 PDF with complete Chinese sentinels', async () => {
  const dto = projectV1Report(completeV1Fixture());
  const pdf = await generateV1ReportPdf(dto, { python, timeoutMs: 60_000 });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile('tmp/pdfs/v1-report-test.pdf', pdf);
  const check = `import pdfplumber\np='tmp/pdfs/v1-report-test.pdf'\nwith pdfplumber.open(p) as f:\n t='\\n'.join((x.extract_text() or '') for x in f.pages)\n print(len(f.pages))\n for s in ['V1 Agent 完整评测报告','一、评分口径与免责声明','二、评测概览','三、完整 Agent Card','四、四方 Agent Card 设计评审','五、逐 CASE 场景评估','六、逐候选同题对打与能力评估','七、逐席模型评审审计','八、完整候选原始输出','九、Runtime、数据、上下文与时间线附录','提交 Agent','Claude Code','Cursor','豆包','SENTINEL-OUTPUT-submitted','SENTINEL-OUTPUT-claude-code','SENTINEL-OUTPUT-cursor','SENTINEL-OUTPUT-doubao','完整中文评语','仅基于本次公开输出。','任务完成','方法专业性','数据证据质量','风险与不确定性','产物可用性','执行成功评分','耗时评分','能力总分','最终评级','claude-sonnet-4-6','ep-20260720110725-5rbml','ep-20260708162855-pcf9x']:\n  print(s in t)\n print('Agent 锐评系统 - V1 完整评测报告' in t)\n print(f.pages[0].width, f.pages[0].height)`;
  const { stdout } = await exec(python, ['-c', check]);
  const values = stdout.trim().split('\n');
  assert.ok(Number(values[0]) > 1);
  assert.deepEqual(values.slice(1, -1), Array(33).fill('True'));
  assert.match(values.at(-1), /^595\./);
});

test('rejects a page object that borrows a following indirect object endobj', async () => {
  const pdf = traditionalPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: { body: '<< /Type /Page /Parent 2 0 R >>', endobj: false },
    4: '<< /Type /Bogus >>'
  });
  await withInjectedRendererPdf('shared-endobj', pdf, async (rendererPath) => {
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: rendererPath }), { statusCode: 502 });
  });
});

test('rejects a page object whose missing endobj lies beyond the object byte bound', async () => {
  const pdf = traditionalPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: { body: `<< /Type /Page /Parent 2 0 R >>\n%${'x'.repeat(1024 * 1024 + 64)}`, endobj: false },
    4: '<< /Type /Bogus >>'
  });
  await withInjectedRendererPdf('oversized-missing-endobj', pdf, async (rendererPath) => {
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: rendererPath }), { statusCode: 502 });
  });
});

test('rejects a root Pages dictionary that declares a Parent', async () => {
  const pdf = traditionalPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Parent 9 0 R /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R >>'
  });
  await withInjectedRendererPdf('root-pages-parent', pdf, async (rendererPath) => {
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: rendererPath }), { statusCode: 502 });
  });
});

test('accepts a valid traditional PDF whose live objects use nonzero xref generations', async () => {
  const pdf = traditionalPdf({
    1: { generation: 2, body: '<< /Type /Catalog /Pages 2 4 R >>' },
    2: { generation: 4, body: '<< /Type /Pages /Kids [3 7 R] /Count 1 >>' },
    3: { generation: 7, body: '<< /Type /Page /Parent 2 4 R >>' }
  }, { objectNumber: 1, generation: 2 });
  await withInjectedRendererPdf('xref-generations', pdf, async (rendererPath) => {
    const generated = await generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: rendererPath });
    assert.equal(generated.toString('latin1'), pdf);
  });
});

test('accepts PDF Name escapes in page-tree keys and values with uppercase and lowercase hex digits', async () => {
  const pdf = traditionalPdf({
    1: '<< /T#79pe /Cata#6cog /Pag#65s 2 0 R >>',
    2: '<< /Ty#70e /Pag#65s /#4Bids [3 0 R] /Co#75nt 1 >>',
    3: '<< /Typ#65 /Pa#67e /Par#65nt 2 0 R >>'
  });
  await withInjectedRendererPdf('escaped-semantic-names', pdf, async (rendererPath) => {
    const generated = await generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: rendererPath });
    assert.equal(generated.toString('latin1'), pdf);
  });
});

test('rejects an escaped Parent key on the root Pages dictionary', async () => {
  const pdf = traditionalPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Par#65nt 9 0 R /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R >>'
  });
  await withInjectedRendererPdf('escaped-root-parent', pdf, async (rendererPath) => {
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: rendererPath }), { statusCode: 502 });
  });
});

test('rejects duplicate dictionary keys that collide after PDF Name decoding', async () => {
  const pdf = traditionalPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /Co#75nt 1 >>',
    3: '<< /Type /Page /Parent 2 0 R >>'
  });
  await withInjectedRendererPdf('duplicate-normalized-key', pdf, async (rendererPath) => {
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: rendererPath }), { statusCode: 502 });
  });
});

test('rejects malformed and incomplete PDF Name hexadecimal escapes', async () => {
  for (const [name, escapedName] of [['malformed-name-escape', 'bad#G1'], ['incomplete-name-escape', 'bad#']]) {
    const pdf = traditionalPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: `<< /Type /Pages /Kids [3 0 R] /Count 1 /Note /${escapedName} >>`,
      3: '<< /Type /Page /Parent 2 0 R >>'
    });
    await withInjectedRendererPdf(name, pdf, async (rendererPath) => {
      await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: rendererPath }), { statusCode: 502 });
    });
  }
});

test('rejects malformed, failed, timed-out, and oversized renderer output without returning partial PDF bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'v1-report-renderer-'));
  const script = async (name, body) => {
    const filename = path.join(directory, name);
    await writeFile(filename, `#!/bin/sh\ncat >/dev/null\n${body}\n`);
    await chmod(filename, 0o755);
    return filename;
  };
  try {
    const invalid = await script('invalid.sh', "printf '%s' '%PDF-1.7 incomplete'");
    const fakePrefix = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
    const shapedButTruncated = await script('shaped-but-truncated.sh', shellPrint(`${fakePrefix}xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(fakePrefix)}\n%%EOF`));
    const bogusPage = await script('bogus-page.sh', shellPrint(traditionalPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Bogus /Parent 2 0 R /Payload (/Type /Page) >>'
    })));
    const cycle = await script('cycle.sh', shellPrint(traditionalPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Pages /Kids [2 0 R] /Count 1 /Payload (/Type /Page) >>'
    })));
    const badParent = await script('bad-parent.sh', shellPrint(traditionalPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Page /Parent 4 0 R >>'
    })));
    const missingKids = await script('missing-kids.sh', shellPrint(traditionalPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Count 1 /Bogus 3 0 R >>', 3: '<< /Type /Page /Parent 2 0 R >>'
    })));
    const failed = await script('failed.sh', "echo renderer-failed >&2; exit 7");
    const delayed = await script('delayed.sh', 'sleep 2; printf %s %PDF-1.7');
    const oversized = await script('oversized.sh', "printf '%s' '%PDF-1.7\\nstartxref\\n0\\n%%EOF'; head -c 512 /dev/zero");
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: invalid }), { statusCode: 502 });
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: shapedButTruncated }), { statusCode: 502 });
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: bogusPage }), { statusCode: 502 });
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: cycle }), { statusCode: 502 });
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: badParent }), { statusCode: 502 });
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: missingKids }), { statusCode: 502 });
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: failed }), { statusCode: 502 });
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: delayed, timeoutMs: 50 }), { statusCode: 504 });
    await assert.rejects(generateV1ReportPdf(projectV1Report(completeV1Fixture()), { python: oversized, maxPdfBytes: 128 }), { statusCode: 502 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
