import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSseEvents } from '../src/a2a.js';
import { createMarketAgentServer } from '../agents/market-analyst/a2a-server.js';

const A2A_HEADERS = {
  'a2a-version': '1.0',
  authorization: 'Bearer owner-a',
  'content-type': 'application/a2a+json'
};

function messageRequest(messageId, part, configuration = {}) {
  return {
    message: {
      messageId,
      role: 'ROLE_USER',
      parts: [part]
    },
    configuration
  };
}

function completedArtifacts(runId = 'run-fake') {
  return [
    {
      name: 'market-report.md',
      mediaType: 'text/markdown',
      content: '# Market report\n\nEvidence-backed close.'
    },
    {
      name: 'evidence-pack.json',
      mediaType: 'application/json',
      data: {
        schemaVersion: '1.0',
        runId,
        reportDate: '2026-07-23',
        status: 'complete',
        conclusions: []
      }
    },
    {
      name: 'run-trace.json',
      mediaType: 'application/json',
      data: {
        runId,
        authorization: 'Bearer must-never-escape',
        steps: [{ tool: 'panda-market-worker', status: 'ok' }]
      }
    }
  ];
}

class FakeOrchestrator {
  constructor() {
    this.calls = [];
  }

  async run(input) {
    this.calls.push(input);
    if (input.operation.date === '2026-07-24') {
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const error = new Error('fake run canceled');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    const runId = `run-${this.calls.length}`;
    return {
      taskId: `orchestrator-task-${this.calls.length}`,
      runId,
      reportDate: input.operation.date || '2026-07-23',
      outcome: 'complete',
      taskState: 'TASK_STATE_COMPLETED',
      deliveryRequested: false,
      emailStatus: 'not-requested',
      artifacts: completedArtifacts(runId)
    };
  }
}

async function startHarness(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'market-a2a-'));
  const orchestrator = overrides.orchestrator || new FakeOrchestrator();
  const runLoader = overrides.runLoader || (async (runId, owner) => ({
    id: `orchestrator-${runId}`,
    runId,
    owner,
    reportDate: '2026-07-23',
    status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: completedArtifacts(runId)
  }));
  const server = createMarketAgentServer({
    config: {
      stateDir,
      publicBaseUrl: '',
      accessToken: 'configured-secret-must-never-appear',
      timezone: 'Asia/Shanghai'
    },
    orchestrator,
    runLoader,
    authenticate({ token }) {
      return ['owner-a', 'owner-b'].includes(token) ? { owner: token } : null;
    },
    ...overrides
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, orchestrator };
}

async function a2aFetch(origin, pathname, options = {}) {
  const headers = {
    ...A2A_HEADERS,
    ...(options.headers || {})
  };
  if (options.body === undefined) delete headers['content-type'];
  return fetch(`${origin}${pathname}`, { ...options, headers });
}

async function json(response) {
  return JSON.parse(await response.text());
}

function assertA2aJson(response) {
  assert.match(response.headers.get('content-type') || '', /^application\/a2a\+json\b/);
}

function assertError(payload, { code, status, reason }) {
  assert.equal(payload.error.code, code);
  assert.equal(payload.error.status, status);
  assert.equal(typeof payload.error.message, 'string');
  assert.ok(payload.error.message.length > 0);
  assert.ok(Array.isArray(payload.error.details));
  assert.equal(payload.error.details[0]['@type'], 'type.googleapis.com/google.rpc.ErrorInfo');
  assert.equal(payload.error.details[0].reason, reason);
  assert.equal(payload.error.details[0].domain, 'a2a-protocol.org');
}

