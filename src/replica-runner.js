import { createHash, randomUUID } from 'node:crypto';
import { createReplicaPackage } from './replica-package.js';
import {
  REPLICA_BUILD_BUDGET_V1,
  REPLICA_RUN_BUDGET_V1
} from './replica-budgets.js';
import { classifyReplicaFailure } from './replica-failures.js';
import {
  normalizeReplicaResult,
  validateReplicaArtifact
} from './replica-adapter.js';
import {
  canonicalJson,
  createEvidenceManifestItem,
  createEvidenceRecord
} from './evidence.js';
import { inputForTurn } from './test-plan.js';

const HARD_ENFORCEMENT = Object.freeze({
  wallClock: 'hard',
  tokens: 'hard',
  outputBytes: 'hard',
  network: 'hard'
});
const HASH = /^[a-f0-9]{64}$/u;

/**
 * Builds exactly one temporary Skill per configured Runtime. Checkpoint
 * failures are platform failures and deliberately sit outside Runtime failure
 * attribution.
 */
export async function buildReplicas(options = {}) {
  const runtimes = requiredArray(options.runtimes, 'runtimes');
  const evidenceVault = requiredObject(options.evidenceVault, 'evidenceVault');
  const now = options.now || (() => new Date().toISOString());
  const replicaPackage = (options.createReplicaPackage || createReplicaPackage)(
    options.agentCard,
    options.agentExamples,
    {
      rubricVersion: requiredString(options.rubricVersion, 'rubricVersion'),
      generatedAt:
        options.resume?.packageGeneratedAt ||
        options.generatedAt ||
        now(),
      ...(options.packageOptions || {})
    }
  );
  const packageHash = replicaPackage.manifest.contentHash;
  const packageGeneratedAt = replicaPackage.manifest.generatedAt;
  if (
    options.resume?.packageHash &&
    options.resume.packageHash !== packageHash
  ) {
    throw replicaError(
      'CHECKPOINT_COMMITMENT_MISMATCH',
      'Replica checkpoint package hash did not match the rebuilt public package'
    );
  }
  await checkpoint(options, {
    version: 'replica-checkpoint/v1',
    type: 'package-locked',
    packageHash,
    packageGeneratedAt
  });

  const resumeBuilds = options.resume?.builds || {};
  const resumeDispatches = options.resume?.buildDispatches || {};
  const sealedManifestItems = [];
  const summaries = [];

  for (const runtime of runtimes) {
    const runtimeId = requiredString(runtime?.id, 'runtime.id');
    const resumed = resumeBuilds[runtimeId];
    if (resumed) {
      const summary = await resumeBuildSummary({
        evidenceVault,
        resumed,
        runtimeId,
        packageHash
      });
      summaries.push(summary);
      sealedManifestItems.push(
        ...(await manifestsForCommitments(
          evidenceVault,
          summary.evidenceCommitments,
          options.secrets
        ))
      );
      continue;
    }

    const operationId = stableOperationId(
      'build',
      packageHash,
      runtimeId
    );
    const dispatch = resumeDispatches[runtimeId];
    if (dispatch) {
      assertBuildDispatch(dispatch, {
        runtimeId,
        packageHash,
        operationId
      });
    }
    const capturedAt = dispatch?.capturedAt || now();
    assertIso(capturedAt, 'build capturedAt');
    await checkpoint(options, {
      version: 'replica-checkpoint/v1',
      type: 'build-dispatching',
      runtimeId,
      packageHash,
      operationId,
      capturedAt
    });

    const adapter = resolveAdapter(options, runtime);
    let summary;
    if (!adapter) {
      summary = invalidRuntime(
        runtimeId,
        'invalid-infrastructure',
        { code: 'ADAPTER_CONFIG_INVALID' }
      );
      await addFailureEvidence(summary, {
        evidenceVault,
        capturedAt,
        runtimeId,
        operationId,
        packageHash,
        failurePhase: 'adapter-resolution',
        error: { code: 'ADAPTER_CONFIG_INVALID' },
        secrets: options.secrets
      });
    } else {
      let health;
      let stage = 'health';
      try {
        health = await adapter.health({ phase: 'replica-build' });
        if (!isHardHealthy(health)) {
          throw replicaError(
            health?.code || 'REPLICA_ENFORCEMENT_UNPROVEN',
            'Replica Runtime health did not prove hard enforcement'
          );
        }
        stage = 'build';
        const artifact = await adapter.build(
          structuredClone(replicaPackage),
          REPLICA_BUILD_BUDGET_V1,
          buildOptions(options, runtimeId, packageHash)
        );
        validateReplicaArtifact(artifact, REPLICA_BUILD_BUDGET_V1, {
          packageHash
        });
        if (artifact.runtimeId !== runtimeId) {
          throw replicaError(
            'UNSAFE_REPLICA_ARTIFACT',
            'Replica artifact Runtime identity mismatch'
          );
        }
        stage = 'evidence';
        const evidence = await persistEvidence({
          evidenceVault,
          capturedAt,
          runtimeId,
          operationId,
          payload: {
            phase: 'build',
            runtimeId,
            packageHash,
            artifact,
            health
          },
          secrets: options.secrets
        });
        sealedManifestItems.push(evidence.manifestItem);
        summary = {
          runtimeId,
          validity: 'pending-first-run',
          artifact: structuredClone(artifact),
          artifactEvidenceIds: [evidence.record.evidenceId],
          artifactCommitment: commitmentFor(evidence.record),
          evidenceIds: [evidence.record.evidenceId],
          evidenceCommitments: [commitmentFor(evidence.record)],
          failureEvidenceCommitments: [],
          failureCategory: null,
          storageFailureCategory: null
        };
      } catch (error) {
        if (stage === 'evidence') throw error;
        const classification = classifyReplicaFailure(error, {
          ready: health?.ready === true,
          artifactValid: false,
          executionStarted: false
        });
        summary = invalidRuntime(
          runtimeId,
          classification.source === 'replica-infrastructure'
            ? 'invalid-build'
            : 'attribution-pending',
          error,
          health
        );
        await addFailureEvidence(summary, {
          evidenceVault,
          capturedAt,
          runtimeId,
          operationId,
          packageHash,
          failurePhase: stage,
          error,
          health,
          secrets: options.secrets
        });
      }
    }

    summaries.push(summary);
    await checkpoint(options, buildCompleteStep(summary, {
      packageHash,
      operationId,
      capturedAt
    }));
  }

  const evidenceCommitments = uniqueCommitments(
    summaries.flatMap((summary) => summary.evidenceCommitments)
  );
  return {
    packageHash,
    packageGeneratedAt,
    replicaPackage,
    runtimes: summaries,
    evidenceIds: evidenceCommitments.map((item) => item.evidenceId),
    evidenceCommitments,
    sealedManifestItems
  };
}

