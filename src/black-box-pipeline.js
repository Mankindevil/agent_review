import {
  createHash,
  hkdfSync,
  randomUUID
} from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEvidenceEncryptionKey } from './evidence-vault.js';
import {
  canonicalJson,
  createEvidenceManifestItem,
  createEvidenceRecord,
  redactEvidence
} from './evidence.js';
import {
  executeA2AProtocolRecoveryProbe,
  executeA2ATurn
} from './a2a-executor.js';
import { evaluateAcceptance as evaluateAcceptanceDefault } from './acceptance.js';
import {
  aggregateObjectiveCapability as aggregateObjectiveCapabilityDefault,
  buildObjectiveMetrics as buildObjectiveMetricsDefault
} from './objective-scoring.js';
import { validateAgentCard } from './a2a.js';
import { RUBRIC_V1 } from './rubric.js';
import { compileAgentExamples } from './example-compiler.js';
import { finalizeTestPlan } from './test-plan.js';
import {
  buildObjectiveInputFromExecution,
  executeTestPlan
} from './test-executor.js';
import {
  buildReplicas,
  executeReplicas,
  sealReplicaArena,
  sealedReplicaProjection
} from './replica-runner.js';
import {
  appendRunLogFile,
  applyActiveWork,
  applyRunLog,
  createRunLogEntry,
  runLogFilePath,
  sanitizeLogText
} from './run-log.js';
import {
  lockAndReleaseAbsoluteResult,
  skipHumanReview
} from './review-governance.js';
import {
  runSealedModelArena,
  validReplicaIdsFor
} from './arena-release.js';
import { getReplicaReviewPolicy } from './replica-human-review.js';

export { releaseReplicaArena } from './arena-release.js';

const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const RESUME_MAC_KEYS = new WeakMap();
const EVIDENCE_ENCRYPTION_KEYS = new WeakMap();
const RUN_EVIDENCE_KINDS = Object.freeze(new Map([
  ['protocol-request', 'B'],
  ['protocol-response', 'B'],
  ['platform-timing', 'A'],
  ['transport-fact', 'A'],
  ['agent-output', 'C']
]));

export const PHASE1_EXECUTION_POLICY = deepFreeze({
  version: 'phase1-public-examples/v1',
  repeatCount: 3,
  targetMs: 15_000,
  // Align with agent-check max response window so slow multi-agent
  // research endpoints can pass qualification and formal cells.
  timeoutMs: 1_200_000,
  streaming: false,
  platformReplacementLimit: 1,
  qualificationRetryDelaysMs: [250, 1000]
});

export function readBlackBoxRuntimeConfig(env = {}, options = {}) {
  const enabled = env.A2A_BLACK_BOX_V1_ENABLED === 'true';
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      evidenceRoot: null,
      resumeMacKey: null
    });
  }

  const decoded = decodeEvidenceEncryptionKey(env.EVIDENCE_ENCRYPTION_KEY);
  const evidenceEncryptionKey = Buffer.from(decoded);
  let resumeMacKey;
  try {
    resumeMacKey = Buffer.from(hkdfSync(
      'sha256',
      decoded,
      Buffer.alloc(0),
      'agent-roast/resume-idempotency/v1',
      32
    ));
  } finally {
    decoded.fill(0);
  }
  const serverRoot = path.resolve(options.serverRoot || MODULE_ROOT);
  const evidenceRoot = path.resolve(
    serverRoot,
    env.EVIDENCE_ROOT || 'data/evidence'
  );
  const config = Object.freeze({
    enabled: true,
    evidenceRoot
  });
  EVIDENCE_ENCRYPTION_KEYS.set(config, Buffer.from(evidenceEncryptionKey));
  RESUME_MAC_KEYS.set(config, Buffer.from(resumeMacKey));
  evidenceEncryptionKey.fill(0);
  resumeMacKey.fill(0);
  return config;
}

export function copyEvidenceEncryptionKey(config) {
  if (!config?.enabled) return null;
  const key = EVIDENCE_ENCRYPTION_KEYS.get(config);
  if (!key) throw new TypeError('invalid black-box runtime configuration');
  return Buffer.from(key);
}

export function copyResumeMacKey(config) {
  if (!config?.enabled) return null;
  const key = RESUME_MAC_KEYS.get(config);
  if (!key) throw new TypeError('invalid black-box runtime configuration');
  return Buffer.from(key);
}

export function compileBlackBoxRunPlan(snapshot, options = {}) {
  const policy = options.policy || PHASE1_EXECUTION_POLICY;
  const createId = options.createId || defaultId;
  const examples = snapshot.agentExamples.value;
  const timingPolicyHash = hashCanonical({
    targetMs: policy.targetMs,
    timeoutMs: policy.timeoutMs,
    streaming: policy.streaming,
    platformReplacementLimit: policy.platformReplacementLimit,
    repeatCount: policy.repeatCount
  });
  const protocolConfigHash = hashCanonical({
    binding: snapshot.selectedInterface.binding,
    version: snapshot.selectedInterface.version,
    endpointHash: hashText(snapshot.selectedInterface.url)
  });
  const cells = [];
  for (const [exampleIndex, example] of examples.entries()) {
    const testId = `test_${hashCanonical({
      submissionExamplesHash: snapshot.agentExamples.sha256,
      exampleIndex,
      submittedExampleId: example.id
    }).slice(0, 32)}`;
    const requiredExecutable = countRequiredExecutable(example);
    for (let repeatIndex = 0; repeatIndex < policy.repeatCount; repeatIndex += 1) {
      const identity = {
        testId,
        repeatIndex,
        inputHash: hashCanonical(example.turns.map((turn) => turn.input)),
        testContractHash: hashCanonical(example),
        timingPolicyHash,
        seed: null,
        protocolConfigHash,
        rubricVersion: RUBRIC_V1.version
      };
      cells.push({
        cellId: `cell_${hashCanonical(identity).slice(0, 32)}`,
        exampleIndex,
        requiredExecutable,
        policy: {
          version: policy.version,
          repeatCount: policy.repeatCount,
          targetMs: policy.targetMs,
          timeoutMs: policy.timeoutMs,
          streaming: policy.streaming,
          platformReplacementLimit: policy.platformReplacementLimit
        },
        identity,
        status: 'planned',
        selectedAttemptIndex: null,
        attempts: [],
        turns: example.turns.map((_turn, turnIndex) => ({
          turnIndex,
          runId: createId('run'),
          status: 'planned'
        }))
      });
    }
  }
  return cells;
}

export async function runBlackBoxFoundation(evaluation, services = {}) {
  const store = requiredService(services.store, 'store');
  const events = services.events;
  const credentialVault = requiredService(
    services.credentialVault,
    'credentialVault'
  );
  const executeTurn = services.executeTurn || executeA2ATurn;
  const executeProtocolRecovery = services.executeProtocolRecovery ||
    (services.executeTurn ? services.executeTurn : executeA2AProtocolRecoveryProbe);
  const evaluateAcceptance =
    services.evaluateAcceptance || evaluateAcceptanceDefault;
  const buildObjectiveMetrics =
    services.buildObjectiveMetrics || buildObjectiveMetricsDefault;
  const aggregateObjectiveCapability =
    services.aggregateObjectiveCapability || aggregateObjectiveCapabilityDefault;
  const rubric = services.rubric || RUBRIC_V1;
  const policy = services.policy || PHASE1_EXECUTION_POLICY;
  const now = services.now || (() => new Date().toISOString());
  const clock = services.clock || (() => Date.now());
  const sleep = services.sleep || abortableSleep;
  const createId = services.createId || defaultId;
  let context = null;

  try {
    const evidenceVault = requiredService(
      services.evidenceVaultFactory,
      'evidenceVaultFactory'
    )(evaluation.id);
    const authorization = credentialVault.get(evaluation.id);
    context = {
      store,
      events,
      evidenceVault,
      evaluationId: evaluation.id,
      now,
      clock,
      policy,
      executeTurn,
      executeProtocolRecovery,
      evaluateAcceptance,
      attributeFormalRun: services.attributeFormalRun,
      snapshotRequest: services.snapshotRequest,
      signal: services.signal,
      createId,
      authorization,
      runLogRoot: services.runLogRoot || path.join(MODULE_ROOT, 'data', 'runlogs'),
      worker: true
    };
    let current = store.get(evaluation.id);
    await persistSubmissionProvenance(current, context);
    current = store.get(evaluation.id);

    const firstTurn = current.submission.agentExamples.value[0].turns[0];
    let qualified = current.qualification.status === 'eligible';
    if (!qualified) {
      await mutateCurrent(context, (record) => withRunProgress(record, context, {
        execution: {
          ...record.execution,
          status: 'running',
          stage: 'qualification',
          progress: 5,
          startedAt: record.execution.startedAt || now()
        },
        entry: {
          level: 'info',
          source: 'PIPELINE',
          phase: 'qualification',
          text: '开始资格验证',
          detail: '正在建立可调用的 A2A 证据'
        },
        activeWork: null
      }));
    }
    const qualificationStart =
      current.qualification.attemptRunIds.length;
    for (
      let attemptIndex = qualificationStart;
      !qualified && attemptIndex < 3;
      attemptIndex += 1
    ) {
      const runId = createId('run_qualification');
      const attemptNumber = attemptIndex + 1;
      const attemptStartedAt = now();
      const attemptStartedMs = clock();
      await mutateCurrent(context, (record) => withRunProgress(record, context, {
        entry: {
          level: 'info',
          source: 'A2A',
          phase: 'qualification',
          text: `资格验证 attempt ${attemptNumber}/3`,
          detail: `timeout ${policy.timeoutMs}ms`,
          refs: { attempt: attemptNumber, runId, testId: 'test_qualification' }
        },
        activeWork: {
          key: `qualification:${attemptNumber}`,
          phase: 'qualification',
          label: `等待 Agent 资格验证 · ${attemptNumber}/3`,
          detail: '正在调用 A2A 端点',
          startedAt: attemptStartedAt,
          index: attemptNumber,
          total: 3,
          kind: 'call'
        }
      }));
      const snapshotPersistence = createSnapshotPersistence(context, {
        runId,
        testId: 'test_qualification'
      });
      await markFirstDispatch(context);
      const run = await executeTurn({
        card: current.submission.agentCard.value,
        input: firstTurn.input,
        streaming: policy.streaming,
        timeoutMs: policy.timeoutMs,
        authorization,
        signal: services.signal,
        runId,
        testId: 'test_qualification',
        requestId: createId('request'),
        persistSnapshot: snapshotPersistence.persistSnapshot,
        ...(context.snapshotRequest
          ? { snapshotRequest: context.snapshotRequest }
          : {})
      });
      const evidence = await persistRunEvidence(run, {
        ...context,
        testId: 'test_qualification'
      });
      mergeEvidenceBundle(evidence, snapshotPersistence);
      qualified = isVersionValidObservation(run);
      const attemptDurationMs = Math.max(0, clock() - attemptStartedMs);
      await mutateCurrent(context, (record) => {
        const attemptRunIds = [
          ...record.qualification.attemptRunIds,
          runId
        ];
        return withRunProgress({
          ...record,
          qualification: qualified
            ? {
                status: 'eligible',
                reason: 'version-valid-a2a-response',
                attemptRunIds,
                selectedInterface: publicSelectedInterface(record.submission),
                completedAt: now()
              }
            : {
                ...record.qualification,
                attemptRunIds
              },
          evaluationWindow: {
            ...record.evaluationWindow,
            lastRunAt: now()
          },
          evidenceManifest: appendManifest(
            record.evidenceManifest,
            evidence.manifestItems
          ),
          runtimeState: appendFingerprint(record.runtimeState, run),
          auditEvents: qualified
            ? appendAudit(record.auditEvents, {
                id: createId('audit'),
                type: 'qualification-eligible',
                occurredAt: now(),
                summary: 'A version-valid A2A response established callability'
              })
            : record.auditEvents
        }, context, {
          entry: {
            level: qualified ? 'success' : 'warn',
            source: 'A2A',
            phase: 'qualification',
            text: qualified ? '资格验证通过' : '资格验证未通过，准备重试',
            detail: run.outcome?.status
              ? `outcome=${run.outcome.status}`
              : 'version-valid observation failed',
            durationMs: attemptDurationMs,
            refs: { attempt: attemptNumber, runId }
          },
          activeWork: null
        });
      });
      if (qualified) {
        break;
      }
      if (attemptIndex < 2) {
        await sleep(policy.qualificationRetryDelaysMs[attemptIndex], services.signal);
      }
    }

    if (!qualified) {
      await mutateCurrent(context, (record) => withRunProgress({
        ...record,
        qualification: {
          status: 'ineligible',
          reason: 'endpoint-not-callable',
          attemptRunIds: record.qualification.attemptRunIds,
          selectedInterface: publicSelectedInterface(record.submission),
          completedAt: now()
        },
        execution: {
          status: 'completed',
          stage: 'ineligible',
          progress: 100,
          completedAt: now()
        },
        objectiveCapability: {
          status: 'not-applicable',
          score: null,
          coverage: 0,
          provisional: true,
          metrics: []
        },
        absoluteReview: { status: 'not-applicable' },
        replicaArena: { status: 'disabled' },
        resultV2: null,
        auditEvents: appendAudit(record.auditEvents, {
          id: createId('audit'),
          type: 'qualification-ineligible',
          occurredAt: now(),
          summary: 'The endpoint did not produce a version-valid A2A response'
        })
      }, context, {
        entry: {
          level: 'error',
          source: 'PIPELINE',
          phase: 'qualification',
          text: '不具备正式评测资格',
          detail: 'endpoint-not-callable'
        },
        activeWork: null
      }));
      return store.get(evaluation.id);
    }

    await mutateCurrent(context, (record) => withRunProgress(record, context, {
      execution: {
        ...record.execution,
        status: 'running',
        stage: 'public-examples',
        progress: 20
      },
      entry: {
        level: 'info',
        source: 'PIPELINE',
        phase: 'public-examples',
        text: '进入公开用例执行'
      },
      activeWork: {
        key: 'public-examples',
        phase: 'public-examples',
        label: '正在执行公开用例',
        detail: '按计划采集正式样本',
        startedAt: now(),
        kind: 'call'
      }
    }));
    current = store.get(evaluation.id);
    if (services.phase2?.enabled === true && isFormalPhase2Submission(current.submission)) {
      return await runFormalPhase2(current, context, services, evidenceVault);
    }
    await executeFormalCells(context);

    current = store.get(evaluation.id);
    const objectiveInput = await buildObjectiveInput(
      current,
      evidenceVault
    );
    const objectiveMetrics = buildObjectiveMetrics(objectiveInput);
    const objectiveCapability =
      aggregateObjectiveCapability(objectiveMetrics, rubric);
    await mutateCurrent(context, (record) => withRunProgress({
      ...record,
      execution: {
        status: 'completed',
        stage: 'waiting-model',
        progress: 100,
        completedAt: now()
      },
      governance: { ...record.governance, phase: 'waiting_model' },
      objectiveCapability,
      absoluteReview: {
        status: 'pending-model-review',
        confidence: {
          status: 'pending-model-review',
          value: null
        }
      },
      replicaArena: { status: 'disabled' },
      resultV2: {
        absolute: { status: 'pending-model-review' },
        replica: { status: 'disabled' },
        rating: {
          status: 'pending-model-and-human',
          code: null,
          label: null
        }
      },
      auditEvents: appendAudit(record.auditEvents, {
        id: createId('audit'),
        type: 'phase1-completed',
        occurredAt: now(),
        summary: 'Phase 1 objective capability calculation completed'
      })
    }, context, {
      entry: {
        level: 'success',
        source: 'PIPELINE',
        phase: 'waiting-model',
        text: 'Phase 1 完成，等待模型评审'
      },
      activeWork: null
    }));
    return store.get(evaluation.id);
  } catch (error) {
    if (context) {
      try {
        await mutateCurrent(context, (record) => withRunProgress(record, context, {
          entry: {
            level: 'error',
            source: 'SYSTEM',
            phase: record.execution?.stage || 'failed',
            text: error?.name === 'AbortError' ? '评测已取消或中止' : '评测执行失败',
            detail: safeErrorDetail(error),
            internalDetail: error?.stack || String(error)
          },
          activeWork: null
        }));
      } catch {
        // Keep original failure path even if logging cannot commit.
      }
      await interruptEvaluation(context);
    }
    throw error;
  } finally {
    credentialVault.delete(evaluation.id);
  }
}

