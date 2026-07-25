import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildReplicas,
  executeReplicas,
  sealReplicaArena
} from '../src/replica-runner.js';
import { createReplicaAdapter } from '../src/replica-adapter.js';
import { canonicalJson } from '../src/evidence.js';

const CARD = {
  name: 'Replica fixture', description: 'Uses supplied input only.', version: '1.0.0',
  capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
  skills: [{ id: 'reply', name: 'Reply', description: 'Reply to input.', tags: [], examples: [] }],
  supportedInterfaces: [{ url: 'https://submitted.example/a2a' }]
};
const EXAMPLES = [{
  id: 'public-example', name: 'Public example', constraints: [], turns: [{
    input: { parts: [{ type: 'text', text: 'Public prompt.' }] },
    acceptanceCriteria: []
  }]
}];
const TEST_PLAN = {
  rubricVersion: 'a2a-black-box-v1', defaultRepeatCount: 3,
  tests: [{
    testId: 'test_same_input', repeatCount: 3, contextPolicy: 'reuse-within-example',
    timing: { timeoutMs: 50 }, turns: [
      { input: { parts: [{ type: 'text', text: 'first hidden input' }] } },
      { input: { parts: [{ type: 'text', text: 'second hidden input' }] } }
    ]
  }]
};

test('builds each healthy runtime once from one safe package and never chooses a baseline', async () => {
  const builds = [];
  const vault = memoryVault();
  const runtimes = [{ id: 'runtime-a' }, { id: 'runtime-b' }];
  const adapters = Object.fromEntries(runtimes.map((runtime) => [runtime.id, fakeAdapter(runtime.id, { builds })]));

  const built = await buildReplicas({
    agentCard: CARD,
    agentExamples: EXAMPLES,
    runtimes,
    adapters,
    evidenceVault: vault,
    rubricVersion: 'a2a-black-box-v1',
    now: () => '2026-07-25T12:00:00.000Z',
    createId: ids()
  });

  assert.equal(builds.length, 2);
  assert.equal(new Set(builds.map((item) => item.package.manifest.contentHash)).size, 1);
  for (const { package: replicaPackage } of builds) {
    const serialized = canonicalJson(replicaPackage);
    for (const forbidden of ['submitted.example', 'hidden input', 'submittedOutput', 'absoluteReview', 'Bearer']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  }
  assert.equal(built.runtimes.every((item) => item.validity === 'pending-first-run'), true);
  assert.equal(Object.hasOwn(built, 'bestReplicaId'), false);
  assert.equal(vault.records.length, 2);
});

test('runs three repeats with cloned identical current inputs and destroys every example context', async () => {
  const calls = [];
  const disposed = [];
  const vault = memoryVault();
  const adapter = fakeAdapter('runtime-a', { calls, disposed });
  const build = await buildReplicas({
    agentCard: CARD, agentExamples: EXAMPLES, runtimes: [{ id: 'runtime-a' }],
    adapters: { 'runtime-a': adapter }, evidenceVault: vault,
    rubricVersion: 'a2a-black-box-v1', now: () => '2026-07-25T12:00:00.000Z', createId: ids()
  });

  const executed = await executeReplicas({
    testPlan: structuredClone(TEST_PLAN),
    replicas: build,
    adapters: { 'runtime-a': adapter }, evidenceVault: vault,
    now: () => '2026-07-25T12:00:01.000Z', createId: ids(),
    submittedInputForTurn: (test, turnIndex) => structuredClone(test.turns[turnIndex].input)
  });

  assert.equal(calls.length, 6);
  assert.equal(disposed.length, 3);
  assert.equal(new Set(calls.filter((item) => item.turnIndex === 0).map((item) => item.context)).size, 3);
  for (const call of calls) {
    assert.equal(canonicalJson(call.input), canonicalJson(TEST_PLAN.tests[0].turns[call.turnIndex].input));
  }
  assert.equal(TEST_PLAN.tests[0].turns[0].input.parts[0].text, 'first hidden input');
  assert.equal(executed.runtimes[0].runCount, 3);
  assert.equal(executed.runtimes[0].turnCount, 6);
  assert.equal(vault.records.length, 7);
  for (const record of vault.records) {
    assert.equal(record.runId.includes('runtime-a'), false);
    assert.equal(record.testId.includes('hidden'), false);
    assert.equal(record.testId, 'replica_evidence');
  }
});

test('standard adapter receives same-example history lengths zero then one in every repeat', async () => {
  const historyLengths = [];
  const runtime = { id: 'runtime-a' };
  const adapter = createReplicaAdapter(runtime, 'live', {
    config: {
      kind: 'remote-http',
      url: 'https://replica-runtime.invalid/run'
    },
    health: async () => ({
      ready: true,
      budgetEnforcement: {
        wallClock: 'hard',
        tokens: 'hard',
        outputBytes: 'hard',
        network: 'hard'
      }
    }),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.action === 'build_replica') {
        return new Response(JSON.stringify(
          artifact(runtime.id, body.replicaPackage.manifest.contentHash)
        ));
      }
      historyLengths.push(body.contextHandle.history.length);
      return new Response(JSON.stringify({
        status: 'completed',
        messageParts: [{ type: 'text', text: 'reply' }],
        artifacts: [],
        durationMs: 1,
        error: null,
        budgetUsage: { tokens: 1 },
        evidence: {}
      }));
    }
  });
  const vault = memoryVault();
  const built = await buildReplicas({
    agentCard: CARD,
    agentExamples: EXAMPLES,
    runtimes: [runtime],
    adapters: { 'runtime-a': adapter },
    evidenceVault: vault,
    rubricVersion: 'a2a-black-box-v1',
    now: () => '2026-07-25T12:00:00.000Z',
    createId: ids()
  });

  await executeReplicas({
    testPlan: structuredClone(TEST_PLAN),
    replicas: built,
    adapters: { 'runtime-a': adapter },
    evidenceVault: vault,
    now: () => '2026-07-25T12:00:01.000Z',
    createId: ids()
  });

  assert.deepEqual(historyLengths, [0, 1, 0, 1, 0, 1]);
});

