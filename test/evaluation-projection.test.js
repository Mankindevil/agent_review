import test from 'node:test';
import assert from 'node:assert/strict';
import { projectEvaluation } from '../src/evaluation-projection.js';

const UNSECURED_JWT = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxMjMifQ.';
const FLAT_ASSIGNMENTS = [
  'password=projection-password-secret',
  'apiKey=projection-api-secret',
  'session=projection-session-secret',
  'credentials=projection-credential-secret',
  `jwt=${UNSECURED_JWT}`
].join('; ');

function unsafeEvaluation() {
  return {
    schemaVersion: 2,
    id: 'eval_projection',
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:01:00.000Z',
    revision: 3,
    execution: {
      status: 'running',
      stage: 'qualification',
      progress: 25,
      authorization: 'Bearer projection-secret'
    },
    governance: { phase: 'waiting_model', anonymousMapping: { A: 'submitted-agent' } },
    submission: {
      submissionVersion: '1.0',
      frozenAt: '2026-07-24T09:59:00.000Z',
      agentCard: { sha256: 'a'.repeat(64), value: { authorization: 'card-secret' } },
      agentExamples: { sha256: 'b'.repeat(64), value: [{ hiddenInput: 'hidden-secret' }] },
      config: { rubricVersion: 'rubric-v1', hiddenTestPackageVersion: 'hidden-v1' }
    },
    qualification: { status: 'passed', attemptRunIds: ['run_1'], hiddenInput: 'hidden-secret' },
    evidenceManifest: {
      version: '1.0',
      items: [{
        evidenceId: 'ev_public',
        runId: 'run_1',
        grade: 'A',
        kind: 'timing',
        testId: 'test_1',
        turnIndex: 0,
        repeatIndex: 0,
        occurredAt: '2026-07-24T10:00:30.000Z',
        summary: 'Completed in 30ms',
        payloadHash: 'c'.repeat(64),
        recordHash: 'd'.repeat(64),
        visibility: 'public',
        redaction: { status: 'applied', count: 2 },
        payload: { raw: 'raw-payload-secret' }
      }]
    },
    objectiveCapability: { status: 'pending', score: null, hiddenTests: ['hidden-secret'] },
    absoluteReview: { status: 'pending-model-review', authorization: 'review-secret' },
    replicaArena: {
      status: 'sealed',
      seal: 'replica-seal-secret',
      anonymousMapping: { A: 'replica-secret' },
      logs: ['sensitive-log-secret']
    },
    resultV2: { status: 'pending', score: null, rawPayload: 'result-secret' },
    auditEvents: [{
      id: 'audit_1',
      type: 'created',
      occurredAt: '2026-07-24T10:00:00.000Z',
      summary: 'Evaluation created',
      sensitiveLog: 'sensitive-log-secret'
    }],
    rawEvidence: { authorization: 'raw-top-level-secret' },
    logs: [{ message: 'sensitive-log-secret' }]
  };
}