test('well-known Agent Card declares the exact A2A 1.0 market interface and five skills', async (t) => {
  const { origin } = await startHarness(t);
  const response = await fetch(`${origin}/.well-known/agent-card.json`);
  assert.equal(response.status, 200);
  assertA2aJson(response);
  const card = await json(response);

  assert.equal(card.name, 'Panda Market Analyst');
  assert.equal(card.version, '1.0.0');
  assert.deepEqual(card.supportedInterfaces, [{
    url: `${origin}/a2a/v1`,
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }]);
  assert.deepEqual(card.capabilities, {
    streaming: true,
    pushNotifications: false
  });
  assert.deepEqual(card.defaultInputModes, ['text/plain', 'application/json']);
  assert.deepEqual(card.defaultOutputModes, ['text/markdown', 'application/json']);
  assert.deepEqual(card.skills.map(({ id }) => id), [
    'daily-market-report',
    'hot-topic-analysis',
    'sell-pressure-scan',
    'potential-watchlist',
    'inspect-run-trace'
  ]);
  for (const skill of card.skills) {
    assert.ok(skill.name);
    assert.ok(skill.description);
    assert.ok(skill.tags.length);
    assert.ok(skill.examples.length);
  }
  assert.deepEqual(card.securitySchemes, {
    bearerAuth: {
      httpAuthSecurityScheme: {
        description: 'Bearer token for protected Panda Market Analyst operations',
        scheme: 'Bearer',
        bearerFormat: 'opaque'
      }
    }
  });
  assert.deepEqual(card.securityRequirements, [{
    schemes: { bearerAuth: { list: [] } }
  }]);
  assert.equal(JSON.stringify(card).includes('configured-secret-must-never-appear'), false);
});

test('health is public while A2A task and run-detail routes require Bearer authentication', async (t) => {
  const { origin } = await startHarness(t);
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await json(health), { ok: true, agent: 'panda-market-analyst' });

  for (const pathname of [
    '/a2a/v1/tasks',
    '/runs/run-1',
    '/runs/run-1/report',
    '/runs/run-1/evidence',
    '/runs/run-1/trace'
  ]) {
    const response = await fetch(`${origin}${pathname}`, {
      headers: { 'a2a-version': '1.0' }
    });
    assert.equal(response.status, 401, pathname);
    assert.match(response.headers.get('www-authenticate') || '', /^Bearer\b/);
    if (pathname.startsWith('/a2a/')) {
      assertA2aJson(response);
      assertError(await json(response), {
        code: 401,
        status: 'UNAUTHENTICATED',
        reason: 'UNAUTHENTICATED'
      });
    }
  }
});

test('tokenless mode requires an explicit loopback-only development flag', () => {
  const orchestrator = new FakeOrchestrator();
  const base = {
    stateDir: os.tmpdir(),
    accessToken: '',
    timezone: 'Asia/Shanghai'
  };
  assert.throws(
    () => createMarketAgentServer({
      config: { ...base, host: '127.0.0.1' },
      orchestrator
    }),
    /access token|loopback development/i
  );
  assert.throws(
    () => createMarketAgentServer({
      config: {
        ...base,
        host: '0.0.0.0',
        allowInsecureLoopback: true
      },
      orchestrator
    }),
    /loopback/i
  );
  const server = createMarketAgentServer({
    config: {
      ...base,
      host: '127.0.0.1',
      allowInsecureLoopback: true
    },
    orchestrator
  });
  server.close();
});

test('all A2A operations reject a missing or unsupported A2A-Version', async (t) => {
  const { origin } = await startHarness(t);
  for (const version of [undefined, '0.3', '1.1']) {
    const headers = { authorization: 'Bearer owner-a' };
    if (version !== undefined) headers['a2a-version'] = version;
    const response = await fetch(`${origin}/a2a/v1/tasks`, { headers });
    assert.equal(response.status, 400);
    assertA2aJson(response);
    assertError(await json(response), {
      code: 400,
      status: 'FAILED_PRECONDITION',
      reason: 'VERSION_NOT_SUPPORTED'
    });
  }
});

