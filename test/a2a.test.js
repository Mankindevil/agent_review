import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeAgentUrl, extractAgentText, getInterfaces, validateAgentCard } from '../src/a2a.js';
import { buildRoast, judgeOutput, scoreComplexity } from '../src/scoring.js';

const card = {
  name: 'Research Agent',
  description: 'A multi-step research workflow with browser tools, retries and human confirmation.',
  supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
  capabilities: { streaming: true },
  skills: [{ id: 'research', name: 'Research', description: 'Plan, browse, verify sources and retry failures.' }]
};

test('accepts an A2A 1.0 agent card', () => {
  const result = validateAgentCard(card);
  assert.equal(result.valid, true);
  assert.equal(result.interfaces[0].binding, 'HTTP+JSON');
});

test('rejects malformed field types without throwing', () => {
  const result = validateAgentCard({
    name: 42,
    description: 'valid description',
    supportedInterfaces: [{ url: 99 }],
    skills: { id: 'not-an-array' }
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('；'), /name 必须是非空字符串/);
  assert.match(result.errors.join('；'), /至少声明一个 skill/);
  assert.match(result.errors.join('；'), /supportedInterfaces/);
});

test('supports legacy A2A cards with a top-level url', () => {
  const result = getInterfaces({ url: 'https://example.com/a2a', preferredTransport: 'JSONRPC', protocolVersion: '0.3' });
  assert.deepEqual(result[0], { url: 'https://example.com/a2a', binding: 'JSONRPC', version: '0.3' });
});

test('blocks loopback and private IPv6 Agent URLs by default', () => {
  const previous = process.env.ALLOW_PRIVATE_AGENT_URLS;
  delete process.env.ALLOW_PRIVATE_AGENT_URLS;
  try {
    assert.throws(() => assertSafeAgentUrl('http://[::1]/a2a'), /SSRF/);
    assert.throws(() => assertSafeAgentUrl('http://[fc00::1]/a2a'), /SSRF/);
    assert.throws(() => assertSafeAgentUrl('http://[fe80::1]/a2a'), /SSRF/);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_AGENT_URLS; else process.env.ALLOW_PRIVATE_AGENT_URLS = previous;
  }
});

test('extracts text from A2A artifacts', () => {
  assert.equal(extractAgentText({ task: { artifacts: [{ parts: [{ text: 'done' }] }] } }), 'done');
});

test('complex workflows score above trivial transforms', () => {
  const complex = scoreComplexity(card, [{ prompt: 'Research and verify this claim across sources' }]);
  const simple = scoreComplexity({ ...card, description: 'Rename and organize files', capabilities: {}, skills: [{ id: 'files', name: 'Files', description: '整理文件和重命名' }] }, [{ prompt: '整理文件' }]);
  assert.ok(complex.score > simple.score);
});

test('rewards auditable financial research output over unsupported return claims', () => {
  const disciplined = judgeOutput('回测因子', '数据来源：授权行情 Skill；样本区间 2019-2024，月频、后复权。方法报告 Rank IC、基准、手续费、滑点、换手和最大回撤。风险提示：历史结果不代表未来收益，不构成投资建议。', 'same-seed');
  const hype = judgeOutput('回测因子', '这个策略年化收益很高，建议立即买入。', 'same-seed');
  assert.ok(disciplined.score > hype.score);
  assert.equal(disciplined.dimensions.dataEvidence, 86);
  assert.equal(disciplined.dimensions.riskDisclosure, 88);
});

test('uses only 夯, 人上人, NPC and 拉 verdict tiers', () => {
  const agentWorthy = { score: 70 };
  assert.equal(buildRoast(90, 85, 78, 80, agentWorthy).tier.label, '夯');
  assert.equal(buildRoast(86, 85, 78, 80, agentWorthy).tier.label, '人上人');
  assert.equal(buildRoast(80, 85, 78, 80, agentWorthy).tier.label, 'NPC');
  assert.equal(buildRoast(70, 85, 78, 80, agentWorthy).tier.label, '拉');
  assert.equal(buildRoast(90, 70, 60, 80, { score: 20 }).tier.label, '拉');
});
