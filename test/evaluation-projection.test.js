import test from 'node:test';
import assert from 'node:assert/strict';
import { projectEvaluation } from '../src/evaluation-projection.js';
import {
  createEvidenceManifestItem,
  createEvidenceRecord
} from '../src/evidence.js';

const UNSECURED_JWT = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxMjMifQ.';
const FLAT_ASSIGNMENTS = [
  'password=projection-password-secret',
  'apiKey=projection-api-secret',
  'session=projection-session-secret',
  'credentials=projection-credential-secret',
  `jwt=${UNSECURED_JWT}`
].join('; ');
const PUBLIC_RECORD = createEvidenceRecord({
  evidenceId: 'ev_public',
  runId: 'run_1',
  grade: 'A',
  kind: 'platform-timing',
  testId: 'test_1',
  turnIndex: 0,
  repeatIndex: 0,
  capturedAt: '2026-07-24T10:00:30.000Z',
  payload: { durationMs: 30 }
});
const PUBLIC_MANIFEST = createEvidenceManifestItem(PUBLIC_RECORD, {
  summary: 'Completed in 30ms',
  visibility: 'public'
});

function unsafeEvaluation() {
  return {
    schemaVersion: 2,
    id: 'eval_projection',
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:01:00.000Z',
    revision: 3,
    evaluationWindow: {
      firstRunAt: '2026-07-24T10:00:15.000Z',
      lastRunAt: null,
      endpointHash: 'must-not-project'
    },
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
    qualification: {
      status: 'eligible',
      reason: 'version-valid-a2a-response',
      attemptRunIds: ['run_1'],
      selectedInterface: {
        binding: 'HTTP+JSON',
        version: '1.0',
        endpointHash: 'c'.repeat(64),
        endpointUrl: 'private-interface-url'
      },
      hiddenInput: 'hidden-secret'
    },
    evidenceManifest: {
      version: '1.0',
      items: [structuredClone(PUBLIC_MANIFEST)]
    },
    objectiveCapability: { status: 'pending', score: null, hiddenTests: ['hidden-secret'] },
    absoluteReview: {
      status: 'pending-model-review',
      confidence: {
        status: 'pending-model-review',
        value: null,
        privateReason: 'private-confidence-reason'
      },
      authorization: 'review-secret'
    },
    replicaArena: {
      status: 'sealed',
      seal: 'replica-seal-secret',
      anonymousMapping: { A: 'replica-secret' },
      logs: ['sensitive-log-secret']
    },
    resultV2: {
      absolute: { status: 'pending-model-review', private: 'absolute-private' },
      replica: { status: 'disabled', private: 'replica-private' },
      rating: {
        status: 'pending-model-and-human',
        code: null,
        label: null,
        private: 'rating-private'
      },
      rawPayload: 'result-secret'
    },
    participantAccess: { tokenHash: 'participant-hash-secret' },
    connection: { authorizationRequired: true, value: 'connection-secret' },
    resumeReceipts: [{
      keyHash: 'receipt-key-secret',
      requestMac: 'receipt-mac-secret',
      response: { private: 'receipt-response-secret' }
    }],
    runtimeState: {
      endpointHash: 'runtime-endpoint-secret',
      runIndex: [{
        contextId: 'context-private-secret',
        continuationTaskId: 'task-private-secret'
      }]
    },
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
    'schemaVersion', 'id', 'createdAt', 'updatedAt', 'revision',
    'evaluationWindow', 'execution', 'governance', 'qualification',
    'evidenceManifest', 'objectiveCapability', 'absoluteReview', 'resultV2'
  ]);
  assert.deepEqual(projection.evaluationWindow, {
    firstRunAt: '2026-07-24T10:00:15.000Z',
    lastRunAt: null
  });
  assert.deepEqual(projection.execution, {
    status: 'running',
    stage: 'qualification',
    progress: 25
  });
  assert.deepEqual(projection.qualification, {
    status: 'eligible',
    reason: 'version-valid-a2a-response',
    attemptRunIds: ['run_1'],
    selectedInterface: {
      binding: 'HTTP+JSON',
      version: '1.0',
      endpointHash: 'c'.repeat(64)
    }
  });
  assert.deepEqual(projection.absoluteReview, {
    status: 'pending-model-review',
    confidence: { status: 'pending-model-review', value: null }
  });
  assert.deepEqual(projection.resultV2, {
    absolute: { status: 'pending-model-review' },
    replica: { status: 'disabled' },
    rating: {
      status: 'pending-model-and-human',
      code: null,
      label: null
    }
  });
  assert.deepEqual(projection.evidenceManifest.items[0], {
    evidenceId: 'ev_public',
    runId: 'run_1',
    grade: 'A',
    kind: 'platform-timing',
    testId: 'test_1',
    turnIndex: 0,
    repeatIndex: 0,
    occurredAt: '2026-07-24T10:00:30.000Z',
    summary: 'Completed in 30ms',
    payloadHash: PUBLIC_RECORD.payloadHash,
    recordHash: PUBLIC_RECORD.recordHash,
    visibility: 'public',
    redaction: { status: 'not-required', count: 0 }
  });
  for (const secret of [
    'projection-secret', 'card-secret', 'hidden-secret',
    'review-secret', 'replica-seal-secret', 'replica-secret',
    'sensitive-log-secret', 'result-secret', 'raw-top-level-secret',
    'participant-hash-secret', 'connection-secret', 'receipt-key-secret',
    'receipt-mac-secret', 'receipt-response-secret', 'runtime-endpoint-secret',
    'context-private-secret', 'task-private-secret', 'private-interface-url',
    'private-confidence-reason', 'absolute-private', 'replica-private',
    'rating-private'
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

test('judge preview exposes redacted submission and locked model reviews without replica material', () => {
  const source = unsafeEvaluation();
  source.submission.agentCard.value = {
    name: 'Research Agent',
    description: 'Reviews supplied evidence.',
    supportedInterfaces: [{
      url: 'https://private-agent.example/a2a',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0'
    }],
    skills: [{ id: 'review', name: 'Review', description: 'Review evidence.' }]
  };
  source.submission.agentExamples.value = [{
    id: 'example-1',
    turns: [{
      input: { parts: [{ type: 'text', text: 'Use token=judge-secret' }] }
    }]
  }];
  source.absoluteReview.modelPanel = {
    status: 'model-locked',
    dimensions: { professionalism: { score: 78 } },
    primary: [{
      reviewRunId: 'primary_0_gpt',
      reviews: [{
        subcriterionId: 'professionalism.evidenceReasoning',
        score: 78,
        confidence: 0.8,
        evidenceIds: ['ev_public'],
        checkEvidence: [{ checkId: 'reasoning', evidenceIds: ['ev_public'] }],
        findings: [{
          findingId: 'finding_1',
          text: 'Evidence is cited.',
          evidenceIds: ['ev_public']
        }],
        counterEvidence: [],
        uncertainties: ['External truth is unavailable.'],
        repairSuggestion: 'State the method.',
        conclusions: { taskCompleted: 'yes', criticalRisk: 'no' }
      }]
    }],
    arbitration: null,
    disputedSubcriterionIds: []
  };

  const projection = projectEvaluation(source, {
    audience: 'judge-preview',
    secrets: ['judge-secret']
  });
  const serialized = JSON.stringify(projection);

  assert.equal(projection.submission.agentCard.value.name, 'Research Agent');
  assert.match(
    projection.submission.agentExamples.value[0].turns[0].input.parts[0].text,
    /REDACTED/u
  );
  assert.equal(
    projection.absoluteReview.modelPanel.primary[0].reviews[0].score,
    78
  );
  assert.equal(Object.hasOwn(projection, 'replicaArena'), false);
  assert.deepEqual(projection.resultV2.replica, { status: 'disabled' });
  assert.equal(serialized.includes('private-agent.example'), false);
  assert.equal(serialized.includes('replica-seal-secret'), false);
  assert.equal(serialized.includes('judge-secret'), false);
});

test('public projection exposes only the safe Phase 2 completion summary', () => {
  const source = unsafeEvaluation();
  source.resultV2.absolute = {
    status: 'model-provisional',
    testSummary: {
      totalTests: 5,
      repeatCount: 3,
      plannedCells: 15,
      completedCells: 15,
      variantCounts: {
        original: 1,
        equivalent: 1,
        boundary: 1,
        multiTurn: 1,
        protocolRecovery: 1
      },
      hiddenPrompts: ['must-not-project']
    },
    modelReviewSummary: {
      primarySeatsLocked: 4,
      arbitrationStatus: 'not-required',
      reviewerIdentities: ['must-not-project']
    }
  };

  const projection = projectEvaluation(source, { audience: 'public' });

  assert.deepEqual(projection.resultV2.absolute, {
    status: 'model-provisional',
    testSummary: {
      totalTests: 5,
      repeatCount: 3,
      plannedCells: 15,
      completedCells: 15,
      variantCounts: {
        original: 1,
        equivalent: 1,
        boundary: 1,
        multiTurn: 1,
        protocolRecovery: 1
      }
    },
    modelReviewSummary: {
      primarySeatsLocked: 4,
      arbitrationStatus: 'not-required'
    }
  });
});

test('all pre-lock projections expose sealed Replica counts without runtime or evidence details', () => {
  const source = unsafeEvaluation();
  source.replicaArena = {
    status: 'sealed', sealVersion: 'replica-arena-seal/v1', packageHash: 'a'.repeat(64),
    runtimeSummaries: [
      { runtimeId: 'runtime-private', validity: 'valid', artifactEvidenceIds: ['ev_private'], runCount: 6, failureCategory: null },
      { runtimeId: 'runtime-pending', validity: 'attribution-pending', artifactEvidenceIds: ['ev_pending'], runCount: 0, failureCategory: 'UNKNOWN' }
    ],
    encryptedArenaEvidenceIds: ['ev_private', 'ev_pending'], releasedAt: null
  };
  source.resultV2.replica = { status: 'sealed', runtimeId: 'runtime-private', output: 'must-not-project' };

  for (const audience of ['public', 'admin', 'judge-preview']) {
    const projection = projectEvaluation(source, { audience });
    assert.deepEqual(projection.resultV2.replica, {
      status: 'sealed', validReplicaCount: 1, pendingAttributionCount: 1
    });
    const serialized = JSON.stringify(projection);
    for (const secret of ['runtime-private', 'runtime-pending', 'ev_private', 'must-not-project']) {
      assert.equal(serialized.includes(secret), false, `${audience}: ${secret}`);
    }
  }
});

test('projects only server-released dual-track summaries after the absolute lock', () => {
  const source = unsafeEvaluation();
  source.governance = {
    phase: 'absolute_locked',
    absoluteLockedAt: '2026-07-25T12:00:00.000Z',
    resultHash: 'a'.repeat(64),
    replicaReleasedAt: '2026-07-25T12:01:00.000Z'
  };
  source.resultV2 = {
    absolute: {
      status: 'locked',
      total: 82,
      dimensions: {
        scenarioValue: { score: 64 },
        agentCapability: { objectiveCoverage: 0.75 }
      },
      resultHash: 'a'.repeat(64)
    },
    replica: {
      status: 'released',
      submittedMedian: 86,
      runtimes: [{ runtimeId: 'alpha', valid: true, median: 71 }],
      bestBaseline: { runtimeId: 'alpha', median: 71 },
      delta: 15,
      conservativeDelta: 12,
      ci95: { confidenceLevel: 0.95, low: 12, high: 15 },
      differenceStable: true,
      output: 'must-not-project'
    },
    rating: {
      status: 'final',
      code: 'HARD',
      label: '夯',
      differenceStable: true,
      reasons: ['locked reason']
    }
  };
  source.replicaArena = { status: 'released', rawScores: 'must-not-project' };

  const projection = projectEvaluation(source, { audience: 'public' });

  assert.deepEqual(projection.resultV2.replica, {
    status: 'released',
    submittedMedian: 86,
    runtimes: [{ runtimeId: 'alpha', valid: true, median: 71 }],
    bestBaseline: { runtimeId: 'alpha', median: 71 },
    delta: 15,
    conservativeDelta: 12,
    ci95: { confidenceLevel: 0.95, low: 12, high: 15 },
    differenceStable: true
  });
  assert.deepEqual(projection.resultV2.rating, {
    status: 'final',
    code: 'HARD',
    label: '夯',
    differenceStable: true
  });
  assert.equal(JSON.stringify(projection).includes('must-not-project'), false);
});

test('keeps stale released Replica details sealed before the absolute lock', () => {
  const source = unsafeEvaluation();
  source.replicaArena = {
    status: 'released',
    runtimeSummaries: [
      { runtimeId: 'runtime-private', validity: 'valid' }
    ]
  };
  source.resultV2 = {
    absolute: { status: 'model-provisional' },
    replica: {
      status: 'released',
      submittedMedian: 86,
      runtimes: [{ runtimeId: 'runtime-private', valid: true, median: 71 }],
      bestBaseline: { runtimeId: 'runtime-private', median: 71 },
      delta: 15,
      conservativeDelta: 12,
      ci95: { confidenceLevel: 0.95, low: 12, high: 15 },
      differenceStable: true
    },
    rating: { status: 'final', code: 'HARD', label: '夯', differenceStable: true }
  };

  const projection = projectEvaluation(source, { audience: 'public' });

  assert.deepEqual(projection.resultV2.replica, {
    status: 'sealed', validReplicaCount: 1, pendingAttributionCount: 0
  });
  assert.deepEqual(projection.resultV2.rating, { status: 'sealed' });
  assert.equal(JSON.stringify(projection).includes('runtime-private'), false);
  assert.equal(JSON.stringify(projection).includes('86'), false);
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
  const hiddenRecord = createEvidenceRecord({
    evidenceId: 'ev_hidden',
    runId: 'run_hidden',
    grade: 'B',
    kind: 'protocol-object',
    testId: 'test_hidden',
    capturedAt: '2026-07-24T10:00:31.000Z',
    payload: { hidden: true }
  });
  source.evidenceManifest.items.push(structuredClone(createEvidenceManifestItem(hiddenRecord, {
    summary: 'hidden input = hidden-manifest-secret',
    visibility: 'admin'
  })));
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

test('fails closed instead of projecting malformed or commitment-mismatched manifest items', () => {
  const source = unsafeEvaluation();
  const valid = structuredClone(PUBLIC_MANIFEST);
  const { recordHash: _recordHash, ...missingRecordHash } = valid;
  source.evidenceManifest.items = [
    valid,
    missingRecordHash,
    { ...valid, recordHash: '0'.repeat(64) },
    { ...valid, grade: 'B', kind: 'protocol-object' },
    { ...valid, kind: 'timing' },
    { ...valid, occurredAt: '2026-07-24T10:00:31.000Z' }
  ];

  for (const audience of ['public', 'admin']) {
    const projection = projectEvaluation(source, { audience });
    assert.deepEqual(projection.evidenceManifest.items, [PUBLIC_MANIFEST]);
  }
});