test('seals encrypted evidence references while retaining only safe aggregate projection fields', async () => {
  const buildCommitment = {
    evidenceId: `ev_${'1'.repeat(64)}`,
    recordHash: '2'.repeat(64),
    payloadHash: '3'.repeat(64)
  };
  const runCommitment = {
    evidenceId: `ev_${'4'.repeat(64)}`,
    recordHash: '5'.repeat(64),
    payloadHash: '6'.repeat(64)
  };
  const sealed = await sealReplicaArena({
    packageHash: 'a'.repeat(64),
    packageGeneratedAt: '2026-07-25T12:00:00.000Z',
    testPlanHash: 'f'.repeat(64),
    built: { runtimes: [{ runtimeId: 'runtime-a', validity: 'valid', artifactEvidenceIds: [buildCommitment.evidenceId], evidenceCommitments: [buildCommitment] }] },
    executed: { runtimes: [{ runtimeId: 'runtime-a', runCount: 6, evidenceIds: [runCommitment.evidenceId], evidenceCommitments: [runCommitment], failureCategory: null }] },
    encryptedArenaEvidenceIds: [buildCommitment.evidenceId, runCommitment.evidenceId]
  });

  assert.deepEqual(sealed, {
    status: 'sealed', sealVersion: 'replica-arena-seal/v1', packageHash: 'a'.repeat(64),
    packageGeneratedAt: '2026-07-25T12:00:00.000Z',
    testPlanHash: 'f'.repeat(64),
    runtimeSummaries: [{ runtimeId: 'runtime-a', validity: 'valid', artifactEvidenceIds: [buildCommitment.evidenceId], runCount: 6, turnCount: 0, failureCategory: null, evidenceCommitments: [buildCommitment, runCommitment] }],
    evidenceCommitments: [buildCommitment, runCommitment],
    encryptedArenaEvidenceIds: [buildCommitment.evidenceId, runCommitment.evidenceId], releasedAt: null
  });
});

test('stops a runtime after its execution boundary cannot start and never counts it as a submitted-Agent win', async () => {
  let calls = 0;
  const vault = memoryVault();
  const adapter = fakeAdapter('runtime-a');
  adapter.run = async () => {
    calls += 1;
    const error = new Error('sandbox did not start');
    error.code = 'EXECUTION_BOUNDARY_NOT_STARTED';
    throw error;
  };
  const built = await buildReplicas({
    agentCard: CARD, agentExamples: EXAMPLES, runtimes: [{ id: 'runtime-a' }],
    adapters: { 'runtime-a': adapter }, evidenceVault: vault,
    rubricVersion: 'a2a-black-box-v1', now: () => '2026-07-25T12:00:00.000Z', createId: ids()
  });
  const oneTurnPlan = {
    defaultRepeatCount: 3,
    tests: [{ testId: 'test_boundary', repeatCount: 3, timing: { timeoutMs: 50 }, turns: [{ input: { parts: [{ type: 'text', text: 'x' }] } }] }]
  };
  const executed = await executeReplicas({
    testPlan: oneTurnPlan, replicas: built, adapters: { 'runtime-a': adapter },
    evidenceVault: vault, now: () => '2026-07-25T12:00:01.000Z', createId: ids()
  });

  assert.equal(calls, 1);
  assert.equal(executed.runtimes[0].validity, 'invalid-infrastructure');
  assert.equal(executed.runtimes[0].runCount, 0);
});

