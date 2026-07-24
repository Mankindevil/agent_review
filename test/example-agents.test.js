import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callA2AAgent, resolveAgentCard } from '../src/a2a.js';
import { executeA2AExample } from '../src/a2a-executor.js';
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
  assert.match(html, /因子显微镜/);
  assert.match(html, /\.well-known\/agent-card\.json/);
});

test('calls the A2A 1.0 HTTP+JSON factor researcher', async () => {
  const card = (await resolveAgentCard('service-url', agents[0].origin)).card;
  const result = await callA2AAgent(card, '检验经营现金流收益率因子的 Rank IC 与五分组表现');
  assert.match(result.text, /Rank IC/);
  assert.match(result.text, /不构成投资建议/);
  assert.equal(result.run.outcome.status, 'succeeded');
});

test('returns and consumes a real context ID across turns without using message IDs', async () => {
  const card = (await resolveAgentCard('service-url', agents[0].origin)).card;
  const result = await executeA2AExample({
    card,
    example: {
      id: 'factor-follow-up',
      turns: [
        { input: { parts: [{ type: 'text', text: 'start research' }] } },
        { input: { parts: [{ type: 'text', text: 'continue research' }] } }
      ]
    },
    repeatIndex: 0,
    policy: { timeoutMs: 5_000 }
  });

  assert.equal(result.contextCheck.status, 'passed');
  assert.equal(result.runs[0].response.normalized.contextId, result.runs[1].response.normalized.contextId);
  assert.notEqual(
    result.runs[0].response.normalized.contextId,
    result.runs[0].response.normalized.messages[0].messageId
  );
});

test('calls the A2A 1.0 JSON-RPC strategy backtester with SendMessage', async () => {
  const card = (await resolveAgentCard('card-url', `${agents[1].origin}/.well-known/agent-card.json`)).card;
  const result = await callA2AAgent(card, '回测沪深 300 月度动量策略，计入手续费和滑点');
  assert.match(result.text, /沪深 300/);
  assert.match(result.text, /手续费/);
});

test('calls the A2A 0.3 JSON-RPC portfolio risk agent and extracts task artifacts', async () => {
  const card = (await resolveAgentCard('service-url', agents[2].origin)).card;
  const result = await callA2AAgent(card, '科技 42%，模拟板块下跌 10% 的冲击');
  assert.match(result.text, /组合风险快照/);
  assert.match(result.text, /-4\.2%/);
});

test('runs a complete live-mode platform evaluation against a real A2A agent', async () => {
  const card = (await resolveAgentCard('service-url', agents[1].origin)).card;
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-live-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({
    mode: 'live', agentCard: card,
    cases: [{ name: '真实回测测试', prompt: '回测沪深 300 月度动量策略，计入手续费、滑点并报告最大回撤。' }]
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
  assert.match(submitted.output, /沪深 300/);
  assert.equal(result.builds.every((build) => build.mode === 'demo'), true, '未配置 runtime 时必须明确保留 demo 标签');
  assert.deepEqual(result.coverage, { agent: 'live', models: 'demo', runtimes: 'demo' });
  assert.equal(result.overallMode, 'mixed');
});
