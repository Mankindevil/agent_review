import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeAgentUrl,
  buildA2ARequest,
  buildGetTaskRequest,
  extractAgentText,
  getInterfaces,
  negotiateAcceptedOutputModes,
  parseA2AResponse,
  parseA2AStreamEvent,
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

test('validates all known nested Agent Card fields and reports every structural error', () => {
  const result = validateAgentCard({
    name: 'Broken Agent',
    description: 'Contains several malformed declared fields.',
    version: 7,
    defaultInputModes: ['text/plain', 42],
    defaultOutputModes: 'application/json',
    capabilities: {
      streaming: 'yes',
      pushNotifications: false,
      stateTransitionHistory: 1,
      extendedAgentCard: 'available'
    },
    supportedInterfaces: [{
      url: 'https://user:secret@example.com/a2a',
      protocolBinding: 42,
      protocolVersion: null,
      tenant: false
    }],
    skills: [{
      id: 'broken',
      name: 'Broken',
      description: 'Malformed optional fields.',
      tags: ['finance', 42],
      examples: 'not-an-array',
      inputModes: ['text/plain', null],
      outputModes: {}
    }],
    provider: [],
    security: {},
    signatures: {},
    extensions: {}
  });

  assert.equal(result.valid, false);
  for (const path of [
    'version',
    'defaultInputModes',
    'defaultOutputModes',
    'capabilities.streaming',
    'capabilities.stateTransitionHistory',
    'capabilities.extendedAgentCard',
    'supportedInterfaces[0].url',
    'supportedInterfaces[0].protocolBinding',
    'supportedInterfaces[0].protocolVersion',
    'supportedInterfaces[0].tenant',
    'skills[0].tags',
    'skills[0].examples',
    'skills[0].inputModes',
    'skills[0].outputModes',
    'provider',
    'security',
    'signatures',
    'extensions'
  ]) {
    assert.match(result.errors.join('\n'), new RegExp(path.replaceAll('[', '\\[').replaceAll(']', '\\]')));
  }
});

test('rejects unsupported-only interfaces but selects a supported interface from a valid mixed declaration', () => {
  const unsupported = validateAgentCard({
    ...card,
    supportedInterfaces: [{
      url: 'https://example.com/custom',
      protocolBinding: 'CUSTOM',
      protocolVersion: '1.0'
    }]
  });
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.selectedInterface, null);
  assert.match(unsupported.errors.join('\n'), /supported interface/i);

  const mixed = validateAgentCard({
    ...card,
    supportedInterfaces: [
      {
        url: 'https://example.com/custom',
        protocolBinding: 'CUSTOM',
        protocolVersion: '1.0'
      },
      {
        url: 'https://example.com/rpc',
        protocolBinding: 'JSON-RPC',
        protocolVersion: '1.1',
        tenant: 'desk-7'
      }
    ]
  });
  assert.equal(mixed.valid, true);
  assert.deepEqual(mixed.selectedInterface, {
    url: 'https://example.com/rpc',
    binding: 'JSONRPC',
    version: '1.1',
    tenant: 'desk-7'
  });
  assert.equal(mixed.schemaVersion, '1.x');
});