async function runFormalPhase2(evaluation, context, services, evidenceVault) {
  const phase2 = services.phase2;
  const resumed = context.store.get(context.evaluationId);
  if (resumed.absoluteReview?.status === 'model-locked') return resumed;
  await mutateCurrent(context, (record) => withRunProgress(record, context, {
    execution: {
      ...record.execution,
      status: 'running',
      stage: 'example_compilation',
      progress: 25
    },
    entry: {
      level: 'info',
      source: 'PIPELINE',
      phase: 'example_compilation',
      text: '编译 Agent 示例为动态评分表'
    },
    activeWork: {
      key: 'example_compilation',
      phase: 'example_compilation',
      label: '正在编译评分表',
      startedAt: context.now(),
      kind: 'compile'
    }
  }));
  const currentBeforePlan = context.store.get(context.evaluationId);
  const compilation = currentBeforePlan.exampleCompilation ||
    compileAgentExamples(
      evaluation.submission.agentCard.value,
      evaluation.submission.agentExamples.value,
      { rubricVersion: evaluation.submission.config.rubricVersion }
    );
  let testPlan = currentBeforePlan.testPlan;
  if (!testPlan) {
    const candidates = [];
    const decisions = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await mutateCurrent(context, (record) => withRunProgress(record, context, {
        execution: {
          ...record.execution,
          stage: attempt === 0 ? 'hidden_generation' : 'hidden_generation_retry',
          progress: 30 + attempt * 3
        },
        entry: {
          level: 'info',
          source: 'MODEL',
          phase: 'hidden_generation',
          text: attempt === 0 ? '生成隐藏测试题' : `隐藏题生成重试 ${attempt + 1}/3`,
          refs: { attempt: attempt + 1 }
        },
        activeWork: {
          key: `hidden_generation:${attempt + 1}`,
          phase: 'hidden_generation',
          label: '模型正在出隐藏题',
          detail: `第 ${attempt + 1}/3 轮`,
          startedAt: context.now(),
          index: attempt + 1,
          total: 3,
          kind: 'compile'
        }
      }));
      const generated = await phase2.generateHidden(compilation, { attempt });
      const roundCandidates = namespacePhase2Candidates(
        generated.candidates || generated,
        attempt
      );
      await mutateCurrent(context, (record) => withRunProgress(record, context, {
        execution: {
          ...record.execution,
          stage: 'scope_review',
          progress: 34 + attempt * 3
        },
        entry: {
          level: 'info',
          source: 'MODEL',
          phase: 'scope_review',
          text: '审查隐藏题是否越界',
          refs: { attempt: attempt + 1 }
        },
        activeWork: {
          key: `scope_review:${attempt + 1}`,
          phase: 'scope_review',
          label: '模型正在审 scope',
          startedAt: context.now(),
          index: attempt + 1,
          total: 3,
          kind: 'review'
        }
      }));
      const reviewed = await phase2.reviewScopes(compilation, roundCandidates, {
        attempt
      });
      const roundDecisions = reviewed.decisions || reviewed;
      candidates.push(...roundCandidates);
      decisions.push(...roundDecisions);
      if (hasEveryApprovedSlot(
        compilation,
        candidates,
        decisions,
        phase2.requiredHiddenVariants
      )) break;
    }

    testPlan = finalizeTestPlan(compilation, candidates, decisions, {
      generatedAt: context.now(),
      generatorIdentity: phase2.generatorIdentity,
      scopeReviewerIdentity: phase2.scopeReviewerIdentity,
      timingPolicy: phase2.timingPolicy,
      multiTurnEnabled: phase2.multiTurnEnabled !== false,
      requiredHiddenVariants: phase2.requiredHiddenVariants,
      repeatCount: phase2.repeatCount
    });
    await mutateCurrent(context, (record) => withRunProgress({
      ...record,
      exampleCompilation: compilation,
      testPlan,
      phase2Execution: testPlan.status === 'ready'
        ? {
            status: 'running',
            testRuns: [],
            partialCells: [],
            reusedCells: []
          }
        : record.phase2Execution,
      execution: {
        ...record.execution,
        stage: testPlan.status === 'ready' ? 'test_execution' : 'scope-incomplete',
        progress: testPlan.status === 'ready' ? 45 : 100,
        ...(testPlan.status === 'ready' ? {} : {
          status: 'completed',
          completedAt: context.now()
        })
      },
      auditEvents: appendAudit(record.auditEvents, {
        id: context.createId('audit'),
        type: testPlan.status === 'ready' ? 'test-plan-locked' : 'scope-incomplete',
        occurredAt: context.now(),
        summary: testPlan.status === 'ready'
          ? 'Closed-scope dynamic test plan locked'
          : 'A required hidden-test slot remained unapproved'
      })
    }, context, {
      entry: {
        level: testPlan.status === 'ready' ? 'success' : 'error',
        source: 'PIPELINE',
        phase: testPlan.status === 'ready' ? 'test_execution' : 'scope-incomplete',
        text: testPlan.status === 'ready' ? '测试计划已锁定，开始正式执行' : '隐藏题 scope 未完成'
      },
      activeWork: testPlan.status === 'ready'
        ? {
            key: 'test_execution',
            phase: 'test_execution',
            label: '正在执行正式测试',
            startedAt: context.now(),
            kind: 'call'
          }
        : null
    }));
  } else {
    await mutateCurrent(context, (record) => withRunProgress(record, context, {
      execution: {
        ...record.execution,
        stage: testPlan.status === 'ready' ? 'test_execution' : 'scope-incomplete',
        progress: testPlan.status === 'ready' ? 45 : 100
      },
      entry: {
        level: 'info',
        source: 'PIPELINE',
        phase: testPlan.status === 'ready' ? 'test_execution' : 'scope-incomplete',
        text: testPlan.status === 'ready' ? '恢复正式测试执行' : '测试计划仍未就绪'
      },
      activeWork: testPlan.status === 'ready'
        ? {
            key: 'test_execution',
            phase: 'test_execution',
            label: '正在执行正式测试',
            startedAt: context.now(),
            kind: 'call'
          }
        : null
    }));
  }
  if (testPlan.status !== 'ready') return context.store.get(context.evaluationId);

  const snapshotBundles = new Map();
  const existingRunIndex = (
    context.store.get(context.evaluationId).phase2Execution?.testRuns || []
  ).map((testRun) => ({
    cellIdentity: testRun.cellIdentity,
    testRun
  }));
  const existingPartialIndex =
    context.store.get(context.evaluationId).phase2Execution?.partialCells || [];
  const phase2Execution = await (phase2.executeTestPlan || executeTestPlan)(
    testPlan,
    {
      card: evaluation.submission.agentCard.value,
      authorization: context.authorization,
      signal: context.signal,
      seed: phase2.seed ?? null,
      executionNamespace: context.evaluationId,
      existingRunIndex,
      existingPartialIndex,
      protocolConfigHash: hashCanonical({
        binding: evaluation.submission.selectedInterface.binding,
        version: evaluation.submission.selectedInterface.version,
        endpointHash: hashText(evaluation.submission.selectedInterface.url)
      }),
      createId: context.createId,
      executeTurn: async (options) => {
        const snapshotPersistence = createSnapshotPersistence(context, {
          runId: options.runId,
          testId: options.testId,
          turnIndex: options.turnIndex,
          repeatIndex: options.repeatIndex
        });
        snapshotBundles.set(options.runId, snapshotPersistence);
        return context.executeTurn({
          ...options,
          persistSnapshot: snapshotPersistence.persistSnapshot,
          ...(context.snapshotRequest
            ? { snapshotRequest: context.snapshotRequest }
            : {})
        });
      },
      executeProtocolRecovery: async (options) => {
        const snapshotPersistence = createSnapshotPersistence(context, {
          runId: options.runId,
          testId: options.testId,
          turnIndex: options.turnIndex,
          repeatIndex: options.repeatIndex
        });
        snapshotBundles.set(options.runId, snapshotPersistence);
        return context.executeProtocolRecovery({
          ...options,
          persistSnapshot: snapshotPersistence.persistSnapshot,
          ...(context.snapshotRequest
            ? { snapshotRequest: context.snapshotRequest }
            : {})
        });
      },
      evaluateAcceptance: context.evaluateAcceptance,
      persistTurn: async ({
        test,
        run,
        repeatIndex,
        attemptIndex,
        cellIdentity
      }) => {
        const evidence = await persistRunEvidence(run, {
          ...context,
          testId: test.testId,
          turnIndex: run.turnIndex,
          repeatIndex,
          visibility: test.visibility === 'public' ? 'public' : 'admin'
        });
        const snapshots = snapshotBundles.get(run.runId);
        if (snapshots) mergeEvidenceBundle(evidence, snapshots);
        run.evidenceIds = evidence.evidenceIds;
        await mutateCurrent(context, (record) => withRunProgress({
          ...record,
          evidenceManifest: appendManifest(
            record.evidenceManifest,
            evidence.manifestItems
          ),
          phase2Execution: appendPhase2PartialTurn(
            record.phase2Execution,
            {
              test,
              repeatIndex,
              attemptIndex,
              cellIdentity,
              run
            }
          ),
          evaluationWindow: {
            ...record.evaluationWindow,
            lastRunAt: context.now()
          }
        }, context, {
          entry: {
            level: run.outcome?.status === 'succeeded' ? 'info' : 'warn',
            source: 'A2A',
            phase: 'test_execution',
            text: `完成 ${test.testId} · R${repeatIndex + 1} · T${run.turnIndex + 1}`,
            detail: run.outcome?.status
              ? `outcome=${run.outcome.status}`
              : 'turn persisted',
            refs: {
              testId: test.testId,
              repeatIndex,
              turnIndex: run.turnIndex,
              runId: run.runId
            }
          },
          activeWork: {
            key: `test_execution:${test.testId}:${repeatIndex}:${run.turnIndex}`,
            phase: 'test_execution',
            label: `正式测试 ${test.testId}`,
            detail: `repeat ${repeatIndex + 1} · turn ${run.turnIndex + 1}`,
            startedAt: context.now(),
            kind: 'call'
          }
        }));
      },
      persistCell: async ({ testRun }) => {
        await mutateCurrent(context, (record) => withRunProgress({
          ...record,
          phase2Execution: appendPhase2TestRun(
            record.phase2Execution,
            testRun
          )
        }, context, {
          entry: {
            level: 'success',
            source: 'PIPELINE',
            phase: 'test_execution',
            text: `单元格完成 ${testRun.cellIdentity?.testId || 'test'}`,
            detail: `status=${testRun.status || 'completed'}`,
            refs: {
              testId: testRun.cellIdentity?.testId,
              repeatIndex: testRun.cellIdentity?.repeatIndex
            }
          }
        }));
      }
    }
  );
  const objectiveInput = buildObjectiveInputFromExecution(
    testPlan,
    phase2Execution
  );
  let replicaArena = null;
  if (services.phase3?.enabled === true) {
    const phase3 = services.phase3;
    const existingCheckpoint = context.store.get(context.evaluationId).replicaCheckpoint;
    if (
      ['running', 'sealed'].includes(existingCheckpoint?.status) &&
      existingCheckpoint.testPlanHash !== hashCanonical(testPlan)
    ) {
      throw new Error('Replica checkpoint test-plan commitment mismatch');
    }
    if (existingCheckpoint?.status === 'sealed' && existingCheckpoint.arena) {
      replicaArena = structuredClone(existingCheckpoint.arena);
      await mutateCurrent(context, (record) => withRunProgress(record, context, {
        entry: {
          level: 'info',
          source: 'REPLICA',
          phase: 'replica',
          text: '复用已密封的 Replica 检查点'
        }
      }));
    } else {
      await mutateCurrent(context, (record) => withRunProgress(record, context, {
        entry: {
          level: 'info',
          source: 'REPLICA',
          phase: 'replica',
          text: '开始构建 Replica 基线'
        },
        activeWork: {
          key: 'replica:build',
          phase: 'replica',
          label: '正在构建 Replica',
          detail: '结果在绝对分锁定前保持密封',
          startedAt: context.now(),
          kind: 'replica'
        }
      }));
      const checkpoint = async (step) => {
        await mutateCurrent(context, (record) => withRunProgress({
          ...record,
          replicaCheckpoint: mergeReplicaCheckpoint(record.replicaCheckpoint, step, testPlan)
        }, context, {
          entry: step?.type
            ? {
                level: 'info',
                source: 'REPLICA',
                phase: 'replica',
                text: `Replica 检查点 · ${step.type}`,
                refs: {
                  runtimeId: step.runtimeId,
                  testId: step.testId,
                  turnIndex: step.turnIndex,
                  repeatIndex: step.repeatIndex
                }
              }
            : undefined,
          activeWork: {
            key: `replica:${step?.type || 'checkpoint'}`,
            phase: 'replica',
            label: step?.type ? `Replica · ${step.type}` : 'Replica 执行中',
            detail: step?.runtimeId ? `runtime=${step.runtimeId}` : undefined,
            startedAt: context.now(),
            kind: 'replica'
          }
        }));
      };
      const built = await buildReplicas({
        ...phase3,
        agentCard: evaluation.submission.agentCard.value,
        agentExamples: evaluation.submission.agentExamples.value,
        rubricVersion: evaluation.submission.config.rubricVersion,
        evidenceVault,
        now: context.now,
        createId: context.createId,
        signal: context.signal,
        checkpoint,
        resume: existingCheckpoint
      });
      await mutateCurrent(context, (record) => withRunProgress(record, context, {
        entry: {
          level: 'info',
          source: 'REPLICA',
          phase: 'replica',
          text: 'Replica 构建完成，开始同题执行'
        },
        activeWork: {
          key: 'replica:execute',
          phase: 'replica',
          label: '正在执行 Replica 同题测试',
          startedAt: context.now(),
          kind: 'replica'
        }
      }));
      const executed = await executeReplicas({
        ...phase3,
        testPlan,
        replicas: built,
        evidenceVault,
        now: context.now,
        createId: context.createId,
        signal: context.signal,
        checkpoint,
        resume: existingCheckpoint
      });
      replicaArena = await sealReplicaArena({
        packageHash: built.packageHash,
        packageGeneratedAt: built.packageGeneratedAt,
        testPlanHash: hashCanonical(testPlan),
        built,
        executed
      });
      await mutateCurrent(context, (record) => withRunProgress({
        ...record,
        replicaCheckpoint: {
          ...structuredClone(record.replicaCheckpoint),
          version: 'replica-checkpoint/v1',
          status: 'sealed',
          packageHash: built.packageHash,
          packageGeneratedAt: built.packageGeneratedAt,
          testPlanHash: hashCanonical(testPlan),
          arena: structuredClone(replicaArena),
          evidenceCommitments: structuredClone(
            replicaArena.evidenceCommitments
          ),
          sealedEvidenceIds: [
            ...replicaArena.encryptedArenaEvidenceIds
          ]
        }
      }, context, {
        entry: {
          level: 'success',
          source: 'REPLICA',
          phase: 'replica',
          text: 'Replica 证据已密封'
        },
        activeWork: null
      }));
    }
  }
  const objectiveMetrics = (services.buildObjectiveMetrics ||
    buildObjectiveMetricsDefault)(objectiveInput);
  const objectiveCapability = (services.aggregateObjectiveCapability ||
    aggregateObjectiveCapabilityDefault)(
    objectiveMetrics,
    services.rubric || RUBRIC_V1
  );
  await mutateCurrent(context, (record) => withRunProgress({
    ...record,
    phase2Execution,
    objectiveCapability,
    execution: {
      ...record.execution,
      stage: 'model_review',
      progress: 78
    }
  }, context, {
    entry: {
      level: 'info',
      source: 'MODEL',
      phase: 'model_review',
      text: '开始四席模型评审'
    },
    activeWork: {
      key: 'model_review',
      phase: 'model_review',
      label: '四席模型正在评审',
      detail: '独立会话，等待锁定',
      startedAt: context.now(),
      kind: 'review'
    }
  }));

  const current = context.store.get(context.evaluationId);
  const applicableChecks = compilation.rubricChecks.filter(
    (check) => check.applicable
  );
  const modelContract = {
    subcriterionIds: [...new Set(
      applicableChecks.map((check) => check.subcriterionId)
    )],
    checks: applicableChecks,
    evidenceIds: current.evidenceManifest.items.map((item) => item.evidenceId),
    rubric: services.rubric || RUBRIC_V1
  };
  const evidencePackage = await buildPhase2EvidencePackage(
    current,
    evidenceVault,
    testPlan,
    context.authorization
  );
  const modelPanel = await phase2.runPanel({
    contract: modelContract,
    evidencePackage
  });
  if (modelPanel.status !== 'model-locked') {
    throw new Error('model panel did not lock four valid primary reviews');
  }
  const lockedAt = context.now();
  const confidenceValues = Object.values(modelPanel.subcriteria || {})
    .map((item) => item.confidence)
    .filter(Number.isFinite);
  const modelConfidence = confidenceValues.length === 0
    ? null
    : confidenceValues.reduce((sum, value) => sum + value, 0) /
      confidenceValues.length;
  const testSummary = summarizePhase2Execution(testPlan, phase2Execution);
  const arbitrationRequired =
    (modelPanel.disputedSubcriterionIds || []).length > 0;
  await mutateCurrent(context, (record) => withRunProgress({
    ...record,
    execution: {
      status: 'completed',
      stage: 'human-open',
      progress: 100,
      completedAt: lockedAt
    },
    governance: {
      ...record.governance,
      phase: 'human_open',
      modelLockedAt: lockedAt
    },
    absoluteReview: {
      status: 'model-locked',
      modelPanel,
      confidence: {
        status: 'pending-human-review',
        value: modelConfidence
      }
    },
    replicaArena: replicaArena || { status: 'disabled' },
    resultV2: {
      absolute: {
        status: 'model-provisional',
        dimensions: modelPanel.dimensions,
        testSummary,
        modelReviewSummary: {
          primarySeatsLocked: 4,
          arbitrationStatus: arbitrationRequired
            ? modelPanel.arbitration
              ? 'completed'
              : 'required'
            : 'not-required'
        }
      },
      replica: replicaArena
        ? sealedReplicaProjection(replicaArena)
        : { status: 'disabled' },
      rating: {
        status: 'pending-human',
        code: null,
        label: null
      }
    },
    auditEvents: appendAudit(record.auditEvents, {
      id: context.createId('audit'),
      type: 'model-seat-locked',
      occurredAt: lockedAt,
      summary: 'Four independent model reviews locked; human review opened'
    })
  }, context, {
    entry: {
      level: 'success',
      source: 'MODEL',
      phase: 'human-open',
      text: '模型初评已锁定，打开人类评审'
    },
    activeWork: null
  }));
  const lockedRecord = context.store.get(context.evaluationId);
  const withReplicaTrack = await openReplicaTrackAfterModelLock(
    lockedRecord,
    context,
    services
  );
  if (withReplicaTrack.governance?.skipHumanReview === true) {
    return autoSkipHumanReview(withReplicaTrack, context);
  }
  return withReplicaTrack;
}

