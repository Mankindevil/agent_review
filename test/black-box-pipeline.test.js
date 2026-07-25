import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compileBlackBoxRunPlan,
  copyEvidenceEncryptionKey,
  copyResumeMacKey,
  PHASE1_EXECUTION_POLICY,
  readBlackBoxRuntimeConfig,
  runBlackBoxFoundation
} from '../src/black-box-pipeline.js';
import { freezeSubmission } from '../src/submission.js';
import { createEvaluationRecord } from '../src/evaluation-model.js';
import { evaluateAcceptance } from '../src/acceptance.js';
import {
  aggregateObjectiveCapability,
  buildObjectiveMetrics
} from '../src/objective-scoring.js';
import { RUBRIC_V1 } from '../src/rubric.js';

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');
const CARD_ENDPOINT_HASH = createHash('sha256')
  .update('https://agent.example/a2a')
  .digest('hex');
const CARD = {
  name: 'Worker Agent',
  description: 'A worker fixture.',
  version: '1.2.3',
  supportedInterfaces: [{
    url: 'https://agent.example/a2a',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }],
  capabilities: {},
  skills: [{ id: 'run', name: 'Run', description: 'Run work.' }]
};
const EXAMPLES = [{
  id: 'unsafe example id',
  name: 'Example',
  turns: [{
    input: { parts: [{ type: 'text', text: 'ping' }] },
    acceptanceCriteria: [{
      id: 'contains output',
      type: 'contains',
      expected: ['done'],
      description: 'Contains done',
      required: true
    }]
  }]
}];

test('deep-freezes the exact Phase 1 public-example policy', () => {
  assert.deepEqual(PHASE1_EXECUTION_POLICY, {
    version: 'phase1-public-examples/v1',
    repeatCount: 3,
    targetMs: 15_000,
    timeoutMs: 45_000,
    streaming: false,
    platformReplacementLimit: 1,
    qualificationRetryDelaysMs: [250, 1000]
  });
  assert.equal(Object.isFrozen(PHASE1_EXECUTION_POLICY), true);
  assert.equal(Object.isFrozen(PHASE1_EXECUTION_POLICY.qualificationRetryDelaysMs), true);
});

test('captures exact flag parsing and resolves enabled evidence configuration once', () => {
  const serverRoot = path.resolve('server-root-fixture');
  for (const value of [undefined, '', 'TRUE', '1', 'false']) {
    const config = readBlackBoxRuntimeConfig({
      A2A_BLACK_BOX_V1_ENABLED: value,
      EVIDENCE_ENCRYPTION_KEY: 'deliberately invalid',
      EVIDENCE_ROOT: 'ignored'
    }, { serverRoot });
    assert.equal(config.enabled, false);
    assert.equal(config.evidenceRoot, null);
    assert.equal(config.resumeMacKey, null);
  }

  const enabled = readBlackBoxRuntimeConfig({
    A2A_BLACK_BOX_V1_ENABLED: 'true',
    EVIDENCE_ENCRYPTION_KEY: VALID_KEY,
    EVIDENCE_ROOT: 'data/evidence'
  }, { serverRoot });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.evidenceRoot, path.resolve(serverRoot, 'data/evidence'));
  assert.equal(enabled.resumeMacKey, undefined);
  assert.equal(enabled.evidenceEncryptionKey, undefined);
  const evidenceKeyCopy = copyEvidenceEncryptionKey(enabled);
  assert.equal(Buffer.isBuffer(evidenceKeyCopy), true);
  assert.equal(evidenceKeyCopy.toString('base64'), VALID_KEY);
  evidenceKeyCopy.fill(0);
  assert.equal(
    copyEvidenceEncryptionKey(enabled).toString('base64'),
    VALID_KEY
  );
  const firstKeyCopy = copyResumeMacKey(enabled);
  const secondKeyCopy = copyResumeMacKey(enabled);
  assert.equal(Buffer.isBuffer(firstKeyCopy), true);
  assert.equal(firstKeyCopy.length, 32);
  assert.notEqual(firstKeyCopy, secondKeyCopy);
  firstKeyCopy.fill(0);
  assert.equal(secondKeyCopy.every((byte) => byte === 0), false);
  assert.deepEqual(copyResumeMacKey(enabled), secondKeyCopy);
  assert.equal(Object.isFrozen(enabled), true);

  const moduleRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const defaultRoot = readBlackBoxRuntimeConfig({
    A2A_BLACK_BOX_V1_ENABLED: 'true',
    EVIDENCE_ENCRYPTION_KEY: VALID_KEY
  });
  assert.equal(
    defaultRoot.evidenceRoot,
    path.resolve(moduleRoot, 'data/evidence')
  );
});

test('compiles deterministic safe three-repeat cells with frozen executable counts', () => {
  const snapshot = frozenSnapshot(EXAMPLES);
  const first = compileBlackBoxRunPlan(snapshot, {
    policy: PHASE1_EXECUTION_POLICY,
    createId: deterministicIds()
  });
  const second = compileBlackBoxRunPlan(snapshot, {
    policy: PHASE1_EXECUTION_POLICY,
    createId: deterministicIds()
  });
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((cell) => cell.identity.repeatIndex), [0, 1, 2]);
  assert.equal(first.every((cell) => /^cell_[a-f0-9]{32}$/u.test(cell.cellId)), true);
  assert.equal(first.every((cell) => /^test_[a-f0-9]{32}$/u.test(cell.identity.testId)), true);
  assert.equal(first.every((cell) => cell.requiredExecutable === 1), true);
  assert.equal(first.every((cell) => cell.turns.length === 1), true);
  assert.deepEqual(first[0].policy, {
    version: 'phase1-public-examples/v1',
    repeatCount: 3,
    targetMs: 15_000,
    timeoutMs: 45_000,
    streaming: false,
    platformReplacementLimit: 1
  });
});

test('qualifies separately, executes exactly three formal samples, persists before manifest, and scores trusted evidence', async () => {
  const { evaluation, store } = workerFixture();
  const operations = [];
  const vault = memoryVault(operations);
  let executeCalls = 0;
  let acceptanceCalls = 0;
  let objectiveInput;
  const credentialVault = {
    get: () => 'agent-secret',
    delete: () => operations.push('credential-delete')
  };
  await runBlackBoxFoundation(evaluation, {
    store,
    events: { emit: () => {} },
    credentialVault,
    evidenceVaultFactory: () => vault,
    executeTurn: async (options) => {
      executeCalls += 1;
      assert.equal(options.authorization, 'agent-secret');
      return successfulRun(options, `ctx-${executeCalls}`);
    },
    evaluateAcceptance: (...args) => {
      acceptanceCalls += 1;
      return evaluateAcceptance(...args);
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    },
    aggregateObjectiveCapability,
    rubric: RUBRIC_V1,
    policy: { ...PHASE1_EXECUTION_POLICY, qualificationRetryDelaysMs: [1, 2] },
    attributeFormalRun: () => 'agent',
    now: monotonicIso(),
    clock: monotonicClock(),
    sleep: async () => {},
    createId: deterministicIds()
  });

  const result = store.get(evaluation.id);
  assert.equal(executeCalls, 4);
  assert.equal(acceptanceCalls, 3);
  assert.equal(result.qualification.status, 'eligible');
  assert.equal(result.qualification.attemptRunIds.length, 1);
  assert.equal(result.runtimeState.runIndex.length, 3);
  assert.deepEqual(
    result.runtimeState.runIndex.map((cell) => cell.identity.repeatIndex),
    [0, 1, 2]
  );
  assert.equal(
    result.runtimeState.runIndex.every((cell) => cell.status === 'completed'),
    true
  );
  assert.equal(objectiveInput.plannedTests[0].requiredExecutable, 1);
  assert.equal(objectiveInput.plannedTests[0].runs.length, 3);
  assert.equal(result.execution.status, 'completed');
  assert.equal(result.execution.stage, 'waiting-model');
  assert.equal(result.resultV2.rating.code, null);
  assert.equal(result.resultV2.rating.label, null);
  assert.equal(JSON.stringify(result).includes('agent-secret'), false);
  assert.ok(operations.indexOf('put') < operations.indexOf('manifest-get'));
  assert.equal(operations.at(-1), 'credential-delete');
  assert.equal(store.expectedRevisions.every(Number.isSafeInteger), true);
  assert.deepEqual(
    vault.records
      .filter((record) => record.runId === 'run_submission_provenance')
      .map((record) => [record.kind, record.grade]),
    [
      ['agent-card-claim', 'C'],
      ['agent-example-claim', 'C']
    ]
  );
  assert.equal(
    store.commits.some(
      (commit) => commit.manifestDelta === 5 &&
        commit.completedTurnDelta === 1
    ),
    true
  );
  assert.equal(
    objectiveInput.plannedTests[0].runs.some(
      (run) => result.qualification.attemptRunIds.includes(run.runId)
    ),
    false
  );
  for (const cell of result.runtimeState.runIndex) {
    const turn = cell.attempts[cell.selectedAttemptIndex].turns[0];
    assert.deepEqual(
      vault.records
        .filter((record) => record.runId === turn.runId)
        .map((record) => [
          record.kind,
          record.grade,
          record.testId,
          record.turnIndex,
          record.repeatIndex
        ]),
      [
        ['protocol-request', 'B', cell.identity.testId, 0, cell.identity.repeatIndex],
        ['protocol-response', 'B', cell.identity.testId, 0, cell.identity.repeatIndex],
        ['platform-timing', 'A', cell.identity.testId, 0, cell.identity.repeatIndex],
        ['transport-fact', 'A', cell.identity.testId, 0, cell.identity.repeatIndex],
        ['agent-output', 'C', cell.identity.testId, 0, cell.identity.repeatIndex]
      ]
    );
  }
});

