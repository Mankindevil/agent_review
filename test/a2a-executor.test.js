import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeA2AExample,
  executeA2AProtocolRecoveryProbe,
  executeA2ATurn,
  normalizeA2AResult,
  snapshotUrlParts,
  validateAgentAuthorization
} from '../src/a2a-executor.js';

test('exports the shared Agent authorization validation boundary', () => {
  assert.equal(validateAgentAuthorization(undefined), undefined);
  assert.equal(validateAgentAuthorization('abc'), 'abc');
  assert.equal(validateAgentAuthorization('Bearer abc'), 'Bearer abc');
  for (const value of ['', ' abcd', 'abc def', 'a\u0000bc']) {
    assert.throws(() => validateAgentAuthorization(value), /authorization/i);
  }
});

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
const streamingHttpCard = {
  ...rpcCard,
  supportedInterfaces: [{
    url: 'https://agent.example/a2a',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }]
};

test('sends one bounded malformed request before a valid request with fresh context', async () => {
  const bodies = [];
  const run = await executeA2AProtocolRecoveryProbe({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'recover now' }] },
    timeoutMs: 5_000,
    runId: 'run_recovery',
    testId: 'protocol_error_recovery',
    turnIndex: 0,
    repeatIndex: 0,
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: 'Invalid params' }
        });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          message: {
            messageId: 'reply-recovery',
            contextId: 'ctx-fresh',
            role: 'ROLE_AGENT',
            parts: [{ text: 'recovered' }]
          }
        }
      });
    }
  });

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].params, {});
  assert.equal(bodies[1].params.message.contextId, undefined);
  assert.equal(bodies[1].params.message.taskId, undefined);
  assert.equal(run.protocolRecovery.malformedRejected, true);
  assert.equal(run.protocolRecovery.validRequestUsedFreshContext, true);
  assert.equal(run.outcome.status, 'succeeded');
});

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
  assert.equal(run.protocol.validated, true);
  assert.equal(run.response.normalized.responseKind, 'message');
  assert.equal(run.response.normalized.contextId, 'ctx-1');
  assert.equal(run.response.normalized.text, 'completed');
  assert.equal(run.timing.firstByteMs, 20);
  assert.match(run.request.bodyHash, /^[a-f0-9]{64}$/);
  assert.match(run.response.rawHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(run), /top-secret-token|authorization/i);
});

test('locks a caller-supplied run ID and exposes only current direct Message output', async () => {
  const run = await executeA2ATurn({
    card: rpcCard,
    runId: 'run_locked',
    requestId: 'request_locked',
    messageId: 'message_locked',
    input: { parts: [{ type: 'text', text: 'user input must not return' }] },
    testId: 'test_locked',
    turnIndex: 1,
    repeatIndex: 2,
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          message: {
            messageId: 'reply-current',
            role: 'ROLE_AGENT',
            parts: [
              { text: '{"looks":"json"}' },
              { data: { current: true } }
            ]
          }
        }
      });
    }
  });
  assert.equal(run.runId, 'run_locked');
  assert.equal(run.request.requestId, 'request_locked');
  assert.equal(run.request.messageId, 'message_locked');
  assert.equal(run.request.body.params.message.messageId, 'message_locked');
  assert.deepEqual(run.response.currentOutput, {
    text: '{"looks":"json"}',
    data: { current: true },
    artifacts: []
  });
});