/**
 * Runs immediately after the absolute model panel locks (see
 * docs/superpowers/specs/2026-07-26-parallel-replica-human-review-design.md):
 * the Replica track opens in parallel with absolute human review and never
 * waits for `absolute_locked`. When the sealed Replica has valid Runtimes,
 * this best-effort runs the anonymous model Arena into
 * `replicaArena.modelScoringCube` and marks the replica-human track open
 * (persisting default review policy). When there are no valid Runtimes, it
 * marks the track unavailable so `finalizeDualTrack` can settle on
 * 「待复刻」 without any replica-human review. A failed Arena attempt (e.g.
 * judges not yet configured) never blocks the pipeline — `finalizeDualTrack`
 * retries the Arena run at finalize time.
 */
async function openReplicaTrackAfterModelLock(record, context, services) {
  try {
    return await openReplicaTrackAfterModelLockUnsafe(record, context, services);
  } catch (error) {
    console.error(
      `[v2-pipeline] opening the replica-human track failed for ${context.evaluationId}`,
      error
    );
    return context.store.get(context.evaluationId);
  }
}

async function openReplicaTrackAfterModelLockUnsafe(record, context, services) {
  // Phase 3 not wired / disabled → settle replica track as unavailable so the
  // dual-track UI does not keep saying 「等双轨」forever.
  if (record.replicaArena?.status !== 'sealed') {
    if (record.governance?.replicaUnavailableAt) return record;
    return await mutateCurrent(context, (current) => withRunProgress({
      ...current,
      governance: {
        ...current.governance,
        replicaUnavailableAt: current.governance?.replicaUnavailableAt || context.now()
      },
      resultV2: {
        ...(current.resultV2 || {}),
        replica: { status: 'unavailable' }
      }
    }, context, {
      entry: {
        level: 'info',
        source: 'REPLICA',
        phase: 'replica-human',
        text: 'Replica 轨未启用或未密封，标记为待复刻'
      }
    }));
  }
  const validReplicaIds = validReplicaIdsFor(record.replicaArena);

  if (validReplicaIds.length === 0) {
    if (record.governance?.replicaUnavailableAt) return record;
    return await mutateCurrent(context, (current) => withRunProgress({
      ...current,
      governance: {
        ...current.governance,
        replicaUnavailableAt: current.governance?.replicaUnavailableAt || context.now()
      }
    }, context, {
      entry: {
        level: 'info',
        source: 'REPLICA',
        phase: 'replica-human',
        text: 'Replica 无有效实例，标记为待复刻'
      }
    }));
  }

  try {
    await mutateCurrent(context, async (current) => {
      await runSealedModelArena(current, {
        evidenceVault: context.evidenceVault,
        now: context.now,
        ...(services.runAnonymousArena
          ? { runAnonymousArena: services.runAnonymousArena }
          : {}),
        ...(services.arenaOptions ? { arenaOptions: services.arenaOptions } : {})
      });
      return current;
    });
  } catch (error) {
    console.error(
      `[v2-pipeline] sealed model Arena run failed for ${context.evaluationId}`,
      error
    );
  }

  const beforeOpen = context.store.get(context.evaluationId);
  if (beforeOpen.governance?.replicaHumanPhase === 'replica_human_open') {
    return beforeOpen;
  }
  return await mutateCurrent(context, (current) => {
    // Persists default replicaReviewPolicy the first time it is read so the
    // replica-human desk has a stable policy before any submission arrives.
    getReplicaReviewPolicy(current);
    return withRunProgress({
      ...current,
      governance: {
        ...current.governance,
        replicaHumanPhase: 'replica_human_open',
        replicaHumanOpenedAt: current.governance?.replicaHumanOpenedAt || context.now()
      }
    }, context, {
      entry: {
        level: 'success',
        source: 'REPLICA',
        phase: 'replica-human',
        text: '模型 Arena 已尝试密封评分，打开复刻人工复核'
      }
    });
  });
}

