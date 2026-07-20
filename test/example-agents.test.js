import test from 'node:test';
import assert from 'node:assert/strict';
import { callA2AAgent, resolveAgentCard } from '../src/a2a.js';
import { startExampleAgents, stopExampleAgents } from '../examples/agents/server.js';
import { EvaluationPipeline } from '../src/pipeline.js';
import { EvaluationStore } from '../src/store.js';
import { EventEmitter } from 'node:events';

process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
let agents;

test.before(async () => { agents = await startExampleAgents({ ports: [0, 0, 0] }); });
test.after(async () => stopExampleAgents(agents));

test('discovers all examples from the well-known Agent Card path', async () => {
  for (const agent of agents) {
    const resolved = await resolveAgentCard('service-url', agent.origin);
    assert.equal(resolved.card.name, agent.name);
    assert.match(resolved.resolvedUrl, /\.well-known\/agent-card\.json$/);
  }
});

test('serves a human-readable status page at each example root', async () => {
  const response = await fetch(`${agents[0].origin}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /文件收纳员/);
  assert.match(html, /\.well-known\/agent-card\.json/);
});

test('calls the A2A 1.0 HTTP+JSON file organizer', async () => {
  const card = (await resolveAgentCard('service-url', agents[0].origin)).card;
  const result = await callA2AAgent(card, '整理 会议记录.docx 和 报价单.xlsx，只预览');
  assert.match(result.text, /会议记录\.docx/);
  assert.match(result.text, /仅预览/);
});

test('calls the A2A 1.0 JSON-RPC contract reviewer with SendMessage', async () => {
  const card = (await resolveAgentCard('card-url', `${agents[1].origin}/.well-known/agent-card.json`)).card;
  const result = await callA2AAgent(card, '审查数据出境、赔偿上限和自动续费');
  assert.match(result.text, /数据出境/);
  assert.match(result.text, /赔偿上限/);
});

test('calls the A2A 0.3 JSON-RPC incident agent and extracts task artifacts', async () => {
  const card = (await resolveAgentCard('service-url', agents[2].origin)).card;
  const result = await callA2AAgent(card, '支付成功率下降，请组织 P1 响应');
  assert.match(result.text, /P1 事故作战板/);
  assert.match(result.text, /验收/);
});

test('runs a complete live-mode platform evaluation against a real A2A agent', async () => {
  const card = (await resolveAgentCard('service-url', agents[1].origin)).card;
  const store = new EvaluationStore(`/tmp/agent-roast-live-${process.pid}.json`);
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({
    mode: 'live', agentCard: card,
    cases: [{ name: '真实合同测试', prompt: '审查数据出境、赔偿上限和自动续费，并给出依据。' }]
  });
  let result;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    result = store.get(created.id);
    if (['completed', 'failed'].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(result.status, 'completed');
  const submitted = result.benchmark[0].entries.find((entry) => entry.id === 'submitted');
  assert.equal(submitted.mode, 'live');
  assert.match(submitted.output, /数据出境/);
  assert.equal(result.builds.every((build) => build.mode === 'demo'), true, '未配置 runtime 时必须明确保留 demo 标签');
  assert.deepEqual(result.coverage, { agent: 'live', models: 'demo', runtimes: 'demo' });
  assert.equal(result.overallMode, 'mixed');
});
