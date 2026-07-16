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
  assert.equal((await response.json()).ok, true);
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
  const createdResponse = await fetch(`${origin}/api/evaluations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard: card, mode: 'demo', cases: [{ name: 'test', prompt: 'Plan and execute this workflow with evidence.' }] }) });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();
  let result;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    result = await (await fetch(`${origin}/api/evaluations/${created.id}`)).json();
    if (result.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(result.status, 'completed');
  assert.equal(result.benchmark[0].entries.length, 4);
  assert.ok(result.roast.tier.label);
  assert.ok(result.logs.length > 10);
  assert.ok(result.logs.every((log) => log.source && log.phase && log.mode));
});

test('rejects malformed agent cards', async () => {
  const response = await fetch(`${origin}/api/evaluations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard: { name: 'Nope' }, cases: [{ prompt: 'x' }] }) });
  assert.equal(response.status, 400);
});
