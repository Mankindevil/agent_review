import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeA2AExample,
  executeA2ATurn,
  normalizeA2AResult,
  snapshotUrlParts
} from '../src/a2a-executor.js';

const rpcCard = {
  name: 'Executor Agent',
  description: 'Exercises the A2A executor.',
  supportedInterfaces: [{
    url: 'https://agent.example/a2a',
    protocolBinding: 'JSONRPC',
    protocolVersion: '1.0'
  }],
  capabilities: { streaming: true },
  skills: [{ id: 'run', name: 'Run', description: 'Run a workflow.' }]
};

test('captures a blocking Message with stable hashes, timing, and no authorization evidence', async () => {
  let observedAuthorization;
  const request = async (_url, options) => {
    observedAuthorization = options.headers.authorization;
    const body = JSON.parse(options.body);
    options.onHeaders({ status: 200, headers: { 'content-type': 'application/json' }, at: 1_010 });
    options.onChunk({ bytes: Buffer.from('response'), at: 1_020, first: true });
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        message: {
          messageId: 'reply-1',
          contextId: 'ctx-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'completed' }]
        }
      }
    });
  };

  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    timeoutMs: 5_000,
    authorization: 'top-secret-token',
    testId: 'example-1',
    turnIndex: 0,
    repeatIndex: 2,
    request,
    clock: sequenceClock([1_000, 1_030])
  });

  assert.equal(observedAuthorization, 'Bearer top-secret-token');
  assert.equal(run.outcome.status, 'succeeded');
  assert.equal(run.response.normalized.responseKind, 'message');
  assert.equal(run.response.normalized.contextId, 'ctx-1');
  assert.equal(run.response.normalized.text, 'completed');
  assert.equal(run.timing.firstByteMs, 20);
  assert.match(run.request.bodyHash, /^[a-f0-9]{64}$/);
  assert.match(run.response.rawHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(run), /top-secret-token|authorization/i);
});

test('redacts an authorization secret even when a remote Agent echoes it', async () => {
  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    authorization: 'echoed-secret',
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          message: {
            messageId: 'reply-secret',
            role: 'ROLE_AGENT',
            parts: [{ text: 'echoed-secret' }]
          }
        }
      });
    }
  });

  assert.equal(run.outcome.status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(run), /echoed-secret/);
  assert.match(JSON.stringify(run), /\[REDACTED\]/);
});

test('redacts the token portion when authorization already includes the Bearer scheme', async () => {
  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    authorization: 'Bearer prefixed-secret',
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          message: {
            messageId: 'reply-prefixed-secret',
            role: 'ROLE_AGENT',
            parts: [{ text: 'prefixed-secret' }]
          }
        }
      });
    }
  });

  assert.doesNotMatch(JSON.stringify(run), /prefixed-secret/);
});

test('rejects unsafe authorization before transport and scrubs encoded and escaped echoes', async () => {
  for (const authorization of ['', 'ab', 'abc\u0007']) {
    let called = false;
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'run' }] },
      authorization,
      request: async () => {
        called = true;
        throw new Error('transport should not run');
      }
    });
    assert.equal(called, false);
    assert.equal(run.outcome.status, 'platform-error');
    assert.equal(run.error.category, 'configuration');
  }

  const token = 'a/b';
  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    authorization: token,
    request: async () => {
      throw new Error(
        `echo Bearer ${token} ${encodeURIComponent(token)} a%2fb a\\/b https://files.example/${token}?sig=${encodeURIComponent(token)}`
      );
    }
  });
  const serialized = JSON.stringify(run);
  assert.doesNotMatch(serialized, /a\/b|a%2fb|a\\\/b|Bearer a\/b/iu);
  assert.match(serialized, /\[REDACTED\]/);
});

test('scrubs credential encodings and JSON-escaped credentials from metadata keys and values', async () => {
  const token = 'q"\\x/9';
  const encoded = [
    JSON.stringify(token).slice(1, -1),
    Buffer.from(token).toString('base64'),
    Buffer.from(token).toString('base64url'),
    Buffer.from(token).toString('hex')
  ];
  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    authorization: token,
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          message: {
            messageId: 'reply-encoded',
            role: 'ROLE_AGENT',
            parts: [{ data: Object.fromEntries(encoded.map((value) => [value, token])) }]
          }
        }
      });
    }
  });
  const serialized = JSON.stringify(run);
  for (const value of encoded) assert.equal(serialized.includes(value), false);
  assert.doesNotMatch(serialized, /q"\\x\/9/);
});