/**
 * Executes one immutable current input at a time. Resume validates every
 * commitment before using it and reconstructs same-example history.
 */
export async function executeReplicas(options = {}) {
  const testPlan = requiredObject(options.testPlan, 'testPlan');
  const replicas = requiredObject(options.replicas, 'replicas');
  const evidenceVault = requiredObject(options.evidenceVault, 'evidenceVault');
  const now = options.now || (() => new Date().toISOString());
  const createId = options.createId || defaultId;
  const submittedInput = options.submittedInputForTurn || inputForTurn;
  const resumeTurns = options.resume?.turns || {};
  const resumeFailures = options.resume?.failures || {};
  const resumeDispatches = options.resume?.turnDispatches || {};
  const resumeCellDispatches =
    options.resume?.cellDispatches || {};
  const resumeCells = options.resume?.cells || {};
  const packageHash = requiredHash(
    replicas.packageHash ||
      replicas.runtimes?.[0]?.artifact?.manifest?.packageHash,
    'replicas.packageHash'
  );
  const testPlanHash = hashCanonical(testPlan);
  if (
    options.resume?.testPlanHash &&
    options.resume.testPlanHash !== testPlanHash
  ) {
    throw replicaError(
      'CHECKPOINT_COMMITMENT_MISMATCH',
      'Replica checkpoint test-plan hash mismatch'
    );
  }
  if (testPlan.defaultRepeatCount !== 3) {
    throw new TypeError(
      'Replica execution requires exactly three planned repeats'
    );
  }

  const results = replicas.runtimes.map((replica) => ({
    runtimeId: replica.runtimeId,
    validity: replica.validity,
    artifactEvidenceIds: [...(replica.artifactEvidenceIds || [])],
    runCount: 0,
    turnCount: 0,
    evidenceIds: [],
    evidenceCommitments: [],
    failureEvidenceCommitments: [],
    failureCategory: replica.failureCategory || null,
    storageFailureCategory: replica.storageFailureCategory || null,
    runs: []
  }));
  const byRuntime = new Map(
    results.map((item) => [item.runtimeId, item])
  );
  const sealedManifestItems = [];

  for (const test of requiredArray(testPlan.tests, 'testPlan.tests')) {
    const testId = requiredString(test.testId, 'test.testId');
    const turns = requiredArray(test.turns, 'test.turns');
    const repeatCount =
      test.repeatCount ?? testPlan.defaultRepeatCount;
    if (repeatCount !== 3) {
      throw new TypeError(
        'Each Replica test requires exactly three planned repeats'
      );
    }
    for (let repeatIndex = 0; repeatIndex < 3; repeatIndex += 1) {
      for (const replica of replicas.runtimes) {
        const result = byRuntime.get(replica.runtimeId);
        if (
          !result ||
          !['pending-first-run', 'valid'].includes(result.validity)
        ) {
          continue;
        }
        const cellKey = stableOperationId(
          'cell',
          packageHash,
          testPlanHash,
          replica.runtimeId,
          testId,
          repeatIndex
        );
        const resumedCell = resumeCells[
          checkpointCellKey(replica.runtimeId, testId, repeatIndex)
        ];
        if (resumedCell) {
          assertCellCheckpoint(resumedCell, {
            cellKey,
            runtimeId: replica.runtimeId,
            packageHash,
            testPlanHash,
            testId,
            repeatIndex
          });
        }
        const cellDispatch = resumeCellDispatches[cellKey];
        if (cellDispatch) {
          assertCellCheckpoint(cellDispatch, {
            cellKey,
            runtimeId: replica.runtimeId,
            packageHash,
            testPlanHash,
            testId,
            repeatIndex
          });
          assertIso(
            cellDispatch.capturedAt,
            'cell dispatch capturedAt'
          );
        }
        const cellCapturedAt =
          cellDispatch?.capturedAt || now();
        if (!resumedCell) {
          await checkpoint(options, {
            version: 'replica-checkpoint/v1',
            type: 'cell-dispatching',
            cellKey,
            capturedAt: cellCapturedAt,
            runtimeId: replica.runtimeId,
            packageHash,
            testPlanHash,
            testId,
            repeatIndex
          });
        }
        const adapter = resolveAdapter(options, { id: replica.runtimeId });
        if (!adapter) {
          const failureKey = stableOperationId(
            'failure',
            cellKey,
            'adapter-resolution'
          );
          await resumeOrAddFailure(result, {
            prior: resumeFailures[failureKey],
            evidenceVault,
            capturedAt: cellCapturedAt,
            runtimeId: replica.runtimeId,
            operationId: failureKey,
            packageHash,
            testPlanHash,
            testId,
            repeatIndex,
            failurePhase: 'adapter-resolution',
            error: { code: 'ADAPTER_CONFIG_INVALID' },
            secrets: options.secrets
          });
          result.validity = 'invalid-infrastructure';
          result.failureCategory = 'ADAPTER_CONFIG_INVALID';
          await checkpoint(options, {
            version: 'replica-checkpoint/v1',
            type: 'failure-evidence-committed',
            failureKey,
            runtimeId: replica.runtimeId,
            packageHash,
            testPlanHash,
            testId,
            repeatIndex,
            turnIndex: null,
            failurePhase: 'adapter-resolution',
            failureCommitment:
              result.failureEvidenceCommitments.at(-1)
          });
          continue;
        }

        const context = { id: createId('ctx'), history: [] };
        let completedCell = true;
        const shouldDispose = !resumedCell;
        try {
          for (
            let turnIndex = 0;
            turnIndex < turns.length;
            turnIndex += 1
          ) {
            const submitted = structuredClone(
              submittedInput(test, turnIndex)
            );
            const currentInput = deepFreeze(
              structuredClone(inputForTurn(test, turnIndex))
            );
            if (
              canonicalJson(currentInput) !== canonicalJson(submitted)
            ) {
              throw replicaError(
                'INPUT_PARITY_MISMATCH',
                'Replica current input must equal submitted-Agent input'
              );
            }
            const inputHash = hashCanonical(currentInput);
            const turnKey = stableOperationId(
              'turn',
              packageHash,
              testPlanHash,
              replica.runtimeId,
              testId,
              repeatIndex,
              turnIndex,
              inputHash
            );
            const coordinates = {
              runtimeId: replica.runtimeId,
              packageHash,
              testPlanHash,
              testId,
              repeatIndex,
              turnIndex,
              inputHash
            };
            const prior = resumeTurns[turnKey];
            let normalized;
            let resultEvidence;
            if (prior?.resultCommitment) {
              assertTurnCheckpoint(prior, coordinates);
              resultEvidence = await loadCommittedResult(
                evidenceVault,
                prior.resultCommitment,
                coordinates,
                turnKey
              );
              normalized = normalizeReplicaResult(
                resultEvidence.payload.result
              );
              result.validity = prior.validity || 'valid';
            } else {
              const dispatch = resumeDispatches[turnKey];
              if (dispatch) {
                assertTurnDispatch(dispatch, {
                  operationId: turnKey,
                  ...coordinates
                });
              }
              const capturedAt = dispatch?.capturedAt || now();
              assertIso(capturedAt, 'turn capturedAt');
              await checkpoint(options, {
                version: 'replica-checkpoint/v1',
                type: 'turn-dispatching',
                turnKey,
                operationId: turnKey,
                capturedAt,
                ...coordinates
              });
              const failureKey = stableOperationId(
                'failure',
                turnKey,
                'run'
              );
              const committedFailure =
                resumeFailures[failureKey];
              if (committedFailure?.failureCommitment) {
                const record = await resumeOrAddFailure(result, {
                  prior: committedFailure,
                  evidenceVault,
                  capturedAt,
                  operationId: failureKey,
                  ...coordinates,
                  failurePhase: 'run'
                });
                const failure = classifyReplicaFailure(
                  record.payload.error,
                  {
                    ready: true,
                    artifactValid: true,
                    executionStarted:
                      record.payload.error?.code !==
                        'EXECUTION_BOUNDARY_NOT_STARTED'
                  }
                );
                result.failureCategory ||= failure.code;
                if (
                  failure.scoreSemantics === 'invalidate-replica' ||
                  failure.scoreSemantics === 'hold-for-review'
                ) {
                  result.validity =
                    failure.scoreSemantics === 'invalidate-replica'
                      ? 'invalid-infrastructure'
                      : 'attribution-pending';
                  completedCell = false;
                  break;
                }
                normalized = normalizedFailureResult(
                  failure,
                  record.payload.error
                );
                result.validity = 'valid';
              } else try {
                const output = await adapter.run(
                  replica.artifact,
                  currentInput,
                  context,
                  {
                    ...REPLICA_RUN_BUDGET_V1,
                    wallClockMs: test.timing?.timeoutMs
                  },
                  {
                    seed: options.seed ?? null,
                    idempotencyKey: opaqueId(turnKey)
                  }
                );
                normalized = normalizeReplicaResult(output);
                if (normalized.status === 'invalid-output') {
                  throw replicaError(
                    'INVALID_REPLICA_OUTPUT',
                    normalized.error?.message
                  );
                }
                result.validity = 'valid';
              } catch (error) {
                const failure = classifyReplicaFailure(error, {
                  ready: true,
                  artifactValid: true,
                  executionStarted:
                    error?.code !== 'EXECUTION_BOUNDARY_NOT_STARTED'
                });
                await resumeOrAddFailure(result, {
                  prior: resumeFailures[failureKey],
                  evidenceVault,
                  capturedAt,
                  operationId: failureKey,
                  ...coordinates,
                  failurePhase: 'run',
                  error,
                  secrets: options.secrets
                });
                await checkpoint(options, {
                  version: 'replica-checkpoint/v1',
                  type: 'failure-evidence-committed',
                  failureKey,
                  failurePhase: 'run',
                  failureCommitment:
                    result.failureEvidenceCommitments.at(-1),
                  ...coordinates
                });
                if (
                  failure.scoreSemantics === 'invalidate-replica' ||
                  failure.scoreSemantics === 'hold-for-review'
                ) {
                  result.validity =
                    failure.scoreSemantics === 'invalidate-replica'
                      ? 'invalid-infrastructure'
                      : 'attribution-pending';
                  result.failureCategory ||= failure.code;
                  completedCell = false;
                  break;
                }
                normalized = normalizedFailureResult(failure, error);
                result.validity = 'valid';
                result.failureCategory ||= failure.code;
              }
              resultEvidence = (
                await persistEvidence({
                  evidenceVault,
                  capturedAt,
                  runtimeId: replica.runtimeId,
                  operationId: turnKey,
                  turnIndex,
                  repeatIndex,
                  payload: {
                    phase: 'run',
                    runtimeId: replica.runtimeId,
                    packageHash,
                    testPlanHash,
                    testId,
                    repeatIndex,
                    turnIndex,
                    inputHash,
                    input: currentInput,
                    result: normalized
                  },
                  secrets: options.secrets
                })
              ).record;
              await checkpoint(options, {
                version: 'replica-checkpoint/v1',
                type: 'turn-evidence-committed',
                turnKey,
                ...coordinates,
                resultCommitment: commitmentFor(resultEvidence),
                validity: result.validity
              });
            }

            const commitment = commitmentFor(resultEvidence);
            addCommitment(result, commitment, false);
            sealedManifestItems.push(
              createEvidenceManifestItem(resultEvidence, {
                summary: 'Replica evidence sealed',
                visibility: 'admin',
                secrets: options.secrets || []
              })
            );
            result.runs.push({
              testId,
              repeatIndex,
              turnIndex,
              status: normalized.status,
              evidenceId: resultEvidence.evidenceId
            });
            result.turnCount += 1;
            context.history.push({
              input: structuredClone(currentInput),
              output: structuredClone(normalized.messageParts)
            });
          }
        } finally {
          if (shouldDispose) {
            const failureKey = stableOperationId(
              'failure',
              cellKey,
              'dispose'
            );
            const committedFailure =
              resumeFailures[failureKey];
            if (committedFailure?.failureCommitment) {
              const record = await resumeOrAddFailure(result, {
                prior: committedFailure,
                evidenceVault,
                capturedAt: cellCapturedAt,
                runtimeId: replica.runtimeId,
                operationId: failureKey,
                packageHash,
                testPlanHash,
                testId,
                repeatIndex,
                failurePhase: 'dispose'
              });
              result.failureCategory ||=
                record.payload.error?.code ||
                'CONTEXT_DISPOSE_FAILED';
              if (result.validity !== 'attribution-pending') {
                result.validity = 'invalid-infrastructure';
              }
              completedCell = false;
            } else try {
              await adapter.disposeContext(context);
            } catch (error) {
              await resumeOrAddFailure(result, {
                prior: resumeFailures[failureKey],
                evidenceVault,
                capturedAt: cellCapturedAt,
                runtimeId: replica.runtimeId,
                operationId: failureKey,
                packageHash,
                testPlanHash,
                testId,
                repeatIndex,
                failurePhase: 'dispose',
                error,
                secrets: options.secrets
              });
              await checkpoint(options, {
                version: 'replica-checkpoint/v1',
                type: 'failure-evidence-committed',
                failureKey,
                runtimeId: replica.runtimeId,
                packageHash,
                testPlanHash,
                testId,
                repeatIndex,
                turnIndex: null,
                failurePhase: 'dispose',
                failureCommitment:
                  result.failureEvidenceCommitments.at(-1)
              });
              if (!result.failureCategory) {
                result.failureCategory =
                  error?.code || 'CONTEXT_DISPOSE_FAILED';
              }
              if (result.validity !== 'attribution-pending') {
                result.validity = 'invalid-infrastructure';
              }
              completedCell = false;
            }
          }
        }

        if (completedCell && result.validity === 'valid') {
          result.runCount += 1;
        }
        await checkpoint(options, {
          version: 'replica-checkpoint/v1',
          type: 'cell-complete',
          cellKey,
          runtimeId: replica.runtimeId,
          packageHash,
          testPlanHash,
          testId,
          repeatIndex,
          validity: result.validity,
          failureCategory: result.failureCategory,
          runCount: result.runCount,
          turnCount: result.turnCount,
          evidenceCommitments: structuredClone(
            result.evidenceCommitments
          )
        });
      }
    }
  }

  return {
    testPlanHash,
    runtimes: results,
    sealedManifestItems,
    evidenceCommitments: uniqueCommitments(
      results.flatMap((item) => item.evidenceCommitments)
    )
  };
}