test('exposes only final Task artifacts as current output', async () => {
  const run = await executeA2ATurn({
    card: rpcCard,
    runId: 'run_task_output',
    input: { parts: [{ type: 'text', text: 'user input must not return' }] },
    testId: 'test_task_output',
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          task: {
            id: 'task-output',
            contextId: 'ctx-output',
            status: {
              state: 'TASK_STATE_COMPLETED',
              message: {
                messageId: 'status-output',
                role: 'ROLE_AGENT',
                parts: [{ text: 'status text must not return' }]
              }
            },
            history: [{
              messageId: 'old-history',
              role: 'ROLE_AGENT',
              parts: [{ text: 'old history must not return' }]
            }],
            artifacts: [
              {
                artifactId: 'artifact-1',
                parts: [
                  { text: '{"still":"text"}' },
                  { data: { current: true } }
                ]
              },
              {
                artifactId: 'artifact-2',
                parts: [{ text: 'second artifact' }]
              }
            ]
          }
        }
      });
    }
  });

  assert.deepEqual(run.response.currentOutput, {
    text: '{"still":"text"}\nsecond artifact',
    data: { current: true },
    artifacts: run.response.normalized.artifacts
  });
  assert.doesNotMatch(
    JSON.stringify(run.response.currentOutput),
    /old history|status text|user input/u
  );
});

test('does not inherit a working Task draft artifact when the final polled Task omits artifacts', async () => {
  let calls = 0;
  const run = await executeA2ATurn({
    card: rpcCard,
    runId: 'run_final_task_artifacts',
    input: { parts: [{ type: 'text', text: 'run' }] },
    testId: 'test_final_task_artifacts',
    sleep: async () => {},
    request: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      if (calls === 1) {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            task: {
              id: 'task-final-artifacts',
              contextId: 'ctx-final-artifacts',
              status: { state: 'TASK_STATE_WORKING' },
              artifacts: [{
                artifactId: 'draft-artifact',
                parts: [{ text: 'draft must not be accepted' }]
              }]
            }
          }
        });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          id: 'task-final-artifacts',
          contextId: 'ctx-final-artifacts',
          status: { state: 'TASK_STATE_COMPLETED' }
        }
      });
    }
  });

  assert.equal(run.outcome.status, 'succeeded');
  assert.equal(run.outcome.lifecycle, 'completed');
  assert.deepEqual(run.response.currentOutput, {
    text: '',
    data: null,
    artifacts: []
  });
  assert.match(run.response.normalized.text, /draft must not be accepted/u);
});

test('passes locked run provenance to URL snapshot persistence', async () => {
  let persisted;
  await executeA2ATurn({
    card: rpcCard,
    runId: 'run_snapshot_locked',
    input: { parts: [{ type: 'text', text: 'run' }] },
    testId: 'test_snapshot_locked',
    turnIndex: 3,
    repeatIndex: 2,
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          message: {
            messageId: 'reply-url-locked',
            role: 'ROLE_AGENT',
            parts: [{ url: 'https://files.example/report.csv' }]
          }
        }
      });
    },
    snapshotRequest: async () => ({
      status: 200,
      headers: { 'content-type': 'text/csv' },
      body: Buffer.from('ok')
    }),
    persistSnapshot: async (snapshot) => {
      persisted = snapshot;
      return { evidenceId: 'ev_snapshot_locked' };
    }
  });
  assert.deepEqual({
    runId: persisted.runId,
    testId: persisted.testId,
    turnIndex: persisted.turnIndex,
    repeatIndex: persisted.repeatIndex
  }, {
    runId: 'run_snapshot_locked',
    testId: 'test_snapshot_locked',
    turnIndex: 3,
    repeatIndex: 2
  });
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

test('accepts only RFC 6750 b64token authorization and emits one canonical Bearer scheme', async () => {
  const valid = [
    ['abc-._~+/==', 'Bearer abc-._~+/=='],
    ['bEaReR abc+def==', 'Bearer abc+def==']
  ];
  for (const [authorization, expectedHeader] of valid) {
    let observed;
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'run' }] },
      authorization,
      request: async (_url, options) => {
        observed = options.headers.authorization;
        const body = JSON.parse(options.body);
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            message: {
              messageId: 'valid-auth',
              role: 'ROLE_AGENT',
              parts: [{ text: 'ok' }]
            }
          }
        });
      }
    });
    assert.equal(run.outcome.status, 'succeeded');
    assert.equal(observed, expectedHeader);
  }

  for (const authorization of [
    'Bearer',
    'Basic abc',
    'abc def',
    'Bearer Bearer abc',
    ' Bearer abc',
    'Bearer abc ',
    'Bearer  abc'
  ]) {
    let calls = 0;
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'run' }] },
      authorization,
      request: async () => {
        calls += 1;
        throw new Error('transport must not run');
      }
    });
    assert.equal(calls, 0);
    assert.equal(run.outcome.status, 'platform-error');
    assert.equal(run.error.category, 'configuration');
    assert.equal(JSON.stringify(run).includes(authorization), false);
  }
});