test('polls a non-terminal Task on the locked schedule within one wall-clock deadline', async () => {
  const delays = [];
  const timeouts = [];
  const methods = [];
  let now = 10_000;
  let pollCount = 0;
  const request = async (_url, options) => {
    timeouts.push(options.timeoutMs);
    const body = JSON.parse(options.body);
    methods.push(body.method);
    if (body.method === 'SendMessage') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } } }
      });
    }
    pollCount += 1;
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: pollCount === 3 ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' },
        history: [{ messageId: `history-${pollCount}`, role: 'ROLE_AGENT', parts: [{ text: `step ${pollCount}` }] }],
        artifacts: pollCount === 3 ? [{ artifactId: 'artifact-1', parts: [{ text: 'done' }] }] : []
      }
    });
  };

  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'long run' }] },
    timeoutMs: 5_000,
    request,
    clock: () => now,
    sleep: async (delay) => {
      delays.push(delay);
      now += delay;
    }
  });

  assert.deepEqual(delays, [250, 500, 1_000]);
  assert.deepEqual(methods, ['SendMessage', 'GetTask', 'GetTask', 'GetTask']);
  assert.deepEqual(timeouts, [5_000, 4_750, 4_250, 3_250]);
  assert.deepEqual(run.response.normalized.statusSequence, [
    'TASK_STATE_WORKING',
    'TASK_STATE_WORKING',
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED'
  ]);
  assert.equal(run.response.normalized.terminalState, 'TASK_STATE_COMPLETED');
  assert.equal(run.response.normalized.text.includes('done'), true);
  assert.equal(run.outcome.status, 'succeeded');
});

test('parses SSE by arriving chunk and records the real first complete event time', async () => {
  const first = 'data: {"jsonrpc":"2.0","id":"stream-req","result":{"task":{"id":"task-1","contextId":"ctx-1","status":{"state":"TASK_STATE_WORK';
  const second = 'ING"}}}}\n\n';
  const third = 'data: {"jsonrpc":"2.0","id":"stream-req","result":{"statusUpdate":{"taskId":"task-1","contextId":"ctx-1","status":{"state":"TASK_STATE_COMPLETED","message":{"messageId":"status-1","role":"ROLE_AGENT","parts":[{"text":"stream done"}]}}}}}\n\n';
  const request = async (_url, options) => {
    options.onHeaders({ status: 200, headers: { 'content-type': 'text/event-stream' }, at: 2_005 });
    options.onChunk({ bytes: Buffer.from(first), at: 2_010, first: true });
    options.onChunk({ bytes: Buffer.from(second), at: 2_025, first: false });
    options.onChunk({ bytes: Buffer.from(third), at: 2_050, first: false });
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Buffer.from(first + second + third)
    };
  };

  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'stream' }] },
    streaming: true,
    timeoutMs: 5_000,
    request,
    requestId: 'stream-req',
    clock: sequenceClock([2_000, 2_060])
  });

  assert.equal(run.response.rawObjects.length, 2);
  assert.equal(run.timing.firstByteAt, 2_010);
  assert.equal(run.timing.firstEventAt, 2_025);
  assert.equal(run.timing.firstEventMs, 25);
  assert.deepEqual(run.response.normalized.statusSequence, [
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED'
  ]);
  assert.equal(run.outcome.status, 'succeeded');
});

test('rejects a stream Message as terminal when the same stream started a Task lifecycle', async () => {
  const body = [
    'data: {"jsonrpc":"2.0","id":"mixed-stream","result":{"task":{"id":"task-1","status":{"state":"TASK_STATE_WORKING"}}}}\n\n',
    'data: {"jsonrpc":"2.0","id":"mixed-stream","result":{"message":{"messageId":"reply-1","role":"ROLE_AGENT","parts":[{"text":"not a Task terminal"}]}}}\n\n'
  ].join('');
  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'stream' }] },
    streaming: true,
    requestId: 'mixed-stream',
    request: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Buffer.from(body)
    })
  });

  assert.equal(run.outcome.status, 'agent-error');
  assert.equal(run.error.category, 'protocol');
  assert.equal(run.timing.firstByteAt, null);
  assert.equal(run.timing.firstEventAt, null);
});