/** Converts internal build/run state to the private Phase 3 sealed envelope. */
export async function sealReplicaArena(options = {}) {
  const built = requiredObject(options.built, 'built');
  const executed = requiredObject(options.executed, 'executed');
  const packageHash = requiredHash(
    options.packageHash || built.packageHash,
    'packageHash'
  );
  const packageGeneratedAt = requiredString(
    options.packageGeneratedAt || built.packageGeneratedAt,
    'packageGeneratedAt'
  );
  assertIso(packageGeneratedAt, 'packageGeneratedAt');
  const testPlanHash = requiredHash(
    options.testPlanHash || executed.testPlanHash,
    'testPlanHash'
  );
  const runByRuntime = new Map(
    requiredArray(executed.runtimes, 'executed.runtimes').map(
      (item) => [item.runtimeId, item]
    )
  );
  const runtimeSummaries = requiredArray(
    built.runtimes,
    'built.runtimes'
  ).map((build) => {
    const run = runByRuntime.get(build.runtimeId);
    const evidenceCommitments = uniqueCommitments([
      ...(build.evidenceCommitments || []),
      ...(run?.evidenceCommitments || [])
    ]);
    return {
      runtimeId: build.runtimeId,
      validity: run?.validity || build.validity,
      artifactEvidenceIds: [...(build.artifactEvidenceIds || [])],
      runCount: run?.runCount || 0,
      turnCount: run?.turnCount || 0,
      failureCategory:
        run?.failureCategory || build.failureCategory || null,
      evidenceCommitments
    };
  });
  const evidenceCommitments = uniqueCommitments(
    options.evidenceCommitments ||
      runtimeSummaries.flatMap((item) => item.evidenceCommitments)
  );
  return {
    status: 'sealed',
    sealVersion: 'replica-arena-seal/v1',
    packageHash,
    packageGeneratedAt,
    testPlanHash,
    runtimeSummaries,
    evidenceCommitments,
    encryptedArenaEvidenceIds:
      options.encryptedArenaEvidenceIds
        ? uniqueStrings(options.encryptedArenaEvidenceIds)
        : evidenceCommitments.map((item) => item.evidenceId),
    releasedAt: null
  };
}

