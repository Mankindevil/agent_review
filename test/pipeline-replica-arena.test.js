import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseReplicaArena } from '../src/arena-release.js';
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
    }
  };
}

test('refuses to release a sealed arena before the immutable absolute lock', () => {
  assert.throws(
    () => releaseReplicaArena(
      { governance: { phase: 'human_open' } },
      {}
    ),
    /absolute.*locked/i
  );
});

test('releases a sealed arena using the locked absolute result without mutation', async () => {
  const evaluation = lockedEvaluation();
  const absolute = evaluation.resultV2.absolute;
  const calls = [];
  const services = {
    evidenceVault: sealedEvidenceVault(),
    runAnonymousArena: async ({ validReplicaIds }) => {
      calls.push(['arena', validReplicaIds]);
      return {
        scoringCube: [
          { scores: { submitted: 88, 'replica:alpha': 70 } },
          { scores: { submitted: 84, 'replica:alpha': 72 } }
        ]
      };
    },
    bootstrapReplicaAdvantage: (cube, validReplicaIds) => {
      calls.push(['bootstrap', cube, validReplicaIds]);
      return {
        status: 'ready',
        submittedMedian: 86,
        bestReplicaId: 'alpha',
        bestReplicaMedian: 71,
        delta: 15,
        conservativeDelta: 12,
        interval: { confidenceLevel: 0.95, low: 12, high: 15 }
      };
    },
    classifyDualTrackRating: (input) => {
      calls.push(['rating', input]);
      return {
        status: 'final',
        code: 'HARD',
        label: '夯',
        differenceStable: true
      };
    },
    now: () => '2026-07-25T12:01:00.000Z'
  };

  const released = await releaseReplicaArena(evaluation, services);

  assert.equal(released.replicaArena.status, 'released');
  assert.equal(released.replicaArena.releasedAt, '2026-07-25T12:01:00.000Z');
  assert.equal(released.governance.replicaReleasedAt, '2026-07-25T12:01:00.000Z');
  assert.strictEqual(released.resultV2.absolute, absolute);
  assert.equal(released.resultV2.absolute.total, 82);
  assert.deepEqual(released.resultV2.replica, {
    status: 'released',
    submittedMedian: 86,
    runtimes: [{ runtimeId: 'alpha', valid: true, median: 71 }],
    bestBaseline: { runtimeId: 'alpha', median: 71 },
    delta: 15,
    conservativeDelta: 12,
    ci95: { confidenceLevel: 0.95, low: 12, high: 15 },
    differenceStable: true
  });
  assert.equal(released.resultV2.rating.label, '夯');
  assert.deepEqual(calls.map(([name]) => name), ['arena', 'bootstrap', 'rating']);
  assert.deepEqual(calls[0][1], ['alpha']);
  assert.deepEqual(calls[1][2], ['alpha']);
  assert.equal(calls[2][1].absoluteTotal, 82);
  assert.equal(calls[2][1].scenarioScore, 64);
  assert.equal(calls[2][1].objectiveCoverage, 0.75);

  const publicView = projectEvaluation(released, { audience: 'public' });
  assert.deepEqual(publicView.governance, {
    phase: 'absolute_locked',
    absoluteLockedAt: '2026-07-25T12:00:00.000Z',
    resultHash: 'a'.repeat(64),
    replicaReleasedAt: '2026-07-25T12:01:00.000Z'
  });
  assert.equal(publicView.resultV2.replica.status, 'released');
});

test('loads sealed test and output material before invoking the default arena adapter', async () => {
  const evaluation = lockedEvaluation();
  let arenaOptions;
  const released = await releaseReplicaArena(evaluation, {
    evidenceVault: {
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
    },
    runAnonymousArena: async (options) => {
      arenaOptions = options;
      return {
        scoringCube: [
          { scores: { submitted: 88, 'replica:alpha': 70 } },
          { scores: { submitted: 84, 'replica:alpha': 72 } }
        ]
      };
    },
    bootstrapReplicaAdvantage: () => ({
      status: 'ready',
      submittedMedian: 86,
      bestReplicaId: 'alpha',
      bestReplicaMedian: 71,
      delta: 15,
      conservativeDelta: 12,
      interval: { confidenceLevel: 0.95, low: 12, high: 15 }
    }),
    classifyDualTrackRating: () => ({
      status: 'final', code: 'HARD', label: '夯', differenceStable: true
    }),
    now: () => '2026-07-25T12:01:00.000Z'
  });

  assert.equal(released.replicaArena.status, 'released');
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
  assert.equal(arenaOptions.evidenceVault.get instanceof Function, true);
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
  assert.strictEqual(released.resultV2.absolute, evaluation.resultV2.absolute);
});

test('does not overwrite an already released arena', () => {
  const evaluation = lockedEvaluation();
  evaluation.replicaArena.status = 'released';
  evaluation.replicaArena.releasedAt = '2026-07-25T12:01:00.000Z';
  evaluation.resultV2.replica = { status: 'released', delta: 12 };

  assert.strictEqual(releaseReplicaArena(evaluation, {}), evaluation);
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