test('rejects unsafe authorization before transport and scrubs encoded and escaped echoes', async () => {
  for (const authorization of ['', 'ab', 'abc\u0007', 'x'.repeat(4_097)]) {
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

test('scrubs credential encodings and slash-escaped credentials from metadata keys and values', async () => {
  const token = 'q/x+9';
  const encoded = [
    token.replaceAll('/', '\\/'),
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
  assert.doesNotMatch(serialized, /q\/x\+9/);
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
    'TASK_STATE_COMPLETED'
  ]);
  assert.equal(run.response.normalized.terminalState, 'TASK_STATE_COMPLETED');
  assert.equal(run.response.normalized.text.includes('done'), true);
  assert.equal(run.outcome.status, 'succeeded');
});

test('records a validated blocking Task before a later polling deadline expires', async () => {
  const run = await executeA2ATurn({
    card: streamingHttpCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    timeoutMs: 200,
    clock: sequenceClock([1_000, 1_050, 1_200]),
    request: async () => jsonResponse({
      task: {
        id: 'task-working',
        status: { state: 'TASK_STATE_WORKING' }
      }
    })
  });

  assert.equal(run.outcome.status, 'platform-error');
  assert.equal(run.error.category, 'timeout');
  assert.equal(run.protocol.validated, true);
  assert.equal(run.response.normalized.responseKind, 'task');
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
  assert.equal(run.protocol.validated, false);
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

test('accepts one final v1 HTTP Task snapshot and normalizes cumulative evidence once', async () => {
  const httpCard = {
    ...rpcCard,
    supportedInterfaces: [{
      url: 'https://agent.example/a2a',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0'
    }]
  };
  const historyMessage = {
    messageId: 'history-1',
    role: 'ROLE_AGENT',
    parts: [{ text: 'history' }]
  };
  const statusMessage = {
    messageId: 'status-1',
    role: 'ROLE_AGENT',
    parts: [{ text: 'done' }]
  };
  const events = [
    { task: {
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_WORKING' },
      history: [historyMessage]
    } },
    { artifactUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      artifact: { artifactId: 'artifact-1', parts: [{ text: 'ha' }] },
      append: true
    } },
    { artifactUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      artifact: { artifactId: 'artifact-1', parts: [{ text: 'ha' }] },
      append: true
    } },
    { statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED', message: statusMessage }
    } },
    { task: {
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED', message: statusMessage },
      history: [historyMessage],
      artifacts: [{
        artifactId: 'artifact-1',
        parts: [{ text: 'ha' }, { text: 'ha' }]
      }]
    } }
  ];
  const run = await executeA2ATurn({
    card: streamingHttpCard,
    input: { parts: [{ type: 'text', text: 'stream' }] },
    streaming: true,
    request: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
  });

  assert.equal(run.outcome.status, 'succeeded');
  assert.deepEqual(run.response.normalized.statusSequence, [
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED'
  ]);
  assert.equal(run.response.normalized.history.length, 1);
  assert.deepEqual(
    run.response.normalized.artifacts[0].parts,
    [{ text: 'ha' }, { text: 'ha' }]
  );
  assert.equal(run.response.normalized.text, 'history\ndone\nha\nha');
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
  assert.equal(protocol.protocol.validated, false);

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
  assert.equal(failed.protocol.validated, true);
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

test('matches exact Content-Type essences while allowing legal parameters', async () => {
  const jsonPayload = (id) => ({
    jsonrpc: '2.0',
    id,
    result: {
      message: {
        messageId: 'content-type',
        role: 'ROLE_AGENT',
        parts: [{ text: 'ok' }]
      }
    }
  });
  for (const mediaType of ['application/jsonp', 'application/json-evil']) {
    const run = await executeA2ATurn({
      card: rpcCard,
      input: { parts: [{ type: 'text', text: 'run' }] },
      request: async (_url, options) => {
        const body = JSON.parse(options.body);
        return {
          status: 200,
          headers: { 'content-type': mediaType },
          body: Buffer.from(JSON.stringify(jsonPayload(body.id)))
        };
      }
    });
    assert.equal(run.outcome.status, 'agent-error');
    assert.equal(run.error.category, 'content-type');
  }

  const parameterized = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify(jsonPayload(body.id)))
      };
    }
  });
  assert.equal(parameterized.outcome.status, 'succeeded');

  const legacyCard = {
    name: rpcCard.name,
    description: rpcCard.description,
    skills: rpcCard.skills,
    url: 'https://agent.example/a2a',
    protocolVersion: '0.3',
    preferredTransport: 'JSONRPC'
  };
  const legacyParameterized = await executeA2ATurn({
    card: legacyCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            kind: 'message',
            messageId: 'legacy-content-type',
            role: 'agent',
            parts: [{ kind: 'text', text: 'ok' }]
          }
        }))
      };
    }
  });
  assert.equal(legacyParameterized.outcome.status, 'succeeded');

  const requestId = 'evil-stream-type';
  const stream = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'stream' }] },
    streaming: true,
    requestId,
    request: async () => ({
      ...eventStreamResponse(requestId, [{
        message: {
          messageId: 'stream-content-type',
          role: 'ROLE_AGENT',
          parts: [{ text: 'ok' }]
        }
      }]),
      headers: { 'content-type': 'text/event-stream-evil' }
    })
  });
  assert.equal(stream.outcome.status, 'agent-error');
  assert.equal(stream.error.category, 'content-type');
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