test('freezes pristine current input, uses opaque adapter metadata, and holds unknown attribution without later cells', async () => {
  let calls = 0;
  const vault = memoryVault();
  const adapter = fakeAdapter('runtime-a');
  adapter.run = async (_artifact, input, context, _budget, options) => {
    calls += 1;
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.parts), true);
    assert.match(context.id, /^ctx_/u);
    assert.deepEqual(Object.keys(options).sort(), ['idempotencyKey', 'seed']);
    assert.match(options.idempotencyKey, /^op_[a-f0-9]{32}$/u);
    assert.throws(() => { input.parts[0].text = 'mutated'; }, TypeError);
    throw Object.assign(new Error('unclassified runtime state'), { code: 'UNCLASSIFIED' });
  };
  const built = await buildReplicas({
    agentCard: CARD, agentExamples: EXAMPLES, runtimes: [{ id: 'runtime-a' }],
    adapters: { 'runtime-a': adapter }, evidenceVault: vault,
    rubricVersion: 'a2a-black-box-v1', now: () => '2026-07-25T12:00:00.000Z', createId: ids(), seed: 7
  });
  const executed = await executeReplicas({
    testPlan: { defaultRepeatCount: 3, tests: [{
      testId: 'test_two_turns', repeatCount: 3, timing: { timeoutMs: 50 }, turns: [
        { input: { parts: [{ type: 'text', text: 'one' }] } },
        { input: { parts: [{ type: 'text', text: 'two' }] } }
      ]
    }] },
    replicas: built, adapters: { 'runtime-a': adapter }, evidenceVault: vault,
    now: () => '2026-07-25T12:00:01.000Z', createId: ids(), seed: 7
  });

  assert.equal(calls, 1);
  assert.equal(executed.runtimes[0].validity, 'attribution-pending');
  assert.equal(executed.runtimes[0].runCount, 0);
  assert.equal(executed.runtimes[0].turnCount, 0);
});

test('resumes committed builds and turns from vault commitments without replaying adapters or evidence', async () => {
  const vault = memoryVault();
  const builds = [];
  const calls = [];
  const checkpoints = [];
  const adapter = fakeAdapter('runtime-a', { builds, calls });
  const common = {
    agentCard: CARD, agentExamples: EXAMPLES, runtimes: [{ id: 'runtime-a' }],
    adapters: { 'runtime-a': adapter }, evidenceVault: vault, rubricVersion: 'a2a-black-box-v1',
    now: () => '2026-07-25T12:00:00.000Z', createId: ids(), checkpoint: async (entry) => checkpoints.push(entry)
  };
  const firstBuild = await buildReplicas(common);
  const buildCheckpoint = checkpoints.find((entry) => entry.type === 'build-complete');
  const firstRun = await executeReplicas({ ...common, testPlan: structuredClone(TEST_PLAN), replicas: firstBuild });
  const turns = Object.fromEntries(checkpoints
    .filter((entry) => entry.type === 'turn-evidence-committed')
    .map((entry) => [entry.turnKey, {
      resultCommitment: entry.resultCommitment,
      validity: entry.validity,
      runtimeId: entry.runtimeId,
      packageHash: entry.packageHash,
      testPlanHash: entry.testPlanHash,
      testId: entry.testId,
      repeatIndex: entry.repeatIndex,
      turnIndex: entry.turnIndex,
      inputHash: entry.inputHash
    }]));
  const recordCount = vault.records.length;
  const resumedBuild = await buildReplicas({ ...common, resume: { builds: {
    'runtime-a': { artifactCommitment: buildCheckpoint.artifactCommitment, validity: 'pending-first-run' }
  } } });
  const resumedRun = await executeReplicas({ ...common, testPlan: structuredClone(TEST_PLAN), replicas: resumedBuild, resume: { turns } });

  assert.equal(builds.length, 1);
  assert.equal(calls.length, 6);
  assert.equal(vault.records.length, recordCount);
  assert.equal(resumedRun.runtimes[0].turnCount, firstRun.runtimes[0].turnCount);
});