export function sealedReplicaProjection(replicaArena) {
  const summaries = Array.isArray(replicaArena?.runtimeSummaries)
    ? replicaArena.runtimeSummaries
    : [];
  return {
    status: replicaArena?.status || 'disabled',
    validReplicaCount: summaries.filter(
      (item) => item.validity === 'valid'
    ).length,
    pendingAttributionCount: summaries.filter(
      (item) => item.validity === 'attribution-pending'
    ).length
  };
}

async function persistEvidence({
  evidenceVault,
  capturedAt,
  runtimeId,
  operationId,
  testId = 'replica_evidence',
  turnIndex,
  repeatIndex,
  payload,
  secrets
}) {
  assertIso(capturedAt, 'evidence capturedAt');
  const evidenceId = evidenceIdFor(operationId, payload.phase);
  const record = createEvidenceRecord({
    evidenceId,
    runId: `run_${hashCanonical({ operationId }).slice(0, 32)}`,
    grade: 'C',
    kind: 'agent-output',
    testId,
    ...(turnIndex === undefined ? {} : { turnIndex }),
    ...(repeatIndex === undefined ? {} : { repeatIndex }),
    capturedAt,
    payload: structuredClone(payload)
  });
  try {
    await evidenceVault.put(record);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await evidenceVault.get(
      record.evidenceId,
      record.recordHash
    );
    if (existing.payloadHash !== record.payloadHash) throw error;
  }
  return {
    record,
    manifestItem: createEvidenceManifestItem(record, {
      summary: 'Replica evidence sealed',
      visibility: 'admin',
      secrets: secrets || []
    })
  };
}

