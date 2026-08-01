import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_FILE = path.join(tmpdir(), `agent-roast-v1-report-route-${process.pid}.json`);
process.env.A2A_BLACK_BOX_V1_ENABLED = 'false';

const { server, evaluationStore, pipeline } = await import('../server.js');
const reportPython = '/Users/jintingzhou/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';

function completeV1ReportFixture(id) {
  const reviews = ['gpt', 'claude', 'doubao', 'deepseek'].map((reviewerId) => ({ reviewerId, reviewer: reviewerId, model: reviewerId, score: 80, comment: '完成', dimensions: {} }));
  const entries = [['submitted', '提交 Agent'], ['claude-code', 'Claude Code'], ['cursor', 'Cursor'], ['doubao', '豆包']]
    .map(([id, name]) => ({ id, name, output: `${name} 输出`, score: 80, dimensions: {}, detail: {}, execution: {}, judgeReviews: [] }));
  return {
    id, schemaVersion: 1, status: 'completed', mode: 'demo', createdAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-01T00:01:00Z',
    agentCard: { name: 'Route PDF Agent', description: '完整 V1 路由测试记录', skills: [] },
    scoringConfig: { version: 'v1-model-arena/v2', mode: 'panel' }, professional: { reviews },
    averages: { submitted: 80 }, roast: { tier: { code: 'NPC', label: 'NPC' }, headline: '完成' }, builds: [],
    benchmark: [{ case: { name: '路由案例', prompt: '输出完整分析' }, entries }], logs: []
  };
}

function requestReport(id) {
  return new Promise((resolve) => {
    const request = Object.assign(new EventEmitter(), {
      method: 'GET', url: `/api/evaluations/${encodeURIComponent(id)}/report.pdf`, headers: { host: 'localhost' }
    });
    const headers = new Map();
    const response = {
      setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
      writeHead(status, values = {}) { this.statusCode = status; Object.entries(values).forEach(([name, value]) => headers.set(name.toLowerCase(), value)); },
      end(body = '') { resolve({ status: this.statusCode, headers, body: Buffer.isBuffer(body) ? body : Buffer.from(String(body)) }); }
    };
    server.emit('request', request, response);
  });
}

test('fresh V1 create completes and downloads its report without a store reload', async () => {
  const created = await pipeline.create({
    mode: 'demo',
    seed: 8082,
    scoringConfig: { mode: 'single', reviewerId: 'deepseek' },
    agentCard: {
      name: 'Fresh Report Agent',
      description: '面向金融研究的多步分析 Agent。',
      supportedInterfaces: [{
        url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0'
      }],
      skills: [{ id: 'research', name: '研究', description: '生成完整研究报告。' }]
    },
    cases: [{ name: '新建报告', prompt: '请输出一份包含方法、证据与风险的完整研究报告。' }]
  });
  let completed;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    completed = evaluationStore.get(created.id);
    if (completed?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const previousPython = process.env.REPORT_PDF_PYTHON;
  try {
    assert.equal(created.schemaVersion, 1);
    assert.equal(completed?.schemaVersion, 1);
    assert.equal(completed?.status, 'completed');
    process.env.REPORT_PDF_PYTHON = reportPython;
    const report = await requestReport(created.id);
    assert.equal(report.status, 200);
    assert.equal(report.headers.get('content-type'), 'application/pdf');
    assert.equal(report.headers.get('content-disposition'), `attachment; filename="agent-review-${created.id}.pdf"`);
    assert.equal(report.body.subarray(0, 5).toString(), '%PDF-');
  } finally {
    if (previousPython === undefined) delete process.env.REPORT_PDF_PYTHON; else process.env.REPORT_PDF_PYTHON = previousPython;
    await evaluationStore.delete(created.id);
  }
});

test('maps incomplete V1 topology and failed renderers to JSON without partial PDF bytes', async () => {
  const completed = completeV1ReportFixture('v1-route-complete');
  const incomplete = { ...completed, id: 'v1-route-incomplete', professional: { reviews: completed.professional.reviews.slice(0, 3) } };
  await evaluationStore.set(completed);
  await evaluationStore.set(incomplete);
  const directory = await mkdtemp(path.join(tmpdir(), 'v1-report-route-'));
  const failed = path.join(directory, 'failed.sh');
  const oversized = path.join(directory, 'oversized.sh');
  await writeFile(failed, "#!/bin/sh\ncat >/dev/null\nprintf '%s' '%PDF-1.7 partial'; exit 7\n");
  await writeFile(oversized, "#!/bin/sh\ncat >/dev/null\nprintf '%s' '%PDF-1.7'; head -c 512 /dev/zero\n");
  await chmod(failed, 0o755);
  await chmod(oversized, 0o755);
  const previousPython = process.env.REPORT_PDF_PYTHON;
  const previousMax = process.env.REPORT_PDF_MAX_BYTES;
  try {
    const topology = await requestReport(incomplete.id);
    assert.equal(topology.status, 409);
    assert.match(String(topology.headers.get('content-type')), /application\/json/);
    assert.doesNotMatch(topology.body.toString(), /%PDF-/);

    process.env.REPORT_PDF_PYTHON = failed;
    const nonzero = await requestReport(completed.id);
    assert.equal(nonzero.status, 502);
    assert.match(String(nonzero.headers.get('content-type')), /application\/json/);
    assert.doesNotMatch(nonzero.body.toString(), /%PDF-/);

    process.env.REPORT_PDF_PYTHON = oversized;
    process.env.REPORT_PDF_MAX_BYTES = '128';
    const tooLarge = await requestReport(completed.id);
    assert.equal(tooLarge.status, 502);
    assert.match(tooLarge.body.toString(), /超过输出上限/);
    assert.doesNotMatch(tooLarge.body.toString(), /%PDF-/);
  } finally {
    if (previousPython === undefined) delete process.env.REPORT_PDF_PYTHON; else process.env.REPORT_PDF_PYTHON = previousPython;
    if (previousMax === undefined) delete process.env.REPORT_PDF_MAX_BYTES; else process.env.REPORT_PDF_MAX_BYTES = previousMax;
    await evaluationStore.delete(completed.id);
    await evaluationStore.delete(incomplete.id);
    await rm(directory, { recursive: true, force: true });
  }
});