test('preserves equal artifact append chunks while deduplicating replayed snapshots', () => {
  const repeatedHistory = {
    messageId: 'history-1',
    role: 'ROLE_AGENT',
    parts: [{ text: 'history' }]
  };
  const normalized = normalizeA2AResult(
    { binding: 'HTTP+JSON', version: '1.0' },
    [
      { task: {
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_WORKING' },
        history: [repeatedHistory]
      } },
      { task: {
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_WORKING' },
        history: [repeatedHistory]
      } },
      { artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'artifact-1', parts: [{ text: 'ha' }] },
        append: true
      } },
      { artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'artifact-1', parts: [{ text: 'ha' }] },
        append: true
      } },
      { statusUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_COMPLETED' }
      } }
    ]
  );

  assert.equal(normalized.history.length, 1);
  assert.deepEqual(
    normalized.artifacts[0].parts,
    [{ text: 'ha' }, { text: 'ha' }]
  );
  assert.deepEqual(
    normalized.parts,
    [{ text: 'history' }, { text: 'ha' }, { text: 'ha' }]
  );
  assert.equal(normalized.text, 'history\nha\nha');
});

test('keeps HTTP streaming artifact updates when a terminal Task omits artifacts', async () => {
  const body = [
    'data: {"task":{"id":"task-stream","contextId":"ctx-stream","status":{"state":"TASK_STATE_WORKING"}}}\n\n',
    'data: {"artifactUpdate":{"taskId":"task-stream","contextId":"ctx-stream","artifact":{"artifactId":"artifact-1","parts":[{"text":"assembled"}]},"lastChunk":true}}\n\n',
    'data: {"statusUpdate":{"taskId":"task-stream","contextId":"ctx-stream","status":{"state":"TASK_STATE_COMPLETED"}}}\n\n',
    'data: {"task":{"id":"task-stream","contextId":"ctx-stream","status":{"state":"TASK_STATE_COMPLETED"}}}\n\n'
  ].join('');
  const run = await executeA2ATurn({
    card: streamingHttpCard,
    input: { parts: [{ type: 'text', text: 'stream' }] },
    streaming: true,
    request: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Buffer.from(body)
    })
  });

  assert.equal(run.outcome.status, 'succeeded', JSON.stringify(run.error));
  assert.equal(run.response.currentOutput.text, 'assembled');
  assert.equal(run.response.currentOutput.artifacts.length, 1);
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