test('rejects a malformed terminal Task inside a valid SSE envelope', async () => {
  const body = 'data: {"jsonrpc":"2.0","id":"malformed-stream","result":{"task":{"status":{"state":"TASK_STATE_COMPLETED"}}}}\n\n';
  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'stream' }] },
    streaming: true,
    requestId: 'malformed-stream',
    request: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Buffer.from(body)
    })
  });

  assert.equal(run.outcome.status, 'agent-error');
  assert.equal(run.error.category, 'protocol');
});

test('enforces the streaming Message-or-Task lifecycle state machine', async () => {
  const task = {
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
  const invalidStreams = [
    [{ statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } } }],
    [task, task],
    [{ ...task, message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'mixed' }] } }],
    [{ message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'done' }] } }, terminal],
    [task, { statusUpdate: { ...terminal.statusUpdate, taskId: 'task-2' } }],
    [task, terminal, { artifactUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      artifact: { artifactId: 'a', parts: [{ text: 'late' }] }
    } }],
    [task, { statusUpdate: { contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } } }]
  ];

  for (const [index, events] of invalidStreams.entries()) {
    const requestId = `invalid-stream-${index}`;
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'stream' }] },
      streaming: true,
      requestId,
      request: async () => eventStreamResponse(requestId, events)
    });
    assert.equal(run.outcome.status, 'agent-error', `case ${index}`);
    assert.equal(run.error.category, 'protocol', `case ${index}`);
  }

  const requestId = 'single-message-stream';
  const messageRun = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'stream' }] },
    streaming: true,
    requestId,
    request: async () => eventStreamResponse(requestId, [{
      message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'done' }] }
    }])
  });
  assert.equal(messageRun.outcome.status, 'succeeded');

  const noContextId = 'terminal-task-without-context';
  const noContextRun = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'stream' }] },
    streaming: true,
    requestId: noContextId,
    request: async () => eventStreamResponse(noContextId, [{
      task: { id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } }
    }])
  });
  assert.equal(noContextRun.outcome.status, 'succeeded');
  assert.equal(noContextRun.response.normalized.contextId, null);
});

test('locks GetTask polling to the initial Task and context identity', async () => {
  const invalidPollResults = [
    { id: 'task-other', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } },
    { id: 'task-1', contextId: 'ctx-other', status: { state: 'TASK_STATE_COMPLETED' } },
    { messageId: 'message-instead', role: 'ROLE_AGENT', parts: [{ text: 'wrong operation' }] }
  ];

  for (const pollResult of invalidPollResults) {
    let call = 0;
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'poll' }] },
      sleep: async () => {},
      request: async (_url, options) => {
        const body = JSON.parse(options.body);
        call += 1;
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: call === 1
            ? { task: {
              id: 'task-1',
              contextId: 'ctx-1',
              status: { state: 'TASK_STATE_WORKING' }
            } }
            : pollResult
        });
      }
    });
    assert.equal(run.outcome.status, 'agent-error');
    assert.equal(run.error.category, 'protocol');
  }
});

test('classifies transport, protocol, and terminal Agent failures without leaking authorization', async () => {
  const transport = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    authorization: 'do-not-leak',
    request: async () => { throw Object.assign(new Error('socket failed do-not-leak'), { code: 'connection' }); }
  });
  assert.equal(transport.outcome.status, 'platform-error');
  assert.equal(transport.error.category, 'transport');
  assert.doesNotMatch(JSON.stringify(transport), /do-not-leak/);

  const protocol = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    request: async () => jsonResponse({ invalid: true })
  });
  assert.equal(protocol.outcome.status, 'agent-error');
  assert.equal(protocol.error.category, 'protocol');

  const failed = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { task: { id: 'task-failed', status: { state: 'TASK_STATE_FAILED' } } }
      });
    }
  });
  assert.equal(failed.outcome.status, 'agent-error');
  assert.equal(failed.error.category, 'agent');
});