test('orchestrates a formal Phase 2 evaluation through model lock and opens human review', async () => {
  const snapshot = freezeSubmission({
    agentCard: CARD,
    agentExamples: EXAMPLES,
    config: {
      rubricVersion: 'a2a-black-box-v1',
      hiddenTestPackageVersion: 'black-box-test-plan/v1',
      modelConfigVersion: 'panel-v1',
      runtimeConfigVersion: 'phase2-black-box-runtime/v1'
    },
    frozenAt: '2026-07-25T10:00:00.000Z'
  });
  const evaluation = createEvaluationRecord(snapshot, {
    id: 'eval_phase2',
    createdAt: '2026-07-25T10:00:00.000Z',
    participantAccess: {
      tokenHash: 'a'.repeat(64),
      createdAt: '2026-07-25T10:00:00.000Z'
    },
    authorizationRequired: false,
    endpointHash: 'b'.repeat(64),
    agentVersion: '1.2.3',
    serviceBuildId: null,
    runIndex: []
  });
  const store = memoryStore(evaluation);
  const candidate = (variantType, suffix = '') => ({
    candidateId: `unsafe-${variantType}${suffix}`,
    sourceExampleId: 'unsafe example id',
    variantType,
    changeSummary: `${variantType} in-scope variation`,
    turns: variantType === 'multi-turn'
      ? [{
          input: { parts: [{ type: 'text', text: 'ping multi-turn first' }] }
        }, {
          input: { parts: [{ type: 'text', text: 'ping multi-turn second' }] }
        }]
      : [{
          input: { parts: [{ type: 'text', text: `ping ${variantType}` }] }
        }],
    inheritedCriteriaIds: ['contains output'],
    proposedCriteria: [],
    timingClass: variantType === 'multi-turn' ? 'multiTurn' : 'singleTurn'
  });
  let round = 0;
  const phase2 = {
    enabled: true,
    generatorIdentity: 'mock:generator:model',
    scopeReviewerIdentity: 'mock:scope:model',
    generateHidden: async () => {
      round += 1;
      return {
        candidates: [
          candidate('equivalent'),
          candidate('boundary'),
          candidate('multi-turn')
        ]
      };
    },
    reviewScopes: async (_compilation, candidates) => ({
      decisions: candidates.map((item) => ({
        candidateId: item.candidateId,
        checks: {
          sameDomain: !(round === 1 && item.variantType === 'boundary'),
          declaredOrDemonstratedCapabilityOnly: true,
          noExternalTruthDependency: true,
          difficultyFromAllowedTransformation: true,
          sameInputForAgentAndReplica: true
        },
        approved: !(round === 1 && item.variantType === 'boundary'),
        reasons: round === 1 && item.variantType === 'boundary'
          ? ['Rejected first out-of-scope attempt.']
          : []
      }))
    }),
    runPanel: async ({ contract }) => ({
      status: 'model-locked',
      dimensions: {
        scenarioValue: { score: 70 },
        professionalism: { score: 75 },
        agentCapability: { score: 80 }
      },
      subcriteria: Object.fromEntries(
        contract.subcriterionIds.map((id) => [id, {
          score: 75,
          confidence: 0.8
        }])
      ),
      checkEvidenceIndex: {}
    })
  };

  await runBlackBoxFoundation(evaluation, workerServices(store, {
    phase2,
    executeTurn: async (options) => successfulRun(
      options,
      options.contextId || `ctx-${options.testId}-${options.repeatIndex}`
    )
  }));

  const result = store.get(evaluation.id);
  assert.equal(result.exampleCompilation.compilationVersion, 'example-compilation/v1');
  assert.equal(result.testPlan.status, 'ready');
  assert.equal(result.testPlan.tests.every((item) => item.repeatCount === 3), true);
  assert.equal(result.testPlan.scopeAudit.rejected.length, 1);
  assert.equal(
    result.testPlan.scopeAudit.rejected[0].candidate.generatorCandidateId,
    'unsafe-boundary'
  );
  assert.equal(
    result.testPlan.tests.find(
      (item) => item.variantType === 'boundary'
    ).candidateId.startsWith('phase2_1_'),
    true
  );
  assert.equal(result.absoluteReview.status, 'model-locked');
  assert.equal(result.governance.phase, 'human_open');
  assert.equal(result.resultV2.absolute.status, 'model-provisional');
  assert.deepEqual(result.resultV2.absolute.testSummary.variantCounts, {
    original: 1,
    equivalent: 1,
    boundary: 1,
    multiTurn: 1,
    protocolRecovery: 1
  });
  assert.equal(result.resultV2.absolute.testSummary.plannedCells, 15);
  assert.equal(result.resultV2.absolute.testSummary.completedCells, 15);
  assert.equal(
    result.resultV2.absolute.modelReviewSummary.primarySeatsLocked,
    4
  );
  assert.equal(result.resultV2.rating.status, 'pending-human');
  assert.equal(result.replicaArena.status, 'disabled');
  assert.deepEqual(result.phase2Execution.partialCells, []);
  assert.equal(
    store.commits.some((commit) =>
      commit.manifestDelta > 0 && commit.phase2PartialCells > 0
    ),
    true
  );
});

test('seals Phase 3 replica work after the immutable test plan without exposing its runtime material', async () => {
  const snapshot = freezeSubmission({
    agentCard: CARD,
    agentExamples: EXAMPLES,
    config: {
      rubricVersion: 'a2a-black-box-v1', hiddenTestPackageVersion: 'black-box-test-plan/v1',
      modelConfigVersion: 'panel-v1', runtimeConfigVersion: 'phase2-black-box-runtime/v1'
    },
    frozenAt: '2026-07-25T10:00:00.000Z'
  });
  const evaluation = createEvaluationRecord(snapshot, {
    id: 'eval_phase3_sealed', createdAt: '2026-07-25T10:00:00.000Z',
    participantAccess: { tokenHash: 'a'.repeat(64), createdAt: '2026-07-25T10:00:00.000Z' },
    authorizationRequired: false, endpointHash: 'b'.repeat(64), agentVersion: '1.2.3', serviceBuildId: null, runIndex: []
  });
  const store = memoryStore(evaluation);
  const candidate = (variantType) => ({
    candidateId: `phase3-${variantType}`, sourceExampleId: 'unsafe example id', variantType,
    changeSummary: 'in-scope', timingClass: variantType === 'multi-turn' ? 'multiTurn' : 'singleTurn',
    turns: variantType === 'multi-turn'
      ? [{ input: { parts: [{ type: 'text', text: 'first' }] } }, { input: { parts: [{ type: 'text', text: 'second' }] } }]
      : [{ input: { parts: [{ type: 'text', text: variantType }] } }],
    inheritedCriteriaIds: ['contains output'], proposedCriteria: []
  });
  let builds = 0;
  const phase2 = {
    enabled: true, generatorIdentity: 'generator', scopeReviewerIdentity: 'scope',
    generateHidden: async () => ({ candidates: ['equivalent', 'boundary', 'multi-turn'].map(candidate) }),
    reviewScopes: async (_compilation, candidates) => ({ decisions: candidates.map((item) => ({
      candidateId: item.candidateId,
      checks: { sameDomain: true, declaredOrDemonstratedCapabilityOnly: true, noExternalTruthDependency: true, difficultyFromAllowedTransformation: true, sameInputForAgentAndReplica: true },
      approved: true, reasons: []
    })) }),
    runPanel: async ({ contract }) => ({ status: 'model-locked', dimensions: {}, subcriteria: Object.fromEntries(contract.subcriterionIds.map((id) => [id, { score: 70, confidence: 0.8 }])), checkEvidenceIndex: {} })
  };
  const phase3 = {
    enabled: true,
    runtimes: [{ id: 'sealed-runtime' }],
    adapters: {
      'sealed-runtime': {
        health: async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } }),
        build: async (packet) => { builds += 1; assert.equal(JSON.stringify(packet).includes('agent.example'), false); return replicaArtifact('sealed-runtime', packet.manifest.contentHash); },
        run: async (_artifact, input) => ({ status: 'completed', messageParts: [{ type: 'text', text: input.parts[0].text }], artifacts: [], durationMs: 1, error: null, budgetUsage: { tokens: 1 }, evidence: {} }),
        disposeContext: async () => {}
      }
    }
  };

  await runBlackBoxFoundation(evaluation, workerServices(store, {
    phase2, phase3,
    executeTurn: async (options) => successfulRun(options, options.contextId || `ctx-${options.testId}-${options.repeatIndex}`)
  }));

  const result = store.get(evaluation.id);
  assert.equal(builds, 1);
  assert.equal(result.replicaArena.status, 'sealed');
  assert.deepEqual(result.resultV2.replica, { status: 'sealed', validReplicaCount: 1, pendingAttributionCount: 0 });
  assert.equal(JSON.stringify(result.resultV2.replica).includes('sealed-runtime'), false);
  assert.equal(
    result.evidenceManifest.items.some((item) => item.runId.includes('replica')),
    false
  );
  assert.equal(Object.hasOwn(result, 'replicaCheckpoint'), true);
});