async function autoSkipHumanReview(evaluation, context) {
  const actor = {
    principalId: 'system',
    idempotencyKey: `auto-skip-human-review:${evaluation.id}`
  };
  try {
    return await mutateCurrent(context, async (current) => {
      skipHumanReview(current, { principalId: 'system' });
      await lockAndReleaseAbsoluteResult(current, {
        evidenceVault: context.evidenceVault,
        now: context.now
      }, actor);
      return current;
    });
  } catch (error) {
    console.error(`[v2-pipeline] auto-skip human review failed for ${evaluation.id}`, error);
    return context.store.get(context.evaluationId);
  }
}

function namespacePhase2Candidates(candidates, attempt) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('hidden generator candidates must be an array');
  }
  return candidates.map((candidate, index) => ({
    ...structuredClone(candidate),
    generatorCandidateId: candidate.candidateId,
    candidateId: `phase2_${attempt}_${index}_${hashCanonical({
      candidateId: candidate.candidateId,
      sourceExampleId: candidate.sourceExampleId,
      variantType: candidate.variantType
    }).slice(0, 16)}`
  }));
}

function mergeReplicaCheckpoint(previous, step, testPlan) {
  const current = previous?.status === 'running' ? previous : {};
  const next = {
    version: 'replica-checkpoint/v1',
    status: 'running',
    packageHash: current.packageHash || null,
    packageGeneratedAt: current.packageGeneratedAt || null,
    testPlanHash: hashCanonical(testPlan),
    buildDispatches: { ...(current.buildDispatches || {}) },
    builds: { ...(current.builds || {}) },
    cellDispatches: { ...(current.cellDispatches || {}) },
    turnDispatches: { ...(current.turnDispatches || {}) },
    turns: { ...(current.turns || {}) },
    failures: { ...(current.failures || {}) },
    cells: { ...(current.cells || {}) }
  };
  if (step.type === 'package-locked') {
    next.packageHash = step.packageHash;
    next.packageGeneratedAt = step.packageGeneratedAt;
  }
  if (step.type === 'build-dispatching') {
    next.buildDispatches[step.runtimeId] = {
      runtimeId: step.runtimeId,
      packageHash: step.packageHash,
      operationId: step.operationId,
      capturedAt: step.capturedAt
    };
  }
  if (step.type === 'build-complete') {
    next.builds[step.runtimeId] = {
      validity: step.validity,
      failureCategory: step.failureCategory || null,
      storageFailureCategory: step.storageFailureCategory || null,
      artifactCommitment: structuredClone(
        step.artifactCommitment || null
      ),
      failureEvidenceCommitments: structuredClone(
        step.failureEvidenceCommitments || []
      ),
      evidenceCommitments: structuredClone(
        step.evidenceCommitments || []
      )
    };
  }
  if (step.type === 'cell-dispatching') {
    next.cellDispatches[step.cellKey] = {
      cellKey: step.cellKey,
      capturedAt: step.capturedAt,
      runtimeId: step.runtimeId,
      packageHash: step.packageHash,
      testPlanHash: step.testPlanHash,
      testId: step.testId,
      repeatIndex: step.repeatIndex
    };
  }
  if (step.type === 'turn-dispatching') {
    next.turnDispatches[step.turnKey] = {
      operationId: step.operationId,
      capturedAt: step.capturedAt,
      runtimeId: step.runtimeId,
      packageHash: step.packageHash,
      testPlanHash: step.testPlanHash,
      testId: step.testId,
      repeatIndex: step.repeatIndex,
      turnIndex: step.turnIndex,
      inputHash: step.inputHash
    };
  }
  if (step.type === 'turn-evidence-committed') {
    next.turns[step.turnKey] = {
      resultCommitment: structuredClone(step.resultCommitment),
      validity: step.validity,
      runtimeId: step.runtimeId,
      packageHash: step.packageHash,
      testPlanHash: step.testPlanHash,
      testId: step.testId,
      repeatIndex: step.repeatIndex,
      turnIndex: step.turnIndex,
      inputHash: step.inputHash
    };
  }
  if (step.type === 'failure-evidence-committed') {
    next.failures[step.failureKey] = {
      failureCommitment: structuredClone(step.failureCommitment),
      failurePhase: step.failurePhase,
      runtimeId: step.runtimeId,
      packageHash: step.packageHash,
      testPlanHash: step.testPlanHash,
      testId: step.testId,
      repeatIndex: step.repeatIndex,
      turnIndex: step.turnIndex,
      inputHash: step.inputHash
    };
  }
  if (step.type === 'cell-complete') {
    next.cells[`${step.runtimeId}:${step.testId}:${step.repeatIndex}`] = {
      cellKey: step.cellKey,
      runtimeId: step.runtimeId,
      packageHash: step.packageHash,
      testPlanHash: step.testPlanHash,
      testId: step.testId,
      repeatIndex: step.repeatIndex,
      validity: step.validity,
      failureCategory: step.failureCategory || null,
      runCount: step.runCount,
      turnCount: step.turnCount,
      evidenceCommitments: structuredClone(
        step.evidenceCommitments || []
      )
    };
  }
  return next;
}

function summarizePhase2Execution(testPlan, execution) {
  const variantCounts = {
    original: 0,
    equivalent: 0,
    boundary: 0,
    multiTurn: 0,
    protocolRecovery: 0
  };
  for (const test of testPlan.tests) {
    const key = test.variantType === 'multi-turn'
      ? 'multiTurn'
      : test.variantType === 'protocol-recovery'
        ? 'protocolRecovery'
        : test.variantType;
    if (Object.hasOwn(variantCounts, key)) variantCounts[key] += 1;
  }
  return {
    totalTests: testPlan.tests.length,
    repeatCount: testPlan.defaultRepeatCount,
    plannedCells: testPlan.tests.reduce(
      (sum, test) => sum + test.repeatCount,
      0
    ),
    completedCells: execution.testRuns.length,
    variantCounts
  };
}

function isFormalPhase2Submission(submission) {
  return Boolean(
    submission?.config?.hiddenTestPackageVersion &&
    submission?.config?.modelConfigVersion &&
    submission?.config?.runtimeConfigVersion === 'phase2-black-box-runtime/v1'
  );
}

function hasEveryApprovedSlot(
  compilation,
  candidates,
  decisions,
  requiredVariants = ['equivalent', 'boundary', 'multi-turn']
) {
  const decisionById = new Map(
    decisions.map((decision) => [decision.candidateId, decision])
  );
  const approvedSlots = new Set(candidates.flatMap((candidate) => {
    const decision = decisionById.get(candidate.candidateId);
    const approved = decision?.approved === true &&
      Object.values(decision.checks || {}).every((value) => value === true);
    return approved
      ? [`${candidate.sourceExampleId}:${candidate.variantType}`]
      : [];
  }));
  return compilation.contracts.every((contract) =>
    requiredVariants.every((variantType) =>
      approvedSlots.has(`${contract.exampleId}:${variantType}`)
    )
  );
}

function appendPhase2TestRun(execution, testRun) {
  const current = execution || {
    status: 'running',
    testRuns: [],
    reusedCells: []
  };
  const identityHash = hashCanonical(testRun.cellIdentity);
  const testRuns = current.testRuns || [];
  if (testRuns.some((item) =>
    hashCanonical(item.cellIdentity) === identityHash
  )) {
    return current;
  }
  return {
    ...current,
    status: 'running',
    testRuns: [...testRuns, structuredClone(testRun)],
    partialCells: (current.partialCells || []).filter(
      (item) => hashCanonical(item.cellIdentity) !== identityHash
    )
  };
}