test('selects and validates the declared 0.3 Agent Card shape', () => {
  const legacy = validateAgentCard({
    name: 'Legacy Agent',
    description: 'A legacy A2A Agent.',
    url: 'https://example.com/a2a',
    protocolVersion: '0.3',
    capabilities: { streaming: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['application/json'],
    skills: [{
      id: 'legacy',
      name: 'Legacy',
      description: 'Legacy skill.',
      tags: ['compatibility'],
      examples: ['Run the legacy workflow'],
      inputModes: ['text/plain'],
      outputModes: ['application/json']
    }],
    provider: { organization: 'Example' },
    security: [],
    signatures: [],
    extensions: []
  });

  assert.equal(legacy.valid, true);
  assert.equal(legacy.schemaVersion, '0.3');
  assert.deepEqual(legacy.selectedInterface, {
    url: 'https://example.com/a2a',
    binding: 'JSONRPC',
    version: '0.3'
  });
});

test('defaults an unversioned top-level URL Card to protocol 0.3', () => {
  const legacy = validateAgentCard({
    name: 'Unversioned Legacy Agent',
    description: 'Uses the legacy top-level URL shape.',
    url: 'https://example.com/a2a',
    skills: [{ id: 'legacy', name: 'Legacy', description: 'Legacy skill.' }]
  });

  assert.equal(legacy.valid, true);
  assert.equal(legacy.schemaVersion, '0.3');
  assert.equal(legacy.selectedInterface.version, '0.3');
});

test('accepts a hybrid top-level URL Card that claims a 1.x protocol version', () => {
  const result = validateAgentCard({
    name: 'Hybrid Agent',
    description: 'Legacy shape with a modern version.',
    url: 'https://example.com/a2a',
    protocolVersion: '1.0',
    preferredTransport: 'JSONRPC',
    skills: [{ id: 'hybrid', name: 'Hybrid', description: 'Hybrid skill.' }]
  });

  assert.equal(result.valid, true);
  assert.equal(result.schemaVersion, '0.3');
  assert.deepEqual(result.selectedInterface, {
    url: 'https://example.com/a2a',
    binding: 'JSONRPC',
    version: '1.0'
  });
  assert.match(result.warnings.join('\n'), /混合格式/);
});

test('accepts a hybrid HTTP+JSON 1.0 top-level URL Card', () => {
  const result = validateAgentCard({
    name: 'Hybrid HTTP Agent',
    description: 'Hybrid HTTP+JSON card.',
    url: 'https://example.com/a2a',
    protocolVersion: '1.0',
    preferredTransport: 'HTTP+JSON',
    skills: [{ id: 'hybrid', name: 'Hybrid', description: 'Hybrid skill.' }]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.selectedInterface, {
    url: 'https://example.com/a2a',
    binding: 'HTTP+JSON',
    version: '1.0'
  });
  assert.match(result.warnings.join('\n'), /混合格式/);
});

test('rejects a hybrid 1.x top-level URL Card without preferredTransport', () => {
  const result = validateAgentCard({
    name: 'Hybrid Missing Transport',
    description: 'Hybrid shape without transport.',
    url: 'https://example.com/a2a',
    protocolVersion: '1.0',
    skills: [{ id: 'hybrid', name: 'Hybrid', description: 'Hybrid skill.' }]
  });

  assert.equal(result.valid, false);
  assert.equal(result.selectedInterface, null);
  assert.match(result.errors.join('\n'), /preferredTransport/);
});

test('normalizes a top-level 0.2.x Card to a 0.3 execution interface', () => {
  const card02 = {
    name: '财神 MoneyGod',
    description: '玄学皮·量化芯投研团队',
    url: 'https://example.com/',
    protocolVersion: '0.2.6',
    preferredTransport: 'JSONRPC',
    skills: [{
      id: 'multi_agent_quant_research',
      name: '多 Agent 量化投研',
      description: '因子到回测反馈闭环'
    }]
  };
  const result = validateAgentCard(card02);

  assert.equal(result.valid, true);
  assert.deepEqual(result.selectedInterface, {
    url: 'https://example.com/',
    binding: 'JSONRPC',
    version: '0.3'
  });
  assert.match(result.warnings.join('\n'), /0\.2\.x/);
  assert.deepEqual(selectInterface(card02), result.selectedInterface);
  assert.deepEqual(getInterfaces(card02), result.interfaces);
});

test('keeps getInterfaces aligned with validateAgentCard for hybrid cards', () => {
  const hybrid = {
    name: 'Aligned Hybrid',
    description: 'Interface selection must match validation.',
    url: 'https://example.com/rpc',
    protocolVersion: '1.0',
    preferredTransport: 'JSON-RPC',
    skills: [{ id: 'hybrid', name: 'Hybrid', description: 'Hybrid skill.' }]
  };
  const result = validateAgentCard(hybrid);
  assert.equal(result.valid, true);
  assert.deepEqual(getInterfaces(hybrid), result.interfaces);
  assert.deepEqual(selectInterface(hybrid), result.selectedInterface);
});

test('rejects a 0.3 endpoint declared inside the 1.x supportedInterfaces shape', () => {
  const result = validateAgentCard({
    ...card,
    supportedInterfaces: [{
      url: 'https://example.com/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '0.3'
    }]
  });

  assert.equal(result.valid, false);
  assert.equal(result.schemaVersion, '1.x');
  assert.equal(result.selectedInterface, null);
  assert.match(result.errors.join('\n'), /protocolVersion/);
});

test('does not let a valid legacy URL bypass an invalid declared 1.x shape', () => {
  const result = validateAgentCard({
    ...card,
    url: 'https://example.com/legacy',
    protocolVersion: '0.3',
    preferredTransport: 'JSONRPC',
    supportedInterfaces: [{
      url: 'https://example.com/a2a',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: 1
    }]
  });

  assert.equal(result.valid, false);
  assert.equal(result.schemaVersion, '1.x');
  assert.match(result.errors.join('\n'), /supportedInterfaces\[0\]\.protocolVersion/);
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

  const patchVersion = buildA2ARequest(
    { url: 'https://example.com/a2a', binding: 'JSONRPC', version: '1.0.0' },
    'hello',
    { requestId: 'req-patch', messageId: 'msg-patch' }
  );
  assert.equal(patchVersion.headers['a2a-version'], '1.0');
});

test('serializes explicitly negotiated output modes for both A2A bindings', () => {
  const acceptedOutputModes = ['text/markdown', 'application/json'];
  const rpc = buildA2ARequest(
    { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '1.0' },
    'hello',
    { acceptedOutputModes }
  );
  const rest = buildA2ARequest(
    { url: 'https://example.com/a2a/v1', binding: 'HTTP+JSON', version: '1.0' },
    'hello',
    { acceptedOutputModes }
  );

  assert.deepEqual(rpc.body.params.configuration, { acceptedOutputModes });
  assert.deepEqual(rest.body.configuration, { acceptedOutputModes });
});

test('negotiates accepted output modes from Agent Card defaults', () => {
  assert.deepEqual(
    negotiateAcceptedOutputModes({
      defaultOutputModes: ['application/pdf', 'text/markdown', 'application/json', 'text/markdown']
    }),
    ['text/markdown', 'application/json']
  );
  assert.deepEqual(
    negotiateAcceptedOutputModes({}),
    ['text/plain', 'application/json']
  );
});

test('serializes normalized multipart input for A2A 1.x and keeps turn context', () => {
  const request = buildA2ARequest(
    { url: 'https://example.com/a2a/v1', binding: 'HTTP+JSON', version: '1.0' },
    {
      parts: [
        { type: 'text', text: 'continue', mediaType: 'text/plain' },
        { type: 'data', data: { holdings: ['000001.SZ'] }, filename: 'holdings.json' },
        { type: 'raw', raw: 'UERG', mediaType: 'application/pdf', filename: 'input.pdf' },
        { type: 'url', url: 'https://files.example/input.csv', mediaType: 'text/csv', filename: 'input.csv' }
      ]
    },
    {
      requestId: 'req-multipart-v1',
      messageId: 'msg-multipart-v1',
      contextId: 'ctx-1',
      taskId: 'task-1'
    }
  );

  assert.equal(request.body.message.contextId, 'ctx-1');
  assert.equal(request.body.message.taskId, 'task-1');
  assert.deepEqual(request.body.message.parts, [
    { text: 'continue', mediaType: 'text/plain' },
    { data: { holdings: ['000001.SZ'] }, filename: 'holdings.json' },
    { raw: 'UERG', mediaType: 'application/pdf', filename: 'input.pdf' },
    { url: 'https://files.example/input.csv', mediaType: 'text/csv', filename: 'input.csv' }
  ]);
});

test('serializes normalized multipart input for A2A 0.3 JSON-RPC', () => {
  const request = buildA2ARequest(
    { url: 'https://example.com/a2a', binding: 'JSONRPC', version: '0.3' },
    {
      parts: [
        { type: 'text', text: 'continue' },
        { type: 'data', data: { portfolio: 7 } },
        { type: 'raw', raw: 'UERG', mediaType: 'application/pdf', filename: 'input.pdf' },
        { type: 'url', url: 'https://files.example/input.csv', mediaType: 'text/csv', filename: 'input.csv' }
      ]
    },
    {
      requestId: 'req-multipart-v03',
      messageId: 'msg-multipart-v03',
      contextId: 'ctx-legacy',
      taskId: 'task-legacy'
    }
  );

  assert.equal(request.body.params.message.contextId, 'ctx-legacy');
  assert.equal(request.body.params.message.taskId, 'task-legacy');
  assert.deepEqual(request.body.params.message.parts, [
    { kind: 'text', text: 'continue' },
    { kind: 'data', data: { portfolio: 7 } },
    { kind: 'file', file: { bytes: 'UERG', mimeType: 'application/pdf', name: 'input.pdf' } },
    { kind: 'file', file: { uri: 'https://files.example/input.csv', mimeType: 'text/csv', name: 'input.csv' } }
  ]);
});

test('rejects invalid normalized raw bytes at the A2A serialization boundary', () => {
  assert.throws(
    () => buildA2ARequest(
      { url: 'https://example.com/a2a', binding: 'JSONRPC', version: '1.0' },
      { parts: [{ type: 'raw', raw: 'not-base64', mediaType: 'application/pdf' }] }
    ),
    /base64/i
  );
});

test('builds versioned GetTask requests for JSON-RPC and HTTP+JSON', () => {
  const modernRpc = buildGetTaskRequest(
    { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '1.0', tenant: 'desk-7' },
    { taskId: 'task/1', requestId: 'poll-1', historyLength: 50 }
  );
  assert.equal(modernRpc.body.method, 'GetTask');
  assert.deepEqual(modernRpc.body.params, { id: 'task/1', historyLength: 50, tenant: 'desk-7' });

  const legacyRpc = buildGetTaskRequest(
    { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '0.3' },
    { taskId: 'task-2', requestId: 'poll-2', historyLength: 50 }
  );
  assert.equal(legacyRpc.body.method, 'tasks/get');

  const rest = buildGetTaskRequest(
    { url: 'https://example.com/a2a/v1', binding: 'HTTP+JSON', version: '1.0' },
    { taskId: 'task/1', requestId: 'poll-3', historyLength: 50 }
  );
  assert.equal(rest.method, 'GET');
  assert.equal(rest.body, null);
  assert.equal(rest.url, 'https://example.com/a2a/v1/tasks/task%2F1?historyLength=50');

  const restWithQuery = buildGetTaskRequest(
    { url: 'https://example.com/a2a/v1?signature=keep', binding: 'HTTP+JSON', version: '1.0' },
    { taskId: 'task-2', requestId: 'poll-4', historyLength: 50 }
  );
  assert.equal(restWithQuery.url, 'https://example.com/a2a/v1/tasks/task-2?signature=keep&historyLength=50');

  assert.throws(
    () => buildGetTaskRequest(
      { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '1.0' },
      { taskId: '' }
    ),
    /taskId/i
  );
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
    () => parseA2AResponse(target, {
      jsonrpc: '2.0',
      id: 'req-1',
      result: { message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'ok' }] } },
      error: { code: -32602, message: 'both branches' }
    }, 'req-1'),
    /result|error|oneof/i
  );
  assert.throws(
    () => parseA2AResponse(target, {
      jsonrpc: '2.0',
      id: 'req-1',
      result: { message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'ok' }] } },
      error: null
    }, 'req-1'),
    /result|error|oneof/i
  );
  assert.throws(
    () => parseA2AResponse(target, {
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: 'bad', message: 7 }
    }, 'req-1'),
    /error/i
  );
  assert.throws(
    () => parseA2AResponse(target, { jsonrpc: '2.0', id: 'req-1', result: { message: {} } }, 'req-1'),
    /Message/
  );
  assert.throws(
    () => parseA2AResponse(target, { jsonrpc: '2.0', id: 'req-1', result: { task: { status: {} } } }, 'req-1'),
    /Task/
  );
  assert.throws(
    () => parseA2AResponse(target, {
      jsonrpc: '2.0',
      id: 1,
      result: {
        message: {
          messageId: 'numeric-id',
          role: 'ROLE_AGENT',
          parts: [{ text: 'must not match string id' }]
        }
      }
    }, '1'),
    /ID|id/i
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
  assert.throws(
    () => parseA2AResponse(target, {
      jsonrpc: '2.0',
      id: 'req-2',
      result: { messageId: 'reply-2', role: 'agent', parts: [{ kind: 'text', text: 'missing kind' }] }
    }, 'req-2'),
    /kind/i
  );
  assert.throws(
    () => parseA2AResponse(target, {
      jsonrpc: '2.0',
      id: 'req-3',
      result: { id: 'task-3', contextId: 'ctx-3', status: { state: 'completed' } }
    }, 'req-3'),
    /kind/i
  );
});

