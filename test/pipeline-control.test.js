import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EvaluationPipeline } from '../src/pipeline.js';
import { EvaluationStore } from '../src/store.js';

function evaluation(id, status = 'running') {
  return {
    id, status, mode: 'demo', progress: 52, stage: 'Runtime 现场复刻', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), logs: [],
    agentCard: { name: 'Test Agent', description: 'test', supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }], skills: [{ id: 'test', name: 'Test', description: 'test' }] },
    cases: [{ name: 'case', prompt: 'test prompt' }], validation: { valid: true, interfaces: [{ url: 'https://example.com/a2a', binding: 'HTTP+JSON', version: '1.0' }] }
  };
}

async function waitFor(store, id, predicate, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const item = store.get(id);
    if (predicate(item)) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.get(id);
}

test('cancels an active evaluation and aborts its controller', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-cancel-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const item = evaluation('eval_cancel');
  const controller = new AbortController();
  await store.set(item);
  pipeline.activeRuns.set(item.id, controller);

  const cancelled = await pipeline.cancel(item.id);
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stage, '评测已停止');
  assert.match(cancelled.logs.at(-1).detail, /保留/);
});

test('marks persisted running evaluations as interrupted after a restart', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-recover-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  await store.set(evaluation('eval_stale', 'running'));
  await store.set(evaluation('eval_done', 'completed'));

  await pipeline.recoverInterrupted();
  assert.equal(store.get('eval_stale').status, 'interrupted');
  assert.match(store.get('eval_stale').error, /进程.*重启/);
  assert.equal(store.get('eval_done').status, 'completed');
});