test('message:send returns a completed Task and deduplicates messageId per owner', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  const body = JSON.stringify(messageRequest(
    'message-dedupe',
    { text: '生成 2026-07-23 的每日市场报告' }
  ));

  const firstResponse = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body
  });
  assert.equal(firstResponse.status, 200);
  assertA2aJson(firstResponse);
  const first = await json(firstResponse);
  assert.equal(first.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(typeof first.task.status.timestamp, 'string');
  assert.ok(first.task.contextId);
  assert.equal(first.task.history[0].messageId, 'message-dedupe');
  assert.ok(first.task.metadata.createdAt);
  assert.ok(first.task.metadata.lastModified);

  const duplicate = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body
  }));
  assert.equal(duplicate.task.id, first.task.id);
  assert.equal(orchestrator.calls.length, 1);
  assert.deepEqual({
    owner: orchestrator.calls[0].owner,
    operation: orchestrator.calls[0].operation,
    trigger: orchestrator.calls[0].trigger,
    deliverEmail: orchestrator.calls[0].deliverEmail
  }, {
    owner: 'owner-a',
    operation: {
      operation: 'daily-market-report',
      date: '2026-07-23',
      sections: [],
      topN: 10
    },
    trigger: 'a2a',
    deliverEmail: false
  });

  const otherOwner = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    headers: { authorization: 'Bearer owner-b' },
    body
  }));
  assert.notEqual(otherOwner.task.id, first.task.id);
  assert.equal(orchestrator.calls.length, 2);
});

test('message:stream emits Task, working status, artifacts, and terminal status in order', async (t) => {
  const { origin } = await startHarness(t);
  const response = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-stream',
      { data: { operation: 'hot-topic-analysis', date: '2026-07-23', topN: 8 } }
    ))
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream\b/);
  const events = parseSseEvents(await response.text());
  assert.ok(events.length >= 4);
  assert.deepEqual(Object.keys(events[0]), ['task']);
  assert.equal(events[0].task.status.state, 'TASK_STATE_SUBMITTED');
  assert.deepEqual(Object.keys(events[1]), ['statusUpdate']);
  assert.equal(events[1].statusUpdate.status.state, 'TASK_STATE_WORKING');
  const artifactIndexes = events
    .map((event, index) => event.artifactUpdate ? index : -1)
    .filter((index) => index >= 0);
  assert.ok(artifactIndexes.length >= 1);
  const terminalIndex = events.findIndex(
    (event) => event.statusUpdate?.status?.state === 'TASK_STATE_COMPLETED'
  );
  assert.ok(terminalIndex > Math.max(...artifactIndexes));
  for (const event of events) {
    assert.equal(
      ['task', 'statusUpdate', 'artifactUpdate'].filter((key) => key in event).length,
      1
    );
  }
});

test('stream artifact events stay within the evaluator 64 KB event limit', async (t) => {
  const artifactLoader = async () => [{
    name: 'market-report.md',
    mediaType: 'text/markdown',
    content: `# Large report\n\n${'x'.repeat(100_000)}`
  }, ...completedArtifacts('run-large').slice(1)];
  const { origin } = await startHarness(t, { artifactLoader });
  const response = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-large-stream-artifact',
      { text: '生成 2026-07-23 的每日市场报告' }
    ))
  });
  const raw = await response.text();
  const events = parseSseEvents(raw);
  const artifacts = events.filter((event) => event.artifactUpdate);
  assert.ok(artifacts.length >= 1);
  for (const event of artifacts) {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024);
  }
});

test('duplicate completed streams keep every SSE event within 64 KB', async (t) => {
  const artifactLoader = async () => [{
    name: 'market-report.md',
    mediaType: 'text/markdown',
    content: `# Large report\n\n${'x'.repeat(100_000)}`
  }, ...completedArtifacts('run-large-replay').slice(1)];
  const { origin } = await startHarness(t, { artifactLoader });
  const body = JSON.stringify(messageRequest(
    'message-large-stream-replay',
    { text: 'Generate the daily market report for 2026-07-23' }
  ));
  const completed = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body
  });
  assert.equal(completed.status, 200);

  const replay = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body
  });
  const events = parseSseEvents(await replay.text());
  assert.ok(events.length >= 1);
  assert.equal(events[0].task.status.state, 'TASK_STATE_COMPLETED');
  for (const event of events) {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024);
  }
});

