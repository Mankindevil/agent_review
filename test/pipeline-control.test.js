import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EvaluationPipeline } from '../src/pipeline.js';
import { EvaluationStore } from '../src/store.js';

function evaluation(id, status = 'running') {
  return {
    id, status, mode: 'demo', progress: 52, stage: 'Runtime 现场复刻', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), logs: [],
    agentCard: { name: 'Test Agent', description: 'test', supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }], skills: [{ id: 'test', name: 'Test', description: 'test' }] },
    cases: [{ name: 'case', prompt: 'test prompt' }], validation: { valid: true, interfaces: [{ url: 'https://example.com/a2a', binding: 'HTTP+JSON', version: '1.0' }] }
  };
}

test('cancels an active evaluation and aborts its controller', async () => {
  const store = new EvaluationStore(`/tmp/agent-roast-cancel-${process.pid}.json`);
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
  const store = new EvaluationStore(`/tmp/agent-roast-recover-${process.pid}.json`);
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  await store.set(evaluation('eval_stale', 'running'));
  await store.set(evaluation('eval_done', 'completed'));

  await pipeline.recoverInterrupted();
  assert.equal(store.get('eval_stale').status, 'interrupted');
  assert.match(store.get('eval_stale').error, /进程.*重启/);
  assert.equal(store.get('eval_done').status, 'completed');
});

test('persists each completed reviewer, runtime and benchmark entry incrementally', async () => {
  const store = new EvaluationStore(`/tmp/agent-roast-incremental-${process.pid}.json`);
  const snapshots = [];
  const originalSet = store.set.bind(store);
  store.set = async (item) => {
    snapshots.push(structuredClone(item));
    return originalSet(item);
  };
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({ mode: 'demo', agentCard: evaluation('template').agentCard, cases: [{ name: 'case', prompt: 'test prompt' }] });
  for (let attempt = 0; attempt < 80 && store.get(created.id).status !== 'completed'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(snapshots.some((item) => item.professional?.reviews?.length === 1));
  assert.ok(snapshots.some((item) => item.builds?.length === 1));
  assert.ok(snapshots.some((item) => item.benchmark?.[0]?.entries?.length === 1));
  assert.equal(store.get(created.id).status, 'completed');
});