test('deletes ephemeral credentials when worker evidence or credential setup throws', async () => {
  for (const failure of ['evidence-factory', 'credential-get']) {
    const { evaluation, store } = workerFixture();
    const deletes = [];
    const credentialVault = {
      get() {
        if (failure === 'credential-get') {
          throw new Error('credential setup failed');
        }
        return 'ephemeral-agent-secret';
      },
      delete(id) {
        deletes.push(id);
      }
    };
    const services = workerServices(store, {
      credentialVault,
      evidenceVaultFactory: failure === 'evidence-factory'
        ? () => {
            throw new Error('evidence setup failed');
          }
        : () => memoryVault([])
    });

    await assert.rejects(
      runBlackBoxFoundation(evaluation, services),
      new RegExp(`${failure === 'evidence-factory' ? 'evidence' : 'credential'} setup failed`)
    );
    assert.deepEqual(deletes, [evaluation.id]);
  }
});

test('resume completes missing submission provenance without duplicating committed claims', async () => {
  const examples = [
    EXAMPLES[0],
    {
      ...EXAMPLES[0],
      id: 'second-example',
      name: 'Second example'
    }
  ];
  const { evaluation, store } = workerFixture({ examples });
  const vault = memoryVault([]);
  const nextId = deterministicIds();
  let evidenceIds = 0;
  const services = workerServices(store, {
    evidenceVaultFactory: () => vault,
    executeTurn: async (options) => failedQualificationRun(options),
    createId: (prefix) => {
      if (prefix === 'ev' && (evidenceIds += 1) === 3) {
        throw new Error('simulated crash after partial submission provenance');
      }
      return nextId(prefix);
    }
  });

  await assert.rejects(
    runBlackBoxFoundation(evaluation, services),
    /partial submission provenance/u
  );
  assert.deepEqual(
    store.get(evaluation.id).evidenceManifest.items
      .filter((item) => item.runId === 'run_submission_provenance')
      .map((item) => item.kind),
    ['agent-card-claim', 'agent-example-claim']
  );

  await runBlackBoxFoundation(store.get(evaluation.id), services);

  const provenanceItems = store.get(evaluation.id).evidenceManifest.items.filter(
    (item) => item.runId === 'run_submission_provenance'
  );
  assert.deepEqual(
    provenanceItems.map((item) => item.kind),
    [
      'agent-card-claim',
      'agent-example-claim',
      'agent-example-claim'
    ]
  );
  assert.equal(
    new Set(provenanceItems.map((item) => item.testId)).size,
    3
  );
  assert.equal(
    vault.records.filter(
      (record) => record.runId === 'run_submission_provenance'
    ).length,
    3
  );
});

test('commits a valid qualification observation, evidence, and eligibility atomically', async () => {
  const { evaluation, store } = workerFixture();
  const committedStates = [];
  const mutate = store.mutate.bind(store);
  store.mutate = async (...args) => {
    const committed = await mutate(...args);
    committedStates.push(committed);
    return committed;
  };

  await runBlackBoxFoundation(evaluation, workerServices(store));

  const firstObservedQualification = committedStates.find(
    (record) => record.qualification.attemptRunIds.length > 0
  );
  assert.ok(firstObservedQualification);
  assert.equal(firstObservedQualification.qualification.status, 'eligible');
  const [qualificationRunId] =
    firstObservedQualification.qualification.attemptRunIds;
  assert.equal(
    firstObservedQualification.evidenceManifest.items.some(
      (item) => item.runId === qualificationRunId
    ),
    true
  );
  assert.equal(
    firstObservedQualification.auditEvents.some(
      (event) => event.type === 'qualification-eligible'
    ),
    true
  );
});

test('retries qualification exactly twice, never scores it, and ends ineligible', async () => {
  const { evaluation, store } = workerFixture();
  const delays = [];
  let executeCalls = 0;
  let acceptanceCalls = 0;
  let scoringCalls = 0;
  let deleted = 0;
  await runBlackBoxFoundation(evaluation, {
    store,
    events: { emit: () => {} },
    credentialVault: { get: () => undefined, delete: () => { deleted += 1; } },
    evidenceVaultFactory: () => memoryVault([]),
    executeTurn: async (options) => {
      executeCalls += 1;
      return failedQualificationRun(options);
    },
    evaluateAcceptance: () => { acceptanceCalls += 1; },
    buildObjectiveMetrics: () => { scoringCalls += 1; },
    aggregateObjectiveCapability: () => { scoringCalls += 1; },
    rubric: RUBRIC_V1,
    policy: { ...PHASE1_EXECUTION_POLICY, qualificationRetryDelaysMs: [250, 1000] },
    now: monotonicIso(),
    clock: monotonicClock(),
    sleep: async (delay) => { delays.push(delay); },
    createId: deterministicIds()
  });

  const result = store.get(evaluation.id);
  assert.equal(executeCalls, 3);
  assert.deepEqual(delays, [250, 1000]);
  assert.equal(acceptanceCalls, 0);
  assert.equal(scoringCalls, 0);
  assert.equal(deleted, 1);
  assert.equal(result.qualification.status, 'ineligible');
  assert.equal(result.qualification.attemptRunIds.length, 3);
  assert.equal(result.execution.stage, 'ineligible');
  assert.equal(result.objectiveCapability.status, 'not-applicable');
  assert.equal(result.resultV2, null);
});

test('a protocol-valid failed Task qualifies but every formal failed Task is one selected Agent observation', async () => {
  const { evaluation, store } = workerFixture();
  let calls = 0;
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      calls += 1;
      return failedTaskRun(options);
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  const result = store.get(evaluation.id);
  assert.equal(calls, 4);
  assert.equal(result.qualification.status, 'eligible');
  assert.deepEqual(
    result.runtimeState.runIndex.map((cell) => cell.attempts.length),
    [1, 1, 1]
  );
  assert.deepEqual(
    objectiveInput.plannedTests[0].runs.map((run) => [
      run.attribution,
      run.terminalSuccess
    ]),
    [
      ['agent', false],
      ['agent', false],
      ['agent', false]
    ]
  );
});

test('formal attribution permits one platform replacement, excludes pending, and never retries Agent failure', async () => {
  const { evaluation, store } = workerFixture();
  const formalAttributions = ['platform', 'agent', 'pending', 'agent'];
  let calls = 0;
  let formalIndex = 0;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      calls += 1;
      if (calls === 1) return successfulRun(options, 'ctx-qualification');
      const attribution = formalAttributions[formalIndex++];
      if (attribution === 'pending') return transportFailureRun(options);
      if (attribution === 'agent') {
        const run = failedTaskRun(options);
        run.testAttribution = attribution;
        return run;
      }
      const run = successfulRun(options, null);
      run.testAttribution = attribution;
      return run;
    },
    attributeFormalRun: (run) => run.testAttribution ||
      (run.error?.category === 'transport' ? 'pending' : 'agent')
  }));

  const result = store.get(evaluation.id);
  assert.equal(calls, 5);
  assert.deepEqual(
    result.runtimeState.runIndex.map((cell) => [
      cell.status,
      cell.selectedAttemptIndex,
      cell.attempts.map((attempt) => attempt.attribution)
    ]),
    [
      ['completed', 1, ['platform', 'agent']],
      ['attribution-pending', null, ['pending']],
      ['completed', 0, ['agent']]
    ]
  );
  assert.equal(
    result.runtimeState.runIndex[0].attempts[0].evidenceIds.length > 0,
    true
  );
});