test('duplicate streams bound aggregate artifact metadata in the initial Task event', async (t) => {
  const artifactLoader = async () => Array.from({ length: 16 }, (_, index) => ({
    name: `${`artifact-${index}-`.padEnd(195, 'n')}.json`,
    mediaType: 'application/json',
    data: { index },
    description: 'metadata'.repeat(2_000),
    size: 10_000 + index,
    sha256: 'a'.repeat(64)
  }));
  const { origin } = await startHarness(t, { artifactLoader });
  const body = JSON.stringify(messageRequest(
    'message-aggregate-stream-replay',
    { text: 'Generate the daily market report for 2026-07-23' }
  ));
  await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body
  });

  const replay = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body
  });
  const events = parseSseEvents(await replay.text());
  assert.equal(events[0].task.status.state, 'TASK_STATE_COMPLETED');
  for (const event of events) {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024);
  }
});

test('completed tasks expose Markdown, Evidence Pack, and Run Trace artifacts', async (t) => {
  const { origin } = await startHarness(t);
  const result = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-artifacts',
      { text: '分析最近一个交易日最热的行业和概念' }
    ))
  }));
  const byName = Object.fromEntries(result.task.artifacts.map((artifact) => [
    artifact.name,
    artifact
  ]));
  assert.match(byName['market-report.md'].parts[0].text, /^# Market report/);
  assert.equal(byName['market-report.md'].parts[0].mediaType, 'text/markdown');
  assert.equal(byName['evidence-pack.json'].parts[0].data.schemaVersion, '1.0');
  assert.ok(Array.isArray(byName['run-trace.json'].parts[0].data.steps));
  assert.equal(
    JSON.stringify(byName['run-trace.json']).includes('must-never-escape'),
    false
  );
});

test('get and list hide tasks owned by another authenticated caller', async (t) => {
  const { origin } = await startHarness(t);
  const created = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-private',
      { text: '列出卖压最明显的十只 A 股' }
    ))
  }));

  const ownGet = await a2aFetch(origin, `/a2a/v1/tasks/${created.task.id}`);
  assert.equal(ownGet.status, 200);
  assert.equal((await json(ownGet)).id, created.task.id);

  const hiddenGet = await a2aFetch(origin, `/a2a/v1/tasks/${created.task.id}`, {
    headers: { authorization: 'Bearer owner-b' }
  });
  assert.equal(hiddenGet.status, 404);
  assertError(await json(hiddenGet), {
    code: 404,
    status: 'NOT_FOUND',
    reason: 'TASK_NOT_FOUND'
  });

  const ownList = await json(await a2aFetch(origin, '/a2a/v1/tasks'));
  assert.deepEqual(ownList.tasks.map(({ id }) => id), [created.task.id]);
  assert.equal(ownList.totalSize, 1);

  const hiddenList = await json(await a2aFetch(origin, '/a2a/v1/tasks', {
    headers: { authorization: 'Bearer owner-b' }
  }));
  assert.deepEqual(hiddenList.tasks, []);
  assert.equal(hiddenList.totalSize, 0);
});