test('rejects bounded encoded credential URL variants before any snapshot request', async (t) => {
  const latin1Token = '\u00ff\u00ffx';
  assert.deepEqual(
    [...latin1Token].map((character) => character.codePointAt(0)),
    [0xff, 0xff, 0x78]
  );
  const cases = [
    {
      name: 'uppercase hexadecimal in a path',
      token: 'xyz',
      encoded: '78797A',
      url: 'https://files.example/78797A/report.csv'
    },
    {
      name: 'mixed-case per-byte percent encoding in a path',
      token: 'a/b?',
      encoded: 'a%2fb%3F',
      url: 'https://files.example/a%2fb%3F/report.csv',
      expectedCode: 'configuration'
    },
    {
      name: 'form plus encoding in a path',
      token: 'a b',
      encoded: 'a+b',
      url: 'https://files.example/a+b/report.csv',
      expectedCode: 'configuration'
    },
    {
      name: 'unpadded standard base64 in a path',
      token: latin1Token,
      encoded: 'w7/Dv3g',
      url: 'https://files.example/w7/Dv3g/report.csv',
      expectedCode: 'configuration'
    },
    {
      name: 'unpadded base64url in a query',
      token: '~~~x',
      encoded: 'fn5-eA',
      url: 'https://files.example/report.csv?credential=fn5-eA'
    },
    {
      name: 'mixed-case percent encoding for a legal token',
      token: 'a/b',
      encoded: 'a%2fb',
      url: 'https://files.example/a%2fb/report.csv'
    },
    {
      name: 'bounded recursively encoded percent representation',
      token: 'a/b',
      encoded: 'a%252fb',
      url: 'https://files.example/a%252fb/report.csv'
    },
    {
      name: 'form encoding of the canonical Bearer header',
      token: 'abc',
      encoded: 'Bearer+abc',
      url: 'https://files.example/Bearer+abc/report.csv'
    },
    {
      name: 'unpadded standard base64 for a legal token',
      token: '~~~x',
      encoded: 'fn5+eA',
      url: 'https://files.example/fn5+eA/report.csv'
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let calls = 0;
      await assert.rejects(
        snapshotUrlParts([{ url: item.url }], {
          authorization: item.token,
          persistSnapshot: async () => ({ evidenceId: 'unused' }),
          request: async () => {
            calls += 1;
            return { status: 200, headers: {}, body: Buffer.from('private') };
          }
        }),
        (error) => error?.code === (item.expectedCode || 'credential-in-url')
      );
      assert.equal(calls, 0);
    });
  }
});

