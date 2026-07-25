import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseReplicaArena, runSealedModelArena } from '../src/arena-release.js';
import { lockReplicaHumanReview, submitReplicaHumanReview } from '../src/replica-human-review.js';
import { projectEvaluation } from '../src/evaluation-projection.js';

function lockedEvaluation() {
  return {
    id: 'eval_release_gate',
    governance: {
      phase: 'absolute_locked',
      absoluteLockedAt: '2026-07-25T12:00:00.000Z',
      resultHash: 'a'.repeat(64)
    },
    qualification: { status: 'eligible' },
    objectiveCapability: { coverage: 0.75 },
    resultV2: {
      absolute: {
        status: 'locked',
        total: 82,
        dimensions: {
          scenarioValue: { score: 64 },
          agentCapability: { objectiveCoverage: 0.75 }
        },
        resultHash: 'a'.repeat(64)
      },
      replica: { status: 'sealed' },
      rating: { status: 'pending-human' }
    },
    replicaArena: {
      status: 'sealed',
      runtimeSummaries: [{ runtimeId: 'alpha', validity: 'valid' }],
      releasedAt: null
    },
    replicaHumanReviews: [],
    testPlan: {
      tests: [{
        testId: 'test_1',
        repeatCount: 1,
        input: { parts: [{ type: 'text', text: 'Evaluate this.' }] }
      }]
    },
    phase2Execution: {
      testRuns: [{
        testId: 'test_1',
        repeatIndex: 0,
        runs: [{
          response: {
            currentOutput: { text: 'Submitted output.', data: null, artifacts: [] }
          }
        }]
      }]
    },
    replicaCheckpoint: {
      status: 'sealed',
      turns: {
        'alpha:test_1:0:0': {
          runtimeId: 'alpha',
          testId: 'test_1',
          repeatIndex: 0,
          turnIndex: 0,
          resultCommitment: {
            evidenceId: 'ev_alpha_test_1',
            recordHash: 'b'.repeat(64)
          }
        }
      }
    },
    auditEvents: []
  };
}

test('refuses to finalize a sealed arena before the immutable absolute lock', async () => {
  await assert.rejects(
    releaseReplicaArena(
      { governance: { phase: 'human_open' } },
      {}
    ),
    /absolute.*locked/i
  );
});

test('runSealedModelArena stores the model scoring cube without requiring the absolute lock', async () => {
  const evaluation = lockedEvaluation();
  evaluation.governance = { phase: 'human_open' };
  evaluation.resultV2.absolute = { status: 'model-provisional' };
  let arenaOptions;
  const result = await runSealedModelArena(evaluation, {
    evidenceVault: sealedEvidenceVault(),
    runAnonymousArena: async (options) => {
      arenaOptions = options;
      return {
        scoringCube: [
          { testId: 'test_1', repeatIndex: 0, judgeId: 'gpt', scores: { submitted: 88, 'replica:alpha': 70 } }
        ]
      };
    },
    now: () => '2026-07-25T12:01:00.000Z'
  });

  assert.deepEqual(result.replicaArena.modelScoringCube, [
    { testId: 'test_1', repeatIndex: 0, judgeId: 'gpt', scores: { submitted: 88, 'replica:alpha': 70 } }
  ]);
  assert.equal(result.replicaArena.modelArenaRanAt, '2026-07-25T12:01:00.000Z');
  assert.deepEqual(result.replicaArena.modelArenaValidReplicaIds, ['alpha']);
  assert.deepEqual(arenaOptions.testPlan, evaluation.testPlan);
  assert.deepEqual(arenaOptions.submittedOutputs, [{
    testId: 'test_1',
    repeatIndex: 0,
    messageParts: [{ type: 'text', text: 'Submitted output.' }]
  }]);
  assert.deepEqual(arenaOptions.replicas, [{
    runtimeId: 'alpha',
    validity: 'valid',
    outputs: [{
      testId: 'test_1',
      repeatIndex: 0,
      messageParts: [{ type: 'text', text: 'Replica output.' }],
      artifacts: []
    }]
  }]);
});

