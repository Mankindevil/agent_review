import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeAgentUrl,
  buildA2ARequest,
  extractAgentText,
  getInterfaces,
  parseA2AResponse,
  parseSseEvents,
  selectInterface,
  validateAgentCard,
  validateStreamResult
} from '../src/a2a.js';
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

test('selects the first supported interface and preserves its tenant', () => {
  const target = selectInterface({
    supportedInterfaces: [
      { url: 'wss://example.com/a2a', protocolBinding: 'CUSTOM', protocolVersion: '1.0' },
      { url: 'https://example.com/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: 'desk-7' },
      { url: 'https://example.com/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }
    ]
  });
  assert.deepEqual(target, {
    url: 'https://example.com/rpc',
    binding: 'JSONRPC',
    version: '1.0',
    tenant: 'desk-7'
  });
});

test('does not assume required 1.0 interface metadata or an unsupported version', () => {
  assert.equal(selectInterface({
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolVersion: '1.0' }]
  }), null);
  assert.equal(selectInterface({
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON' }]
  }), null);
  assert.equal(selectInterface({
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '2.0' }]
  }), null);
});

test('builds versioned A2A requests with tenant and binding-specific endpoints', () => {
  const rpc = buildA2ARequest(
    { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '1.0', tenant: 'desk-7' },
    'hello',
    { requestId: 'req-1', messageId: 'msg-1' }
  );
  assert.equal(rpc.url, 'https://example.com/rpc');
  assert.equal(rpc.body.method, 'SendMessage');
  assert.equal(rpc.body.params.tenant, 'desk-7');
  assert.equal(rpc.body.params.message.messageId, 'msg-1');

  const legacy = buildA2ARequest(
    { url: 'https://example.com/a2a', binding: 'JSONRPC', version: '0.3' },
    'hello',
    { requestId: 'req-2', messageId: 'msg-2' }
  );
  assert.equal(legacy.body.method, 'message/send');
  assert.equal(legacy.body.params.message.role, 'user');

  const rest = buildA2ARequest(
    { url: 'https://example.com/a2a/v1', binding: 'HTTP+JSON', version: '1.0' },
    'hello',
    { requestId: 'req-3', messageId: 'msg-3', streaming: true }
  );
  assert.equal(rest.url, 'https://example.com/a2a/v1/message:stream');
  assert.equal(rest.headers['content-type'], 'application/a2a+json');

  const legacyRest = buildA2ARequest(
    { url: 'https://example.com/a2a/v1', binding: 'HTTP+JSON', version: '0.3' },
    'hello',
    { requestId: 'req-4', messageId: 'msg-4' }
  );
  assert.equal(legacyRest.headers['content-type'], 'application/json');
});

test('builds private HTTP+JSON requests when an explicit policy allows them', () => {
  const request = buildA2ARequest(
    { url: 'http://127.0.0.1:3000/a2a/v1', binding: 'HTTP+JSON', version: '1.0' },
    'hello',
    { allowPrivate: true, requestId: 'req-private', messageId: 'msg-private' }
  );
  assert.equal(request.url, 'http://127.0.0.1:3000/a2a/v1/message:send');
});

test('rejects JSON-RPC errors and mismatched response ids', () => {
  const target = { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '1.0' };
  assert.throws(
    () => parseA2AResponse(target, { jsonrpc: '2.0', id: 'other', result: { message: {} } }, 'req-1'),
    /请求 ID/
  );
  assert.throws(
    () => parseA2AResponse(target, { jsonrpc: '2.0', id: 'req-1', error: { code: -32602, message: 'bad token' } }, 'req-1'),
    /bad token/
  );
  assert.throws(
    () => parseA2AResponse(target, { jsonrpc: '2.0', id: 'req-1', result: { message: {} } }, 'req-1'),
    /Message/
  );
  assert.throws(
    () => parseA2AResponse(target, { jsonrpc: '2.0', id: 'req-1', result: { task: { status: {} } } }, 'req-1'),
    /Task/
  );
});

test('accepts legacy 0.3 JSON-RPC results without a 1.0 response wrapper', () => {
  const target = { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '0.3' };
  const message = {
    kind: 'message',
    messageId: 'reply-1',
    role: 'agent',
    parts: [{ kind: 'text', text: 'legacy reply' }]
  };
  assert.equal(
    parseA2AResponse(target, { jsonrpc: '2.0', id: 'req-1', result: message }, 'req-1'),
    message
  );
});

test('parses SSE frames and requires a terminal stream result', () => {
  const text = [
    ': heartbeat\r\n',
    'data: {"jsonrpc":"2.0","id":"req-1","result":{"task":{"id":"task-1","status":{"state":"TASK_STATE_WORKING"}}}}\r\n\r\n',
    'data: {"jsonrpc":"2.0","id":"req-1","result":{"statusUpdate":{"taskId":"task-1",\r\n',
    'data: "status":{"state":"TASK_STATE_COMPLETED"}}}}\r\n\r\n'
  ].join('');
  const events = parseSseEvents(text);
  assert.equal(events.length, 2);
  assert.equal(validateStreamResult({ binding: 'JSONRPC', version: '1.0' }, events, 'req-1').terminal, true);

  const partial = parseSseEvents('data: {"jsonrpc":"2.0","id":"req-1","result":{"task":{"id":"task-1","status":{"state":"TASK_STATE_WORKING"}}}}\n\n');
  assert.throws(
    () => validateStreamResult({ binding: 'JSONRPC', version: '1.0' }, partial, 'req-1'),
    /终态/
  );
  assert.throws(
    () => validateStreamResult(
      { binding: 'JSONRPC', version: '1.0' },
      [{ jsonrpc: '2.0', id: 'other', result: { message: { messageId: 'm', role: 'ROLE_AGENT', parts: [] } } }],
      'req-1'
    ),
    /请求 ID/
  );
  assert.throws(
    () => validateStreamResult(
      { binding: 'JSONRPC', version: '1.0' },
      [{ jsonrpc: '2.0', id: 'req-1', error: { code: -32603, message: 'stream broke' } }],
      'req-1'
    ),
    /stream broke/
  );
  assert.throws(
    () => parseSseEvents('data: {"one":1}\n\ndata: {"two":2}\n\n', { maxEvents: 1 }),
    /事件数量/
  );
  assert.throws(
    () => parseSseEvents('data: {"large":"payload"}\n\n', { maxEventBytes: 4 }),
    /单个事件/
  );
});

test('accepts a legacy 0.3 terminal status update stream', () => {
  const events = [{
    jsonrpc: '2.0',
    id: 'req-1',
    result: {
      kind: 'status-update',
      taskId: 'task-1',
      final: true,
      status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'legacy done' }] } }
    }
  }];
  const result = validateStreamResult({ binding: 'JSONRPC', version: '0.3' }, events, 'req-1');
  assert.equal(result.terminal, true);
  assert.match(result.text, /legacy done/);
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
