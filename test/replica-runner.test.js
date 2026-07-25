import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildReplicas,
  executeReplicas,
  sealReplicaArena
} from '../src/replica-runner.js';
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

test('seals encrypted evidence references while retaining only safe aggregate projection fields', async () => {
  const sealed = await sealReplicaArena({
    packageHash: 'a'.repeat(64),
    built: { runtimes: [{ runtimeId: 'runtime-a', validity: 'valid', artifactEvidenceIds: ['ev_build'] }] },
    executed: { runtimes: [{ runtimeId: 'runtime-a', runCount: 6, evidenceIds: ['ev_run'], failureCategory: null }] },
    encryptedArenaEvidenceIds: ['ev_build', 'ev_run']
  });

  assert.deepEqual(sealed, {
    status: 'sealed', sealVersion: 'replica-arena-seal/v1', packageHash: 'a'.repeat(64),
    runtimeSummaries: [{ runtimeId: 'runtime-a', validity: 'valid', artifactEvidenceIds: ['ev_build'], runCount: 6, turnCount: 0, failureCategory: null }],
    encryptedArenaEvidenceIds: ['ev_build', 'ev_run'], releasedAt: null
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
    .map((entry) => [entry.turnKey, { resultCommitment: entry.resultCommitment }]));
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