function invalidRuntime(runtimeId, validity, error, health = null) {
  const classification = classifyReplicaFailure(error, {
    ready: health?.ready === true
  });
  return {
    runtimeId,
    validity,
    artifact: null,
    artifactEvidenceIds: [],
    artifactCommitment: null,
    evidenceIds: [],
    evidenceCommitments: [],
    failureEvidenceCommitments: [],
    failureCategory: classification.code,
    storageFailureCategory: null
  };
}

async function addFailureEvidence(summary, options) {
  const evidence = await persistFailureEvidence(options);
  addCommitment(summary, commitmentFor(evidence.record), true);
  return evidence;
}

async function resumeOrAddFailure(summary, options) {
  if (options.prior?.failureCommitment) {
    const record = await loadCommittedFailure(
      options.evidenceVault,
      options.prior.failureCommitment,
      options
    );
    addCommitment(summary, commitmentFor(record), true);
    return record;
  }
  return (await addFailureEvidence(summary, options)).record;
}

async function persistFailureEvidence({
  evidenceVault,
  capturedAt,
  runtimeId,
  operationId,
  packageHash,
  testPlanHash,
  testId,
  repeatIndex,
  turnIndex,
  inputHash,
  failurePhase,
  error,
  health,
  secrets
}) {
  const payload = compactObject({
    phase: 'failure',
    failurePhase,
    runtimeId,
    packageHash,
    testPlanHash,
    testId,
    repeatIndex,
    turnIndex,
    inputHash,
    error: errorPayload(error),
    health:
      health === undefined ? undefined : structuredClone(health)
  });
  return persistEvidence({
    evidenceVault,
    capturedAt,
    runtimeId,
    operationId,
    turnIndex:
      Number.isSafeInteger(turnIndex) ? turnIndex : undefined,
    repeatIndex:
      Number.isSafeInteger(repeatIndex) ? repeatIndex : undefined,
    payload,
    secrets
  });
}