test('enforces version and binding-specific SendMessage response wrappers', () => {
  const v1Rpc = { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '1.0' };
  const v1Http = { url: 'https://example.com/a2a', binding: 'HTTP+JSON', version: '1.0' };
  const v03Http = { url: 'https://example.com/a2a', binding: 'HTTP+JSON', version: '0.3' };
  const messageV1 = {
    messageId: 'reply-1',
    role: 'ROLE_AGENT',
    parts: [{ text: 'ok' }]
  };
  const messageV03 = {
    kind: 'message',
    messageId: 'reply-legacy',
    role: 'agent',
    parts: [{ kind: 'text', text: 'ok' }]
  };

  assert.throws(
    () => parseA2AResponse(v1Rpc, { jsonrpc: '2.0', id: 'r', result: messageV1 }, 'r'),
    /wrapper|oneof/i
  );
  assert.throws(() => parseA2AResponse(v1Http, messageV1, 'r'), /wrapper|oneof/i);
  assert.throws(() => parseA2AResponse(v03Http, messageV03, 'r'), /wrapper|oneof/i);
  assert.equal(parseA2AResponse(v03Http, { message: messageV03 }, 'r').message, messageV03);
  assert.throws(
    () => parseA2AResponse(v1Http, { message: messageV1, task: {
      id: 'task-1',
      status: { state: 'TASK_STATE_COMPLETED' }
    } }, 'r'),
    /exactly one|oneof/i
  );
});