test('a second platform failure becomes unavailable and cannot create a third attempt', async () => {
  const { evaluation, store } = workerFixture();
  let calls = 0;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      calls += 1;
      const run = successfulRun(options, null);
      run.testAttribution = calls <= 3 && calls > 1 ? 'platform' : 'agent';
      return run;
    },
    attributeFormalRun: (run) => run.testAttribution
  }));

  const result = store.get(evaluation.id);
  assert.equal(calls, 5);
  assert.equal(result.runtimeState.runIndex[0].status, 'unavailable-platform');
  assert.equal(result.runtimeState.runIndex[0].attempts.length, 2);
  assert.equal(result.runtimeState.runIndex[0].selectedAttemptIndex, null);
});

test('multi-turn cells start fresh, retain only their own context, and use one shrinking deadline', async () => {
  const examples = [{
    ...EXAMPLES[0],
    turns: [
      EXAMPLES[0].turns[0],
      {
        input: { parts: [{ type: 'text', text: 'continue' }] },
        acceptanceCriteria: []
      }
    ]
  }];
  const policy = {
    ...PHASE1_EXECUTION_POLICY,
    targetMs: 50,
    timeoutMs: 100,
    qualificationRetryDelaysMs: [1, 2]
  };
  const { evaluation, store } = workerFixture({ examples, policy });
  const formalOptions = [];
  let objectiveInput;
  let calls = 0;
  let cellIndex = -1;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    policy,
    clock: incrementingClock(10),
    executeTurn: async (options) => {
      calls += 1;
      if (calls === 1) return successfulRun(options, 'ctx-qualification');
      if (options.turnIndex === 0) cellIndex += 1;
      formalOptions.push(captureTurnOptions(options));
      return successfulRun(options, `ctx-cell-${cellIndex}`);
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  const result = store.get(evaluation.id);
  assert.equal(calls, 7);
  for (let index = 0; index < formalOptions.length; index += 2) {
    assert.equal(formalOptions[index].contextId, undefined);
    assert.equal(formalOptions[index].taskId, undefined);
    assert.equal(
      formalOptions[index + 1].contextId,
      `ctx-cell-${index / 2}`
    );
    assert.equal(formalOptions[index + 1].taskId, undefined);
    assert.ok(
      formalOptions[index + 1].timeoutMs < formalOptions[index].timeoutMs
    );
  }
  assert.deepEqual(
    result.runtimeState.runIndex.map(
      (cell) => cell.attempts[0].timing.durationMs
    ),
    [50, 50, 50]
  );
  assert.equal(
    objectiveInput.contextChecks.filter(
      (check) => check.kind === 'retention'
    ).every((check) => check.status === 'passed'),
    true
  );
  assert.equal(
    objectiveInput.contextChecks.filter(
      (check) => check.kind === 'correction'
    ).length,
    0
  );
  assert.equal(
    objectiveInput.contextChecks.filter(
      (check) => check.kind === 'isolation'
    ).every((check) => check.status === 'passed'),
    true
  );
});

test('selected sample timing uses the full active cell wall clock', async () => {
  const policy = {
    ...PHASE1_EXECUTION_POLICY,
    targetMs: 100,
    timeoutMs: 1_000,
    qualificationRetryDelaysMs: [1, 2]
  };
  const { evaluation, store } = workerFixture({ policy });
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    policy,
    clock: incrementingClock(10)
  }));

  const selectedAttempts = store.get(evaluation.id).runtimeState.runIndex.map(
    (cell) => cell.attempts[cell.selectedAttemptIndex]
  );
  assert.deepEqual(
    selectedAttempts.map((attempt) => attempt.timing.durationMs),
    [30, 30, 30]
  );
  assert.deepEqual(
    selectedAttempts.map((attempt) => attempt.activeElapsedMs),
    [30, 30, 30]
  );
  assert.equal(
    selectedAttempts.every(
      (attempt) =>
        attempt.timing.durationMs >
        attempt.turns.reduce(
          (sum, turn) => sum + turn.timing.durationMs,
          0
        )
    ),
    true
  );
});

test('an interrupted Task continues only inside its cell and a later completion decides terminal success', async () => {
  const examples = [{
    ...EXAMPLES[0],
    turns: [
      EXAMPLES[0].turns[0],
      {
        input: { parts: [{ type: 'text', text: 'continue' }] },
        acceptanceCriteria: [{
          id: 'continued-output',
          type: 'contains',
          expected: ['done'],
          description: 'Contains done',
          required: true
        }]
      }
    ]
  }];
  const { evaluation, store } = workerFixture({ examples });
  const formalOptions = [];
  let calls = 0;
  let cellIndex = -1;
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      calls += 1;
      if (calls === 1) return successfulRun(options, 'ctx-qualification');
      if (options.turnIndex === 0) cellIndex += 1;
      formalOptions.push(captureTurnOptions(options));
      const run = successfulRun(options, `ctx-cell-${cellIndex}`);
      run.response.normalized.responseKind = 'task';
      run.response.normalized.taskId = `task-cell-${cellIndex}`;
      if (options.turnIndex === 0) {
        run.outcome = { status: 'succeeded', lifecycle: 'interrupted' };
      }
      return run;
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  assert.equal(calls, 7);
  for (let index = 0; index < formalOptions.length; index += 2) {
    assert.equal(formalOptions[index].taskId, undefined);
    assert.equal(
      formalOptions[index + 1].taskId,
      `task-cell-${index / 2}`
    );
  }
  assert.deepEqual(
    objectiveInput.plannedTests[0].runs.map((run) => run.terminalSuccess),
    [true, true, true]
  );
  const correctionChecks = objectiveInput.contextChecks.filter(
    (check) => check.kind === 'correction'
  );
  assert.equal(correctionChecks.length, 3);
  assert.equal(
    correctionChecks.every((check) => check.status === 'passed'),
    true
  );
});

test('a crash after dispatch interrupts with the unknown turn still dispatched and never retries it', async () => {
  const { evaluation, store } = workerFixture();
  let calls = 0;
  await assert.rejects(
    runBlackBoxFoundation(evaluation, workerServices(store, {
      executeTurn: async (options) => {
        calls += 1;
        if (calls === 1) return successfulRun(options, 'ctx-qualification');
        throw new Error('scheduler crashed after dispatch');
      }
    })),
    /scheduler crashed/
  );

  const result = store.get(evaluation.id);
  assert.equal(calls, 2);
  assert.equal(result.execution.status, 'interrupted');
  assert.equal(result.runtimeState.runIndex[0].attempts.length, 1);
  assert.equal(
    result.runtimeState.runIndex[0].attempts[0].turns[0].status,
    'dispatched'
  );
  assert.equal(result.runtimeState.runIndex[0].attempts[0].evidenceIds.length, 0);
});

test('trusted scoring rejects a manifest record with mismatched formal coordinates and interrupts safely', async () => {
  const { evaluation, store } = workerFixture();
  const vault = memoryVault([]);
  const originalGet = vault.get;
  let corrupted = false;
  vault.get = async (...args) => {
    const record = await originalGet(...args);
    if (!corrupted && record.repeatIndex !== undefined) {
      corrupted = true;
      return { ...record, turnIndex: (record.turnIndex ?? 0) + 1 };
    }
    return record;
  };
  let deleted = 0;

  await assert.rejects(
    runBlackBoxFoundation(evaluation, workerServices(store, {
      evidenceVaultFactory: () => vault,
      credentialVault: {
        get: () => undefined,
        delete: () => { deleted += 1; }
      }
    })),
    /provenance mismatch/i
  );

  const result = store.get(evaluation.id);
  assert.equal(result.execution.status, 'interrupted');
  assert.equal(result.execution.stage, 'evidence');
  assert.equal(result.resultV2, null);
  assert.equal(deleted, 1);
});

test('resume skips qualification and completed samples and executes only genuinely planned cells', async () => {
  const { evaluation, store } = workerFixture();
  const vault = memoryVault([]);
  let calls = 0;
  const services = workerServices(store, {
    evidenceVaultFactory: () => vault,
    executeTurn: async (options) => {
      calls += 1;
      return successfulRun(options, `ctx-${calls}`);
    }
  });
  await runBlackBoxFoundation(evaluation, services);
  const completed = store.get(evaluation.id);
  const missingCell = completed.runtimeState.runIndex[1];
  const completedRunIds = completed.runtimeState.runIndex
    .filter((cell) => cell.cellId !== missingCell.cellId)
    .flatMap((cell) => cell.attempts.flatMap(
      (attempt) => attempt.turns.map((turn) => turn.runId)
    ));
  store.replace({
    ...completed,
    execution: {
      status: 'interrupted',
      stage: 'recovery',
      progress: 60,
      interruptedAt: '2026-07-24T10:01:00.000Z'
    },
    runtimeState: {
      ...completed.runtimeState,
      runIndex: completed.runtimeState.runIndex.map((cell) =>
        cell.cellId === missingCell.cellId
          ? {
              ...cell,
              status: 'planned',
              selectedAttemptIndex: null,
              attempts: []
            }
          : cell
      )
    }
  });
  const callsBeforeResume = calls;
  const resumedRunIds = [];
  await runBlackBoxFoundation(store.get(evaluation.id), {
    ...services,
    executeTurn: async (options) => {
      calls += 1;
      resumedRunIds.push(options.runId);
      return successfulRun(options, 'ctx-resumed');
    }
  });

  assert.equal(calls - callsBeforeResume, 1);
  assert.equal(
    resumedRunIds.some((runId) => completedRunIds.includes(runId)),
    false
  );
  assert.equal(store.get(evaluation.id).qualification.attemptRunIds.length, 1);
  assert.equal(
    store.get(evaluation.id).runtimeState.runIndex.every(
      (cell) => cell.status === 'completed'
    ),
    true
  );
});