test('persists each completed reviewer, runtime and benchmark entry incrementally', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-incremental-${process.pid}.json`));
  const snapshots = [];
  const originalSet = store.set.bind(store);
  store.set = async (item) => {
    snapshots.push(structuredClone(item));
    return originalSet(item);
  };
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({ mode: 'demo', seed: 424242, agentCard: evaluation('template').agentCard, cases: [{ name: 'case', prompt: 'test prompt' }] });
  for (let attempt = 0; attempt < 80 && store.get(created.id).status !== 'completed'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(snapshots.some((item) => item.professional?.reviews?.length === 1));
  assert.ok(snapshots.some((item) => item.builds?.length === 1));
  assert.ok(snapshots.some((item) => item.benchmark?.[0]?.entries?.length === 1));
  assert.ok(snapshots.some((item) => item.activeWork?.type === 'review'));
  assert.ok(snapshots.some((item) => item.activeWork?.type === 'build'));
  assert.ok(snapshots.some((item) => item.activeWork?.type === 'benchmark'));
  assert.equal(store.get(created.id).status, 'completed');
  assert.equal(store.get(created.id).activeWork, null);
  assert.equal(store.get(created.id).seed, 424242);
  assert.equal(store.get(created.id).temperature, 0);
  assert.equal(store.get(created.id).reviewPlan.length, 4);
  assert.equal(store.get(created.id).runtimePlan.length, 3);
  assert.deepEqual(Object.keys(store.get(created.id).reviewPlan[0]).sort(), ['id', 'model', 'name']);
  assert.equal(store.get(created.id).professional.reviews.every((review) => Number.isInteger(review.seed)), true);
  assert.equal(store.get(created.id).builds.every((build) => Number.isInteger(build.seed)), true);
});

test('retries an individual stage and recalculates the derived verdict', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-retry-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({ mode: 'demo', agentCard: evaluation('template').agentCard, cases: [{ name: 'case', prompt: 'test prompt' }] });
  let item = await waitFor(store, created.id, (value) => value.status === 'completed');
  assert.equal(item.status, 'completed');

  await pipeline.retry(created.id, { type: 'review', key: 'gpt' });
  assert.equal(store.get(created.id).status, 'retrying');
  assert.equal(store.get(created.id).activeWork.type, 'review');
  assert.equal(store.get(created.id).activeWork.retry, true);
  item = await waitFor(store, created.id, (value) => value.status === 'completed' && value.retryHistory?.length === 1);
  assert.equal(item.retryHistory[0].type, 'review');
  assert.equal(item.professional.reviews.find((review) => review.reviewerId === 'gpt').score > 0, true);
  assert.ok(item.roast?.tier);
  assert.equal(item.activeWork, null);

  await pipeline.retry(created.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  item = await waitFor(store, created.id, (value) => value.status === 'completed' && value.retryHistory?.length === 2);
  assert.equal(item.retryHistory.at(-1).type, 'benchmark');
  assert.equal(item.benchmark[0].entries.filter((entry) => entry.id === 'submitted').length, 1, '重跑应替换而不是追加选手结果');

  await pipeline.retry(created.id, { type: 'build', key: 'claude-code' });
  item = await waitFor(store, created.id, (value) => value.status === 'completed' && value.retryHistory?.length === 3);
  assert.equal(item.retryHistory.at(-1).type, 'build');
  assert.equal(item.benchmark[0].entries.filter((entry) => entry.id === 'claude-code').length, 1);
  assert.ok(Number.isFinite(item.averages.submitted));

  const legacyReview = item.professional.reviews.find((review) => review.reviewerId === 'gpt');
  delete legacyReview.reviewerId;
  legacyReview.model = 'GPT-5 Legacy';
  await store.set(item);
  const oldBaseUrl = process.env.OPENAI_BASE_URL;
  const oldApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = 'https://gateway.example.test/v1';
  process.env.OPENAI_API_KEY = 'test-only';
  try {
    await pipeline.retry(created.id, { type: 'review', key: 'GPT-5 Legacy' });
    item = await waitFor(store, created.id, (value) => value.status === 'completed' && value.retryHistory?.length === 4);
    const updatedReview = item.professional.reviews.find((review) => review.reviewerId === 'gpt');
    assert.ok(updatedReview);
    assert.notEqual(updatedReview.model, 'GPT-5 Legacy', '历史模型显示名应映射到当前 reviewer 配置');
  } finally {
    if (oldBaseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = oldBaseUrl;
    if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldApiKey;
  }
});

test('produces identical demo scores for the same explicit seed', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-seed-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const input = { mode: 'demo', seed: 731, agentCard: evaluation('template').agentCard, cases: [{ name: 'case', prompt: 'same prompt' }] };
  const first = await pipeline.create(input);
  const firstResult = await waitFor(store, first.id, (value) => value.status === 'completed');
  const second = await pipeline.create(input);
  const secondResult = await waitFor(store, second.id, (value) => value.status === 'completed');
  assert.deepEqual(secondResult.professional.reviews.map((review) => review.score), firstResult.professional.reviews.map((review) => review.score));
  assert.deepEqual(secondResult.averages, firstResult.averages);
  assert.deepEqual(secondResult.roast, firstResult.roast);
});

test('marks a failed live Agent call as failed coverage', async () => {
  const envNames = ['ALLOW_PRIVATE_AGENT_URLS', 'MODEL_REVIEWERS_JSON', 'RUNTIME_ADAPTERS_JSON', 'ENABLE_LOCAL_CLAUDE_CODE', 'ENABLE_LOCAL_CURSOR_AGENT', 'ARK_BASE_URL', 'ARK_API_KEY'];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const failingAgent = createServer((_request, response) => { response.writeHead(503); response.end('offline'); });
  await new Promise((resolve) => failingAgent.listen(0, '127.0.0.1', resolve));
  try {
    process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
    process.env.MODEL_REVIEWERS_JSON = JSON.stringify([{ id: 'mock', name: 'Mock', model: 'Mock', kind: 'mock' }]);
    process.env.RUNTIME_ADAPTERS_JSON = '{}';
    process.env.ENABLE_LOCAL_CLAUDE_CODE = 'false';
    process.env.ENABLE_LOCAL_CURSOR_AGENT = 'false';
    delete process.env.ARK_BASE_URL;
    delete process.env.ARK_API_KEY;
    const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-coverage-${process.pid}.json`));
    const pipeline = new EvaluationPipeline(store, new EventEmitter());
    const card = evaluation('template').agentCard;
    card.supportedInterfaces[0].url = `http://127.0.0.1:${failingAgent.address().port}/a2a`;
    const created = await pipeline.create({ mode: 'live', agentCard: card, cases: [{ name: 'failure', prompt: 'test prompt' }] });
    const result = await waitFor(store, created.id, (value) => value.status === 'completed');
    assert.equal(result.coverage.agent, 'failed');
    assert.equal(result.benchmark[0].entries.find((entry) => entry.id === 'submitted').mode, 'failed');
    assert.equal(result.overallMode, 'mixed');
  } finally {
    await new Promise((resolve) => failingAgent.close(resolve));
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});

