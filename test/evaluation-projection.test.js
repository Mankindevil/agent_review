import test from 'node:test';
import assert from 'node:assert/strict';
import { projectEvaluation } from '../src/evaluation-projection.js';

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