test('list uses descending status time, opaque pagination, filters, and optional artifacts', async (t) => {
  const { origin } = await startHarness(t);
  const first = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-list-first', { text: '生成报告' }))
  }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-list-second', { text: '生成报告' }))
  }));

  const firstPage = await json(await a2aFetch(
    origin,
    '/a2a/v1/tasks?pageSize=1'
  ));
  assert.deepEqual(firstPage.tasks.map(({ id }) => id), [second.task.id]);
  assert.equal('artifacts' in firstPage.tasks[0], false);
  assert.ok(firstPage.nextPageToken);
  assert.notEqual(firstPage.nextPageToken, '1');

  const secondPage = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks?pageSize=1&pageToken=${encodeURIComponent(firstPage.nextPageToken)}`
  ));
  assert.deepEqual(secondPage.tasks.map(({ id }) => id), [first.task.id]);
  assert.equal(secondPage.nextPageToken, '');

  const filtered = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks?statusTimestampAfter=${encodeURIComponent(second.task.status.timestamp)}`
  ));
  assert.deepEqual(filtered.tasks.map(({ id }) => id), [second.task.id]);

  const withArtifacts = await json(await a2aFetch(
    origin,
    '/a2a/v1/tasks?includeArtifacts=true&pageSize=1'
  ));
  assert.ok(withArtifacts.tasks[0].artifacts.length >= 3);
});

test('list cursor remains stable when a newer task is inserted between pages', async (t) => {
  const { origin } = await startHarness(t);
  const oldest = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cursor-oldest',
      { text: 'Generate the daily market report' }
    ))
  }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const pageAnchor = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cursor-anchor',
      { text: 'Generate the daily market report' }
    ))
  }));
  const firstPage = await json(await a2aFetch(origin, '/a2a/v1/tasks?pageSize=1'));
  assert.deepEqual(firstPage.tasks.map(({ id }) => id), [pageAnchor.task.id]);

  await new Promise((resolve) => setTimeout(resolve, 2));
  await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cursor-newer',
      { text: 'Generate the daily market report' }
    ))
  });
  const secondPage = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks?pageSize=1&pageToken=${encodeURIComponent(firstPage.nextPageToken)}`
  ));
  assert.deepEqual(secondPage.tasks.map(({ id }) => id), [oldest.task.id]);
});

test('cancel is idempotent for a canceled task and aborts active orchestration', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  const submitted = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cancel',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  assert.ok([
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING'
  ].includes(submitted.task.status.state));

  const firstCancel = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks/${submitted.task.id}:cancel`,
    { method: 'POST', body: '{}' }
  ));
  assert.equal(firstCancel.status.state, 'TASK_STATE_CANCELED');

  const secondCancel = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks/${submitted.task.id}:cancel`,
    { method: 'POST', body: '{}' }
  ));
  assert.equal(secondCancel.id, firstCancel.id);
  assert.equal(secondCancel.status.state, 'TASK_STATE_CANCELED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(orchestrator.calls[0].signal.aborted, true);
});

test('cancellation during artifact loading emits nothing after the canceled terminal event', async (t) => {
  let releaseArtifacts;
  let markArtifactLoadStarted;
  const artifactLoadStarted = new Promise((resolve) => {
    markArtifactLoadStarted = resolve;
  });
  const artifactLoader = async () => {
    markArtifactLoadStarted();
    return new Promise((resolve) => {
      releaseArtifacts = () => resolve(completedArtifacts('run-delayed'));
    });
  };
  const { origin, server } = await startHarness(t, { artifactLoader });
  const active = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cancel-artifacts',
      { data: { operation: 'daily-market-report', date: '2026-07-23' } },
      { returnImmediately: true }
    ))
  }));
  await artifactLoadStarted;
  const events = [];
  const unsubscribe = server.marketTaskService.subscribe(
    active.task.id,
    'owner-a',
    (event) => events.push(event)
  );
  await a2aFetch(origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
  releaseArtifacts();
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();

  const canceled = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks/${active.task.id}`
  ));
  assert.equal(canceled.status.state, 'TASK_STATE_CANCELED');
  assert.deepEqual(canceled.artifacts, []);
  assert.deepEqual(
    events.map((event) => Object.keys(event)[0]),
    ['statusUpdate']
  );
  assert.equal(events[0].statusUpdate.status.state, 'TASK_STATE_CANCELED');
});