function appendPhase2PartialTurn(execution, {
  test,
  repeatIndex,
  attemptIndex,
  cellIdentity,
  run
}) {
  const current = execution || {
    status: 'running',
    testRuns: [],
    partialCells: [],
    reusedCells: []
  };
  const identityHash = hashCanonical(cellIdentity);
  const partialCells = structuredClone(current.partialCells || []);
  let partial = partialCells.find(
    (item) => hashCanonical(item.cellIdentity) === identityHash
  );
  if (!partial) {
    partial = {
      cellIdentity: structuredClone(cellIdentity),
      partialTestRun: {
        testId: test.testId,
        repeatIndex,
        attempts: []
      }
    };
    partialCells.push(partial);
  }
  let attempt = partial.partialTestRun.attempts.find(
    (item) => item.attemptIndex === attemptIndex
  );
  if (!attempt) {
    attempt = { attemptIndex, runs: [] };
    partial.partialTestRun.attempts.push(attempt);
  }
  if (!attempt.runs.some((item) => item.runId === run.runId)) {
    attempt.runs.push(structuredClone(run));
  }
  return {
    ...current,
    status: 'running',
    partialCells
  };
}

async function buildPhase2EvidencePackage(
  evaluation,
  evidenceVault,
  testPlan,
  authorization
) {
  const redactedEvidence = [];
  for (const item of evaluation.evidenceManifest.items) {
    const record = await evidenceVault.get(item.evidenceId, item.recordHash);
    redactedEvidence.push({
      evidenceId: item.evidenceId,
      grade: item.grade,
      kind: item.kind,
      payload: redactEvidence(
        record.payload,
        authorization ? [authorization] : []
      )
    });
  }
  return {
    submission: {
      redactedCard: redactEvidence(
        evaluation.submission.agentCard.value,
        authorization ? [authorization] : []
      ),
      redactedExamples: redactEvidence(
        evaluation.submission.agentExamples.value,
        authorization ? [authorization] : []
      )
    },
    testCatalog: testPlan.tests.map((test) => ({
      testId: test.testId,
      variantType: test.variantType,
      criteriaKinds: [...new Set((test.criteria || []).map(
        (criterion) => criterion.type
      ))]
    })),
    evidenceManifest: evaluation.evidenceManifest.items,
    redactedEvidence,
    objectiveCapability: evaluation.objectiveCapability
  };
}

async function executeFormalCells(context) {
  const initial = context.store.get(context.evaluationId);
  const cells = initial.runtimeState.runIndex;
  for (const plannedCell of cells) {
    while (true) {
      const current = context.store.get(context.evaluationId);
      const cell = findCell(current, plannedCell.cellId);
      if (!['planned', 'running'].includes(cell.status)) break;
      const example =
        current.submission.agentExamples.value[cell.exampleIndex];
      let attempt = cell.status === 'running'
        ? cell.attempts.findLast((item) => item.attribution === null)
        : null;
      if (cell.status === 'running' && !attempt) break;
      if (!attempt) {
        const lastAttempt = cell.attempts.at(-1);
        if (lastAttempt && lastAttempt.attribution !== 'platform') break;
        const attemptIndex = lastAttempt ? lastAttempt.attemptIndex + 1 : 0;
        if (attemptIndex > context.policy.platformReplacementLimit) break;
        attempt = createFormalAttempt(cell, attemptIndex, context);
        await mutateCurrent(context, (record) =>
          updateCell(record, cell.cellId, {
            status: 'running',
            attempts: [...findCell(record, cell.cellId).attempts, attempt]
          }));
      }
      const attemptIndex = attempt.attemptIndex;
      const plannedTurns = attempt.turns.filter(
        (turn) => turn.status === 'planned'
      );
      const committedDurationMs = committedActiveElapsedMs(attempt);
      let activeElapsedMs = committedDurationMs;
      const cellStartedAt = context.clock();
      const deadline = cellStartedAt +
        Math.max(0, context.policy.timeoutMs - committedDurationMs);
      const priorCompleted = attempt.turns
        .filter((turn) => turn.status === 'completed')
        .at(-1);
      let returnedContextId = priorCompleted?.contextId || undefined;
      let continuationTaskId =
        priorCompleted?.continuationTaskId || undefined;
      let terminalSuccess = priorCompleted
        ? isCommittedTerminalSuccess(priorCompleted)
        : true;
      let attribution = priorCompleted?.attribution ||
        attributionForCommittedTurn(priorCompleted);
      let cellTimedOut = committedDurationMs >= context.policy.timeoutMs;
      for (const plannedTurn of plannedTurns) {
        const remainingMs = deadline - context.clock();
        if (remainingMs <= 0) {
          cellTimedOut = true;
          terminalSuccess = false;
          await skipRemainingTurns(
            context,
            cell.cellId,
            attemptIndex,
            plannedTurn.turnIndex - 1,
            example,
            cell.identity.testId
          );
          break;
        }
        const sentContextId = returnedContextId || null;
        const sentTaskId = continuationTaskId || null;
        await mutateCurrent(context, (record) => withRunProgress(
          updateAttemptTurn(record, cell.cellId, attemptIndex, plannedTurn.turnIndex, {
            status: 'dispatched',
            sentContextId,
            sentTaskId
          }),
          context,
          {
            entry: {
              level: 'info',
              source: 'A2A',
              phase: 'public-examples',
              text: `调度 ${cell.identity.testId} · R${cell.identity.repeatIndex + 1} · T${plannedTurn.turnIndex + 1}`,
              refs: {
                testId: cell.identity.testId,
                repeatIndex: cell.identity.repeatIndex,
                turnIndex: plannedTurn.turnIndex,
                runId: plannedTurn.runId
              }
            },
            activeWork: {
              key: `public:${cell.identity.testId}:${cell.identity.repeatIndex}:${plannedTurn.turnIndex}`,
              phase: 'public-examples',
              label: `公开用例 ${cell.identity.testId}`,
              detail: `repeat ${cell.identity.repeatIndex + 1} · turn ${plannedTurn.turnIndex + 1}`,
              startedAt: context.now(),
              kind: 'call'
            }
          }
        ));
        const snapshotPersistence = createSnapshotPersistence(context, {
          runId: plannedTurn.runId,
          testId: cell.identity.testId,
          turnIndex: plannedTurn.turnIndex,
          repeatIndex: cell.identity.repeatIndex
        });
        const run = await context.executeTurn({
          card: current.submission.agentCard.value,
          input: example.turns[plannedTurn.turnIndex].input,
          ...(sentContextId ? { contextId: sentContextId } : {}),
          ...(sentTaskId ? { taskId: sentTaskId } : {}),
          streaming: context.policy.streaming,
          timeoutMs: remainingMs,
          authorization: context.authorization,
          signal: context.signal,
          runId: plannedTurn.runId,
          testId: cell.identity.testId,
          turnIndex: plannedTurn.turnIndex,
          repeatIndex: cell.identity.repeatIndex,
          persistSnapshot: snapshotPersistence.persistSnapshot,
          ...(context.snapshotRequest
            ? { snapshotRequest: context.snapshotRequest }
            : {})
        });
        const evidence = await persistRunEvidence(run, {
          ...context,
          testId: cell.identity.testId,
          turnIndex: plannedTurn.turnIndex,
          repeatIndex: cell.identity.repeatIndex
        });
        mergeEvidenceBundle(evidence, snapshotPersistence);
        const rawAcceptance = context.evaluateAcceptance(
          example.turns[plannedTurn.turnIndex].acceptanceCriteria,
          run.response.currentOutput
        );
        const acceptance = safeAcceptance(
          rawAcceptance,
          cell.identity.testId,
          plannedTurn.turnIndex
        );
        attribution = await attributeRun(run, context.attributeFormalRun);
        const succeeded = run.outcome?.status === 'succeeded' &&
          run.outcome?.lifecycle === 'completed';
        terminalSuccess = succeeded;
        const nextContextId = run.response?.normalized?.contextId || null;
        const nextTaskId = run.response?.normalized?.taskId || null;
        activeElapsedMs = Math.max(
          activeElapsedMs,
          committedDurationMs +
            Math.max(0, context.clock() - cellStartedAt)
        );
        await mutateCurrent(context, (record) => {
          let next = updateAttemptTurn(
            record,
            cell.cellId,
            attemptIndex,
            plannedTurn.turnIndex,
            {
              status: 'completed',
              contextId: nextContextId,
              continuationTaskId:
                run.outcome?.lifecycle === 'interrupted' ? nextTaskId : null,
              outcome: run.outcome,
              timing: run.timing,
              acceptance,
              attribution,
              protocolObservation: protocolObservationFor(run),
              evidenceIds: evidence.evidenceIds
            }
          );
          next = updateAttempt(next, cell.cellId, attemptIndex, {
            activeElapsedMs
          });
          next = {
            ...next,
            evidenceManifest: appendManifest(
              next.evidenceManifest,
              evidence.manifestItems
            ),
            evaluationWindow: {
              ...next.evaluationWindow,
              lastRunAt: context.now()
            },
            runtimeState: {
              ...next.runtimeState,
              responseFingerprints: appendUnique(
                next.runtimeState.responseFingerprints,
                { runId: run.runId, rawHash: run.response.rawHash }
              )
            }
          };
          return next;
        });
        returnedContextId = nextContextId || undefined;
        continuationTaskId =
          run.outcome?.lifecycle === 'interrupted' && nextTaskId
            ? nextTaskId
            : undefined;
        if (run.outcome?.status !== 'succeeded' || attribution !== 'agent') {
          await skipRemainingTurns(
            context,
            cell.cellId,
            attemptIndex,
            plannedTurn.turnIndex,
            example,
            cell.identity.testId
          );
          break;
        }
      }
      const cellDurationMs = Math.max(
        activeElapsedMs,
        committedDurationMs +
          Math.max(0, context.clock() - cellStartedAt)
      );
      if (cellDurationMs >= context.policy.timeoutMs) {
        cellTimedOut = true;
        terminalSuccess = false;
        attribution = 'agent';
      }
      const latest = context.store.get(context.evaluationId);
      const completedAttempt =
        findCell(latest, cell.cellId).attempts[attemptIndex];
      const summarized = summarizeAttempt(
        completedAttempt,
        cell.requiredExecutable,
        example,
        terminalSuccess,
        attribution,
        cellTimedOut,
        cellDurationMs
      );
      const status = attribution === 'agent'
        ? 'completed'
        : attribution === 'platform' && attemptIndex <
            context.policy.platformReplacementLimit
          ? 'planned'
          : attribution === 'platform'
            ? 'unavailable-platform'
            : 'attribution-pending';
      await mutateCurrent(context, (record) => {
        const next = updateAttempt(record, cell.cellId, attemptIndex, summarized);
        return updateCell(next, cell.cellId, {
          status,
          selectedAttemptIndex: attribution === 'agent' ? attemptIndex : null
        });
      });
      if (
        attribution !== 'platform' ||
        attemptIndex >= context.policy.platformReplacementLimit
      ) break;
    }
  }
}

function createFormalAttempt(cell, attemptIndex, context) {
  return {
    attemptIndex,
    kind: attemptIndex === 0 ? 'planned' : 'platform-replacement',
    sampleRunId: context.createId('sample'),
    attribution: null,
    terminalSuccess: null,
    acceptance: null,
    schemaFingerprint: null,
    timing: null,
    activeElapsedMs: 0,
    evidenceIds: [],
    turns: cell.turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      runId: attemptIndex === 0 ? turn.runId : context.createId('run'),
      status: 'planned',
      sentContextId: null,
      sentTaskId: null,
      contextId: null,
      continuationTaskId: null,
      outcome: null,
      timing: null,
      acceptance: null,
      attribution: null,
      protocolObservation: null,
      evidenceIds: []
    }))
  };
}

