import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeReplacementRun,
  createAppeal,
  decideAppeal,
  triageAppeal
} from '../src/appeals.js';

const platformProbes = {
  scheduler: { ok: false, evidenceId: 'ev_scheduler' },
  evidenceStore: { ok: true, evidenceId: 'ev_store' },
  organizerEndpoint: { ok: true, evidenceId: 'ev_organizer' },
  independentWorker: { ok: true, evidenceId: 'ev_worker' },
  unrelatedAgentHealth: { ok: true, evidenceId: 'ev_other' }
};

function lockedEvaluation() {
  return {
    id: 'eval_appeal',
    finalizedAt: '2026-07-25T00:00:00.000Z',
    participantAccess: { ownerId: 'participant' },
    governance: {
      phase: 'final',
      resultHash: 'a'.repeat(64),
      evidenceManifestHash: 'b'.repeat(64)
    },
    resultV2: {
      absolute: { status: 'locked', resultHash: 'a'.repeat(64) },
      resultVersions: []
    },
    evidenceManifest: { items: [{ evidenceId: 'ev_visible' }] },
    runtimeState: {
      runIndex: [{
        cellId: 'cell_1',
        identity: {
          testId: 'test_1',
          inputHash: 'input-hash',
          seed: 7,
          protocolConfigHash: 'protocol-hash'
        },
        policy: { timeoutMs: 1000, targetMs: 100, temperature: 0, version: 'runtime-v1' },
        attempts: [{ turns: [{ runId: 'run_1' }] }]
      }]
    }
  };
}

const participant = { principalId: 'participant', role: 'participant' };
const admin = { principalId: 'admin_1', role: 'admin' };
const appealInput = {
  target: { kind: 'test', id: 'test_1', path: 'runtimeState.runIndex[0]' },
  grounds: 'platform-error',
  statement: 'The scheduler failed while independent controls failed too.',
  evidenceIds: ['ev_visible'],
  idempotencyKey: 'appeal-create-1'
};

test('appeal lifecycle appends records without changing the locked result', () => {
  const evaluation = lockedEvaluation();
  const before = structuredClone(evaluation.resultV2.absolute);
  const appeal = createAppeal(evaluation, participant, appealInput);
  triageAppeal(evaluation, appeal.appealId, {
    probes: platformProbes
  }, admin);
  decideAppeal(evaluation, appeal.appealId, { outcome: 'upheld', rationale: 'confirmed' }, admin);

  assert.deepEqual(evaluation.resultV2.absolute, before);
  assert.equal(evaluation.appeals.length, 1);
  assert.equal(evaluation.appealEvents.length, 3);
  assert.equal(evaluation.appeals[0].status, 'upheld');
  assert.equal(evaluation.appeals[0].originalSnapshot.resultHash, before.resultHash);
  assert.equal(evaluation.appeals[0].version, 1);
});

test('triage and replacement derive platform attribution from probes', () => {
  const evaluation = lockedEvaluation();
  const appeal = createAppeal(evaluation, participant, appealInput);
  assert.throws(
    () => triageAppeal(evaluation, appeal.appealId, {
      attribution: { attribution: 'platform', reasons: ['admin assertion'] }
    }, admin),
    /probes/i
  );

  triageAppeal(evaluation, appeal.appealId, { probes: platformProbes }, admin);
  assert.equal(appeal.triage.attribution, 'platform');
  assert.throws(
    () => authorizeReplacementRun(evaluation, appeal.appealId, {
      runId: 'run_1',
      probes: {
        ...platformProbes,
        scheduler: { ok: true },
        independentWorker: { ok: false, targetFailed: true, attempts: 2 },
        targetFailures: 2
      }
    }, admin),
    /platform|attribution/i
  );
});

test('participant ownership, target, statement, and appeal window are enforced', () => {
  const evaluation = lockedEvaluation();
  assert.throws(
    () => createAppeal(evaluation, { principalId: 'other', role: 'participant' }, appealInput),
    /owner|participant/i
  );
  assert.throws(
    () => createAppeal(evaluation, participant, { ...appealInput, statement: ' ' }),
    /statement/i
  );
  assert.throws(
    () => createAppeal(evaluation, participant, {
      ...appealInput,
      target: { ...appealInput.target, id: 'unknown' }
    }),
    /target/i
  );
  evaluation.finalizedAt = '2026-07-20T00:00:00.000Z';
  assert.throws(() => createAppeal(evaluation, participant, appealInput), /window|expired/i);
});

test('idempotent appeal creation never duplicates the appeal', () => {
  const evaluation = lockedEvaluation();
  const first = createAppeal(evaluation, participant, appealInput);
  const replay = createAppeal(evaluation, participant, appealInput);
  assert.equal(replay.appealId, first.appealId);
  assert.equal(evaluation.appeals.length, 1);
  assert.throws(
    () => createAppeal(evaluation, participant, { ...appealInput, statement: 'different' }),
    /idempotency/i
  );
});

test('only confirmed platform faults authorize one same-config replacement', () => {
  const evaluation = lockedEvaluation();
  const appeal = createAppeal(evaluation, participant, appealInput);
  triageAppeal(evaluation, appeal.appealId, {
    probes: {
      scheduler: { ok: true },
      evidenceStore: { ok: true },
      organizerEndpoint: { ok: true },
      independentWorker: { ok: false, targetFailed: true, attempts: 2 },
      unrelatedAgentHealth: { ok: true },
      targetFailures: 2
    }
  }, admin);
  assert.throws(
    () => authorizeReplacementRun(evaluation, appeal.appealId, { runId: 'run_1', probes: platformProbes }, admin),
    /platform/i
  );

  const platformAppeal = createAppeal(evaluation, participant, {
    ...appealInput, idempotencyKey: 'appeal-create-2'
  });
  triageAppeal(evaluation, platformAppeal.appealId, {
    probes: platformProbes
  }, admin);
  const replacement = authorizeReplacementRun(
    evaluation, platformAppeal.appealId, { runId: 'run_1', probes: platformProbes }, admin
  );
  assert.equal(replacement.replacementForRunId, 'run_1');
  assert.equal(replacement.config.inputHash, 'input-hash');
  assert.equal(replacement.config.seed, 7);
  assert.equal(replacement.config.protocolConfigHash, 'protocol-hash');
  assert.throws(
    () => authorizeReplacementRun(evaluation, platformAppeal.appealId, { runId: 'run_1', probes: platformProbes }, admin),
    /already|replacement/i
  );
  assert.equal(evaluation.runtimeState.runIndex[0].attempts[0].turns[0].runId, 'run_1');
});
