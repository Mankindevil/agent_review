import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSIONS,
  createEvaluationRecord,
  migrateStoredEvaluation
} from '../src/evaluation-model.js';

const snapshot = Object.freeze({
  submissionVersion: '1.0',
  frozenAt: '2026-07-24T10:00:00.000Z'
});

test('exports immutable contract version metadata', () => {
  assert.deepEqual(CONTRACT_VERSIONS, {
    store: '1.0',
    evaluation: '2.0',
    submission: '1.0',
    evidence: '1.0',
    rubric: 'a2a-black-box-v1'
  });
  assert.equal(Object.isFrozen(CONTRACT_VERSIONS), true);
});

test('creates the exact queued V2 evaluation record', () => {
  const record = createEvaluationRecord(snapshot, {
    id: 'eval_v2_1',
    createdAt: '2026-07-24T10:01:00.000Z'
  });

  assert.deepEqual(record, {
    schemaVersion: 2,
    id: 'eval_v2_1',
    createdAt: '2026-07-24T10:01:00.000Z',
    updatedAt: '2026-07-24T10:01:00.000Z',
    execution: { status: 'queued', stage: 'qualification', progress: 0 },
    governance: { phase: 'waiting_model' },
    submission: snapshot,
    qualification: { status: 'pending', attemptRunIds: [] },
    evidenceManifest: { version: '1.0', items: [] },
    objectiveCapability: { status: 'pending' },
    absoluteReview: { status: 'pending-model-review' },
    replicaArena: { status: 'disabled' },
    resultV2: null,
    revision: 0,
    auditEvents: []
  });
});

test('marks legacy stored array entries as schemaVersion 1 without inventing V2 fields', () => {
  const legacy = {
    id: 'legacy_1',
    createdAt: '2026-07-23T10:00:00.000Z',
    status: 'complete',
    result: { score: 82 }
  };

  const migrated = migrateStoredEvaluation([legacy]);

  assert.notEqual(migrated, legacy);
  assert.deepEqual(migrated, [{ ...legacy, schemaVersion: 1 }]);
  assert.equal(Object.hasOwn(migrated[0], 'evidenceManifest'), false);
  assert.equal(Object.hasOwn(migrated[0], 'objectiveCapability'), false);
  assert.equal(Object.hasOwn(migrated[0], 'resultV2'), false);
  assert.deepEqual(legacy, {
    id: 'legacy_1',
    createdAt: '2026-07-23T10:00:00.000Z',
    status: 'complete',
    result: { score: 82 }
  });
});

test('preserves already-versioned stored entries and rejects non-array stores', () => {
  const current = { schemaVersion: 2, id: 'eval_v2_1', resultV2: null };
  const migrated = migrateStoredEvaluation([current]);
  assert.deepEqual(migrated, [current]);
  assert.throws(() => migrateStoredEvaluation({ evaluations: [] }), /array/i);
});