async function resumeBuildSummary({
  evidenceVault,
  resumed,
  runtimeId,
  packageHash
}) {
  const evidenceCommitments = validateCommitmentArray(
    resumed.evidenceCommitments || [
      resumed.artifactCommitment,
      ...(resumed.failureEvidenceCommitments || [])
    ].filter(Boolean)
  );
  let artifact = null;
  if (resumed.artifactCommitment) {
    artifact = await loadCommittedArtifact(
      evidenceVault,
      resumed.artifactCommitment,
      { runtimeId, packageHash }
    );
  }
  for (const commitment of resumed.failureEvidenceCommitments || []) {
    await loadCommittedFailure(evidenceVault, commitment, {
      runtimeId,
      packageHash,
      operationId: stableOperationId(
        'build',
        packageHash,
        runtimeId
      )
    });
  }
  return {
    runtimeId,
    validity: resumed.validity,
    artifact,
    artifactEvidenceIds:
      resumed.artifactCommitment
        ? [resumed.artifactCommitment.evidenceId]
        : [],
    artifactCommitment:
      resumed.artifactCommitment
        ? structuredClone(resumed.artifactCommitment)
        : null,
    evidenceIds: evidenceCommitments.map((item) => item.evidenceId),
    evidenceCommitments,
    failureEvidenceCommitments: validateCommitmentArray(
      resumed.failureEvidenceCommitments || []
    ),
    failureCategory: resumed.failureCategory || null,
    storageFailureCategory: resumed.storageFailureCategory || null
  };
}

async function loadCommittedArtifact(vault, commitment, expected) {
  const record = await loadCommittedRecord(vault, commitment);
  assertRecordEnvelope(record, commitment, {
    operationId: stableOperationId(
      'build',
      expected.packageHash,
      expected.runtimeId
    ),
    phase: 'build'
  });
  if (
    record.testId !== 'replica_evidence' ||
    record.turnIndex !== undefined ||
    record.repeatIndex !== undefined ||
    record.payload?.runtimeId !== expected.runtimeId ||
    record.payload?.packageHash !== expected.packageHash
  ) {
    throw commitmentMismatch('Replica artifact coordinates mismatch');
  }
  const artifact = structuredClone(record.payload?.artifact);
  validateReplicaArtifact(artifact, REPLICA_BUILD_BUDGET_V1, {
    packageHash: expected.packageHash
  });
  if (artifact.runtimeId !== expected.runtimeId) {
    throw commitmentMismatch('Replica artifact Runtime mismatch');
  }
  return artifact;
}