test('strictly validates Message, Part, Task, history, and artifact schemas', () => {
  const target = { url: 'https://example.com/a2a', binding: 'HTTP+JSON', version: '1.0' };
  const parseMessage = (message) => parseA2AResponse(target, { message }, 'r');
  const baseMessage = {
    messageId: 'reply-1',
    role: 'ROLE_AGENT',
    parts: [{ text: 'ok' }]
  };

  for (const message of [
    { ...baseMessage, messageId: '' },
    { ...baseMessage, role: 'agent' },
    { ...baseMessage, parts: [] },
    { ...baseMessage, parts: [{ text: 'ok', url: 'https://files.example/x' }] },
    { ...baseMessage, parts: [{ raw: 7 }] },
    { ...baseMessage, parts: [{ url: 7 }] }
  ]) {
    assert.throws(() => parseMessage(message), /Message|Part|role|oneof/i);
  }

  assert.throws(
    () => parseA2AResponse(target, { task: {
      id: 'task-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      history: [{ ...baseMessage, role: 'not-a-role' }]
    } }, 'r'),
    /history|role|Message/i
  );
  assert.throws(
    () => parseA2AResponse(target, { task: {
      id: 'task-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ artifactId: '', parts: [{ text: 'done' }] }]
    } }, 'r'),
    /artifact/i
  );

  assert.throws(
    () => parseA2AResponse(target, { task: {
      id: 'task-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ id: 'not-artifact-id', parts: [{ text: 'done' }] }]
    } }, 'r'),
    /artifactId|artifact id/i
  );

  for (const data of [null, true, 7, 'value', ['value'], { value: 7 }]) {
    assert.doesNotThrow(() => parseMessage({ ...baseMessage, parts: [{ data }] }));
  }
  for (const state of ['TASK_STATE_UNKNOWN', 'TASK_STATE_INTERRUPTED', 'TASK_STATE_CANCELLED']) {
    assert.throws(
      () => parseA2AResponse(target, { task: { id: 'task-1', status: { state } } }, 'r'),
      /state/i
    );
  }
});