test('uses the documented failure taxonomy with public code and status fields', async () => {
  const cases = [
    {
      request: async () => jsonResponse({ unavailable: true }, 503),
      category: 'http',
      status: 503,
      outcome: 'agent-error'
    },
    {
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('not json')
      }),
      category: 'content-type',
      status: null,
      outcome: 'agent-error'
    },
    {
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{')
      }),
      category: 'json',
      status: null,
      outcome: 'agent-error'
    }
  ];
  for (const item of cases) {
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'run' }] },
      request: item.request
    });
    assert.equal(run.outcome.status, item.outcome);
    assert.equal(run.error.category, item.category);
    assert.equal(run.error.status, item.status);
    assert.equal(typeof run.error.code, 'string');
  }

  let called = false;
  const configuration = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [] },
    request: async () => {
      called = true;
      return jsonResponse({});
    }
  });
  assert.equal(called, false);
  assert.equal(configuration.outcome.status, 'platform-error');
  assert.equal(configuration.error.category, 'configuration');

  const rpcError = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    authorization: 'rpc-secret',
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32602, message: 'bad rpc-secret' }
      });
    }
  });
  assert.equal(rpcError.outcome.status, 'agent-error');
  assert.equal(rpcError.error.category, 'protocol');
  assert.equal(rpcError.error.code, 'jsonrpc-error');
  assert.equal(rpcError.error.protocolCode, -32602);
  assert.doesNotMatch(JSON.stringify(rpcError), /rpc-secret/);
});

test('classifies input and authorization requirements as interrupted continuations', async () => {
  for (const state of ['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']) {
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'run' }] },
      request: async (_url, options) => {
        const body = JSON.parse(options.body);
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            task: {
              id: `task-${state}`,
              contextId: 'ctx-interrupted',
              status: { state }
            }
          }
        });
      }
    });
    assert.equal(run.outcome.status, 'succeeded');
    assert.equal(run.outcome.lifecycle, 'interrupted');
    assert.equal(run.error, null);
  }
});

test('rejects kind-only Message and Task objects as malformed protocol output', async () => {
  for (const result of [
    { kind: 'message' },
    { kind: 'task', status: { state: 'TASK_STATE_COMPLETED' } }
  ]) {
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'run' }] },
      request: async (_url, options) => {
        const body = JSON.parse(options.body);
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result });
      }
    });
    assert.equal(run.outcome.status, 'agent-error');
    assert.equal(run.error.category, 'protocol');
  }
});

test('stops before transport for an already-aborted signal and classifies deadline exhaustion', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const cancelled = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    signal: controller.signal,
    request: async () => {
      calls += 1;
      return jsonResponse({});
    }
  });
  assert.equal(calls, 0);
  assert.equal(cancelled.outcome.status, 'platform-error');
  assert.equal(cancelled.error.category, 'signal');

  const timedOut = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    timeoutMs: 500,
    clock: sequenceClock([1_000, 1_500, 1_500]),
    request: async () => {
      throw new Error('must not reach transport');
    }
  });
  assert.equal(timedOut.outcome.status, 'platform-error');
  assert.equal(timedOut.error.category, 'timeout');
});

test('normalizes messages, Task history, artifacts, Parts, and context without inventing it', () => {
  const normalized = normalizeA2AResult(
    { binding: 'HTTP+JSON', version: '1.0' },
    [{
      task: {
        id: 'task-1',
        status: { state: 'TASK_STATE_COMPLETED' },
        history: [{ messageId: 'history-1', role: 'ROLE_AGENT', parts: [{ data: { answer: 42 } }] }],
        artifacts: [{ artifactId: 'artifact-1', parts: [{ url: 'https://files.example/report.csv' }] }]
      }
    }]
  );
  assert.equal(normalized.contextId, null);
  assert.equal(normalized.taskId, 'task-1');
  assert.equal(normalized.history.length, 1);
  assert.equal(normalized.artifacts.length, 1);
  assert.equal(normalized.parts.length, 2);

  const legacyInterrupted = normalizeA2AResult(
    { binding: 'JSONRPC', version: '0.3' },
    [{
      jsonrpc: '2.0',
      id: 'legacy',
      result: { kind: 'task', id: 'legacy-task', status: { state: 'input-required' } }
    }]
  );
  assert.equal(legacyInterrupted.terminal, true);
  assert.equal(legacyInterrupted.terminalState, 'input-required');
});