test('scrubs encoded credential URLs from every failed run evidence surface', async (t) => {
  const latin1Token = '\u00ff\u00ffx';
  const cases = [
    ['xyz', '78797A', 'https://files.example/78797A/report.csv', 'agent-error', 'credential-in-url'],
    ['a/b?', 'a%2fb%3F', 'https://files.example/a%2fb%3F/report.csv', 'platform-error', 'configuration'],
    ['a b', 'a+b', 'https://files.example/a+b/report.csv', 'platform-error', 'configuration'],
    [latin1Token, 'w7/Dv3g', 'https://files.example/w7/Dv3g/report.csv', 'platform-error', 'configuration'],
    ['~~~x', 'fn5-eA', 'https://files.example/report.csv?credential=fn5-eA', 'agent-error', 'credential-in-url'],
    ['a/b', 'a%2fb', 'https://files.example/a%2fb/report.csv', 'agent-error', 'credential-in-url'],
    ['a/b', 'a%252fb', 'https://files.example/a%252fb/report.csv', 'agent-error', 'credential-in-url'],
    [
      'sentinel-token-credential-9ZQ4',
      'Bearer+sentinel-token-credential-9ZQ4',
      'https://files.example/Bearer+sentinel-token-credential-9ZQ4/report.csv',
      'agent-error',
      'credential-in-url'
    ],
    ['~~~x', 'fn5+eA', 'https://files.example/fn5+eA/report.csv', 'agent-error', 'credential-in-url']
  ];

  for (const [token, encoded, url, expectedOutcome, expectedCode] of cases) {
    await t.test(encoded, async () => {
      let snapshotCalls = 0;
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
                messageId: 'reply-credential-url',
                role: 'ROLE_AGENT',
                parts: [{ url }]
              }
            }
          });
        },
        snapshotRequest: async () => {
          snapshotCalls += 1;
          return { status: 200, headers: {}, body: Buffer.from('must-not-fetch') };
        },
        persistSnapshot: async () => ({ evidenceId: 'must-not-persist' })
      });

      assert.equal(snapshotCalls, 0);
      assert.equal(run.outcome.status, expectedOutcome);
      assert.equal(run.error.code, expectedCode);
      assert.deepEqual(run.response.snapshots, []);
      const surfaces = [
        run,
        run.outcome,
        run.response.rawObjects,
        run.response.normalized,
        run.error
      ];
      for (const surface of surfaces) {
        const serialized = JSON.stringify(surface);
        assert.equal(serialized.includes(token), false);
        assert.equal(serialized.includes(encoded), false);
        assert.equal(serialized.toLowerCase().includes(encoded.toLowerCase()), false);
        assert.equal(serialized.includes(url), false);
        assert.equal(serialized.includes('sourceUrl'), false);
      }
    });
  }
});

test('fails closed for credential encodings beyond normalization bounds', async (t) => {
  const nestedCredential = (depth) => `a%${'25'.repeat(depth - 1)}2Fb`;
  const cases = [
    {
      name: 'five encodeURIComponent layers',
      encoded: nestedCredential(5),
      url: `https://files.example/${nestedCredential(5)}/report.csv`,
      maxElapsedMs: 1_000
    },
    {
      name: 'a chain far beyond the decode-depth limit',
      encoded: nestedCredential(100_000),
      url: `https://files.example/${nestedCredential(100_000)}/report.csv`,
      maxElapsedMs: 1_000
    },
    {
      name: 'branching form decoding beyond the view limit',
      encoded: '%25252B+%252B+%2B',
      url: 'https://files.example/%25252B+%252B+%2B/report.csv',
      maxElapsedMs: 1_000
    },
    {
      name: 'an input that exhausts the normalization-work budget',
      encoded: 'budget-marker+%20',
      url: `https://files.example/${'x'.repeat(1_900_000)}/budget-marker+%20`,
      maxElapsedMs: 1_000
    },
    {
      name: 'an input beyond the evidence-string length limit',
      encoded: nestedCredential(5),
      url: `https://files.example/${'x'.repeat((2 * 1024 * 1024) + 1)}/${nestedCredential(5)}`,
      maxElapsedMs: 1_000
    },
    {
      name: 'malformed percent encoding',
      encoded: '%E0%A4%A',
      url: 'https://files.example/%E0%A4%A/report.csv',
      maxElapsedMs: 1_000
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let snapshotCalls = 0;
      const startedAt = performance.now();
      const run = await executeA2ATurn({
        card: rpcCard,
        input: { parts: [{ type: 'text', text: 'run' }] },
        authorization: 'a/b',
        request: async (_url, options) => {
          const body = JSON.parse(options.body);
          return jsonResponse({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              message: {
                messageId: 'reply-deep-credential-url',
                role: 'ROLE_AGENT',
                parts: [{ url: item.url }]
              }
            }
          });
        },
        snapshotRequest: async () => {
          snapshotCalls += 1;
          throw new Error(`snapshot transport received leaked URL: ${item.url}`);
        },
        persistSnapshot: async () => ({ evidenceId: 'must-not-persist' })
      });
      const elapsedMs = performance.now() - startedAt;

      assert.equal(snapshotCalls, 0);
      assert.equal(run.outcome.status, 'agent-error');
      assert.equal(run.error.code, 'credential-in-url');
      assert.equal(run.response.rawObjects[0].result.message.parts[0].url, '[REDACTED]');
      assert.equal(run.response.normalized.parts[0].url, '[REDACTED]');
      assert.deepEqual(run.response.snapshots, []);
      const serialized = JSON.stringify(run);
      assert.equal(serialized.includes(item.encoded), false);
      assert.equal(serialized.includes(item.url), false);
      assert.equal(serialized.includes('sourceUrl'), false);
      assert.ok(
        elapsedMs < item.maxElapsedMs,
        `fail-closed handling took ${elapsedMs.toFixed(1)} ms`
      );
    });
  }
});

