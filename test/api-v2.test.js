import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const testRoot = await mkdtemp(path.join(tmpdir(), 'agent-roast-api-v2-'));
process.env.NODE_ENV = 'test';
process.env.DATA_FILE = path.join(testRoot, 'evaluations.json');
process.env.A2A_BLACK_BOX_V1_ENABLED = 'true';
process.env.EVIDENCE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.EVIDENCE_ROOT = path.join(testRoot, 'evidence');

const {
  evaluationStore,
  pipeline,
  server
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const controller of pipeline.activeRuns.values()) controller.abort();
  await new Promise((resolve) => server.close(resolve));
  await rm(testRoot, { recursive: true, force: true });
});

test('returns a flat one-time V2 create token with no-store caching', async () => {
  const response = await createEvaluation();
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.schemaVersion, 2);
  assert.match(body.id, /^eval_/u);
  assert.match(body.participantAccessToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Object.hasOwn(body, 'evaluation'), false);
  assert.equal(
    JSON.stringify(evaluationStore.get(body.id))
      .includes(body.participantAccessToken),
    false
  );
  await pipeline.cancel(body.id);
});

test('returns no-store on participant-authenticated resume and exact replay', async () => {
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
      authorization: `Bearer ${created.participantAccessToken}`,
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
  assert.equal(firstText.includes(created.participantAccessToken), false);
});

test('authenticates resume before parsing malformed, oversized, or unknown request bodies', async () => {
  const createdResponse = await createEvaluation();
  const created = await createdResponse.json();
  const resumeUrl = `${origin}/api/evaluations/${created.id}/resume`;
  const commonHeaders = {
    authorization: `Bearer ${'x'.repeat(43)}`,
    'content-type': 'application/json',
    'idempotency-key': 'api-v2-auth-order-key-0001'
  };

  try {
    const malformed = await fetch(resumeUrl, {
      method: 'POST',
      headers: commonHeaders,
      body: '{'
    });
    const oversized = await fetch(resumeUrl, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({ padding: 'x'.repeat(20 * 1024) })
    });
    const unknown = await fetch(
      `${origin}/api/evaluations/eval_unknown_auth_order/resume`,
      {
        method: 'POST',
        headers: commonHeaders,
        body: '{'
      }
    );

    assert.equal(malformed.status, 401);
    assert.equal(oversized.status, 401);
    assert.equal(unknown.status, 404);
  } finally {
    await pipeline.cancel(created.id);
    while (pipeline.activeRuns.has(created.id)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
});

test('requires participant Bearer ownership for HTTP V2 cancel and archive', async () => {
  const createdResponse = await createEvaluation();
  const created = await createdResponse.json();
  await pipeline.cancel(created.id, created.participantAccessToken);
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
  const archiveUrl = `${origin}/api/evaluations/${created.id}`;
  const authorized = {
    authorization: `Bearer ${created.participantAccessToken}`
  };
  const wrong = {
    authorization: `Bearer ${'x'.repeat(43)}`
  };
  let baseline = {
    revision: current.revision,
    auditEvents: current.auditEvents.length
  };

  for (const headers of [{}, wrong]) {
    const response = await fetch(cancelUrl, { method: 'POST', headers });
    assert.equal(response.status, 401);
    const unchanged = evaluationStore.get(created.id);
    assert.equal(unchanged.revision, baseline.revision);
    assert.equal(unchanged.auditEvents.length, baseline.auditEvents);
  }

  const cancelled = await fetch(cancelUrl, {
    method: 'POST',
    headers: authorized
  });
  assert.equal(cancelled.status, 200);
  current = evaluationStore.get(created.id);
  assert.equal(current.execution.status, 'cancelled');
  assert.equal(current.revision, baseline.revision + 1);
  baseline = {
    revision: current.revision,
    auditEvents: current.auditEvents.length
  };
  const cancelReplay = await fetch(cancelUrl, {
    method: 'POST',
    headers: authorized
  });
  assert.equal(cancelReplay.status, 200);
  assert.equal(evaluationStore.get(created.id).revision, baseline.revision);

  for (const headers of [{}, wrong]) {
    const response = await fetch(archiveUrl, { method: 'DELETE', headers });
    assert.equal(response.status, 401);
    const unchanged = evaluationStore.get(created.id);
    assert.equal(unchanged.revision, baseline.revision);
    assert.equal(unchanged.auditEvents.length, baseline.auditEvents);
  }

  const [firstArchive, secondArchive] = await Promise.all([
    fetch(archiveUrl, { method: 'DELETE', headers: authorized }),
    fetch(archiveUrl, { method: 'DELETE', headers: authorized })
  ]);
  assert.equal(firstArchive.status, 200);
  assert.equal(secondArchive.status, 200);
  const firstBody = await firstArchive.json();
  const secondBody = await secondArchive.json();
  assert.equal(firstBody.revision, baseline.revision + 1);
  assert.equal(secondBody.revision, baseline.revision + 1);
  assert.equal(evaluationStore.get(created.id).revision, baseline.revision + 1);

  const archiveReplay = await fetch(archiveUrl, {
    method: 'DELETE',
    headers: authorized
  });
  assert.equal(archiveReplay.status, 200);
  assert.equal(
    (await archiveReplay.json()).revision,
    baseline.revision + 1
  );
  assert.equal(evaluationStore.get(created.id).revision, baseline.revision + 1);
  const wrongAfterArchive = await fetch(archiveUrl, {
    method: 'DELETE',
    headers: wrong
  });
  assert.equal(wrongAfterArchive.status, 401);
  assert.equal(evaluationStore.get(created.id).revision, baseline.revision + 1);
});

test('rejects HTTP resume after an interrupted V2 evaluation is archived', async () => {
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
  const archived = await fetch(`${origin}/api/evaluations/${created.id}`, {
    method: 'DELETE'
  });
  assert.equal(archived.status, 200);
  const revision = evaluationStore.get(created.id).revision;

  const resumed = await fetch(
    `${origin}/api/evaluations/${created.id}/resume`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.participantAccessToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'api-v2-archived-resume-0001'
      },
      body: '{}'
    }
  );

  assert.equal(resumed.status, 409);
  assert.equal(evaluationStore.get(created.id).revision, revision);
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