test('a cancellation committed while a turn is in flight rejects the post-cancel evidence mutation', async () => {
  const { evaluation, store } = workerFixture();
  const vault = memoryVault([]);
  let calls = 0;
  await assert.rejects(
    runBlackBoxFoundation(evaluation, workerServices(store, {
      evidenceVaultFactory: () => vault,
      executeTurn: async (options) => {
        calls += 1;
        if (calls === 1) return successfulRun(options, 'ctx-qualification');
        const current = store.get(evaluation.id);
        store.replace({
          ...current,
          revision: current.revision + 1,
          execution: {
            status: 'cancelled',
            stage: 'cancelled',
            progress: current.execution.progress,
            cancelledAt: '2026-07-24T10:02:00.000Z'
          }
        });
        return successfulRun(options, 'ctx-too-late');
      }
    })),
    /cancelled/i
  );

  const result = store.get(evaluation.id);
  assert.equal(result.execution.status, 'cancelled');
  assert.equal(result.resultV2, null);
  assert.equal(
    result.runtimeState.runIndex[0].attempts[0].turns[0].status,
    'dispatched'
  );
  const projectedIds = new Set(
    result.evidenceManifest.items.map((item) => item.evidenceId)
  );
  assert.equal(
    vault.records
      .filter((record) => record.repeatIndex !== undefined)
      .some((record) => projectedIds.has(record.evidenceId)),
    false
  );
});

test('resume continues a partial attempt and creates only attempt 1 after a committed platform attempt', async () => {
  const examples = [{
    ...EXAMPLES[0],
    turns: [
      EXAMPLES[0].turns[0],
      {
        input: { parts: [{ type: 'text', text: 'continue' }] },
        acceptanceCriteria: []
      }
    ]
  }];
  const { evaluation, store } = workerFixture({ examples });
  const vault = memoryVault([]);
  let calls = 0;
  const services = workerServices(store, {
    evidenceVaultFactory: () => vault,
    executeTurn: async (options) => {
      calls += 1;
      return successfulRun(options, `ctx-${Math.ceil(calls / 2)}`);
    }
  });
  await runBlackBoxFoundation(evaluation, services);
  const completed = store.get(evaluation.id);
  const partialCell = completed.runtimeState.runIndex[0];
  const platformCell = completed.runtimeState.runIndex[1];
  const partialAttempt = structuredClone(partialCell.attempts[0]);
  partialAttempt.attribution = null;
  partialAttempt.terminalSuccess = null;
  partialAttempt.acceptance = null;
  partialAttempt.timing = null;
  partialAttempt.evidenceIds = [...partialAttempt.turns[0].evidenceIds];
  partialAttempt.turns[1] = {
    ...partialAttempt.turns[1],
    status: 'planned',
    sentContextId: null,
    sentTaskId: null,
    contextId: null,
    continuationTaskId: null,
    outcome: null,
    timing: null,
    acceptance: null,
    evidenceIds: []
  };
  const committedPlatformAttempt = {
    ...platformCell.attempts[0],
    attribution: 'platform',
    terminalSuccess: false,
    timing: null
  };
  store.replace({
    ...completed,
    execution: {
      status: 'interrupted',
      stage: 'recovery',
      progress: 50
    },
    runtimeState: {
      ...completed.runtimeState,
      runIndex: completed.runtimeState.runIndex.map((cell) =>
        cell.cellId === partialCell.cellId
          ? {
              ...cell,
              status: 'running',
              selectedAttemptIndex: null,
              attempts: [partialAttempt]
            }
          : cell.cellId === platformCell.cellId
            ? {
                ...cell,
                status: 'planned',
                selectedAttemptIndex: null,
                attempts: [committedPlatformAttempt]
              }
            : cell
      )
    }
  });
  const resumeOptions = [];
  await runBlackBoxFoundation(store.get(evaluation.id), {
    ...services,
    executeTurn: async (options) => {
      resumeOptions.push(captureTurnOptions(options));
      if (resumeOptions.length === 2) return failedTaskRun(options);
      return successfulRun(options, options.contextId || 'ctx-replacement');
    }
  });

  const result = store.get(evaluation.id);
  assert.equal(resumeOptions.length, 2);
  assert.equal(resumeOptions[0].runId, partialAttempt.turns[1].runId);
  assert.equal(
    resumeOptions[0].contextId,
    partialAttempt.turns[0].contextId
  );
  assert.equal(
    result.runtimeState.runIndex[0].attempts.length,
    1
  );
  assert.deepEqual(
    result.runtimeState.runIndex[1].attempts.map(
      (attempt) => attempt.attemptIndex
    ),
    [0, 1]
  );
  assert.equal(resumeOptions[1].contextId, undefined);
});

test('skipped required turns produce closed failed checks after an Agent failure', async () => {
  const examples = [{
    ...EXAMPLES[0],
    turns: [
      EXAMPLES[0].turns[0],
      {
        input: { parts: [{ type: 'text', text: 'must not dispatch' }] },
        acceptanceCriteria: [{
          id: 'required-after-failure',
          type: 'contains',
          expected: ['never'],
          description: 'Required later result',
          required: true
        }]
      }
    ]
  }];
  const { evaluation, store } = workerFixture({ examples });
  let calls = 0;
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      calls += 1;
      if (calls === 1) return successfulRun(options, 'ctx-qualification');
      return failedTaskRun(options);
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  assert.equal(calls, 4);
  for (const run of objectiveInput.plannedTests[0].runs) {
    assert.equal(run.acceptance.requiredExecutable, 2);
    assert.equal(run.acceptance.checks.length, 2);
    assert.equal(run.acceptance.checks[1].status, 'failed');
  }
  assert.equal(store.get(evaluation.id).execution.status, 'completed');
});

test('objective adapter emits explicit interface, response, lifecycle, and Part checks plus schema fingerprints', async () => {
  const examples = [{
    ...EXAMPLES[0],
    turns: [{
      input: EXAMPLES[0].turns[0].input,
      acceptanceCriteria: [{
        id: 'structured-output',
        type: 'json-schema',
        schema: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { const: true } },
          additionalProperties: false
        },
        description: 'Returns structured output',
        required: true
      }]
    }]
  }];
  const { evaluation, store } = workerFixture({ examples });
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      const run = successfulRun(options, `ctx-${options.repeatIndex ?? 'q'}`);
      run.response.currentOutput = {
        text: '',
        data: { ok: true },
        artifacts: []
      };
      return run;
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  assert.equal(
    objectiveInput.plannedTests[0].runs.every(
      (run) => /^[a-f0-9]{64}$/u.test(run.schemaFingerprint)
    ),
    true
  );
  assert.equal(
    objectiveInput.a2aChecks.some(
      (check) => check.id === 'a2a_frozen_interface'
    ),
    true
  );
  assert.equal(
    objectiveInput.a2aChecks.some(
      (check) => check.id === 'a2a_card_validity'
    ),
    true
  );
  for (const kind of [
    'response',
    'lifecycle',
    'status_sequence',
    'parts',
    'artifacts'
  ]) {
    assert.equal(
      objectiveInput.a2aChecks.filter(
        (check) => check.id.startsWith(`a2a_${kind}_`)
      ).length,
      3
    );
  }
  assert.equal(
    objectiveInput.a2aChecks.every((check) => check.status === 'passed'),
    true
  );
});

