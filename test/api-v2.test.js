import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const testRoot = await mkdtemp(path.join(tmpdir(), 'agent-roast-api-v2-'));
process.env.NODE_ENV = 'test';
process.env.DATA_FILE = path.join(testRoot, 'evaluations.json');
process.env.A2A_BLACK_BOX_V1_ENABLED = 'true';
process.env.REVIEW_GOVERNANCE_ENABLED = 'true';
process.env.REVIEW_PRINCIPALS_JSON = JSON.stringify([{
  principalId: 'judge_preview_test',
  displayName: 'Judge Preview Test',
  role: 'judge',
  tokenSha256: createHash('sha256').update('judge-preview-test-key', 'utf8').digest('hex')
}]);
process.env.EVIDENCE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.EVIDENCE_ROOT = path.join(testRoot, 'evidence');

const {
  evaluationStore,
  pipeline,
  server,
  setReplicaCreateGateForTests
} = await import('../server.js');

const CARD = {
  name: 'V2 API Agent',
  description: 'V2 API integration fixture',
  supportedInterfaces: [{
    url: 'https://example.com/a2a',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }],
  skills: [{ id: 'api', name: 'API', description: 'fixture' }]
};
const EXAMPLES = [{
  id: 'api-example',
  name: 'API example',
  turns: [{
    input: { parts: [{ type: 'text', text: 'ping' }] },
    acceptanceCriteria: []
  }]
}];

let origin;
test.before(async () => {
  setReplicaCreateGateForTests(async () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const controller of pipeline.activeRuns.values()) controller.abort();
  await new Promise((resolve) => server.close(resolve));
  await rm(testRoot, { recursive: true, force: true });
});

test('returns a flat V2 create projection with no-store caching', async () => {
  const response = await createEvaluation();
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.schemaVersion, 2);
  assert.match(body.id, /^eval_/u);
  assert.equal(Object.hasOwn(body, 'participantAccessToken'), false);
  assert.equal(Object.hasOwn(body, 'evaluation'), false);
  assert.equal(evaluationStore.get(body.id)?.participantAccess, undefined);
  await pipeline.cancel(body.id);
});

test('rejects V2 create when no Replica runtime is ready', async () => {
  const { assertReplicaRuntimesReady } = await import('../src/phase3-services.js');
  setReplicaCreateGateForTests(async () => {
    await assertReplicaRuntimesReady({
      getRuntimeStatusFn: async () => [{
        id: 'claude-code',
        name: 'Claude Code',
        enabled: false,
        installed: false,
        authenticated: false,
        runtimeReady: false,
        note: '未安装'
      }]
    });
  });
  try {
    const response = await createEvaluation();
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 'REPLICA_RUNTIME_NOT_READY');
    assert.equal(body.runtimes[0].runtimeReady, false);
    assert.equal(evaluationStore.list().some((item) => item.id === body.id), false);
  } finally {
    setReplicaCreateGateForTests(async () => {});
  }
});

test('serves a non-blind judge view without a token while never leaking raw replica material', async () => {
  const created = await (await createEvaluation()).json();
  await pipeline.cancel(created.id);

  const unauthenticated = await fetch(`${origin}/api/evaluations/${created.id}`);
  const unauthenticatedBody = await unauthenticated.json();
  assert.equal(unauthenticated.status, 200);
  assert.equal(Object.hasOwn(unauthenticatedBody.submission.agentCard, 'value'), false);
  assert.equal(Object.hasOwn(unauthenticatedBody, 'replicaArena'), false);
  assert.equal(Object.hasOwn(unauthenticatedBody.resultV2 || {}, 'replica'), false);

  const authorized = await fetch(
    `${origin}/api/evaluations/${created.id}`,
    {
      headers: {
        authorization: 'Bearer judge-preview-test-key'
      }
    }
  );
  const body = await authorized.json();

  assert.equal(authorized.status, 200);
  assert.equal(body.submission.agentCard.value.name, CARD.name);
  assert.equal(Object.hasOwn(body, 'replicaArena'), false);
  assert.equal(Object.hasOwn(body.resultV2 || {}, 'replica'), false);
});

