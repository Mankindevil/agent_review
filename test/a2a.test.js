import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAgentText, getInterfaces, validateAgentCard } from '../src/a2a.js';
import { scoreComplexity } from '../src/scoring.js';

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