test('A2A lifecycle, status sequence, Part, and Artifact checks use distinct protocol predicates', async () => {
  const { evaluation, store } = workerFixture();
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      const run = successfulRun(
        options,
        `ctx-${options.repeatIndex ?? 'qualification'}`
      );
      if (options.repeatIndex === undefined) return run;
      run.response.rawObjects = [{
        id: `task-${options.repeatIndex}`,
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: []
      }];
      run.response.normalized = {
        ...run.response.normalized,
        responseKind: 'task',
        terminal: true,
        terminalState: 'TASK_STATE_COMPLETED',
        taskId: `task-${options.repeatIndex}`,
        statusSequence: options.repeatIndex === 0
          ? ['TASK_STATE_WORKING']
          : ['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED'],
        parts: options.repeatIndex === 1 ? [{ bogus: true }] : [],
        artifacts: options.repeatIndex === 2
          ? [{ artifactId: 'artifact-empty', parts: [] }]
          : []
      };
      return run;
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  const cells = store.get(evaluation.id).runtimeState.runIndex;
  for (const [repeatIndex, cell] of cells.entries()) {
    const byPrefix = (prefix) => objectiveInput.a2aChecks.find(
      (check) => check.id === `${prefix}_${cell.cellId}_0`
    );
    assert.equal(byPrefix('a2a_response').status, 'passed');
    assert.equal(byPrefix('a2a_lifecycle').status, 'passed');
    assert.equal(
      byPrefix('a2a_status_sequence').status,
      repeatIndex === 0 ? 'failed' : 'passed'
    );
    assert.equal(
      byPrefix('a2a_parts').status,
      repeatIndex === 1 ? 'failed' : 'passed'
    );
    assert.equal(
      byPrefix('a2a_artifacts').status,
      repeatIndex === 2 ? 'failed' : 'passed'
    );
  }
});

test('claim checks use only formal A/B observations for declared capabilities exercised by locked policy', async () => {
  const streamingCard = {
    ...CARD,
    capabilities: { streaming: true }
  };
  const streamingPolicy = {
    ...PHASE1_EXECUTION_POLICY,
    streaming: true
  };
  const { evaluation, store } = workerFixture({
    card: streamingCard,
    policy: streamingPolicy
  });
  const vault = memoryVault([]);
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    evidenceVaultFactory: () => vault,
    policy: {
      ...streamingPolicy,
      qualificationRetryDelaysMs: [1, 2]
    },
    executeTurn: async (options) => {
      if (options.repeatIndex === 0) return transportFailureRun(options);
      const run = successfulRun(
        options,
        `ctx-${options.repeatIndex ?? 'qualification'}`
      );
      if (options.repeatIndex !== undefined) {
        run.response.mediaType = 'text/event-stream; charset=utf-8';
        run.timing.firstEventAt = 2;
        run.timing.firstEventMs = 1;
      }
      return run;
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  assert.equal(objectiveInput.claimChecks.length, 3);
  assert.deepEqual(
    objectiveInput.claimChecks.map((check) => check.status),
    ['unavailable', 'passed', 'passed']
  );
  for (const check of objectiveInput.claimChecks) {
    assert.equal(check.id.startsWith('claim_streaming_'), true);
    assert.equal(
      check.evidenceIds.every((evidenceId) => {
        const record = vault.records.find(
          (item) => item.evidenceId === evidenceId
        );
        return record && ['A', 'B'].includes(record.grade) &&
          !['agent-card-claim', 'agent-example-claim'].includes(record.kind);
      }),
      true
    );
  }

  const unexercised = workerFixture({ card: streamingCard });
  let unexercisedInput;
  await runBlackBoxFoundation(
    unexercised.evaluation,
    workerServices(unexercised.store, {
      buildObjectiveMetrics: (input) => {
        unexercisedInput = structuredClone(input);
        return buildObjectiveMetrics(input);
      }
    })
  );
  assert.deepEqual(unexercisedInput.claimChecks, []);
});

test('frozen interface checks compare every verified transport fact to the submitted interface', async () => {
  const { evaluation, store } = workerFixture();
  const vault = memoryVault([]);
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    evidenceVaultFactory: () => vault,
    executeTurn: async (options) => {
      const run = successfulRun(options, `ctx-${options.repeatIndex ?? 'q'}`);
      if (options.repeatIndex === 1) run.protocol.version = '0.3';
      return run;
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  const check = objectiveInput.a2aChecks.find(
    (item) => item.id === 'a2a_frozen_interface'
  );
  assert.equal(check.status, 'failed');
  assert.equal(check.evidenceIds.length > 0, true);
  assert.equal(
    check.evidenceIds.every(
      (evidenceId) => vault.records.find(
        (record) => record.evidenceId === evidenceId
      )?.kind === 'transport-fact'
    ),
    true
  );
});

test('trusted reload rejects scorer attempt evidence drift and incomplete locked core evidence', async () => {
  const { evaluation, store } = workerFixture();
  const vault = memoryVault([]);
  const services = workerServices(store, {
    evidenceVaultFactory: () => vault
  });
  await runBlackBoxFoundation(evaluation, services);
  const completed = store.get(evaluation.id);
  const firstCell = completed.runtimeState.runIndex[0];
  store.replace({
    ...completed,
    execution: { status: 'interrupted', stage: 'recovery', progress: 90 },
    runtimeState: {
      ...completed.runtimeState,
      runIndex: completed.runtimeState.runIndex.map((cell) =>
        cell.cellId === firstCell.cellId
          ? {
              ...cell,
              attempts: cell.attempts.map((attempt, index) =>
                index === cell.selectedAttemptIndex
                  ? {
                      ...attempt,
                      evidenceIds: [...attempt.evidenceIds, 'ev_unknown']
                    }
                  : attempt
              )
            }
          : cell
      )
    }
  });
  await assert.rejects(
    runBlackBoxFoundation(store.get(evaluation.id), services),
    /evidence|provenance|manifest/i
  );

  const incomplete = structuredClone(completed);
  const selected = incomplete.runtimeState.runIndex[0].selectedAttemptIndex;
  const attempt = incomplete.runtimeState.runIndex[0].attempts[selected];
  const removedId = attempt.turns[0].evidenceIds[0];
  attempt.turns[0].evidenceIds = attempt.turns[0].evidenceIds.filter(
    (id) => id !== removedId
  );
  attempt.evidenceIds = attempt.evidenceIds.filter((id) => id !== removedId);
  incomplete.execution = {
    status: 'interrupted',
    stage: 'recovery',
    progress: 90
  };
  store.replace(incomplete);
  await assert.rejects(
    runBlackBoxFoundation(store.get(evaluation.id), services),
    /complete|evidence|provenance/i
  );
});

test('worker supplies URL snapshot persistence and commits encrypted snapshot evidence with the turn', async () => {
  const { evaluation, store } = workerFixture();
  const vault = memoryVault([]);
  let calls = 0;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    evidenceVaultFactory: () => vault,
    executeTurn: async (options) => {
      calls += 1;
      const run = successfulRun(options, `ctx-${calls}`);
      if (options.repeatIndex !== undefined) {
        assert.equal(typeof options.persistSnapshot, 'function');
        const persisted = await options.persistSnapshot({
          bytes: Buffer.from('snapshot-bytes'),
          mediaType: 'text/plain',
          size: 14,
          sha256: 'f'.repeat(64),
          sourceUrl: 'https://files.example/report.txt',
          runId: options.runId,
          testId: options.testId,
          turnIndex: options.turnIndex,
          repeatIndex: options.repeatIndex
        });
        run.response.snapshots = [{
          evidenceRef: persisted.evidenceId,
          mediaType: 'text/plain',
          size: 14,
          sha256: 'f'.repeat(64),
          sourceUrl: 'https://files.example/report.txt'
        }];
      }
      return run;
    }
  }));

  const snapshotRecords = vault.records.filter(
    (record) => record.kind === 'agent-output' &&
      record.payload?.bytesBase64 !== undefined
  );
  assert.equal(snapshotRecords.length, 3);
  assert.equal(
    snapshotRecords.every(
      (record) => record.payload.bytesBase64 ===
        Buffer.from('snapshot-bytes').toString('base64')
    ),
    true
  );
  const result = store.get(evaluation.id);
  assert.equal(
    result.runtimeState.runIndex.every(
      (cell) => cell.attempts[0].evidenceIds.length === 6
    ),
    true
  );
});

test('missing first-turn contexts emit unavailable isolation checks for every selected cell', async () => {
  const { evaluation, store } = workerFixture();
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => successfulRun(options, null),
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  const isolation = objectiveInput.contextChecks.filter(
    (check) => check.kind === 'isolation'
  );
  assert.equal(isolation.length, 3);
  assert.equal(
    isolation.every((check) => check.status === 'unavailable'),
    true
  );
});