test('enforces exact v1 enums and rejects every legacy discriminator while preserving 0.3', () => {
  const v1 = { url: 'https://example.com/a2a', binding: 'HTTP+JSON', version: '1.0' };
  const v03 = { url: 'https://example.com/a2a', binding: 'HTTP+JSON', version: '0.3' };
  const message = {
    messageId: 'message-1',
    role: 'ROLE_AGENT',
    parts: [{ text: 'ok' }]
  };

  assert.throws(
    () => parseA2AResponse(v1, { message: { ...message, kind: 'message' } }, 'unused'),
    /kind|legacy/i
  );
  assert.throws(
    () => parseA2AResponse(v1, {
      message: { ...message, parts: [{ kind: 'text', text: 'ok' }] }
    }, 'unused'),
    /kind|legacy|Part/i
  );
  for (const state of ['completed', 'COMPLETED', 'task_state_completed']) {
    assert.throws(
      () => parseA2AResponse(v1, {
        task: { id: 'task-1', status: { state } }
      }, 'unused'),
      /state/i
    );
  }
  assert.throws(
    () => parseA2AResponse(v1, {
      task: {
        kind: 'task',
        id: 'task-1',
        status: { state: 'TASK_STATE_COMPLETED' }
      }
    }, 'unused'),
    /kind|legacy/i
  );
  assert.throws(
    () => parseA2AStreamEvent(v1, {
      statusUpdate: {
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_COMPLETED' }
      }
    }, 'unused'),
    /kind|legacy/i
  );
  assert.throws(
    () => parseA2AStreamEvent(v1, {
      artifactUpdate: {
        kind: 'artifact-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'artifact-1', parts: [{ text: 'done' }] }
      }
    }, 'unused'),
    /kind|legacy/i
  );

  assert.doesNotThrow(() => parseA2AResponse(v03, {
    task: {
      kind: 'task',
      id: 'legacy-task',
      contextId: 'legacy-context',
      status: { state: 'completed' }
    }
  }, 'unused'));
});