async function persistSubmissionProvenance(evaluation, context) {
  const runId = 'run_submission_provenance';
  const claims = [{
    testId: `test_${hashCanonical({ kind: 'agent-card-claim' }).slice(0, 32)}`,
    kind: 'agent-card-claim',
    payload: {
      agentCard: evaluation.submission.agentCard.value,
      sha256: evaluation.submission.agentCard.sha256
    },
    summary: 'Submitted Agent Card claim'
  }, ...evaluation.submission.agentExamples.value.map((example, index) => ({
    testId: `test_${hashCanonical({
      kind: 'agent-example-claim',
      index
    }).slice(0, 32)}`,
    kind: 'agent-example-claim',
    payload: { example },
    summary: 'Submitted Agent example claim'
  }))];
  for (const claim of claims) {
    const alreadyCommitted = evaluation.evidenceManifest.items.some(
      (item) => item.runId === runId &&
        item.testId === claim.testId &&
        item.kind === claim.kind &&
        item.grade === 'C' &&
        item.turnIndex === null &&
        item.repeatIndex === null
    );
    if (alreadyCommitted) continue;
    await persistEvidence({
      ...context,
      runId,
      testId: claim.testId,
      grade: 'C',
      kind: claim.kind,
      payload: claim.payload,
      summary: claim.summary
    });
  }
}

async function persistRunEvidence(run, context) {
  const definitions = [
    ['B', 'protocol-request', run.request, 'Captured protocol request'],
    ['B', 'protocol-response', {
      rawObjects: run.response.rawObjects,
      rawHash: run.response.rawHash,
      normalized: run.response.normalized,
      snapshots: run.response.snapshots
    }, 'Captured protocol response'],
    ['A', 'platform-timing', run.timing, 'Captured platform timing'],
    ['A', 'transport-fact', {
      protocol: run.protocol,
      protocolRecovery: run.protocolRecovery || null,
      httpStatus: run.response.httpStatus,
      mediaType: run.response.mediaType,
      byteLength: run.response.byteLength,
      outcome: run.outcome,
      error: run.error
    }, 'Captured transport facts'],
    ['C', 'agent-output', run.response.currentOutput, 'Captured current Agent output']
  ];
  const evidenceIds = [];
  const manifestItems = [];
  for (const [grade, kind, payload, summary] of definitions) {
    const evidence = await storeEvidence({
      ...context,
      runId: run.runId,
      grade,
      kind,
      payload,
      summary
    });
    evidenceIds.push(evidence.record.evidenceId);
    manifestItems.push(evidence.manifestItem);
  }
  return { evidenceIds, manifestItems };
}

function createSnapshotPersistence(context, coordinates) {
  const bundle = {
    evidenceIds: [],
    manifestItems: [],
    async persistSnapshot(snapshot) {
      const evidence = await storeEvidence({
        ...context,
        ...coordinates,
        grade: 'C',
        kind: 'agent-output',
        payload: {
          bytesBase64: Buffer.from(snapshot.bytes).toString('base64'),
          mediaType: snapshot.mediaType,
          size: snapshot.size,
          sha256: snapshot.sha256,
          sourceUrl: snapshot.sourceUrl
        },
        summary: 'Captured Agent URL Part snapshot'
      });
      bundle.evidenceIds.push(evidence.record.evidenceId);
      bundle.manifestItems.push(evidence.manifestItem);
      return { evidenceId: evidence.record.evidenceId };
    }
  };
  return bundle;
}

function mergeEvidenceBundle(target, source) {
  target.evidenceIds.push(...source.evidenceIds);
  target.manifestItems.push(...source.manifestItems);
  return target;
}

async function persistEvidence(input) {
  const evidence = await storeEvidence(input);
  await mutateCurrent(input, (evaluation) => ({
    ...evaluation,
    evidenceManifest: appendManifest(
      evaluation.evidenceManifest,
      [evidence.manifestItem]
    )
  }));
  return evidence.record.evidenceId;
}

async function storeEvidence(input) {
  const record = createEvidenceRecord({
    evidenceId: input.createId('ev'),
    runId: input.runId,
    grade: input.grade,
    kind: input.kind,
    testId: input.testId,
    ...(input.turnIndex === undefined ? {} : { turnIndex: input.turnIndex }),
    ...(input.repeatIndex === undefined ? {} : { repeatIndex: input.repeatIndex }),
    capturedAt: input.now(),
    payload: input.payload
  });
  await input.evidenceVault.put(record);
  const manifestItem = createEvidenceManifestItem(record, {
    summary: input.summary,
    visibility: input.visibility || 'public',
    secrets: input.authorization ? [input.authorization] : []
  });
  return { record, manifestItem };
}

async function buildObjectiveInput(evaluation, evidenceVault) {
  const examples = evaluation.submission.agentExamples.value;
  const trustedEvidence = await loadTrustedFormalEvidence(
    evaluation,
    evidenceVault
  );
  const plannedTests = examples.map((example, exampleIndex) => {
    const cells = evaluation.runtimeState.runIndex.filter(
      (cell) => cell.exampleIndex === exampleIndex
    );
    return {
      testId: cells[0].identity.testId,
      weight: 1,
      repeatCount: cells[0].policy.repeatCount,
      requiredExecutable: cells[0].requiredExecutable,
      requiresState: example.turns.length > 1,
      timingPolicy: {
        targetMs: cells[0].policy.targetMs,
        timeoutMs: cells[0].policy.timeoutMs,
        streaming: cells[0].policy.streaming
      },
      runs: cells.map((cell) => objectiveRunForCell(cell))
    };
  });
  return {
    plannedTests,
    contextChecks: buildContextChecks(evaluation, trustedEvidence),
    a2aChecks: buildA2AChecks(evaluation, trustedEvidence),
    claimChecks: buildClaimChecks(evaluation, trustedEvidence),
    errorHandlingChecks: [{
      id: 'core_error_handling',
      status: 'unavailable',
      weight: 1,
      evidenceIds: []
    }]
  };
}

async function loadTrustedFormalEvidence(evaluation, evidenceVault) {
  const manifestById = new Map(
    evaluation.evidenceManifest.items.map((item) => [item.evidenceId, item])
  );
  const trustedEvidence = new Map();
  await loadTrustedSubmissionEvidence(
    evaluation,
    evidenceVault,
    manifestById,
    trustedEvidence
  );
  for (const cell of evaluation.runtimeState.runIndex) {
    const attempt = cell.selectedAttemptIndex === null
      ? cell.attempts.at(-1)
      : cell.attempts[cell.selectedAttemptIndex];
    if (!attempt) throw new Error('trusted evidence formal attempt is missing');
    const projectedAttemptIds = stableUnique(
      attempt.turns.flatMap((turn) => turn.evidenceIds)
    );
    if (
      attempt.evidenceIds.length !== projectedAttemptIds.length ||
      attempt.evidenceIds.some(
        (evidenceId, index) => evidenceId !== projectedAttemptIds[index]
      )
    ) {
      throw new Error('trusted evidence attempt projection mismatch');
    }
    for (const turn of attempt.turns) {
      const turnRecords = [];
      for (const evidenceId of turn.evidenceIds) {
        const item = manifestById.get(evidenceId);
        if (!item) throw new Error('trusted evidence manifest item is missing');
        const record = await evidenceVault.get(
          item.evidenceId,
          item.recordHash
        );
        if (
          item.runId !== turn.runId ||
          item.testId !== cell.identity.testId ||
          item.turnIndex !== turn.turnIndex ||
          item.repeatIndex !== cell.identity.repeatIndex ||
          record.evidenceId !== item.evidenceId ||
          record.recordHash !== item.recordHash ||
          record.runId !== turn.runId ||
          record.testId !== cell.identity.testId ||
          record.turnIndex !== turn.turnIndex ||
          record.repeatIndex !== cell.identity.repeatIndex ||
          record.kind !== item.kind ||
          record.grade !== item.grade ||
          RUN_EVIDENCE_KINDS.get(record.kind) !== record.grade
        ) {
          throw new Error('trusted evidence provenance mismatch');
        }
        trustedEvidence.set(evidenceId, record);
        turnRecords.push(record);
      }
      if (turn.status === 'completed') {
        assertCompleteTurnEvidence(turnRecords);
      }
    }
  }
  return trustedEvidence;
}

async function loadTrustedSubmissionEvidence(
  evaluation,
  evidenceVault,
  manifestById,
  trustedEvidence
) {
  const expectedClaims = [{
    kind: 'agent-card-claim',
    testId: `test_${hashCanonical({
      kind: 'agent-card-claim'
    }).slice(0, 32)}`,
    payloadMatches: (payload) =>
      payload?.sha256 === evaluation.submission.agentCard.sha256 &&
      hashCanonical(payload.agentCard) ===
        evaluation.submission.agentCard.sha256
  }, ...evaluation.submission.agentExamples.value.map(
    (example, index) => ({
      kind: 'agent-example-claim',
      testId: `test_${hashCanonical({
        kind: 'agent-example-claim',
        index
      }).slice(0, 32)}`,
      payloadMatches: (payload) =>
        hashCanonical(payload?.example) === hashCanonical(example)
    })
  )];
  for (const expected of expectedClaims) {
    const items = [...manifestById.values()].filter(
      (item) => item.runId === 'run_submission_provenance' &&
        item.testId === expected.testId &&
        item.kind === expected.kind &&
        item.grade === 'C' &&
        item.turnIndex === null &&
        item.repeatIndex === null
    );
    if (items.length !== 1) {
      throw new Error('trusted evidence submission provenance is incomplete');
    }
    const item = items[0];
    const record = await evidenceVault.get(item.evidenceId, item.recordHash);
    if (
      record.evidenceId !== item.evidenceId ||
      record.recordHash !== item.recordHash ||
      record.runId !== item.runId ||
      record.testId !== item.testId ||
      record.kind !== item.kind ||
      record.grade !== item.grade ||
      record.turnIndex !== undefined ||
      record.repeatIndex !== undefined ||
      !expected.payloadMatches(record.payload)
    ) {
      throw new Error('trusted evidence submission provenance mismatch');
    }
    trustedEvidence.set(item.evidenceId, record);
  }
}

function assertCompleteTurnEvidence(records) {
  const counts = new Map();
  for (const record of records) {
    counts.set(record.kind, (counts.get(record.kind) || 0) + 1);
  }
  for (const kind of [
    'protocol-request',
    'protocol-response',
    'platform-timing',
    'transport-fact'
  ]) {
    if (counts.get(kind) !== 1) {
      throw new Error('trusted evidence core turn set is incomplete');
    }
  }
  if ((counts.get('agent-output') || 0) < 1) {
    throw new Error('trusted evidence core turn set is incomplete');
  }
  if ([...counts].some(([kind]) => !RUN_EVIDENCE_KINDS.has(kind))) {
    throw new Error('trusted evidence core turn set has unknown evidence');
  }
}

