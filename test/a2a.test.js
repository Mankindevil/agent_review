import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAgentText, getInterfaces, validateAgentCard } from '../src/a2a.js';
import { buildRoast, scoreComplexity } from '../src/scoring.js';

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

test('supports legacy A2A cards with a top-level url', () => {
  const result = getInterfaces({ url: 'https://example.com/a2a', preferredTransport: 'JSONRPC', protocolVersion: '0.3' });
  assert.deepEqual(result[0], { url: 'https://example.com/a2a', binding: 'JSONRPC', version: '0.3' });
});

test('extracts text from A2A artifacts', () => {
  assert.equal(extractAgentText({ task: { artifacts: [{ parts: [{ text: 'done' }] }] } }), 'done');
});

test('complex workflows score above trivial transforms', () => {
  const complex = scoreComplexity(card, [{ prompt: 'Research and verify this claim across sources' }]);
  const simple = scoreComplexity({ ...card, description: 'Rename and organize files', capabilities: {}, skills: [{ id: 'files', name: 'Files', description: '整理文件和重命名' }] }, [{ prompt: '整理文件' }]);
  assert.ok(complex.score > simple.score);
});

test('uses only 夯, 人上人, NPC and 拉 verdict tiers', () => {
  const agentWorthy = { score: 70 };
  assert.equal(buildRoast(90, 85, 78, 80, agentWorthy).tier.label, '夯');
  assert.equal(buildRoast(86, 85, 78, 80, agentWorthy).tier.label, '人上人');
  assert.equal(buildRoast(80, 85, 78, 80, agentWorthy).tier.label, 'NPC');
  assert.equal(buildRoast(70, 85, 78, 80, agentWorthy).tier.label, '拉');
  assert.equal(buildRoast(90, 70, 60, 80, { score: 20 }).tier.label, '拉');
});