test('redacts a deeply encoded credential from arbitrary evidence leaves', async () => {
  const encoded = 'a%252525252Fb';
  const evidence = `remote diagnostic: ${encoded}`;
  const run = await executeA2ATurn({
    card: rpcCard,
    input: { parts: [{ type: 'text', text: 'run' }] },
    authorization: 'a/b',
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          message: {
            messageId: 'reply-deep-credential-text',
            role: 'ROLE_AGENT',
            metadata: {
              nested: evidence
            },
            parts: [{ text: evidence }]
          }
        }
      });
    }
  });

  assert.equal(run.outcome.status, 'succeeded');
  assert.equal(run.response.rawObjects[0].result.message.parts[0].text, '[REDACTED]');
  assert.equal(run.response.rawObjects[0].result.message.metadata.nested, '[REDACTED]');
  assert.equal(run.response.normalized.parts[0].text, '[REDACTED]');
  assert.equal(JSON.stringify(run).includes(encoded), false);
});

test('allows a normal non-nested percent URL without a credential match', async () => {
  let snapshotCalls = 0;
  const snapshots = await snapshotUrlParts(
    [{ url: 'https://files.example/reports/quarter%202.csv' }],
    {
      authorization: 'a/b',
      request: async () => {
        snapshotCalls += 1;
        return {
          status: 200,
          headers: { 'content-type': 'text/csv' },
          body: Buffer.from('safe')
        };
      },
      persistSnapshot: async () => ({ evidenceId: 'evidence-safe-percent-url' })
    }
  );

  assert.equal(snapshotCalls, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].sourceUrl, 'https://files.example/reports/quarter%202.csv');
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

test('bounds persistence by the batch deadline and propagates deadline-aware cancellation', async () => {
  let persistenceSignal;
  let persistenceBudget;
  let persistenceCompleted = false;
  await assert.rejects(
    snapshotUrlParts([{ url: 'https://files.example/deadline-persist.csv' }], {
      batchTimeoutMs: 1,
      clock: () => 0,
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'text/csv' },
        body: Buffer.from('x')
      }),
      persistSnapshot: async ({ signal, remainingMs }) => {
        persistenceSignal = signal;
        persistenceBudget = remainingMs;
        await new Promise((resolve) => setTimeout(resolve, 30));
        persistenceCompleted = true;
        return { evidenceId: 'must-not-succeed' };
      }
    }),
    (error) => error.category === 'timeout' && error.outcome === 'platform-error'
  );
  assert.ok(persistenceSignal instanceof AbortSignal);
  assert.equal(persistenceSignal.aborted, true);
  assert.ok(persistenceBudget > 0 && persistenceBudget <= 1);
  assert.equal(persistenceCompleted, false);

  const controller = new AbortController();
  let externalSignal;
  const pending = snapshotUrlParts([{ url: 'https://files.example/abort-persist.csv' }], {
    signal: controller.signal,
    request: async () => ({
      status: 200,
      headers: {},
      body: Buffer.from('x')
    }),
    persistSnapshot: ({ signal }) => {
      externalSignal = signal;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ evidenceId: 'too-late' }), 30);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('cancelled persistence'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
  });
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(
    pending,
    (error) => error.category === 'signal' && error.outcome === 'platform-error'
  );
  assert.equal(externalSignal.aborted, true);
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