test('runSealedModelArena is idempotent once the model scoring cube is stored', async () => {
  const evaluation = lockedEvaluation();
  evaluation.governance = { phase: 'human_open' };
  let calls = 0;
  const services = {
    evidenceVault: sealedEvidenceVault(),
    runAnonymousArena: async () => {
      calls += 1;
      return { scoringCube: [{ testId: 'test_1', repeatIndex: 0, judgeId: 'gpt', scores: { submitted: 88, 'replica:alpha': 70 } }] };
    },
    now: () => '2026-07-25T12:01:00.000Z'
  };
  await runSealedModelArena(evaluation, services);
  await runSealedModelArena(evaluation, services);
  assert.equal(calls, 1);
});

test('runSealedModelArena skips invoking the arena when there are no valid Replicas', async () => {
  const evaluation = lockedEvaluation();
  evaluation.governance = { phase: 'human_open' };
  evaluation.replicaArena.runtimeSummaries = [{ runtimeId: 'alpha', validity: 'invalid-infrastructure' }];
  let judged = false;
  const result = await runSealedModelArena(evaluation, {
    runAnonymousArena: async () => { judged = true; },
    now: () => '2026-07-25T12:01:00.000Z'
  });
  assert.equal(judged, false);
  assert.deepEqual(result.replicaArena.modelScoringCube, []);
});

test('marks a sealed arena without valid Replicas unavailable and pending', async () => {
  const evaluation = lockedEvaluation();
  evaluation.replicaArena.runtimeSummaries = [{
    runtimeId: 'alpha',
    validity: 'invalid-infrastructure'
  }];
  let judged = false;

  const released = await releaseReplicaArena(evaluation, {
    runAnonymousArena: async () => { judged = true; },
    now: () => '2026-07-25T12:01:00.000Z'
  });

  assert.equal(judged, false);
  assert.equal(released.replicaArena.status, 'unavailable');
  assert.equal(released.resultV2.replica.status, 'unavailable');
  assert.deepEqual(released.resultV2.rating, {
    status: 'pending-replica',
    code: 'PENDING_REPLICA',
    label: '待复刻'
  });
  assert.equal(released.governance.phase, 'final');
  assert.strictEqual(released.resultV2.absolute, evaluation.resultV2.absolute);
});

test('refuses to finalize when a valid Replica still needs a replica-human lock', async () => {
  const evaluation = lockedEvaluation();
  await assert.rejects(
    releaseReplicaArena(evaluation, { evidenceVault: sealedEvidenceVault() }),
    /replica-human/i
  );
});