test('binds GetTask responses to Task only and requires 0.3 task context', () => {
  const v1Rpc = { url: 'https://example.com/rpc', binding: 'JSONRPC', version: '1.0' };
  const task = {
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state: 'TASK_STATE_COMPLETED' }
  };
  assert.equal(
    parseA2AResponse(
      v1Rpc,
      { jsonrpc: '2.0', id: 'poll', result: task },
      'poll',
      { operation: 'get-task' }
    ),
    task
  );
  assert.throws(
    () => parseA2AResponse(v1Rpc, {
      jsonrpc: '2.0',
      id: 'poll',
      result: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'no' }] }
    }, 'poll', { operation: 'get-task' }),
    /GetTask|Task/i
  );
  assert.throws(
    () => parseA2AResponse(
      { ...v1Rpc, version: '0.3' },
      { jsonrpc: '2.0', id: 'poll', result: { kind: 'task', id: 'task-1', status: { state: 'completed' } } },
      'poll',
      { operation: 'get-task' }
    ),
    /contextId/i
  );
});

test('parses SSE frames and requires a terminal stream result', () => {
  const text = [
    ': heartbeat\r\n',
    'data: {"jsonrpc":"2.0","id":"req-1","result":{"task":{"id":"task-1","status":{"state":"TASK_STATE_WORKING"}}}}\r\n\r\n',
    'data: {"jsonrpc":"2.0","id":"req-1","result":{"statusUpdate":{"taskId":"task-1","contextId":"ctx-1",\r\n',
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
  const events = [
    {
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'working' }
      }
    },
    {
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        final: true,
        status: {
          state: 'completed',
          message: {
            kind: 'message',
            messageId: 'legacy-status',
            role: 'agent',
            parts: [{ kind: 'text', text: 'legacy done' }]
          }
        }
      }
    }
  ];
  const result = validateStreamResult({ binding: 'JSONRPC', version: '0.3' }, events, 'req-1');
  assert.equal(result.terminal, true);
  assert.match(result.text, /legacy done/);
  assert.throws(
    () => validateStreamResult(
      { binding: 'JSONRPC', version: '0.3' },
      [events[1]],
      'req-1'
    ),
    /before|Task/i
  );
});