test('does not duplicate cumulative Task snapshots during normalization', () => {
  const snapshots = [1, 2, 3].map((index) => ({
    jsonrpc: '2.0',
    id: `poll-${index}`,
    result: index === 1
      ? { task: {
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_WORKING' },
        history: [{ messageId: 'history-1', role: 'ROLE_AGENT', parts: [{ text: 'same history' }] }],
        artifacts: [{ artifactId: 'artifact-1', parts: [{ text: 'same artifact' }] }]
      } }
      : {
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: index === 3 ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' },
        history: [{ messageId: 'history-1', role: 'ROLE_AGENT', parts: [{ text: 'same history' }] }],
        artifacts: [{ artifactId: 'artifact-1', parts: [{ text: 'same artifact' }] }]
      }
  }));
  const normalized = normalizeA2AResult(
    { binding: 'JSONRPC', version: '1.0' },
    snapshots
  );
  assert.equal(normalized.history.length, 1);
  assert.equal(normalized.artifacts.length, 1);
  assert.equal(normalized.parts.length, 2);
  assert.equal(normalized.text, 'same history\nsame artifact');
});

test('assembles streamed artifact append chunks and preserves their timeline', () => {
  const normalized = normalizeA2AResult(
    { binding: 'HTTP+JSON', version: '1.0' },
    [
      { task: {
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_WORKING' }
      } },
      { artifactUpdate: {
        taskId: 'task-1',
        artifact: { artifactId: 'artifact-1', parts: [{ text: 'chunk one' }] },
        append: false,
        lastChunk: false
      } },
      { artifactUpdate: {
        taskId: 'task-1',
        artifact: { artifactId: 'artifact-1', parts: [{ text: 'chunk two' }] },
        append: true,
        lastChunk: true
      } },
      { statusUpdate: {
        taskId: 'task-1',
        status: { state: 'TASK_STATE_COMPLETED' }
      } }
    ]
  );
  assert.deepEqual(normalized.artifacts[0].parts, [{ text: 'chunk one' }, { text: 'chunk two' }]);
  assert.deepEqual(normalized.artifactTimeline, [
    { artifactId: 'artifact-1', append: false, lastChunk: false, partCount: 1 },
    { artifactId: 'artifact-1', append: true, lastChunk: true, partCount: 1 }
  ]);
  assert.equal(normalized.text, 'chunk one\nchunk two');
});

test('reuses task IDs only for interrupted continuations and checks adjacent contexts', async () => {
  const calls = [];
  const result = await executeA2AExample({
    card: rpcCard,
    example: {
      id: 'multi-turn',
      turns: [
        { input: { parts: [{ type: 'text', text: 'first' }] } },
        { input: { parts: [{ type: 'text', text: 'second' }] } },
        { input: { parts: [{ type: 'text', text: 'third' }] } }
      ]
    },
    repeatIndex: 3,
    policy: { timeoutMs: 4_000 },
    executeTurn: async (options) => {
      calls.push(options);
      return {
        outcome: {
          status: 'succeeded',
          lifecycle: calls.length === 1 ? 'interrupted' : 'completed'
        },
        response: {
          normalized: { contextId: 'ctx-returned', taskId: 'task-returned' }
        }
      };
    }
  });

  assert.equal(calls[0].contextId, undefined);
  assert.equal(calls[0].taskId, undefined);
  assert.equal(calls[1].contextId, 'ctx-returned');
  assert.equal(calls[1].taskId, 'task-returned');
  assert.equal(calls[2].contextId, 'ctx-returned');
  assert.equal(calls[2].taskId, undefined);
  assert.equal(result.contextCheck.status, 'passed');

  const unavailable = await executeA2AExample({
    card: rpcCard,
    example: { id: 'one-turn', turns: [{ input: { parts: [{ type: 'text', text: 'only' }] } }] },
    repeatIndex: 4,
    executeTurn: async () => ({
      outcome: { status: 'succeeded' },
      response: { normalized: { contextId: null, taskId: null, messages: [{ messageId: 'not-context' }] } }
    })
  });
  assert.equal(unavailable.contextCheck.status, 'unavailable');

  const lateContext = await executeA2AExample({
    card: rpcCard,
    example: {
      id: 'late-context',
      turns: [
        { input: { parts: [{ type: 'text', text: 'one' }] } },
        { input: { parts: [{ type: 'text', text: 'two' }] } },
        { input: { parts: [{ type: 'text', text: 'three' }] } }
      ]
    },
    executeTurn: async ({ turnIndex }) => ({
      outcome: { status: 'succeeded', lifecycle: 'completed' },
      response: { normalized: {
        contextId: turnIndex === 0 ? null : 'ctx-late',
        taskId: `task-${turnIndex}`
      } }
    })
  });
  assert.equal(lateContext.contextCheck.status, 'unavailable');

  const mismatched = await executeA2AExample({
    card: rpcCard,
    example: {
      id: 'mismatched-context',
      turns: [
        { input: { parts: [{ type: 'text', text: 'one' }] } },
        { input: { parts: [{ type: 'text', text: 'two' }] } }
      ]
    },
    executeTurn: async ({ turnIndex }) => ({
      outcome: { status: 'succeeded', lifecycle: 'completed' },
      response: { normalized: {
        contextId: turnIndex === 0 ? 'ctx-expected' : 'ctx-other',
        taskId: `task-${turnIndex}`
      } }
    })
  });
  assert.equal(mismatched.contextCheck.status, 'failed');
});

