import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATA_FILE = `/tmp/agent-roast-test-${process.pid}.json`;
const { server } = await import('../server.js');

let origin;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => new Promise((resolve) => server.close(resolve)));

test('health endpoint responds', async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(Number.isInteger(health.evaluationSeed), true);
  assert.equal(health.modelTemperature, 0);
});

test('serves the scoring methodology document in the web UI', async () => {
  const response = await fetch(`${origin}/methodology.html`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /每一分/);
  assert.match(html, /clamp\(18 \+ 10C/);
  assert.match(html, /夯 \/ 人上人 \/ NPC \/ 拉/);
  assert.match(html, /最新结果替换旧结果/);
});

test('reports honest local runtime availability', async () => {
  const response = await fetch(`${origin}/api/runtimes`);
  const runtimes = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(runtimes.map((runtime) => runtime.id), ['claude-code', 'cursor', 'doubao']);
  assert.equal(runtimes.every((runtime) => typeof runtime.runtimeReady === 'boolean'), true);
});

test('creates and completes a demo evaluation', async () => {
  const card = {
    name: 'Workflow Agent', description: 'Multi-step API workflow with retries and human review.',
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    skills: [{ id: 'flow', name: 'Workflow', description: 'Plan and execute an API workflow.' }]
  };
  const createdResponse = await fetch(`${origin}/api/evaluations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard: card, mode: 'demo', seed: 9981, cases: [{ name: 'test', prompt: 'Plan and execute this workflow with evidence.' }] }) });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();
  let result;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    result = await (await fetch(`${origin}/api/evaluations/${created.id}`)).json();
    if (result.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(result.status, 'completed');
  assert.equal(result.seed, 9981);
  assert.equal(result.temperature, 0);
  assert.equal(result.benchmark[0].entries.length, 4);
  assert.ok(result.roast.tier.label);
  assert.ok(result.logs.length > 10);
  assert.ok(result.logs.every((log) => log.source && log.phase && log.mode));

  const retryResponse = await fetch(`${origin}/api/evaluations/${created.id}/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'benchmark', key: 'submitted', caseIndex: 0 })
  });
  assert.equal(retryResponse.status, 202);
  assert.equal((await retryResponse.json()).status, 'retrying');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    result = await (await fetch(`${origin}/api/evaluations/${created.id}`)).json();
    if (result.status === 'completed' && result.retryHistory?.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(result.retryHistory.length, 1);
  assert.equal(result.retryHistory[0].type, 'benchmark');
  assert.ok(result.roast.tier.label, '重试完成后应重新生成最终锐评');

  const cancelResponse = await fetch(`${origin}/api/evaluations/${created.id}/cancel`, { method: 'POST' });
  assert.equal(cancelResponse.status, 200);
  assert.equal((await cancelResponse.json()).status, 'completed', '停止接口应当对已结束评测保持幂等');
});

test('returns 404 when stopping an unknown evaluation', async () => {
  const response = await fetch(`${origin}/api/evaluations/eval_missing/cancel`, { method: 'POST' });
  assert.equal(response.status, 404);
});

test('returns 404 when retrying an unknown evaluation', async () => {
  const response = await fetch(`${origin}/api/evaluations/eval_missing/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'review', key: 'gpt' })
  });
  assert.equal(response.status, 404);
});

test('rejects malformed agent cards', async () => {
  const response = await fetch(`${origin}/api/evaluations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard: { name: 'Nope' }, cases: [{ prompt: 'x' }] }) });
  assert.equal(response.status, 400);
});

test('rejects an out-of-range evaluation seed', async () => {
  const card = {
    name: 'Seed Agent', description: 'Valid card with invalid seed.',
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    skills: [{ id: 'seed', name: 'Seed', description: 'Test seed validation.' }]
  };
  const response = await fetch(`${origin}/api/evaluations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentCard: card, mode: 'demo', seed: 2_147_483_647, cases: [{ prompt: 'test' }] })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Seed/);
});