test('uses one PandaAI snapshot to verify every benchmark output', async () => {
  const envNames = ['ALLOW_PRIVATE_AGENT_URLS', 'MODEL_REVIEWERS_JSON', 'RUNTIME_ADAPTERS_JSON', 'ENABLE_LOCAL_CLAUDE_CODE', 'ENABLE_LOCAL_CURSOR_AGENT', 'ARK_BASE_URL', 'ARK_API_KEY'];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const agent = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      message: {
        messageId: 'panda-evidence-reply',
        role: 'ROLE_AGENT',
        parts: [{ text: '数据来源：PandaAI。沪深 300 期末收盘为 11.30 点，风险提示：历史数据不代表未来收益。' }]
      }
    }));
  });
  await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve));
  let queryCalls = 0;
  try {
    process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
    process.env.MODEL_REVIEWERS_JSON = JSON.stringify([{ id: 'mock', name: 'Mock', model: 'Mock', kind: 'mock' }]);
    process.env.RUNTIME_ADAPTERS_JSON = '{}';
    process.env.ENABLE_LOCAL_CLAUDE_CODE = 'false';
    process.env.ENABLE_LOCAL_CURSOR_AGENT = 'false';
    delete process.env.ARK_BASE_URL;
    delete process.env.ARK_API_KEY;
    const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-data-evidence-${process.pid}.json`));
    const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
      dataVerificationEnabled: true,
      dataQuery: async () => {
        queryCalls += 1;
        return { provider: 'pandaai', method: 'get_index_daily', rowCount: 1, truncated: false, data: [{ symbol: '000300.SH', date: '20250110', close: 11.3 }] };
      }
    });
    const card = evaluation('template').agentCard;
    card.supportedInterfaces[0].url = `http://127.0.0.1:${agent.address().port}/a2a`;
    const created = await pipeline.create({
      mode: 'live', agentCard: card,
      cases: [{
        name: '数据锚点', prompt: '截至 2025-01-10，报告沪深 300 期末收盘。',
        dataQueries: [{
          method: 'get_index_daily', params: { symbol: ['000300.SH'], start_date: '20250101', end_date: '20250110', fields: [] },
          requiredFields: ['date', 'symbol', 'close'],
          facts: [{ label: '沪深 300 期末收盘', field: 'close', aliases: ['期末收盘'], tolerance: 0.01 }]
        }]
      }]
    });
    const result = await waitFor(store, created.id, (value) => value.status === 'completed');
    assert.equal(queryCalls, 1, '同一用例的所有选手必须复用同一份参考快照');
    assert.equal(result.benchmark[0].dataEvidence.status, 'ready');
    assert.equal(result.benchmark[0].entries.find((entry) => entry.id === 'submitted').dataVerification.status, 'verified');
    assert.equal(result.benchmark[0].entries.find((entry) => entry.id === 'submitted').dimensions.dataEvidence, 96);
    assert.ok(result.logs.some((log) => log.source === 'DATA' && log.phase === 'evidence'));
  } finally {
    await new Promise((resolve) => agent.close(resolve));
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});

test('rejects an unknown retry step and a retry while work is active', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-retry-invalid-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const active = evaluation('eval_active');
  const done = evaluation('eval_done_retry', 'completed');
  await store.set(active);
  await store.set(done);
  await assert.rejects(() => pipeline.retry(active.id, { type: 'review', key: 'gpt' }), (error) => error.statusCode === 409);
  await assert.rejects(() => pipeline.retry(done.id, { type: 'review', key: 'missing' }), (error) => error.statusCode === 400);
});