test('snapshots URL Parts only through an injected persistence boundary and never returns bytes', async () => {
  const calls = [];
  const persisted = [];
  const snapshots = await snapshotUrlParts([
    { url: 'https://files.example/report.csv?signature=unrelated', mediaType: 'text/csv' },
    { url: 'https://files.example/report.csv?signature=unrelated', mediaType: 'text/csv' },
    { text: '<a href="https://evil.example/hidden">hidden</a>' }
  ], {
    authorization: 'a/b',
    request: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 200,
        headers: { 'content-type': 'text/csv' },
        body: Buffer.from('snapshot secret bytes')
      };
    },
    persistSnapshot: async (snapshot) => {
      persisted.push(snapshot);
      return { evidenceId: 'evidence-snapshot-1' };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeoutMs, 10_000);
  assert.equal(calls[0].options.maxBytes, 1024 * 1024);
  assert.equal(Object.hasOwn(calls[0].options.headers || {}, 'authorization'), false);
  assert.equal(snapshots[0].sourceUrl, 'https://files.example/report.csv');
  assert.equal(snapshots[0].size, 21);
  assert.equal(snapshots[0].evidenceRef, 'evidence-snapshot-1');
  assert.equal(Object.hasOwn(snapshots[0], 'bytes'), false);
  assert.doesNotMatch(JSON.stringify(snapshots), /snapshot secret bytes|c25hcHNob3Qgc2VjcmV0IGJ5dGVz|signature/iu);
  assert.deepEqual(persisted[0].bytes, Buffer.from('snapshot secret bytes'));
  assert.match(snapshots[0].sha256, /^[a-f0-9]{64}$/);
});

test('captures agent-delivered URL Parts during turn execution but ignores user history URLs', async () => {
  let snapshotCalls = 0;
  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          message: {
            messageId: 'reply-url',
            role: 'ROLE_AGENT',
            parts: [{ url: 'https://files.example/report.csv?signature=unrelated' }]
          }
        }
      });
    },
    snapshotRequest: async () => {
      snapshotCalls += 1;
      return {
        status: 200,
        headers: { 'content-type': 'text/csv' },
        body: Buffer.from('a,b\n1,2')
      };
    },
    persistSnapshot: async () => ({ evidenceId: 'evidence-turn-snapshot' })
  });
  assert.equal(run.outcome.status, 'succeeded');
  assert.equal(snapshotCalls, 1);
  assert.equal(run.response.snapshots[0].evidenceRef, 'evidence-turn-snapshot');
  assert.equal(Object.hasOwn(run.response.snapshots[0], 'bytes'), false);

  const userHistory = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          task: {
            id: 'task-user-url',
            contextId: 'ctx-user-url',
            status: { state: 'TASK_STATE_COMPLETED' },
            history: [{
              messageId: 'user-history',
              role: 'ROLE_USER',
              parts: [{ url: 'https://files.example/user-input.csv' }]
            }]
          }
        }
      });
    },
    snapshotRequest: async () => {
      snapshotCalls += 1;
      throw new Error('user URL must not be snapshotted');
    }
  });
  assert.equal(userHistory.outcome.status, 'succeeded');
  assert.deepEqual(userHistory.response.snapshots, []);
  assert.equal(snapshotCalls, 1);
});