function buildA2AChecks(evaluation, trustedEvidence) {
  const checks = [];
  const cardEvidence = [...trustedEvidence].find(
    ([, record]) => record.kind === 'agent-card-claim'
  );
  const cardValidation = validateAgentCard(
    evaluation.submission.agentCard.value
  );
  const cardValid = cardValidation.valid &&
    hashCanonical(cardValidation.selectedInterface) ===
      hashCanonical(evaluation.submission.selectedInterface);
  checks.push({
    id: 'a2a_card_validity',
    status: cardValid ? 'passed' : 'failed',
    weight: 1,
    evidenceIds: cardEvidence ? [cardEvidence[0]] : []
  });
  const transportFacts = evaluation.runtimeState.runIndex.flatMap((cell) => {
    if (cell.selectedAttemptIndex === null) return [];
    const attempt = cell.attempts[cell.selectedAttemptIndex];
    return attempt.turns.flatMap((turn) =>
      turn.evidenceIds
        .map((evidenceId) => [evidenceId, trustedEvidence.get(evidenceId)])
        .filter(([, record]) => record?.kind === 'transport-fact')
    );
  });
  const frozenInterface = evaluation.submission.selectedInterface;
  const interfaceMatches = transportFacts.length > 0 &&
    transportFacts.every(([, record]) => {
      const protocol = record.payload?.protocol;
      return protocol?.binding === frozenInterface.binding &&
        protocol.version === frozenInterface.version &&
        protocol.endpointHash === hashText(frozenInterface.url);
    });
  checks.push({
    id: 'a2a_frozen_interface',
    status: transportFacts.length === 0
      ? 'unavailable'
      : interfaceMatches ? 'passed' : 'failed',
    weight: 1,
    evidenceIds: transportFacts.map(([evidenceId]) => evidenceId)
  });
  for (const cell of evaluation.runtimeState.runIndex) {
    const selected = cell.selectedAttemptIndex !== null;
    const attempt = !selected
      ? cell.attempts.at(-1)
      : cell.attempts[cell.selectedAttemptIndex];
    for (const turn of attempt?.turns || []) {
      const entries = turn.evidenceIds.map(
        (evidenceId) => [evidenceId, trustedEvidence.get(evidenceId)]
      );
      const transportEntry = entries.find(
        ([, record]) => record?.kind === 'transport-fact'
      );
      const responseEntry = entries.find(
        ([, record]) => record?.kind === 'protocol-response'
      );
      const observation = selected && responseEntry && transportEntry
        ? {
            validated:
              transportEntry[1].payload?.protocol?.validated === true,
            rawObjects: responseEntry[1].payload?.rawObjects,
            normalized: responseEntry[1].payload?.normalized
          }
        : null;
      const evidenceIds = observation
        ? [responseEntry[0], transportEntry[0]]
        : [];
      const normalized = observation?.normalized;
      const responseValid = observation?.validated === true &&
        Array.isArray(observation.rawObjects) &&
        observation.rawObjects.length > 0 &&
        ['message', 'task'].includes(normalized?.responseKind);
      checks.push({
        id: `a2a_response_${cell.cellId}_${turn.turnIndex}`,
        status: observation
          ? responseValid ? 'passed' : 'failed'
          : 'unavailable',
        weight: 1,
        evidenceIds
      });
      const lifecycleValid = responseValid &&
        normalized.terminal === true &&
        (
          normalized.responseKind === 'message' ||
          isTerminalTaskState(normalized.terminalState)
        );
      checks.push({
        id: `a2a_lifecycle_${cell.cellId}_${turn.turnIndex}`,
        status: observation
          ? lifecycleValid ? 'passed' : 'failed'
          : 'unavailable',
        weight: 1,
        evidenceIds
      });
      const statusSequenceValid = lifecycleValid &&
        validStatusSequence(normalized);
      checks.push({
        id: `a2a_status_sequence_${cell.cellId}_${turn.turnIndex}`,
        status: observation
          ? statusSequenceValid ? 'passed' : 'failed'
          : 'unavailable',
        weight: 1,
        evidenceIds
      });
      const partsValid = responseValid &&
        Array.isArray(normalized.parts) &&
        normalized.parts.every(isObservedPart);
      checks.push({
        id: `a2a_parts_${cell.cellId}_${turn.turnIndex}`,
        status: observation
          ? partsValid ? 'passed' : 'failed'
          : 'unavailable',
        weight: 1,
        evidenceIds
      });
      const artifactsValid = responseValid &&
        Array.isArray(normalized.artifacts) &&
        normalized.artifacts.every(isObservedArtifact);
      checks.push({
        id: `a2a_artifacts_${cell.cellId}_${turn.turnIndex}`,
        status: observation
          ? artifactsValid ? 'passed' : 'failed'
          : 'unavailable',
        weight: 1,
        evidenceIds
      });
    }
  }
  return checks;
}

function buildClaimChecks(evaluation, trustedEvidence) {
  if (evaluation.submission.agentCard.value.capabilities?.streaming !== true) {
    return [];
  }
  const checks = [];
  for (const cell of evaluation.runtimeState.runIndex) {
    if (cell.policy.streaming !== true) continue;
    const selected = cell.selectedAttemptIndex !== null;
    const attempt = selected
      ? cell.attempts[cell.selectedAttemptIndex]
      : cell.attempts.at(-1);
    for (const turn of attempt?.turns || []) {
      const entries = turn.evidenceIds.map(
        (evidenceId) => [evidenceId, trustedEvidence.get(evidenceId)]
      );
      const responseEntry = entries.find(
        ([, record]) => record?.kind === 'protocol-response'
      );
      const transportEntry = entries.find(
        ([, record]) => record?.kind === 'transport-fact'
      );
      const timingEntry = entries.find(
        ([, record]) => record?.kind === 'platform-timing'
      );
      const observation = selected &&
        responseEntry && transportEntry && timingEntry;
      const passed = observation &&
        transportEntry[1].payload?.protocol?.validated === true &&
        contentTypeBase(transportEntry[1].payload?.mediaType) ===
          'text/event-stream' &&
        Number.isFinite(timingEntry[1].payload?.firstEventMs) &&
        Array.isArray(responseEntry[1].payload?.rawObjects) &&
        responseEntry[1].payload.rawObjects.length > 0;
      checks.push({
        id: `claim_streaming_${cell.cellId}_${turn.turnIndex}`,
        status: !observation
          ? 'unavailable'
          : passed ? 'passed' : 'failed',
        weight: 1,
        evidenceIds: observation
          ? [responseEntry[0], transportEntry[0], timingEntry[0]]
          : []
      });
    }
  }
  return checks;
}

function validStatusSequence(normalized) {
  if (!Array.isArray(normalized.statusSequence)) return false;
  if (normalized.responseKind === 'message') {
    return normalized.statusSequence.length === 0 &&
      normalized.terminalState === null;
  }
  if (
    normalized.responseKind !== 'task' ||
    normalized.statusSequence.length === 0
  ) {
    return false;
  }
  return normalizeTaskState(normalized.statusSequence.at(-1)) ===
    normalizeTaskState(normalized.terminalState);
}

function isTerminalTaskState(value) {
  return new Set([
    'COMPLETED',
    'FAILED',
    'CANCELED',
    'CANCELLED',
    'REJECTED',
    'INTERRUPTED',
    'INPUT_REQUIRED',
    'AUTH_REQUIRED'
  ]).has(normalizeTaskState(value));
}

function normalizeTaskState(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/^TASK_STATE_/u, '')
    .replace(/-/gu, '_');
}

function isObservedArtifact(value) {
  return isRecord(value) &&
    typeof (value.artifactId || value.id) === 'string' &&
    (value.artifactId || value.id).length > 0 &&
    Array.isArray(value.parts) &&
    value.parts.length > 0 &&
    value.parts.every(isObservedPart);
}

function isObservedPart(value) {
  if (!isRecord(value)) return false;
  if (value.kind === undefined) {
    const choices = ['text', 'data', 'raw', 'url'].filter(
      (key) => Object.hasOwn(value, key)
    );
    if (choices.length !== 1) return false;
    if (choices[0] === 'text') return typeof value.text === 'string';
    if (choices[0] === 'raw' || choices[0] === 'url') {
      return typeof value[choices[0]] === 'string';
    }
    return value.data !== undefined;
  }
  if (value.kind === 'text') return typeof value.text === 'string';
  if (value.kind === 'data') return isRecord(value.data);
  if (value.kind !== 'file' || !isRecord(value.file)) return false;
  return ['uri', 'bytes'].filter(
    (key) => Object.hasOwn(value.file, key)
  ).length === 1;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' &&
    !Array.isArray(value);
}

function contentTypeBase(value) {
  return typeof value === 'string'
    ? value.split(';', 1)[0].trim().toLowerCase()
    : '';
}

function objectiveRunForCell(cell) {
  const attempt = cell.selectedAttemptIndex === null
    ? cell.attempts.at(-1)
    : cell.attempts[cell.selectedAttemptIndex];
  return {
    runId: attempt.sampleRunId,
    repeatIndex: cell.identity.repeatIndex,
    attribution: attempt.attribution,
    terminalSuccess: attempt.terminalSuccess,
    acceptance: attempt.acceptance,
    schemaFingerprint: attempt.schemaFingerprint,
    timing: attempt.timing,
    evidenceIds: attempt.evidenceIds
  };
}

function buildContextChecks(evaluation, trustedEvidence) {
  const cells = evaluation.runtimeState.runIndex;
  const examples = evaluation.submission.agentExamples.value;
  const checks = [];
  const contexts = [];
  for (const cell of cells) {
    const selected = cell.selectedAttemptIndex !== null;
    const attempt = !selected
      ? cell.attempts.at(-1)
      : cell.attempts[cell.selectedAttemptIndex];
    if (!attempt) {
      contexts.push({
        cell,
        values: [],
        initialClean: false,
        hasInitialContext: false,
        attempt: null,
        observable: false
      });
      continue;
    }
    for (let index = 1; index < attempt.turns.length; index += 1) {
      const current = attempt.turns[index];
      checks.push({
        id: `context_retention_${cell.cellId}_${index}`,
        kind: 'retention',
        status: !selected
          ? 'unavailable'
          : current.sentContextId && current.contextId
          ? current.sentContextId === current.contextId ? 'passed' : 'failed'
          : 'unavailable',
        weight: 1,
        evidenceIds: current.evidenceIds.filter((id) => trustedEvidence.has(id))
      });
      const criteria =
        examples[cell.exampleIndex].turns[index].acceptanceCriteria;
      if (criteria.some(
        (criterion) => criterion.required !== false &&
          criterion.type !== 'model'
      )) {
        checks.push({
          id: `context_correction_${cell.cellId}_${index}`,
          kind: 'correction',
          status: !selected
            ? 'unavailable'
            : current.acceptance?.semanticSuccess === true
            ? 'passed'
            : current.acceptance?.semanticSuccess === false
              ? 'failed'
              : 'unavailable',
          weight: 1,
          evidenceIds: current.evidenceIds.filter(
            (id) => trustedEvidence.has(id)
          )
        });
      }
    }
    const firstTurn = attempt.turns[0];
    contexts.push({
      cell,
      values: selected
        ? attempt.turns.map((turn) => turn.contextId).filter(Boolean)
        : [],
      initialClean: selected &&
        firstTurn?.sentContextId === null &&
        firstTurn?.sentTaskId === null,
      hasInitialContext: selected && Boolean(firstTurn?.contextId),
      attempt,
      observable: selected
    });
  }
  for (const item of contexts) {
    const duplicate = item.values.some((value) => contexts.some(
      (other) => other.cell.cellId !== item.cell.cellId &&
        other.values.includes(value)
    ));
    checks.push({
      id: `context_isolation_${item.cell.cellId}`,
      kind: 'isolation',
      status: !item.observable
        ? 'unavailable'
        : !item.initialClean
          ? 'failed'
          : duplicate
            ? 'failed'
            : !item.hasInitialContext
              ? 'unavailable'
              : 'passed',
      weight: 1,
      evidenceIds: (item.attempt?.evidenceIds || []).filter(
        (id) => trustedEvidence.has(id)
      )
    });
  }
  return checks;
}