test('treats checkpoint failures as platform errors and never dispatches an adapter before intent commits', async () => {
  const vault = memoryVault();
  const builds = [];
  const adapter = fakeAdapter('runtime-a', { builds });
  const error = Object.assign(new Error('injected revision conflict'), {
    code: 'REVISION_CONFLICT'
  });

  await assert.rejects(
    buildReplicas({
      agentCard: CARD,
      agentExamples: EXAMPLES,
      runtimes: [{ id: 'runtime-a' }],
      adapters: { 'runtime-a': adapter },
      evidenceVault: vault,
      rubricVersion: 'a2a-black-box-v1',
      now: () => '2026-07-25T12:00:00.000Z',
      createId: ids(),
      checkpoint: async (entry) => {
        if (entry.type === 'build-dispatching') throw error;
      }
    }),
    (caught) => caught === error
  );

  assert.equal(builds.length, 0);
  assert.equal(vault.records.length, 0);
});

test('reuses the committed cell timestamp when dispose evidence commits after a CAS retry', async () => {
  const vault = memoryVault();
  const checkpoints = [];
  const adapter = fakeAdapter('runtime-a');
  adapter.disposeContext = async () => {
    throw Object.assign(new Error('dispose exploded'), {
      code: 'CONTEXT_DISPOSE_FAILED'
    });
  };
  const built = await buildReplicas({
    agentCard: CARD,
    agentExamples: EXAMPLES,
    runtimes: [{ id: 'runtime-a' }],
    adapters: { 'runtime-a': adapter },
    evidenceVault: vault,
    rubricVersion: 'a2a-black-box-v1',
    now: isoSequence(),
    createId: ids()
  });
  const oneTurnPlan = {
    defaultRepeatCount: 3,
    tests: [{
      testId: 'test_dispose_resume',
      repeatCount: 3,
      turns: [{ input: { parts: [{ type: 'text', text: 'x' }] } }]
    }]
  };
  let failed = false;
  await assert.rejects(
    executeReplicas({
      testPlan: oneTurnPlan,
      replicas: built,
      adapters: { 'runtime-a': adapter },
      evidenceVault: vault,
      now: isoSequence(),
      createId: ids(),
      checkpoint: async (entry) => {
        checkpoints.push(entry);
        if (
          entry.type === 'failure-evidence-committed' &&
          !failed
        ) {
          failed = true;
          throw Object.assign(new Error('injected CAS failure'), {
            code: 'REVISION_CONFLICT'
          });
        }
      }
    }),
    /injected CAS failure/iu
  );
  const cellDispatch = checkpoints.find(
    (entry) => entry.type === 'cell-dispatching'
  );
  assert.equal(typeof cellDispatch?.capturedAt, 'string');
  const turns = Object.fromEntries(
    checkpoints
      .filter((entry) => entry.type === 'turn-evidence-committed')
      .map((entry) => [entry.turnKey, {
        resultCommitment: entry.resultCommitment,
        validity: entry.validity,
        runtimeId: entry.runtimeId,
        packageHash: entry.packageHash,
        testPlanHash: entry.testPlanHash,
        testId: entry.testId,
        repeatIndex: entry.repeatIndex,
        turnIndex: entry.turnIndex,
        inputHash: entry.inputHash
      }])
  );
  const recordCount = vault.records.length;

  const resumed = await executeReplicas({
    testPlan: oneTurnPlan,
    replicas: built,
    adapters: { 'runtime-a': adapter },
    evidenceVault: vault,
    now: isoSequence(100),
    createId: ids(),
    resume: {
      testPlanHash: cellDispatch.testPlanHash,
      turns,
      cellDispatches: {
        [cellDispatch.cellKey]: {
          cellKey: cellDispatch.cellKey,
          runtimeId: cellDispatch.runtimeId,
          packageHash: cellDispatch.packageHash,
          testPlanHash: cellDispatch.testPlanHash,
          testId: cellDispatch.testId,
          repeatIndex: cellDispatch.repeatIndex,
          capturedAt: cellDispatch.capturedAt
        }
      }
    }
  });

  assert.equal(resumed.runtimes[0].failureCategory, 'CONTEXT_DISPOSE_FAILED');
  assert.equal(vault.records.length, recordCount);
});

