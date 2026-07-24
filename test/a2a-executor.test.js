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
        task: {
          id: 'task-1',
          contextId: 'ctx-1',
          status: { state: pollCount === 3 ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' },
          history: [{ messageId: `history-${pollCount}`, role: 'ROLE_AGENT', parts: [{ text: `step ${pollCount}` }] }],
          artifacts: pollCount === 3 ? [{ artifactId: 'artifact-1', parts: [{ text: 'done' }] }] : []
        }
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
  const first = 'data: {"jsonrpc":"2.0","id":"stream-req","result":{"task":{"id":"task-1","status":{"state":"TASK_STATE_WORK';
  const second = 'ING"}}}}\n\n';
  const third = 'data: {"jsonrpc":"2.0","id":"stream-req","result":{"statusUpdate":{"taskId":"task-1","final":true,"status":{"state":"TASK_STATE_COMPLETED","message":{"parts":[{"text":"stream done"}]}}}}}\n\n';
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

test('reuses only returned context and task IDs inside one example repeat', async () => {
  const calls = [];
  const result = await executeA2AExample({
    card: rpcCard,
    example: {
      id: 'multi-turn',
      turns: [
        { input: { parts: [{ type: 'text', text: 'first' }] } },
        { input: { parts: [{ type: 'text', text: 'second' }] } }
      ]
    },
    repeatIndex: 3,
    policy: { timeoutMs: 4_000 },
    executeTurn: async (options) => {
      calls.push(options);
      return {
        outcome: { status: 'succeeded' },
        response: {
          normalized: calls.length === 1
            ? { contextId: 'ctx-returned', taskId: 'task-returned' }
            : { contextId: 'ctx-returned', taskId: 'task-returned' }
        }
      };
    }
  });

  assert.equal(calls[0].contextId, undefined);
  assert.equal(calls[0].taskId, undefined);
  assert.equal(calls[1].contextId, 'ctx-returned');
  assert.equal(calls[1].taskId, 'task-returned');
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
});

test('snapshots only directly returned URL Parts once with bounded safe requests', async () => {
  const calls = [];
  const snapshots = await snapshotUrlParts([
    { url: 'https://files.example/report.csv?signature=secret', mediaType: 'text/csv' },
    { url: 'https://files.example/report.csv?signature=secret', mediaType: 'text/csv' },
    { text: '<a href="https://evil.example/hidden">hidden</a>' }
  ], {
    authorization: 'must-not-forward',
    request: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 200,
        headers: { 'content-type': 'text/csv' },
        body: Buffer.from('a,b\n1,2\nhttps://evil.example/body')
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeoutMs, 10_000);
  assert.equal(calls[0].options.maxBytes, 1024 * 1024);
  assert.equal(Object.hasOwn(calls[0].options.headers || {}, 'authorization'), false);
  assert.equal(snapshots[0].sourceUrl, 'https://files.example/report.csv');
  assert.equal(snapshots[0].size, 33);
  assert.equal(Buffer.from(snapshots[0].bytes, 'base64').toString(), 'a,b\n1,2\nhttps://evil.example/body');
  assert.match(snapshots[0].sha256, /^[a-f0-9]{64}$/);
});

test('validates URL Parts before invoking an injected snapshot transport', async () => {
  let calls = 0;
  await assert.rejects(
    snapshotUrlParts([{ url: 'file:///private/report.csv' }], {
      request: async () => {
        calls += 1;
        return { status: 200, headers: {}, body: Buffer.from('private') };
      }
    }),
    /HTTP|URL/
  );
  assert.equal(calls, 0);
});

function jsonResponse(payload, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  };
}

function sequenceClock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