test('subscribe rejects terminal tasks and streams an active task through cancellation', async (t) => {
  const { origin, server } = await startHarness(t);
  const completed = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-terminal-subscribe',
      { text: '生成每日市场报告' }
    ))
  }));
  const terminalResponse = await a2aFetch(
    origin,
    `/a2a/v1/tasks/${completed.task.id}:subscribe`,
    { method: 'POST', body: '{}' }
  );
  assert.equal(terminalResponse.status, 400);
  assertError(await json(terminalResponse), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });

  const active = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-active-subscribe',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  const subscribe = await a2aFetch(
    origin,
    `/a2a/v1/tasks/${active.task.id}:subscribe`,
    { method: 'POST', body: '{}' }
  );
  assert.equal(subscribe.status, 200);
  await a2aFetch(origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
  const events = parseSseEvents(await subscribe.text());
  assert.deepEqual(Object.keys(events[0]), ['task']);
  assert.equal(events.at(-1).statusUpdate.status.state, 'TASK_STATE_CANCELED');
  assert.equal(
    server.marketTaskService.tasks.get(active.task.id).emitter.listenerCount('event'),
    0
  );
});

test('active task subscriptions have a hard per-task listener bound', async (t) => {
  const { origin, server } = await startHarness(t);
  const active = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-listener-bound',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  const releases = Array.from({ length: 64 }, () =>
    server.marketTaskService.subscribe(active.task.id, 'owner-a', () => {})
  );
  assert.throws(
    () => server.marketTaskService.subscribe(active.task.id, 'owner-a', () => {}),
    (error) => error.reason === 'RESOURCE_EXHAUSTED' && error.statusCode === 429
  );
  const overflowResponse = await a2aFetch(
    origin,
    `/a2a/v1/tasks/${active.task.id}:subscribe`,
    {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(1_000)
    }
  );
  assert.equal(overflowResponse.status, 429);
  assertError(await json(overflowResponse), {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    reason: 'RESOURCE_EXHAUSTED'
  });
  releases.forEach((release) => release());
  await a2aFetch(origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
});

test('task capacity preserves unexpired idempotency and active admission is capped', async (t) => {
  const { origin, server, orchestrator } = await startHarness(t, {
    maxTasks: 2,
    maxActiveTasks: 1
  });
  const completed = [];
  for (let index = 0; index < 2; index += 1) {
    completed.push(await json(await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(
        `message-bounded-${index}`,
        { text: '生成报告' }
      ))
    })));
  }
  const retainedOverflow = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-bounded-2',
      { text: 'Generate the daily market report' }
    ))
  });
  assert.equal(retainedOverflow.status, 429);
  assert.equal(server.marketTaskService.tasks.size, 2);
  assert.equal(server.marketTaskService.idempotency.size, 2);
  const replay = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-bounded-0',
      { text: 'Generate the daily market report' }
    ))
  }));
  assert.equal(replay.task.id, completed[0].task.id);
  assert.equal(orchestrator.calls.length, 2);

  const activeHarness = await startHarness(t, {
    maxTasks: 2,
    maxActiveTasks: 1
  });
  const active = await json(await a2aFetch(activeHarness.origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-active-limit-1',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  const overflow = await a2aFetch(activeHarness.origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-active-limit-2',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  });
  assert.equal(overflow.status, 429);
  assertError(await json(overflow), {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    reason: 'RESOURCE_EXHAUSTED'
  });
  await a2aFetch(activeHarness.origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
});

test('malformed requests and unsupported operations use structured A2A errors', async (t) => {
  const { origin } = await startHarness(t);
  const malformed = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: '{"message":'
  });
  assert.equal(malformed.status, 400);
  assertError(await json(malformed), {
    code: 400,
    status: 'INVALID_ARGUMENT',
    reason: 'INVALID_REQUEST'
  });

  const unsupported = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-unsupported',
      { data: { operation: 'arbitrary-panda-method' } }
    ))
  });
  assert.equal(unsupported.status, 400);
  assertError(await json(unsupported), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });

  const pushConfiguration = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-push',
      { text: '生成报告' },
      { taskPushNotificationConfig: { url: 'https://attacker.example/webhook' } }
    ))
  });
  assert.equal(pushConfiguration.status, 400);
  assertError(await json(pushConfiguration), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED'
  });

  const pushRoute = await a2aFetch(
    origin,
    '/a2a/v1/tasks/task-1/pushNotificationConfigs',
    {
      method: 'POST',
      body: '{}'
    }
  );
  assert.equal(pushRoute.status, 400);
  assertError(await json(pushRoute), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED'
  });

  const unknownRoute = await a2aFetch(origin, '/a2a/v1/unknown:operation', {
    method: 'POST',
    body: '{}'
  });
  assert.equal(unknownRoute.status, 400);
  assertError(await json(unknownRoute), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });
});