for (const failurePhase of ['run', 'dispose']) {
  test(`a committed ${failurePhase} failure cannot be reversed by a successful resume`, async () => {
    const vault = memoryVault();
    const checkpoints = [];
    let runCalls = 0;
    let disposeCalls = 0;
    let failing = true;
    const adapter = fakeAdapter('runtime-a');
    adapter.run = async () => {
      runCalls += 1;
      if (failing && failurePhase === 'run') {
        throw Object.assign(new Error('unknown run state'), {
          code: 'UNCLASSIFIED'
        });
      }
      return {
        status: 'completed',
        messageParts: [{ type: 'text', text: 'reply' }],
        artifacts: [],
        durationMs: 1,
        error: null,
        budgetUsage: { tokens: 1 },
        evidence: {}
      };
    };
    adapter.disposeContext = async () => {
      disposeCalls += 1;
      if (failing && failurePhase === 'dispose') {
        throw Object.assign(new Error('dispose failed'), {
          code: 'CONTEXT_DISPOSE_FAILED'
        });
      }
    };
    const built = await buildReplicas({
      agentCard: CARD,
      agentExamples: EXAMPLES,
      runtimes: [{ id: 'runtime-a' }],
      adapters: { 'runtime-a': adapter },
      evidenceVault: vault,
      rubricVersion: 'a2a-black-box-v1',
      now: isoSequence(),
      createId: ids()
    });
    const plan = {
      defaultRepeatCount: 3,
      tests: [{
        testId: `test_committed_${failurePhase}`,
        repeatCount: 3,
        turns: [{ input: { parts: [{ type: 'text', text: 'x' }] } }]
      }]
    };
    const first = await executeReplicas({
      testPlan: plan,
      replicas: built,
      adapters: { 'runtime-a': adapter },
      evidenceVault: vault,
      now: isoSequence(),
      createId: ids(),
      checkpoint: async (entry) => checkpoints.push(entry)
    });
    const expectedValidity =
      failurePhase === 'run'
        ? 'attribution-pending'
        : 'invalid-infrastructure';
    assert.equal(first.runtimes[0].validity, expectedValidity);
    const runCallsBefore = runCalls;
    const disposeCallsBefore = disposeCalls;
    failing = false;

    const resumed = await executeReplicas({
      testPlan: plan,
      replicas: built,
      adapters: { 'runtime-a': adapter },
      evidenceVault: vault,
      now: isoSequence(100),
      createId: ids(),
      resume: runnerResumeState(checkpoints)
    });

    assert.equal(resumed.runtimes[0].validity, expectedValidity);
    if (failurePhase === 'run') {
      assert.equal(runCalls, runCallsBefore);
    } else {
      assert.equal(disposeCalls, disposeCallsBefore);
    }
  });
}

test('persists raw unknown and dispose failures without replacing their primary attribution', async () => {
  const vault = memoryVault();
  const adapter = fakeAdapter('runtime-a');
  adapter.run = async () => {
    throw Object.assign(new Error('unclassified runtime state'), {
      code: 'UNCLASSIFIED'
    });
  };
  adapter.disposeContext = async () => {
    throw Object.assign(new Error('cleanup transport failed'), {
      code: 'CONTEXT_DISPOSE_FAILED'
    });
  };
  const built = await buildReplicas({
    agentCard: CARD,
    agentExamples: EXAMPLES,
    runtimes: [{ id: 'runtime-a' }],
    adapters: { 'runtime-a': adapter },
    evidenceVault: vault,
    rubricVersion: 'a2a-black-box-v1',
    now: () => '2026-07-25T12:00:00.000Z',
    createId: ids()
  });
  const executed = await executeReplicas({
    testPlan: {
      defaultRepeatCount: 3,
      tests: [{
        testId: 'test_failure',
        repeatCount: 3,
        turns: [{ input: { parts: [{ type: 'text', text: 'x' }] } }]
      }]
    },
    replicas: built,
    adapters: { 'runtime-a': adapter },
    evidenceVault: vault,
    now: () => '2026-07-25T12:00:01.000Z',
    createId: ids()
  });

  assert.equal(executed.runtimes[0].failureCategory, 'UNCLASSIFIED');
  assert.equal(executed.runtimes[0].validity, 'attribution-pending');
  const failures = vault.records.filter((record) => record.payload.phase === 'failure');
  assert.deepEqual(
    failures.map((record) => record.payload.failurePhase).sort(),
    ['dispose', 'run']
  );
  assert.equal(
    failures.every((record) => !Object.hasOwn(record.payload, 'health')),
    true
  );
  assert.equal(
    executed.runtimes[0].evidenceCommitments.length,
    failures.length
  );
  const sealed = await sealReplicaArena({
    packageHash: built.packageHash,
    packageGeneratedAt: built.packageGeneratedAt,
    testPlanHash: executed.testPlanHash,
    built,
    executed
  });
  for (const record of failures) {
    assert.equal(
      sealed.encryptedArenaEvidenceIds.includes(record.evidenceId),
      true
    );
    assert.equal(
      sealed.evidenceCommitments.some(
        (item) =>
          item.evidenceId === record.evidenceId &&
          item.recordHash === record.recordHash &&
          item.payloadHash === record.payloadHash
      ),
      true
    );
  }
});