test('allows exactly one final same-Task snapshot only for v1 HTTP streaming', () => {
  const target = { binding: 'HTTP+JSON', version: '1.0' };
  const initial = {
    task: {
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_WORKING' }
    }
  };
  const terminal = {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED' }
    }
  };
  const finalSnapshot = {
    task: {
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED' }
    }
  };
  assert.equal(
    validateStreamResult(target, [initial, terminal, finalSnapshot], 'unused').terminal,
    true
  );

  const invalid = [
    [initial, terminal, { task: { ...finalSnapshot.task, id: 'task-other' } }],
    [initial, terminal, { task: { ...finalSnapshot.task, contextId: 'ctx-other' } }],
    [initial, terminal, { task: {
      ...finalSnapshot.task,
      status: { state: 'TASK_STATE_WORKING' }
    } }],
    [initial, terminal, finalSnapshot, finalSnapshot],
    [initial, terminal, finalSnapshot, {
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'late', parts: [{ text: 'late' }] }
      }
    }]
  ];
  for (const events of invalid) {
    assert.throws(() => validateStreamResult(target, events, 'unused'), /terminal|Task|context|last/i);
  }

  const rpcTarget = { binding: 'JSONRPC', version: '1.0' };
  const envelope = (result) => ({ jsonrpc: '2.0', id: 'req', result });
  assert.throws(
    () => validateStreamResult(
      rpcTarget,
      [initial, terminal, finalSnapshot].map(envelope),
      'req'
    ),
    /terminal/i
  );

  const legacyTarget = { binding: 'HTTP+JSON', version: '0.3' };
  assert.throws(
    () => validateStreamResult(legacyTarget, [
      { task: {
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'working' }
      } },
      { statusUpdate: {
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        final: true,
        status: { state: 'completed' }
      } },
      { task: {
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'completed' }
      } }
    ], 'unused'),
    /terminal/i
  );
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
  assert.equal(extractAgentText({ message: { parts: [{ data: { answer: 42 } }] } }), '{"answer":42}');
  assert.equal(extractAgentText({ task: { id: 'task-1', status: { state: 'working' } } }), '');
});

test('enforces version-specific status and artifact update fields', () => {
  const v1 = { binding: 'JSONRPC', version: '1.0' };
  const v03 = { binding: 'JSONRPC', version: '0.3' };
  const envelope = (id, result) => ({ jsonrpc: '2.0', id, result });
  assert.doesNotThrow(() => parseA2AStreamEvent(v1, envelope('v1', {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED' }
    }
  }), 'v1'));
  assert.throws(() => parseA2AStreamEvent(v1, envelope('v1', {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      final: true,
      status: { state: 'TASK_STATE_COMPLETED' }
    }
  }), 'v1'), /final/i);
  assert.throws(() => parseA2AStreamEvent(v1, envelope('v1', {
    statusUpdate: {
      taskId: 'task-1',
      status: { state: 'TASK_STATE_COMPLETED' }
    }
  }), 'v1'), /contextId/i);
  assert.throws(() => parseA2AStreamEvent(v1, envelope('v1', {
    artifactUpdate: {
      taskId: 'task-1',
      artifact: { artifactId: 'artifact-1', parts: [{ text: 'output' }] }
    }
  }), 'v1'), /contextId/i);

  const legacyStatus = {
    kind: 'status-update',
    taskId: 'task-1',
    contextId: 'ctx-1',
    final: true,
    status: { state: 'completed' }
  };
  assert.doesNotThrow(() => parseA2AStreamEvent(v03, envelope('v03', legacyStatus), 'v03'));
  assert.throws(
    () => parseA2AStreamEvent(v03, envelope('v03', { ...legacyStatus, contextId: undefined }), 'v03'),
    /contextId/i
  );
  assert.throws(
    () => parseA2AStreamEvent(v03, envelope('v03', { ...legacyStatus, final: undefined }), 'v03'),
    /final/i
  );
  assert.throws(() => parseA2AStreamEvent(v03, envelope('v03', {
    kind: 'artifact-update',
    taskId: 'task-1',
    artifact: { artifactId: 'artifact-1', parts: [{ kind: 'text', text: 'output' }] }
  }), 'v03'), /contextId/i);
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