async function loadCommittedResult(
  vault,
  commitment,
  expected,
  operationId
) {
  const record = await loadCommittedRecord(vault, commitment);
  assertRecordEnvelope(record, commitment, {
    operationId,
    phase: 'run'
  });
  if (
    record.testId !== 'replica_evidence' ||
    record.turnIndex !== expected.turnIndex ||
    record.repeatIndex !== expected.repeatIndex ||
    record.payload?.phase !== 'run' ||
    record.payload?.runtimeId !== expected.runtimeId ||
    record.payload?.packageHash !== expected.packageHash ||
    record.payload?.testPlanHash !== expected.testPlanHash ||
    record.payload?.testId !== expected.testId ||
    record.payload?.repeatIndex !== expected.repeatIndex ||
    record.payload?.turnIndex !== expected.turnIndex ||
    record.payload?.inputHash !== expected.inputHash
  ) {
    throw commitmentMismatch('Replica turn coordinates mismatch');
  }
  return record;
}

async function loadCommittedFailure(vault, commitment, expected) {
  const record = await loadCommittedRecord(vault, commitment);
  if (expected.operationId !== undefined) {
    assertRecordEnvelope(record, commitment, {
      operationId: expected.operationId,
      phase: 'failure'
    });
  }
  if (
    record.evidenceId !== commitment.evidenceId ||
    record.recordHash !== commitment.recordHash ||
    record.payloadHash !== commitment.payloadHash ||
    record.payload?.phase !== 'failure' ||
    (expected.runtimeId !== undefined &&
      record.payload?.runtimeId !== expected.runtimeId) ||
    (expected.packageHash !== undefined &&
      record.payload?.packageHash !== expected.packageHash) ||
    (expected.testPlanHash !== undefined &&
      record.payload?.testPlanHash !== expected.testPlanHash) ||
    (expected.testId !== undefined &&
      record.payload?.testId !== expected.testId) ||
    (expected.repeatIndex !== undefined &&
      record.payload?.repeatIndex !== expected.repeatIndex) ||
    (expected.turnIndex !== undefined &&
      record.payload?.turnIndex !== expected.turnIndex) ||
    (expected.inputHash !== undefined &&
      record.payload?.inputHash !== expected.inputHash) ||
    (expected.failurePhase !== undefined &&
      record.payload?.failurePhase !== expected.failurePhase) ||
    (Number.isSafeInteger(expected.turnIndex)
      ? record.turnIndex !== expected.turnIndex
      : record.turnIndex !== undefined) ||
    (Number.isSafeInteger(expected.repeatIndex)
      ? record.repeatIndex !== expected.repeatIndex
      : expected.repeatIndex === undefined &&
        record.repeatIndex !== undefined)
  ) {
    throw commitmentMismatch('Replica failure coordinates mismatch');
  }
  return record;
}

async function loadCommittedRecord(vault, commitment) {
  assertCommitment(commitment);
  const record = await vault.get(
    commitment.evidenceId,
    commitment.recordHash
  );
  if (
    record.evidenceId !== commitment.evidenceId ||
    record.recordHash !== commitment.recordHash ||
    record.payloadHash !== commitment.payloadHash
  ) {
    throw commitmentMismatch('Replica evidence commitment mismatch');
  }
  return record;
}

function assertRecordEnvelope(record, commitment, expected) {
  if (
    record.evidenceId !==
      evidenceIdFor(expected.operationId, expected.phase) ||
    record.evidenceId !== commitment.evidenceId ||
    record.kind !== 'agent-output' ||
    record.grade !== 'C' ||
    record.payload?.phase !== expected.phase
  ) {
    throw commitmentMismatch('Replica evidence identity mismatch');
  }
}

function assertTurnCheckpoint(prior, expected) {
  for (const field of [
    'runtimeId',
    'packageHash',
    'testPlanHash',
    'testId',
    'repeatIndex',
    'turnIndex',
    'inputHash'
  ]) {
    if (prior[field] !== expected[field]) {
      throw commitmentMismatch(
        `Replica turn checkpoint ${field} mismatch`
      );
    }
  }
}

function assertBuildDispatch(dispatch, expected) {
  for (const field of [
    'runtimeId',
    'packageHash',
    'operationId'
  ]) {
    if (dispatch[field] !== expected[field]) {
      throw commitmentMismatch(
        `Replica build dispatch ${field} mismatch`
      );
    }
  }
  assertIso(dispatch.capturedAt, 'build dispatch capturedAt');
}

function assertTurnDispatch(dispatch, expected) {
  for (const field of [
    'operationId',
    'runtimeId',
    'packageHash',
    'testPlanHash',
    'testId',
    'repeatIndex',
    'turnIndex',
    'inputHash'
  ]) {
    if (dispatch[field] !== expected[field]) {
      throw commitmentMismatch(
        `Replica turn dispatch ${field} mismatch`
      );
    }
  }
  assertIso(dispatch.capturedAt, 'turn dispatch capturedAt');
}

function assertCellCheckpoint(cell, expected) {
  for (const field of [
    'cellKey',
    'runtimeId',
    'packageHash',
    'testPlanHash',
    'testId',
    'repeatIndex'
  ]) {
    if (cell[field] !== expected[field]) {
      throw commitmentMismatch(
        `Replica cell checkpoint ${field} mismatch`
      );
    }
  }
}