test('finalizes once absolute is locked and replica-human review is locked, merging the human judge channel', async () => {
  const evaluation = lockedEvaluation();
  evaluation.testPlan.tests[0].repeatCount = 2;
  evaluation.phase2Execution.testRuns.push({
    testId: 'test_1',
    repeatIndex: 1,
    runs: [{ response: { currentOutput: { text: 'Submitted output 2.', data: null, artifacts: [] } } }]
  });
  evaluation.replicaCheckpoint.turns['alpha:test_1:1:0'] = {
    runtimeId: 'alpha',
    testId: 'test_1',
    repeatIndex: 1,
    turnIndex: 0,
    resultCommitment: { evidenceId: 'ev_alpha_test_1_r1', recordHash: 'c'.repeat(64) }
  };

  submitReplicaHumanReview(evaluation, { principalId: 'p1' }, {
    scores: {
      submitted: { taskConstraint: 85, professionalQuality: 85, evidenceRisk: 85, artifactUsability: 85 },
      'replica:alpha': { taskConstraint: 55, professionalQuality: 55, evidenceRisk: 55, artifactUsability: 55 }
    }
  });
  lockReplicaHumanReview(evaluation, { principalId: 'admin_1', idempotencyKey: 'replica-lock-1' });

  const modelCube = [
    { testId: 'test_1', repeatIndex: 0, judgeId: 'gpt', scores: { submitted: 80, 'replica:alpha': 60 } },
    { testId: 'test_1', repeatIndex: 1, judgeId: 'gpt', scores: { submitted: 70, 'replica:alpha': 50 } },
    { testId: 'test_1', repeatIndex: 0, judgeId: 'claude', scores: { submitted: 90, 'replica:alpha': 70 } },
    { testId: 'test_1', repeatIndex: 1, judgeId: 'claude', scores: { submitted: 60, 'replica:alpha': 40 } }
  ];
  let bootstrapCells;
  const released = await releaseReplicaArena(evaluation, {
    evidenceVault: multiCellEvidenceVault(),
    runAnonymousArena: async () => ({ scoringCube: modelCube }),
    bootstrapReplicaAdvantage: (cells, validReplicaIds) => {
      bootstrapCells = cells;
      assert.deepEqual(validReplicaIds, ['alpha']);
      return {
        status: 'ready',
        submittedMedian: 77.5,
        bestReplicaId: 'alpha',
        bestReplicaMedian: 55,
        delta: 22.5,
        conservativeDelta: 18,
        interval: { confidenceLevel: 0.95, low: 18, high: 22.5 }
      };
    },
    classifyDualTrackRating: (input) => ({
      status: 'final',
      code: 'HARD',
      label: '夯',
      differenceStable: true,
      absoluteTotal: input.absoluteTotal
    }),
    now: () => '2026-07-25T12:01:00.000Z'
  });

  assert.deepEqual(bootstrapCells, [
    { testId: 'test_1', repeatIndex: 0, scores: { submitted: 85, 'replica:alpha': 60 } },
    { testId: 'test_1', repeatIndex: 1, scores: { submitted: 70, 'replica:alpha': 50 } }
  ]);
  assert.equal(released.replicaArena.status, 'released');
  assert.equal(released.replicaArena.releasedAt, '2026-07-25T12:01:00.000Z');
  assert.equal(released.governance.replicaReleasedAt, '2026-07-25T12:01:00.000Z');
  assert.equal(released.governance.phase, 'final');
  assert.equal(released.resultV2.rating.label, '夯');
  assert.deepEqual(released.resultV2.replica, {
    status: 'released',
    submittedMedian: 77.5,
    runtimes: [{ runtimeId: 'alpha', valid: true, median: 55 }],
    bestBaseline: { runtimeId: 'alpha', median: 55 },
    delta: 22.5,
    conservativeDelta: 18,
    ci95: { confidenceLevel: 0.95, low: 18, high: 22.5 },
    differenceStable: true
  });

  const publicView = projectEvaluation(released, { audience: 'public' });
  assert.equal(publicView.resultV2.replica.status, 'released');
});

test('does not overwrite an already released arena', async () => {
  const evaluation = lockedEvaluation();
  evaluation.replicaArena.status = 'released';
  evaluation.replicaArena.releasedAt = '2026-07-25T12:01:00.000Z';
  evaluation.resultV2.replica = { status: 'released', delta: 12 };

  assert.strictEqual(await releaseReplicaArena(evaluation, {}), evaluation);
});

function sealedEvidenceVault() {
  return {
    async get(evidenceId, recordHash) {
      assert.equal(evidenceId, 'ev_alpha_test_1');
      assert.equal(recordHash, 'b'.repeat(64));
      return {
        payload: {
          result: {
            messageParts: [{ type: 'text', text: 'Replica output.' }],
            artifacts: []
          }
        }
      };
    },
    async put(record) { return record; }
  };
}

function multiCellEvidenceVault() {
  return {
    async get(evidenceId) {
      return {
        payload: {
          result: {
            messageParts: [{ type: 'text', text: `Replica output for ${evidenceId}.` }],
            artifacts: []
          }
        }
      };
    },
    async put(record) { return record; }
  };
}