test('rejects a URL Part containing a submission credential before snapshot transport', async () => {
  let calls = 0;
  await assert.rejects(
    snapshotUrlParts([{ url: 'https://files.example/a%2Fb/report.csv?sig=a%2fb' }], {
      authorization: 'a/b',
      persistSnapshot: async () => ({ evidenceId: 'unused' }),
      request: async () => {
        calls += 1;
        return { status: 200, headers: {}, body: Buffer.from('private') };
      }
    }),
    /credential|authorization|secret/i
  );
  assert.equal(calls, 0);
});

test('does not fetch a URL Part when snapshot persistence is unavailable', async () => {
  let calls = 0;
  await assert.rejects(
    snapshotUrlParts([{ url: 'https://files.example/report.csv' }], {
      request: async () => {
        calls += 1;
        return { status: 200, headers: {}, body: Buffer.from('private') };
      }
    }),
    /persistence/i
  );
  assert.equal(calls, 0);
});

test('bounds URL Part snapshot count, aggregate bytes, and total batch time', async () => {
  let calls = 0;
  const tooMany = Array.from(
    { length: 17 },
    (_, index) => ({ url: `https://files.example/${index}.csv` })
  );
  await assert.rejects(
    snapshotUrlParts(tooMany, {
      persistSnapshot: async () => ({ evidenceId: 'unused' }),
      request: async () => {
        calls += 1;
        return { status: 200, headers: {}, body: Buffer.from('unused') };
      }
    }),
    (error) => error.category === 'agent' && error.outcome === 'agent-error'
  );
  assert.equal(calls, 0);

  let persisted = 0;
  await assert.rejects(
    snapshotUrlParts(
      Array.from({ length: 5 }, (_, index) => ({ url: `https://files.example/large-${index}.bin` })),
      {
        persistSnapshot: async () => ({ evidenceId: `evidence-${persisted += 1}` }),
        request: async () => ({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.alloc(900 * 1024)
        })
      }
    ),
    (error) => error.category === 'agent' && error.code === 'response-too-large'
  );
  assert.equal(persisted, 4);

  const times = [0, 30_001];
  await assert.rejects(
    snapshotUrlParts([{ url: 'https://files.example/deadline.csv' }], {
      clock: () => times.shift() ?? 30_001,
      persistSnapshot: async () => ({ evidenceId: 'unused' }),
      request: async () => {
        throw new Error('must not start after batch deadline');
      }
    }),
    (error) => error.category === 'timeout' && error.outcome === 'platform-error'
  );
});

test('validates URL Parts before invoking an injected snapshot transport', async () => {
  let calls = 0;
  await assert.rejects(
    snapshotUrlParts([{ url: 'file:///private/report.csv' }], {
      persistSnapshot: async () => ({ evidenceId: 'unused' }),
      request: async () => {
        calls += 1;
        return { status: 200, headers: {}, body: Buffer.from('private') };
      }
    }),
    /HTTP|URL/
  );
  assert.equal(calls, 0);
});

test('ignores mixed or non-protocol URL-like Part shapes', async () => {
  let calls = 0;
  const snapshots = await snapshotUrlParts([
    { url: 'https://files.example/mixed-v1', text: 'not a valid oneof' },
    { kind: 'file', file: { uri: 'https://files.example/mixed-v03', bytes: 'UERG' } },
    { type: 'url', url: 'https://files.example/internal-normalized-shape' }
  ], {
    request: async () => {
      calls += 1;
      return { status: 200, headers: {}, body: Buffer.from('unused') };
    }
  });
  assert.deepEqual(snapshots, []);
  assert.equal(calls, 0);
});

function jsonResponse(payload, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  };
}

function eventStreamResponse(requestId, events) {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Buffer.from(events.map((result) => (
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: requestId, result })}\n\n`
    )).join(''))
  };
}

function sequenceClock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