test('constructs a public V2 projection from explicit allow-listed fields', () => {
  const source = unsafeEvaluation();
  const projection = projectEvaluation(source, { audience: 'public' });
  const serialized = JSON.stringify(projection);

  assert.deepEqual(Object.keys(projection), [
    'schemaVersion', 'id', 'createdAt', 'updatedAt', 'revision', 'execution',
    'governance', 'qualification', 'evidenceManifest', 'objectiveCapability',
    'absoluteReview', 'resultV2'
  ]);
  assert.deepEqual(projection.execution, {
    status: 'running',
    stage: 'qualification',
    progress: 25
  });
  assert.deepEqual(projection.evidenceManifest.items[0], {
    evidenceId: 'ev_public',
    runId: 'run_1',
    grade: 'A',
    kind: 'timing',
    testId: 'test_1',
    turnIndex: 0,
    repeatIndex: 0,
    occurredAt: '2026-07-24T10:00:30.000Z',
    summary: 'Completed in 30ms',
    payloadHash: 'c'.repeat(64),
    recordHash: 'd'.repeat(64),
    visibility: 'public',
    redaction: { status: 'applied', count: 2 }
  });
  for (const secret of [
    'projection-secret', 'card-secret', 'hidden-secret', 'raw-payload-secret',
    'review-secret', 'replica-seal-secret', 'replica-secret',
    'sensitive-log-secret', 'result-secret', 'raw-top-level-secret'
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.deepEqual(source, unsafeEvaluation());
});

test('admin projection adds only safe submission metadata and audit summaries', () => {
  const projection = projectEvaluation(unsafeEvaluation(), { audience: 'admin' });
  const serialized = JSON.stringify(projection);

  assert.deepEqual(projection.submission, {
    submissionVersion: '1.0',
    frozenAt: '2026-07-24T09:59:00.000Z',
    agentCard: { sha256: 'a'.repeat(64) },
    agentExamples: { sha256: 'b'.repeat(64) },
    config: { rubricVersion: 'rubric-v1' }
  });
  assert.deepEqual(projection.auditEvents, [{
    id: 'audit_1',
    type: 'created',
    occurredAt: '2026-07-24T10:00:00.000Z',
    summary: 'Evaluation created'
  }]);
  assert.equal(serialized.includes('hidden-v1'), false);
  assert.equal(serialized.includes('sensitive-log-secret'), false);
  assert.throws(() => projectEvaluation(unsafeEvaluation(), { audience: 'judge' }), /audience/i);
});

test('type-checks and redacts every projected leaf, including allowed summaries and findings', () => {
  const source = unsafeEvaluation();
  source.schemaVersion = { nested: 'top-level-object-secret' };
  source.id = 'run-explicit-secret';
  source.revision = { nested: 'revision-object-secret' };
  source.archivedAt = { nested: 'archive-object-secret' };
  source.execution.stage = 'Bearer stage.secret.token';
  source.qualification.failureCode = 'Cookie: session=qualification-secret';
  source.evidenceManifest.items[0].summary = 'Cookie: sid=manifest-secret';
  source.evidenceManifest.items.push({
    evidenceId: 'ev_hidden',
    runId: 'run_hidden',
    grade: 'B',
    kind: 'protocol-object',
    testId: 'test_hidden',
    occurredAt: '2026-07-24T10:00:31.000Z',
    summary: 'hidden input = hidden-manifest-secret',
    payloadHash: 'e'.repeat(64),
    visibility: 'admin',
    redaction: { status: 'applied', count: 1 }
  });
  source.objectiveCapability.reason = 'raw authorization: objective-secret';
  source.absoluteReview.findings = ['hidden input = finding-secret'];
  source.resultV2.repairSuggestion = 'fetch https://example.test/?token=repair-secret';
  source.auditEvents[0].summary = 'Bearer audit.secret.token';
  source.execution.stage += `; ${FLAT_ASSIGNMENTS}`;
  source.objectiveCapability.reason += `; ${FLAT_ASSIGNMENTS}`;
  source.auditEvents[0].summary += `; ${FLAT_ASSIGNMENTS}`;

  for (const audience of ['public', 'admin']) {
    const projection = projectEvaluation(source, {
      audience,
      secrets: ['run-explicit-secret', 'objective-secret', 'finding-secret']
    });
    const serialized = JSON.stringify(projection);
    for (const secret of [
      'top-level-object-secret', 'revision-object-secret', 'archive-object-secret',
      'run-explicit-secret', 'stage.secret.token', 'qualification-secret',
      'manifest-secret', 'hidden-manifest-secret', 'objective-secret',
      'finding-secret', 'repair-secret', 'projection-password-secret',
      'projection-api-secret', 'projection-session-secret',
      'projection-credential-secret', UNSECURED_JWT
    ]) {
      assert.equal(serialized.includes(secret), false, `${audience}: ${secret}`);
    }
    assert.equal(projection.schemaVersion, undefined);
    assert.equal(projection.revision, undefined);
    assert.equal(projection.archivedAt, undefined);
    assert.match(projection.id, /\[SECRET_REDACTED\]/);
  }

  const admin = projectEvaluation(source, { audience: 'admin' });
  const hidden = admin.evidenceManifest.items.find((item) => item.evidenceId === 'ev_hidden');
  assert.ok(hidden);
  assert.equal(Object.hasOwn(hidden, 'summary'), false);
});