async function manifestsForCommitments(vault, commitments, secrets) {
  const items = [];
  for (const commitment of commitments) {
    const record = await loadCommittedRecord(vault, commitment);
    items.push(createEvidenceManifestItem(record, {
      summary: 'Replica evidence sealed',
      visibility: 'admin',
      secrets: secrets || []
    }));
  }
  return items;
}

function buildCompleteStep(summary, dispatch) {
  return {
    version: 'replica-checkpoint/v1',
    type: 'build-complete',
    runtimeId: summary.runtimeId,
    validity: summary.validity,
    failureCategory: summary.failureCategory,
    storageFailureCategory: summary.storageFailureCategory,
    artifactCommitment: structuredClone(summary.artifactCommitment),
    failureEvidenceCommitments: structuredClone(
      summary.failureEvidenceCommitments
    ),
    evidenceCommitments: structuredClone(summary.evidenceCommitments),
    ...dispatch
  };
}

function addCommitment(summary, commitment, failure) {
  assertCommitment(commitment);
  summary.evidenceCommitments = uniqueCommitments([
    ...(summary.evidenceCommitments || []),
    commitment
  ]);
  summary.evidenceIds = summary.evidenceCommitments.map(
    (item) => item.evidenceId
  );
  if (failure) {
    summary.failureEvidenceCommitments = uniqueCommitments([
      ...(summary.failureEvidenceCommitments || []),
      commitment
    ]);
  }
}

function commitmentFor(record) {
  return {
    evidenceId: record.evidenceId,
    recordHash: record.recordHash,
    payloadHash: record.payloadHash
  };
}

function validateCommitmentArray(values) {
  if (!Array.isArray(values)) {
    throw commitmentMismatch('Replica commitment list is invalid');
  }
  return uniqueCommitments(values.map((item) => {
    assertCommitment(item);
    return structuredClone(item);
  }));
}

function uniqueCommitments(values) {
  const result = [];
  const seen = new Set();
  for (const item of values) {
    assertCommitment(item);
    if (seen.has(item.evidenceId)) continue;
    seen.add(item.evidenceId);
    result.push(structuredClone(item));
  }
  return result;
}

function uniqueStrings(values) {
  return [...new Set(values.map((item) =>
    requiredString(item, 'evidenceId')
  ))];
}

function assertCommitment(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'evidenceId,payloadHash,recordHash' ||
    typeof value.evidenceId !== 'string' ||
    !/^ev_[a-f0-9]{64}$/u.test(value.evidenceId) ||
    !HASH.test(value.recordHash) ||
    !HASH.test(value.payloadHash)
  ) {
    throw commitmentMismatch('Replica evidence commitment is invalid');
  }
}

async function checkpoint(options, value) {
  await options.checkpoint?.(structuredClone(value));
}

function resolveAdapter(options, runtime) {
  if (typeof options.createAdapter === 'function') {
    return options.createAdapter(runtime);
  }
  if (options.adapters instanceof Map) {
    return options.adapters.get(runtime.id);
  }
  return options.adapters?.[runtime.id] || null;
}

function isHardHealthy(value) {
  return (
    value?.ready === true &&
    canonicalJson(value.budgetEnforcement) ===
      canonicalJson(HARD_ENFORCEMENT)
  );
}

function buildOptions(options, runtimeId, packageHash) {
  return {
    seed: options.seed ?? null,
    temperature: options.temperature ?? 0,
    idempotencyKey: opaqueId(
      stableOperationId('build', packageHash, runtimeId)
    )
  };
}

function checkpointCellKey(runtimeId, testId, repeatIndex) {
  return `${runtimeId}:${testId}:${repeatIndex}`;
}

function evidenceIdFor(operationId, phase) {
  return `ev_${hashCanonical({ operationId, phase })}`;
}

function errorPayload(error) {
  return compactObject({
    name:
      typeof error?.name === 'string' ? error.name : undefined,
    code:
      typeof error?.code === 'string'
        ? error.code
        : 'UNKNOWN_REPLICA_FAILURE',
    message: String(
      error?.message || error?.code || 'Unknown Replica failure'
    )
  });
}

function normalizedFailureResult(failure, error) {
  return {
    status: 'failed',
    messageParts: [],
    artifacts: [],
    durationMs: 0,
    error: {
      code: failure.code,
      message: String(error?.message || failure.code)
    },
    budgetUsage: {},
    evidence: {}
  };
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined)
  );
}

function hashCanonical(value) {
  return createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');
}

function stableOperationId(...parts) {
  return hashCanonical(parts);
}

function opaqueId(value) {
  return `op_${hashCanonical(value).slice(0, 32)}`;
}

function deepFreeze(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function requiredArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requiredObject(value, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requiredHash(value, name) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new TypeError(`${name} must be a SHA-256 hash`);
  }
  return value;
}

function assertIso(value, name) {
  if (
    typeof value !== 'string' ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
}

function defaultId(prefix = 'id') {
  return `${prefix}_${randomUUID()}`;
}

function replicaError(code, message) {
  return Object.assign(new Error(message), { code });
}

function commitmentMismatch(message) {
  return replicaError('CHECKPOINT_COMMITMENT_MISMATCH', message);
}