test('context isolation checks every returned turn and rejects non-empty initial context or task', async () => {
  const examples = [{
    ...EXAMPLES[0],
    turns: [
      EXAMPLES[0].turns[0],
      {
        input: { parts: [{ type: 'text', text: 'continue' }] },
        acceptanceCriteria: []
      }
    ]
  }];
  const { evaluation, store } = workerFixture({ examples });
  const vault = memoryVault([]);
  const services = workerServices(store, {
    evidenceVaultFactory: () => vault,
    executeTurn: async (options) => successfulRun(
      options,
      options.repeatIndex === undefined
        ? 'ctx-qualification'
        : options.turnIndex === 0
          ? options.repeatIndex < 2
            ? null
            : 'ctx-start-2'
          : options.repeatIndex < 2
            ? 'ctx-cross-cell'
            : 'ctx-start-2'
    )
  });
  await runBlackBoxFoundation(evaluation, services);
  const completed = store.get(evaluation.id);
  store.replace({
    ...completed,
    execution: {
      status: 'interrupted',
      stage: 'context-audit',
      progress: 90
    },
    runtimeState: {
      ...completed.runtimeState,
      runIndex: completed.runtimeState.runIndex.map((cell) =>
        cell.identity.repeatIndex === 2
          ? {
              ...cell,
              attempts: cell.attempts.map((attempt) => ({
                ...attempt,
                turns: attempt.turns.map((turn) =>
                  turn.turnIndex === 0
                    ? {
                        ...turn,
                        sentContextId: 'ctx-leaked-initial',
                        sentTaskId: 'task-leaked-initial'
                      }
                    : turn
                )
              }))
            }
          : cell
      )
    }
  });

  let objectiveInput;
  await runBlackBoxFoundation(store.get(evaluation.id), {
    ...services,
    executeTurn: async () => {
      throw new Error('completed cells must not dispatch');
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  });

  const isolationChecks = objectiveInput.contextChecks.filter(
    (check) => check.kind === 'isolation'
  );
  assert.equal(isolationChecks.length, 3);
  assert.equal(
    isolationChecks.every((check) => check.status === 'failed'),
    true
  );
});

test('pending formal cells emit unavailable context checks instead of observable successes', async () => {
  const { evaluation, store } = workerFixture();
  const vault = memoryVault([]);
  const services = workerServices(store, {
    evidenceVaultFactory: () => vault
  });
  await runBlackBoxFoundation(evaluation, services);
  const completed = store.get(evaluation.id);
  const pendingCell = completed.runtimeState.runIndex[0];
  const pendingAttempt = pendingCell.attempts[pendingCell.selectedAttemptIndex];
  store.replace({
    ...completed,
    execution: { status: 'interrupted', stage: 'recovery', progress: 90 },
    runtimeState: {
      ...completed.runtimeState,
      runIndex: completed.runtimeState.runIndex.map((cell) =>
        cell.cellId === pendingCell.cellId
          ? {
              ...cell,
              status: 'attribution-pending',
              selectedAttemptIndex: null,
              attempts: [{
                ...pendingAttempt,
                attribution: 'pending'
              }]
            }
          : cell
      )
    }
  });
  let objectiveInput;
  await runBlackBoxFoundation(store.get(evaluation.id), {
    ...services,
    executeTurn: async () => {
      throw new Error('pending cells must not dispatch');
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  });

  const pendingChecks = objectiveInput.contextChecks.filter(
    (check) => check.id.includes(pendingCell.cellId)
  );
  assert.equal(pendingChecks.length > 0, true);
  assert.equal(
    pendingChecks.every((check) => check.status === 'unavailable'),
    true
  );
});

test('pending formal transport facts stay unavailable and do not fail the frozen interface', async () => {
  const { evaluation, store } = workerFixture();
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      const run = successfulRun(options, `ctx-${options.repeatIndex ?? 'q'}`);
      if (options.repeatIndex === 0) {
        run.protocol.validated = false;
        run.outcome = { status: 'platform-error' };
        run.error = {
          category: 'transport',
          code: 'connection',
          status: null,
          message: 'connection failed'
        };
      }
      return run;
    },
    attributeFormalRun: async (run) =>
      run.repeatIndex === 0 ? 'pending' : 'agent',
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));
  const pendingCell = store.get(evaluation.id).runtimeState.runIndex[0];

  assert.equal(
    objectiveInput.a2aChecks.find(
      (check) => check.id === 'a2a_frozen_interface'
    ).status,
    'passed'
  );
  assert.equal(
    objectiveInput.a2aChecks
      .filter((check) => check.id.includes(pendingCell.cellId))
      .every((check) => check.status === 'unavailable'),
    true
  );
});

test('frozen interface matching is independent from selected response validation', async () => {
  const { evaluation, store } = workerFixture();
  let objectiveInput;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      const run = successfulRun(options, `ctx-${options.repeatIndex ?? 'q'}`);
      if (options.repeatIndex === 1) {
        run.protocol.validated = false;
        run.outcome = { status: 'agent-error' };
        run.error = {
          category: 'protocol',
          code: 'invalid-response',
          status: null,
          message: 'invalid response'
        };
      }
      return run;
    },
    buildObjectiveMetrics: (input) => {
      objectiveInput = structuredClone(input);
      return buildObjectiveMetrics(input);
    }
  }));

  assert.equal(
    objectiveInput.a2aChecks.find(
      (check) => check.id === 'a2a_frozen_interface'
    ).status,
    'passed'
  );
  assert.equal(
    objectiveInput.a2aChecks.some(
      (check) => check.id.startsWith('a2a_response_') &&
        check.status === 'failed'
    ),
    true
  );
});

test('same-attempt resume deducts persisted active cell time from its original budget', async () => {
  const examples = [{
    ...EXAMPLES[0],
    turns: [
      EXAMPLES[0].turns[0],
      {
        input: { parts: [{ type: 'text', text: 'continue' }] },
        acceptanceCriteria: []
      }
    ]
  }];
  const { evaluation, store } = workerFixture({ examples });
  const vault = memoryVault([]);
  const services = workerServices(store, {
    evidenceVaultFactory: () => vault
  });
  await runBlackBoxFoundation(evaluation, services);
  const completed = store.get(evaluation.id);
  const cell = completed.runtimeState.runIndex[0];
  const attempt = structuredClone(cell.attempts[0]);
  attempt.attribution = null;
  attempt.acceptance = null;
  attempt.timing = null;
  attempt.activeElapsedMs = 12_345;
  attempt.evidenceIds = [...attempt.turns[0].evidenceIds];
  attempt.turns[1] = {
    ...attempt.turns[1],
    status: 'planned',
    timing: null,
    acceptance: null,
    evidenceIds: []
  };
  store.replace({
    ...completed,
    execution: { status: 'interrupted', stage: 'recovery', progress: 50 },
    runtimeState: {
      ...completed.runtimeState,
      runIndex: completed.runtimeState.runIndex.map((item) =>
        item.cellId === cell.cellId
          ? {
              ...item,
              status: 'running',
              selectedAttemptIndex: null,
              attempts: [attempt]
            }
          : item
      )
    }
  });
  let resumed;
  await runBlackBoxFoundation(store.get(evaluation.id), {
    ...services,
    clock: () => 0,
    executeTurn: async (options) => {
      resumed = captureTurnOptions(options);
      return failedTaskRun(options);
    }
  });

  assert.equal(
    resumed.timeoutMs,
    PHASE1_EXECUTION_POLICY.timeoutMs - attempt.activeElapsedMs
  );
});

test('resume finalizes an all-committed running attempt whose summary CAS was missing', async () => {
  const { evaluation, store } = workerFixture();
  const vault = memoryVault([]);
  const services = workerServices(store, {
    evidenceVaultFactory: () => vault
  });
  await runBlackBoxFoundation(evaluation, services);
  const completed = store.get(evaluation.id);
  const cell = completed.runtimeState.runIndex[0];
  const attempt = cell.attempts[cell.selectedAttemptIndex];
  store.replace({
    ...completed,
    execution: { status: 'interrupted', stage: 'recovery', progress: 90 },
    runtimeState: {
      ...completed.runtimeState,
      runIndex: completed.runtimeState.runIndex.map((item) =>
        item.cellId === cell.cellId
          ? {
              ...item,
              status: 'running',
              selectedAttemptIndex: null,
              attempts: [{
                ...attempt,
                attribution: null,
                terminalSuccess: null,
                acceptance: null,
                schemaFingerprint: null,
                timing: null,
                evidenceIds: [],
                turns: attempt.turns.map((turn) => ({
                  ...turn,
                  outcome: {
                    ...turn.outcome,
                    status: 'succeeded',
                    lifecycle: 'interrupted'
                  }
                }))
              }]
            }
          : item
      )
    }
  });

  await runBlackBoxFoundation(store.get(evaluation.id), {
    ...services,
    executeTurn: async () => {
      throw new Error('committed turns must not dispatch again');
    }
  });
  const finalized = store.get(evaluation.id)
    .runtimeState.runIndex[0].attempts[0];
  assert.equal(finalized.attribution, 'agent');
  assert.equal(finalized.terminalSuccess, false);
  assert.notEqual(finalized.acceptance, null);
  assert.deepEqual(
    finalized.evidenceIds,
    finalized.turns.flatMap((turn) => turn.evidenceIds)
  );
  assert.equal(store.get(evaluation.id).execution.status, 'completed');
});

test('qualification rejects response-shaped observations not explicitly validated by the executor', async () => {
  const { evaluation, store } = workerFixture();
  let calls = 0;
  await runBlackBoxFoundation(evaluation, workerServices(store, {
    executeTurn: async (options) => {
      calls += 1;
      const run = successfulRun(options, null);
      run.protocol.validated = false;
      run.outcome = { status: 'agent-error' };
      run.error = {
        category: 'protocol',
        code: 'invalid-stream-lifecycle',
        status: null,
        message: 'invalid protocol lifecycle'
      };
      return run;
    }
  }));

  assert.equal(calls, 3);
  assert.equal(store.get(evaluation.id).qualification.status, 'ineligible');
});