for (const failure of [
  {
    name: 'missing adapter',
    adapter: null,
    phase: 'adapter-resolution',
    code: 'ADAPTER_CONFIG_INVALID'
  },
  {
    name: 'health exception',
    adapter: {
      ...fakeAdapter('runtime-a'),
      health: async () => {
        throw Object.assign(new Error('health exploded'), {
          code: 'HEALTH_FAILED'
        });
      }
    },
    phase: 'health',
    code: 'HEALTH_FAILED'
  },
  {
    name: 'unhealthy enforcement',
    adapter: {
      ...fakeAdapter('runtime-a'),
      health: async () => ({
        ready: false,
        code: 'REPLICA_ENFORCEMENT_UNPROVEN',
        budgetEnforcement: {}
      })
    },
    phase: 'health',
    code: 'REPLICA_ENFORCEMENT_UNPROVEN'
  },
  {
    name: 'build exception',
    adapter: {
      ...fakeAdapter('runtime-a'),
      build: async () => {
        throw Object.assign(new Error('build exploded'), {
          code: 'BUILD_FAILED'
        });
      }
    },
    phase: 'build',
    code: 'BUILD_FAILED'
  }
]) {
  test(`persists raw ${failure.name} evidence with complete sealed references`, async () => {
    const vault = memoryVault();
    const built = await buildReplicas({
      agentCard: CARD,
      agentExamples: EXAMPLES,
      runtimes: [{ id: 'runtime-a' }],
      adapters: failure.adapter
        ? { 'runtime-a': failure.adapter }
        : {},
      evidenceVault: vault,
      rubricVersion: 'a2a-black-box-v1',
      now: () => '2026-07-25T12:00:00.000Z',
      createId: ids()
    });

    const summary = built.runtimes[0];
    const raw = vault.records.find(
      (record) => record.payload.phase === 'failure'
    );
    assert.equal(summary.failureCategory, failure.code);
    assert.equal(raw.payload.failurePhase, failure.phase);
    assert.equal(raw.payload.error.code, failure.code);
    assert.equal(
      summary.evidenceCommitments.some(
        (item) =>
          item.evidenceId === raw.evidenceId &&
          item.recordHash === raw.recordHash &&
          item.payloadHash === raw.payloadHash
      ),
      true
    );
  });
}

test('propagates primary evidence storage failure instead of relabeling it as a Replica failure', async () => {
  const storageError = Object.assign(
    new Error('primary evidence storage unavailable'),
    { code: 'EIO' }
  );
  const adapter = fakeAdapter('runtime-a');
  let puts = 0;
  const vault = {
    async put() {
      puts += 1;
      throw storageError;
    },
    async get() {
      throw new Error('unexpected get');
    }
  };

  await assert.rejects(
    buildReplicas({
      agentCard: CARD,
      agentExamples: EXAMPLES,
      runtimes: [{ id: 'runtime-a' }],
      adapters: { 'runtime-a': adapter },
      evidenceVault: vault,
      rubricVersion: 'a2a-black-box-v1',
      now: () => '2026-07-25T12:00:00.000Z',
      createId: ids()
    }),
    (error) => error === storageError
  );
  assert.equal(puts, 1);
});