test('request bodies require application/a2a+json and are limited to 1 MB', async (t) => {
  const { origin } = await startHarness(t);
  const wrongType = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(messageRequest('message-type', { text: '生成报告' }))
  });
  assert.equal(wrongType.status, 400);
  assertError(await json(wrongType), {
    code: 400,
    status: 'INVALID_ARGUMENT',
    reason: 'CONTENT_TYPE_NOT_SUPPORTED'
  });

  const oversized = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-large',
      { text: `生成报告${'x'.repeat(1024 * 1024)}` }
    ))
  });
  assert.equal(oversized.status, 413);
  assertError(await json(oversized), {
    code: 413,
    status: 'RESOURCE_EXHAUSTED',
    reason: 'REQUEST_TOO_LARGE'
  });
});

test('structured operations are whitelisted and A2A never forwards caller overrides or email', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-whitelist', {
      data: {
        operation: 'potential-watchlist',
        date: '2026-07-23',
        topN: 7,
        sections: ['summary'],
        pandaMethod: 'get_arbitrary_method',
        deliverEmail: true,
        recipient: 'attacker@example.com',
        outputPath: 'C:\\attacker-output'
      }
    }))
  });
  const call = orchestrator.calls[0];
  assert.deepEqual(call.operation, {
    operation: 'potential-watchlist',
    date: '2026-07-23',
    sections: ['summary'],
    topN: 7
  });
  assert.equal(call.trigger, 'a2a');
  assert.equal(call.deliverEmail, false);
  assert.equal('forceDelivery' in call, false);
  assert.equal('recipient' in call, false);
  assert.equal('pandaMethod' in call.operation, false);
  assert.equal('outputPath' in call.operation, false);
});

test('inspect-run-trace is store-only and protected run routes return sanitized artifacts', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  const inspected = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-inspect', {
      data: { operation: 'inspect-run-trace', runId: 'run-existing' }
    }))
  }));
  assert.equal(orchestrator.calls.length, 0);
  assert.equal(inspected.task.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(
    inspected.task.artifacts.map(({ name }) => name),
    ['run-trace.json']
  );

  const detail = await json(await fetch(`${origin}/runs/run-existing`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.equal(detail.runId, 'run-existing');

  const report = await json(await fetch(`${origin}/runs/run-existing/report`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.match(report.report, /^# Market report/);

  const evidence = await json(await fetch(`${origin}/runs/run-existing/evidence`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.equal(evidence.schemaVersion, '1.0');

  const traceResponse = await fetch(`${origin}/runs/run-existing/trace`, {
    headers: { authorization: 'Bearer owner-a' }
  });
  const traceText = await traceResponse.text();
  assert.equal(traceText.includes('must-never-escape'), false);
  assert.ok(JSON.parse(traceText).steps);
});

test('custom run loaders must attest the exact owner instead of failing open', async (t) => {
  const { origin } = await startHarness(t, {
    runLoader: async (runId) => ({
      runId,
      reportDate: '2026-07-23',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: completedArtifacts(runId)
    })
  });
  const response = await fetch(`${origin}/runs/run-global`, {
    headers: { authorization: 'Bearer owner-a' }
  });
  assert.equal(response.status, 404);
  assert.equal((await json(response)).error.status, 'NOT_FOUND');
});