test('records separate worker interruptions while deduplicating only the same audit identity', async () => {
  const { evaluation, store } = workerFixture();
  const services = workerServices(store, {
    executeTurn: async () => {
      throw new Error('simulated infrastructure interruption');
    }
  });

  await assert.rejects(
    runBlackBoxFoundation(evaluation, services),
    /simulated infrastructure interruption/
  );
  let current = store.get(evaluation.id);
  store.replace({
    ...current,
    execution: {
      status: 'queued',
      stage: 'qualification',
      progress: current.execution.progress
    }
  });
  await assert.rejects(
    runBlackBoxFoundation(store.get(evaluation.id), services),
    /simulated infrastructure interruption/
  );

  current = store.get(evaluation.id);
  const interruptions = current.auditEvents.filter(
    (event) => event.type === 'execution-interrupted'
  );
  assert.equal(interruptions.length, 2);
  assert.notEqual(interruptions[0].id, interruptions[1].id);
});

function frozenSnapshot(agentExamples, agentCard = CARD) {
  return freezeSubmission({
    agentCard,
    agentExamples,
    config: {
      rubricVersion: 'a2a-black-box-v1',
      hiddenTestPackageVersion: null,
      modelConfigVersion: null,
      runtimeConfigVersion: 'phase1-black-box-runtime/v1'
    },
    frozenAt: '2026-07-24T10:00:00.000Z'
  });
}

function workerFixture(options = {}) {
  const examples = options.examples || EXAMPLES;
  const policy = options.policy || PHASE1_EXECUTION_POLICY;
  const snapshot = frozenSnapshot(examples, options.card || CARD);
  const runIndex = compileBlackBoxRunPlan(snapshot, {
    policy,
    createId: deterministicIds()
  });
  const evaluation = createEvaluationRecord(snapshot, {
    id: 'eval_worker',
    createdAt: '2026-07-24T10:00:00.000Z',
    participantAccess: {
      tokenHash: 'a'.repeat(64),
      createdAt: '2026-07-24T10:00:00.000Z'
    },
    authorizationRequired: true,
    endpointHash: 'b'.repeat(64),
    agentVersion: '1.2.3',
    serviceBuildId: null,
    runIndex
  });
  return { evaluation, store: memoryStore(evaluation) };
}

function memoryStore(initial) {
  let value = structuredClone(initial);
  const expectedRevisions = [];
  const commits = [];
  return {
    expectedRevisions,
    commits,
    get: () => structuredClone(value),
    replace(next) {
      value = structuredClone(next);
    },
    async mutate(id, expectedRevision, updater) {
      assert.equal(id, value.id);
      expectedRevisions.push(expectedRevision);
      assert.equal(expectedRevision, value.revision);
      const next = await updater(structuredClone(value));
      commits.push({
        manifestDelta:
          next.evidenceManifest.items.length - value.evidenceManifest.items.length,
        completedTurnDelta:
          countCompletedTurns(next) - countCompletedTurns(value),
        phase2PartialCells:
          next.phase2Execution?.partialCells?.length || 0
      });
      next.revision = value.revision + 1;
      next.updatedAt = '2026-07-24T10:00:00.000Z';
      value = structuredClone(next);
      return structuredClone(value);
    }
  };
}

function memoryVault(operations) {
  const records = new Map();
  const api = {
    records: [],
    async put(record) {
      operations.push('put');
      records.set(record.evidenceId, record);
      api.records.push(record);
      return record;
    },
    async get(evidenceId, recordHash) {
      operations.push('manifest-get');
      const record = records.get(evidenceId);
      assert.equal(record.recordHash, recordHash);
      return record;
    }
  };
  return api;
}

function successfulRun(options, contextId) {
  return {
    runId: options.runId,
    testId: options.testId,
    turnIndex: options.turnIndex,
    repeatIndex: options.repeatIndex,
    protocol: {
      binding: 'HTTP+JSON',
      version: '1.0',
      endpointHash: CARD_ENDPOINT_HASH,
      validated: true
    },
    request: { requestId: `request-${options.runId}`, messageId: `message-${options.runId}`, body: {}, bodyHash: 'c'.repeat(64) },
    response: {
      httpStatus: 200,
      mediaType: 'application/json',
      byteLength: 10,
      rawObjects: [{ messageId: 'response', role: 'ROLE_AGENT', parts: [{ text: 'done' }] }],
      rawHash: 'd'.repeat(64),
      normalized: {
        responseKind: 'message',
        terminal: true,
        terminalState: null,
        contextId,
        taskId: null,
        statusSequence: [],
        messages: [{
          messageId: 'response',
          role: 'ROLE_AGENT',
          parts: [{ text: 'done' }]
        }],
        history: [],
        artifacts: [],
        artifactTimeline: [],
        parts: [{ text: 'done' }],
        text: 'done'
      },
      currentOutput: { text: 'done', data: null, artifacts: [] },
      snapshots: []
    },
    timing: {
      startedAt: 1,
      headersAt: 2,
      firstByteAt: 2,
      firstEventAt: null,
      endedAt: 3,
      firstByteMs: 1,
      firstEventMs: null,
      durationMs: 2
    },
    outcome: { status: 'succeeded', lifecycle: 'completed' },
    error: null
  };
}

function captureTurnOptions(options) {
  return structuredClone(Object.fromEntries(
    Object.entries(options).filter(([, value]) => typeof value !== 'function')
  ));
}

function failedQualificationRun(options) {
  const run = successfulRun(options, null);
  run.response.rawObjects = [];
  run.response.normalized.responseKind = 'unknown';
  run.response.normalized.terminal = false;
  run.outcome = { status: 'platform-error' };
  run.error = { category: 'transport', code: 'connection', status: null, message: 'unavailable' };
  return run;
}

function failedTaskRun(options) {
  const run = successfulRun(options, null);
  run.response.rawObjects = [{
    id: `task-${options.runId}`,
    status: { state: 'TASK_STATE_FAILED' }
  }];
  run.response.normalized = {
    ...run.response.normalized,
    responseKind: 'task',
    terminal: true,
    terminalState: 'TASK_STATE_FAILED',
    taskId: `task-${options.runId}`,
    statusSequence: ['TASK_STATE_FAILED']
  };
  run.outcome = { status: 'agent-error', lifecycle: 'failed' };
  run.response.currentOutput = { text: '', data: null, artifacts: [] };
  return run;
}

function transportFailureRun(options) {
  const run = failedQualificationRun(options);
  run.testAttribution = 'pending';
  return run;
}

function workerServices(store, overrides = {}) {
  return {
    store,
    events: { emit: () => {} },
    credentialVault: { get: () => undefined, delete: () => {} },
    evidenceVaultFactory: () => memoryVault([]),
    executeTurn: async (options) => successfulRun(options, null),
    evaluateAcceptance,
    buildObjectiveMetrics,
    aggregateObjectiveCapability,
    rubric: RUBRIC_V1,
    policy: {
      ...PHASE1_EXECUTION_POLICY,
      qualificationRetryDelaysMs: [1, 2]
    },
    now: monotonicIso(),
    clock: monotonicClock(),
    sleep: async () => {},
    createId: deterministicIds(),
    ...overrides
  };
}

function countCompletedTurns(record) {
  return record.runtimeState.runIndex.reduce(
    (sum, cell) => sum + cell.attempts.reduce(
      (attemptSum, attempt) => attemptSum +
        attempt.turns.filter((turn) => turn.status === 'completed').length,
      0
    ),
    0
  );
}

function deterministicIds() {
  let index = 0;
  return (prefix = 'id') => `${prefix}_${String(index += 1).padStart(4, '0')}`;
}

function monotonicIso() {
  let index = 0;
  const start = Date.parse('2026-07-24T10:00:00.000Z');
  return () => new Date(start + index++ * 1000).toISOString();
}

function monotonicClock() {
  let value = 0;
  return () => value += 5;
}

function replicaArtifact(runtimeId, packageHash) {
  const content = '# Replica Skill\n\nUse only the supplied input.\n';
  return {
    artifactId: `artifact-${runtimeId}`,
    runtimeId,
    skill: { name: 'Replica Skill', description: 'Uses supplied input.', instructions: ['Use supplied input.'] },
    files: [{
      path: 'SKILL.md', mediaType: 'text/markdown', content,
      byteLength: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex')
    }],
    manifest: {
      packageHash, budgetVersion: 'replica-budget/v1',
      budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' }
    },
    buildEvidence: { budgetUsage: { tokens: 1 } }
  };
}

function incrementingClock(step) {
  let value = 0;
  return () => value += step;
}