test('seals complete evidence commitments and package/test-plan provenance for later arena replay', async () => {
  const commitment = {
    evidenceId: `ev_${'1'.repeat(64)}`,
    recordHash: 'b'.repeat(64),
    payloadHash: 'c'.repeat(64)
  };
  const runCommitment = {
    evidenceId: `ev_${'2'.repeat(64)}`,
    recordHash: 'd'.repeat(64),
    payloadHash: 'e'.repeat(64)
  };
  const sealed = await sealReplicaArena({
    packageHash: 'a'.repeat(64),
    packageGeneratedAt: '2026-07-25T12:00:00.000Z',
    testPlanHash: 'f'.repeat(64),
    built: {
      runtimes: [{
        runtimeId: 'runtime-a',
        validity: 'valid',
        artifactEvidenceIds: [commitment.evidenceId],
        artifactCommitment: commitment,
        evidenceCommitments: [commitment]
      }]
    },
    executed: {
      runtimes: [{
        runtimeId: 'runtime-a',
        validity: 'valid',
        runCount: 3,
        turnCount: 3,
        evidenceIds: [runCommitment.evidenceId],
        evidenceCommitments: [runCommitment],
        failureCategory: null
      }]
    }
  });

  assert.equal(sealed.packageGeneratedAt, '2026-07-25T12:00:00.000Z');
  assert.equal(sealed.testPlanHash, 'f'.repeat(64));
  assert.deepEqual(sealed.evidenceCommitments, [commitment, runCommitment]);
  assert.deepEqual(sealed.encryptedArenaEvidenceIds, [
    commitment.evidenceId,
    runCommitment.evidenceId
  ]);
  assert.deepEqual(
    sealed.runtimeSummaries[0].evidenceCommitments,
    [commitment, runCommitment]
  );
});

test('rejects committed evidence whose runtime, phase, coordinates, or evidence identity do not match', async () => {
  const vault = memoryVault();
  const checkpoints = [];
  const adapter = fakeAdapter('runtime-a');
  const common = {
    agentCard: CARD,
    agentExamples: EXAMPLES,
    runtimes: [{ id: 'runtime-a' }],
    adapters: { 'runtime-a': adapter },
    evidenceVault: vault,
    rubricVersion: 'a2a-black-box-v1',
    now: () => '2026-07-25T12:00:00.000Z',
    createId: ids(),
    checkpoint: async (entry) => checkpoints.push(entry)
  };
  const built = await buildReplicas(common);
  await executeReplicas({
    ...common,
    testPlan: structuredClone(TEST_PLAN),
    replicas: built
  });
  const buildStep = checkpoints.find((entry) => entry.type === 'build-complete');
  const turnStep = checkpoints.find((entry) => entry.type === 'turn-evidence-committed');

  await assert.rejects(
    buildReplicas({
      ...common,
      runtimes: [{ id: 'runtime-b' }],
      adapters: { 'runtime-b': fakeAdapter('runtime-b') },
      resume: {
        packageHash: built.packageHash,
        packageGeneratedAt: built.replicaPackage.manifest.generatedAt,
        builds: {
          'runtime-b': {
            validity: 'pending-first-run',
            artifactCommitment: buildStep.artifactCommitment
          }
        }
      }
    }),
    /runtime|commitment|identity/iu
  );

  const forgedKey = turnStep.turnKey;
  await assert.rejects(
    executeReplicas({
      ...common,
      testPlan: structuredClone(TEST_PLAN),
      replicas: built,
      resume: {
        turns: {
          [forgedKey]: {
            resultCommitment: {
              ...turnStep.resultCommitment,
              evidenceId: 'ev_wrong'
            },
            validity: turnStep.validity,
            inputHash: turnStep.inputHash,
            runtimeId: turnStep.runtimeId,
            packageHash: turnStep.packageHash,
            testPlanHash: turnStep.testPlanHash,
            testId: turnStep.testId,
            repeatIndex: turnStep.repeatIndex,
            turnIndex: turnStep.turnIndex
          }
        }
      }
    }),
    /evidence|commitment/iu
  );

  for (const [field, value] of [
    ['runtimeId', 'runtime-b'],
    ['packageHash', '1'.repeat(64)],
    ['testPlanHash', '2'.repeat(64)],
    ['testId', 'wrong-test'],
    ['repeatIndex', 99],
    ['turnIndex', 99],
    ['inputHash', '3'.repeat(64)]
  ]) {
    await assert.rejects(
      executeReplicas({
        ...common,
        testPlan: structuredClone(TEST_PLAN),
        replicas: built,
        resume: {
          turns: {
            [forgedKey]: {
              resultCommitment: turnStep.resultCommitment,
              validity: turnStep.validity,
              runtimeId: turnStep.runtimeId,
              packageHash: turnStep.packageHash,
              testPlanHash: turnStep.testPlanHash,
              testId: turnStep.testId,
              repeatIndex: turnStep.repeatIndex,
              turnIndex: turnStep.turnIndex,
              inputHash: turnStep.inputHash,
              [field]: value
            }
          }
        }
      }),
      new RegExp(field, 'iu')
    );
  }
});