function summarizeAttempt(
  attempt,
  requiredExecutable,
  example,
  terminalSuccess,
  attribution,
  cellTimedOut,
  cellDurationMs
) {
  const completedTurns = attempt.turns.filter((turn) => turn.status === 'completed');
  const closedTurns = attempt.turns.filter(
    (turn) => ['completed', 'skipped'].includes(turn.status)
  );
  const checks = closedTurns.flatMap((turn) => turn.acceptance?.checks || []);
  const passedRequiredExecutable = closedTurns.reduce(
    (sum, turn) => sum + (turn.acceptance?.passedRequiredExecutable || 0),
    0
  );
  return {
    attribution,
    terminalSuccess,
    acceptance: {
      requiredExecutable,
      passedRequiredExecutable,
      semanticSuccess: requiredExecutable === 0
        ? null
        : passedRequiredExecutable === requiredExecutable,
      checks
    },
    schemaFingerprint: schemaFingerprintForExample(example),
    activeElapsedMs: cellDurationMs,
    timing: {
      durationMs: attribution === 'agent' ? cellDurationMs : null,
      firstEventMs: null,
      timedOut: cellTimedOut || completedTurns.some(
        (turn) => turn.outcome?.status === 'timeout' ||
          turn.outcome?.lifecycle === 'timeout'
      )
    },
    evidenceIds: stableUnique(
      completedTurns.flatMap((turn) => turn.evidenceIds)
    )
  };
}

function committedActiveElapsedMs(attempt) {
  if (
    typeof attempt.activeElapsedMs === 'number' &&
    Number.isFinite(attempt.activeElapsedMs) &&
    attempt.activeElapsedMs >= 0
  ) {
    return attempt.activeElapsedMs;
  }
  return attempt.turns.reduce(
    (sum, turn) => sum + (
      turn.status === 'completed'
        ? Math.max(0, turn.timing?.durationMs || 0)
        : 0
    ),
    0
  );
}

function safeAcceptance(acceptance, testId, turnIndex) {
  const checks = acceptance.checks.map((check, index) => ({
    ...check,
    id: `check_${hashCanonical({
      testId,
      turnIndex,
      index,
      submittedCriterionId: check.id
    }).slice(0, 32)}`
  }));
  return { ...acceptance, checks };
}

function closedAcceptance(criteria, testId, turnIndex) {
  const checks = criteria.map((criterion) => ({
    id: criterion.id,
    type: criterion.type,
    required: criterion.required !== false,
    status: criterion.type === 'model' ? 'not-executable' : 'failed'
  }));
  const requiredExecutable = checks.filter(
    (check) => check.required && check.status !== 'not-executable'
  ).length;
  return safeAcceptance({
    checks,
    requiredExecutable,
    passedRequiredExecutable: 0,
    semanticSuccess: requiredExecutable === 0 ? null : false
  }, testId, turnIndex);
}

function schemaFingerprintForExample(example) {
  const contracts = example.turns.flatMap((turn, turnIndex) =>
    turn.acceptanceCriteria
      .filter((criterion) => criterion.type === 'json-schema')
      .map((criterion) => ({
        turnIndex,
        criterionId: criterion.id,
        schema: criterion.schema
      }))
  );
  return contracts.length > 0 ? hashCanonical(contracts) : null;
}

function protocolObservationFor(run) {
  const normalized = run.response?.normalized || {};
  return {
    validated: run.protocol?.validated === true,
    binding: run.protocol?.binding || null,
    version: run.protocol?.version || null,
    responseKind: normalized.responseKind || 'unknown',
    terminal: normalized.terminal === true,
    terminalState: normalized.terminalState || null,
    statusSequence: Array.isArray(normalized.statusSequence)
      ? [...normalized.statusSequence]
      : [],
    partCount: Array.isArray(normalized.parts) ? normalized.parts.length : 0,
    artifactCount: Array.isArray(normalized.artifacts)
      ? normalized.artifacts.length
      : 0
  };
}

async function attributeRun(run, attributeFormalRun) {
  if (typeof attributeFormalRun === 'function') {
    return await attributeFormalRun(run);
  }
  if (run.outcome?.status === 'agent-error' ||
      run.outcome?.status === 'succeeded') {
    return 'agent';
  }
  if (run.error?.category === 'transport') return 'pending';
  if (['instrumentation', 'configuration'].includes(run.error?.category)) {
    return 'platform';
  }
  return 'agent';
}

function attributionForCommittedTurn(turn) {
  if (!turn) return 'agent';
  if (turn.attribution) return turn.attribution;
  if (['succeeded', 'agent-error'].includes(turn.outcome?.status)) {
    return 'agent';
  }
  return turn.outcome?.status === 'platform-error' ? 'platform' : 'pending';
}

function isCommittedTerminalSuccess(turn) {
  const lifecycle = turn?.outcome?.committedLifecycle ??
    turn?.outcome?.lifecycle;
  return turn?.outcome?.status === 'succeeded' &&
    lifecycle === 'completed';
}

function isVersionValidObservation(run) {
  return run.protocol?.validated === true &&
    ['message', 'task'].includes(
    run.response?.normalized?.responseKind
  ) && Array.isArray(run.response?.rawObjects) &&
    run.response.rawObjects.length > 0;
}

async function markFirstDispatch(context) {
  await mutateCurrent(context, (record) => ({
    ...record,
    evaluationWindow: {
      firstRunAt: record.evaluationWindow.firstRunAt || context.now(),
      lastRunAt: record.evaluationWindow.lastRunAt
    }
  }));
}

async function mutateCurrent(context, updater) {
  const current = context.store.get(context.evaluationId);
  if (context.worker && current.execution?.status === 'cancelled') {
    const error = new Error('V2 evaluation was cancelled');
    error.name = 'AbortError';
    throw error;
  }
  const committed = await context.store.mutate(
    context.evaluationId,
    current.revision,
    updater
  );
  context.events?.emit?.(context.evaluationId, committed);
  return committed;
}

function withRunProgress(record, context, options = {}) {
  let next = record;
  if (options.execution) {
    next = { ...next, execution: options.execution };
  }
  const at = context.now();
  const secrets = [context.authorization].filter(Boolean);
  if (options.entry) {
    const entry = createRunLogEntry({
      id: context.createId('log'),
      at,
      level: options.entry.level,
      source: options.entry.source,
      phase: options.entry.phase,
      text: sanitizeLogText(options.entry.text, secrets),
      detail: options.entry.detail != null
        ? sanitizeLogText(options.entry.detail, secrets)
        : undefined,
      durationMs: options.entry.durationMs,
      refs: options.entry.refs
    });
    void writeRunLogFile(context, {
      ...entry,
      evaluationId: context.evaluationId,
      ...(options.entry.internalDetail
        ? { internalDetail: sanitizeLogText(options.entry.internalDetail, secrets) }
        : {})
    });
    next = applyRunLog(next, entry);
  }
  if (Object.hasOwn(options, 'activeWork')) {
    const work = options.activeWork;
    next = applyActiveWork(
      next,
      work == null
        ? null
        : {
            ...work,
            startedAt: work.startedAt || at,
            label: sanitizeLogText(work.label, secrets),
            ...(work.detail != null
              ? { detail: sanitizeLogText(work.detail, secrets) }
              : {})
          }
    );
  }
  return next;
}

async function writeRunLogFile(context, payload) {
  try {
    const root = context.runLogRoot || path.join(MODULE_ROOT, 'data', 'runlogs');
    await appendRunLogFile(runLogFilePath(root, context.evaluationId), payload);
  } catch {
    // Local diagnostics must not block evaluation progress.
  }
}

function safeErrorDetail(error) {
  if (!error) return 'unknown error';
  if (typeof error.code === 'string' && error.code) {
    return `${error.code}: ${error.message || 'failed'}`;
  }
  return String(error.message || error);
}

async function interruptEvaluation(context) {
  try {
    const current = context.store.get(context.evaluationId);
    if (
      current.execution.status === 'completed' ||
      current.execution.status === 'cancelled'
    ) return;
    await mutateCurrent(context, (record) => withRunProgress({
      ...record,
      execution: {
        status: 'interrupted',
        stage: 'evidence',
        progress: record.execution.progress,
        interruptedAt: context.now()
      },
      resultV2: null,
      auditEvents: appendAudit(record.auditEvents, {
        id: context.createId('audit'),
        type: 'execution-interrupted',
        occurredAt: context.now(),
        summary: 'Execution paused before a trustworthy evidence commit'
      })
    }, context, {
      entry: {
        level: 'warn',
        source: 'SYSTEM',
        phase: 'interrupted',
        text: '执行已中断，可使用评测 ID 恢复'
      },
      activeWork: null
    }));
  } catch {
    // Preserve the original infrastructure failure when interruption cannot commit.
  }
}

function appendManifest(manifest, items) {
  return {
    ...manifest,
    items: [...manifest.items, ...items]
  };
}

function updateCell(record, cellId, patch) {
  return {
    ...record,
    runtimeState: {
      ...record.runtimeState,
      runIndex: record.runtimeState.runIndex.map((cell) =>
        cell.cellId === cellId ? { ...cell, ...patch } : cell
      )
    }
  };
}

function updateAttempt(record, cellId, attemptIndex, patch) {
  const cell = findCell(record, cellId);
  const attempts = cell.attempts.map((attempt) =>
    attempt.attemptIndex === attemptIndex
      ? { ...attempt, ...patch }
      : attempt
  );
  return updateCell(record, cellId, { attempts });
}

function updateAttemptTurn(record, cellId, attemptIndex, turnIndex, patch) {
  const cell = findCell(record, cellId);
  const attempt = cell.attempts.find(
    (item) => item.attemptIndex === attemptIndex
  );
  return updateAttempt(record, cellId, attemptIndex, {
    turns: attempt.turns.map((turn) =>
      turn.turnIndex === turnIndex ? { ...turn, ...patch } : turn
    )
  });
}

async function skipRemainingTurns(
  context,
  cellId,
  attemptIndex,
  turnIndex,
  example,
  testId
) {
  await mutateCurrent(context, (record) => {
    const cell = findCell(record, cellId);
    const attempt = cell.attempts.find(
      (item) => item.attemptIndex === attemptIndex
    );
    return updateAttempt(record, cellId, attemptIndex, {
      turns: attempt.turns.map((turn) =>
        turn.turnIndex > turnIndex && turn.status === 'planned'
          ? {
              ...turn,
              status: 'skipped',
              acceptance: closedAcceptance(
                example.turns[turn.turnIndex].acceptanceCriteria,
                testId,
                turn.turnIndex
              )
            }
          : turn
      )
    });
  });
}

function findCell(record, cellId) {
  const cell = record.runtimeState.runIndex.find(
    (item) => item.cellId === cellId
  );
  if (!cell) throw new Error('formal run cell is missing');
  return cell;
}

function appendFingerprint(runtimeState, run) {
  return {
    ...runtimeState,
    responseFingerprints: appendUnique(
      runtimeState.responseFingerprints,
      { runId: run.runId, rawHash: run.response.rawHash }
    )
  };
}

function appendUnique(values, item) {
  return values.some((value) => value.runId === item.runId)
    ? values
    : [...values, item];
}

function appendAudit(values, event) {
  return values.some((value) => value.id === event.id)
    ? values
    : [...values, event];
}

function publicSelectedInterface(submission) {
  return {
    binding: submission.selectedInterface.binding,
    version: submission.selectedInterface.version,
    endpointHash: hashText(submission.selectedInterface.url)
  };
}

function countRequiredExecutable(example) {
  return example.turns.reduce(
    (sum, turn) => sum + turn.acceptanceCriteria.filter(
      (criterion) => criterion.required !== false && criterion.type !== 'model'
    ).length,
    0
  );
}

function stableUnique(values) {
  return [...new Set(values)];
}

function hashCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashText(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function defaultId(prefix = 'id') {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function requiredService(value, name) {
  if (!value) throw new TypeError(`${name} service is required`);
  return value;
}

function abortableSleep(delay, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('cancelled'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