test('preserves the legacy 413 limit for oversized malformed create bodies when V2 is enabled', async () => {
  const response = await fetch(`${origin}/api/evaluations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(1_000_001)
  });

  assert.equal(response.status, 413);
});

test('returns no-store on resume and exact replay without bearer auth', async () => {
  const createdResponse = await createEvaluation();
  const created = await createdResponse.json();
  await pipeline.cancel(created.id);
  while (pipeline.activeRuns.has(created.id)) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const cancelled = evaluationStore.get(created.id);
  await evaluationStore.mutate(created.id, cancelled.revision, (record) => ({
    ...record,
    execution: {
      status: 'interrupted',
      stage: 'recovery',
      progress: record.execution.progress,
      interruptedAt: new Date().toISOString()
    }
  }));
  const options = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'api-v2-resume-key-00001'
    },
    body: '{}'
  };

  const first = await fetch(
    `${origin}/api/evaluations/${created.id}/resume`,
    options
  );
  const firstText = await first.text();
  const replay = await fetch(
    `${origin}/api/evaluations/${created.id}/resume`,
    options
  );
  const replayText = await replay.text();

  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(replay.headers.get('cache-control'), 'no-store');
  assert.equal(replayText, firstText);
});

test('resolves resume by evaluation id before parsing malformed or unknown bodies', async () => {
  const createdResponse = await createEvaluation();
  const created = await createdResponse.json();
  const resumeUrl = `${origin}/api/evaluations/${created.id}/resume`;
  const commonHeaders = {
    'content-type': 'application/json',
    'idempotency-key': 'api-v2-auth-order-key-0001'
  };

  try {
    const malformed = await fetch(resumeUrl, {
      method: 'POST',
      headers: commonHeaders,
      body: '{'
    });
    const unknown = await fetch(
      `${origin}/api/evaluations/eval_unknown_auth_order/resume`,
      {
        method: 'POST',
        headers: commonHeaders,
        body: '{'
      }
    );

    assert.equal(malformed.status, 400);
    assert.equal(unknown.status, 404);
  } finally {
    await pipeline.cancel(created.id);
    while (pipeline.activeRuns.has(created.id)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
});

test('allows id-only HTTP V2 cancel and hard delete', async () => {
  const createdResponse = await createEvaluation();
  const created = await createdResponse.json();
  await pipeline.cancel(created.id);
  while (pipeline.activeRuns.has(created.id)) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  let current = evaluationStore.get(created.id);
  current = await evaluationStore.mutate(
    created.id,
    current.revision,
    (record) => ({
      ...record,
      execution: {
        status: 'interrupted',
        stage: 'recovery',
        progress: record.execution.progress,
        interruptedAt: new Date().toISOString()
      }
    })
  );
  const cancelUrl = `${origin}/api/evaluations/${created.id}/cancel`;
  const deleteUrl = `${origin}/api/evaluations/${created.id}`;
  let baseline = {
    revision: current.revision,
    auditEvents: current.auditEvents.length
  };

  const cancelled = await fetch(cancelUrl, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  current = evaluationStore.get(created.id);
  assert.equal(current.execution.status, 'cancelled');
  assert.equal(current.revision, baseline.revision + 1);
  baseline = {
    revision: current.revision,
    auditEvents: current.auditEvents.length
  };
  const cancelReplay = await fetch(cancelUrl, { method: 'POST' });
  assert.equal(cancelReplay.status, 200);
  assert.equal(evaluationStore.get(created.id).revision, baseline.revision);

  const deleted = await fetch(deleteUrl, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    id: created.id,
    deleted: true
  });
  assert.equal(evaluationStore.get(created.id), undefined);

  const deleteReplay = await fetch(deleteUrl, { method: 'DELETE' });
  assert.equal(deleteReplay.status, 404);
});

test('rejects HTTP resume after a hard-deleted V2 evaluation', async () => {
  const createdResponse = await createEvaluation();
  const created = await createdResponse.json();
  await pipeline.cancel(created.id);
  while (pipeline.activeRuns.has(created.id)) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  let current = evaluationStore.get(created.id);
  current = await evaluationStore.mutate(
    created.id,
    current.revision,
    (record) => ({
      ...record,
      execution: {
        status: 'interrupted',
        stage: 'recovery',
        progress: record.execution.progress,
        interruptedAt: new Date().toISOString()
      }
    })
  );
  const deleted = await fetch(`${origin}/api/evaluations/${created.id}`, {
    method: 'DELETE'
  });
  assert.equal(deleted.status, 200);
  assert.equal(evaluationStore.get(created.id), undefined);

  const resumed = await fetch(
    `${origin}/api/evaluations/${created.id}/resume`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'api-v2-deleted-resume-0001'
      },
      body: '{}'
    }
  );

  assert.equal(resumed.status, 404);
});

test('returns secret-free transient 422 states for invalid and unsupported Cards', async () => {
  const beforeIds = evaluationStore.list().map((item) => item.id);
  const cases = [
    {
      reason: 'invalid-agent-card',
      card: {
        name: 'invalid',
        description: 'invalid-card-secret',
        supportedInterfaces: []
      }
    },
    {
      reason: 'unsupported-interface',
      card: {
        ...CARD,
        description: 'unsupported-card-secret',
        supportedInterfaces: [{
          url: 'https://example.com/custom',
          protocolBinding: 'CUSTOM',
          protocolVersion: '1.0'
        }]
      }
    },
    {
      reason: 'invalid-agent-card',
      card: {
        ...CARD,
        name: '',
        description: 'overlap-card-secret',
        supportedInterfaces: [{
          url: 'https://example.com/custom',
          protocolBinding: 'CUSTOM',
          protocolVersion: '1.0'
        }]
      }
    }
  ];
  for (const fixture of cases) {
    const response = await createEvaluation({
      agentCard: fixture.card,
      agentAuthorization: 'Bearer transient-agent-secret'
    });
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(response.status, 422);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body, {
      schemaVersion: 2,
      qualification: {
        status: 'ineligible',
        reason: fixture.reason,
        attemptRunIds: [],
        selectedInterface: null,
        completedAt: body.qualification.completedAt
      },
      objectiveCapability: {
        status: 'not-applicable',
        score: null
      },
      resultV2: null
    });
    assert.match(body.qualification.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(text.includes('transient-agent-secret'), false);
    assert.equal(text.includes(fixture.card.description), false);
  }
  assert.deepEqual(
    evaluationStore.list().map((item) => item.id),
    beforeIds
  );
});

function createEvaluation(overrides = {}) {
  return fetch(`${origin}/api/evaluations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 2,
      agentCard: CARD,
      agentExamples: EXAMPLES,
      ...overrides
    })
  });
}