function fakeAdapter(runtimeId, { builds = [], calls = [], disposed = [] } = {}) {
  return {
    async health() {
      return { ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } };
    },
    async build(replicaPackage) {
      builds.push({ package: structuredClone(replicaPackage) });
      return artifact(runtimeId, replicaPackage.manifest.contentHash);
    },
    async run(_artifact, input, context, _budget, options) {
      calls.push({ input: structuredClone(input), context: context.id, turnIndex: input.parts[0].text === 'first hidden input' ? 0 : 1 });
      return { status: 'completed', messageParts: [{ type: 'text', text: 'reply' }], artifacts: [], durationMs: 1, error: null, budgetUsage: { tokens: 1 }, evidence: {} };
    },
    async disposeContext(context) { disposed.push(context.id); }
  };
}

function artifact(runtimeId, packageHash) {
  const content = '# Skill\n\nUse only supplied input.\n';
  return {
    artifactId: `artifact-${runtimeId}`, runtimeId,
    skill: { name: 'Skill', description: 'Uses input.', instructions: ['Use the supplied input only.'] },
    files: [{ path: 'SKILL.md', mediaType: 'text/markdown', byteLength: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), content }],
    manifest: { packageHash, budgetVersion: 'replica-budget/v1', budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } },
    buildEvidence: { budgetUsage: { tokens: 1 } }
  };
}

function memoryVault() {
  const records = new Map();
  return {
    records: [],
    async put(record) {
      if (records.has(record.evidenceId)) {
        const error = new Error('already exists'); error.code = 'EEXIST'; throw error;
      }
      records.set(record.evidenceId, record); this.records.push(record); return record;
    },
    async get(evidenceId, recordHash) {
      const record = records.get(evidenceId);
      if (!record || record.recordHash !== recordHash) throw new Error('missing evidence');
      return record;
    }
  };
}

function ids() {
  let index = 0;
  return (prefix = 'id') => `${prefix}_${String(++index).padStart(4, '0')}`;
}

function isoSequence(offset = 0) {
  let index = offset;
  const start = Date.parse('2026-07-25T12:00:00.000Z');
  return () => new Date(start + index++ * 1000).toISOString();
}

function runnerResumeState(entries) {
  const resume = {
    testPlanHash: entries.find(
      (entry) => entry.testPlanHash
    )?.testPlanHash,
    cellDispatches: {},
    turnDispatches: {},
    turns: {},
    failures: {}
  };
  for (const entry of entries) {
    if (entry.type === 'cell-dispatching') {
      resume.cellDispatches[entry.cellKey] = {
        cellKey: entry.cellKey,
        capturedAt: entry.capturedAt,
        runtimeId: entry.runtimeId,
        packageHash: entry.packageHash,
        testPlanHash: entry.testPlanHash,
        testId: entry.testId,
        repeatIndex: entry.repeatIndex
      };
    }
    if (entry.type === 'turn-dispatching') {
      resume.turnDispatches[entry.turnKey] = {
        operationId: entry.operationId,
        capturedAt: entry.capturedAt,
        runtimeId: entry.runtimeId,
        packageHash: entry.packageHash,
        testPlanHash: entry.testPlanHash,
        testId: entry.testId,
        repeatIndex: entry.repeatIndex,
        turnIndex: entry.turnIndex,
        inputHash: entry.inputHash
      };
    }
    if (entry.type === 'turn-evidence-committed') {
      resume.turns[entry.turnKey] = {
        resultCommitment: entry.resultCommitment,
        validity: entry.validity,
        runtimeId: entry.runtimeId,
        packageHash: entry.packageHash,
        testPlanHash: entry.testPlanHash,
        testId: entry.testId,
        repeatIndex: entry.repeatIndex,
        turnIndex: entry.turnIndex,
        inputHash: entry.inputHash
      };
    }
    if (entry.type === 'failure-evidence-committed') {
      resume.failures[entry.failureKey] = {
        failureCommitment: entry.failureCommitment,
        failurePhase: entry.failurePhase,
        runtimeId: entry.runtimeId,
        packageHash: entry.packageHash,
        testPlanHash: entry.testPlanHash,
        testId: entry.testId,
        repeatIndex: entry.repeatIndex,
        turnIndex: entry.turnIndex,
        inputHash: entry.inputHash
      };
    }
  }
  return resume;
}
