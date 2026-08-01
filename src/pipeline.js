import { createHash, createHmac } from 'node:crypto';
import { callA2AAgent, callA2AAgentExample, validateAgentCard } from './a2a.js';
import { validateAgentAuthorization } from './a2a-executor.js';
import {
  compileBlackBoxRunPlan,
  PHASE1_EXECUTION_POLICY,
  runBlackBoxFoundation
} from './black-box-pipeline.js';
import { canonicalJson } from './evidence.js';
import { createEvaluationRecord } from './evaluation-model.js';
import {
  assertFrozenSubmissionIntegrity,
  deriveCasesFromAgentExamples,
  freezeSubmission,
  normalizeAgentExamples
} from './submission.js';
import { configuredReviewers, reviewAgent } from './providers.js';
import { buildRoast, scoreComplexity } from './scoring.js';
import { aggregateV1CardReviews, V1_CARD_REVIEW_VERSION } from './v1-card-review.js';
import { buildSkill, RUNTIMES, runSkill } from './runtimes.js';
import { average, deriveSeed, id, normalizeSeed, normalizeTemperature, now, round, stableNumber } from './utils.js';
import { buildDataPlan, collectDataEvidence, normalizeTestCases, verifyOutputAgainstEvidence } from './data-verifier.js';
import { pandaDataConfig, queryPandaData } from './panda-data.js';
import { loadPandaInterfaceReference } from './panda-runtime.js';
import {
  assertV1ScoringReady,
  LEGACY_V1_SCORING_VERSION,
  normalizeV1ScoringConfig,
  scoreV1ArenaCase,
  V1_SCORING_VERSION
} from './v1-model-scoring.js';

const PIPELINE_PRIVATE = new WeakMap();
const V2_CONFIG = Object.freeze({
  rubricVersion: 'a2a-black-box-v1',
  hiddenTestPackageVersion: 'black-box-test-plan/v1',
  modelConfigVersion: 'panel-v1',
  runtimeConfigVersion: 'phase2-black-box-runtime/v1'
});
const V2_CREATE_FIELDS = new Set([
  'schemaVersion', 'agentCard', 'agentExamples', 'agentAuthorization', 'skipHumanReview'
]);
const V2_RESUME_FIELDS = new Set(['agentAuthorization']);

export class EvaluationPipeline {
  constructor(store, events, options = {}) {
    this.store = store;
    this.events = events;
    this.activeRuns = new Map();
    this.dataQuery = options.dataQuery || queryPandaData;
    this.dataVerificationEnabled = options.dataVerificationEnabled ?? (process.env.NODE_ENV !== 'test' && process.env.PANDA_DATA_AUTO_VERIFY === 'true');
    const pandaConfig = pandaDataConfig();
    const blackBoxEnabled = options.blackBoxEnabled === true;
    PIPELINE_PRIVATE.set(this, {
      blackBoxEnabled,
      blackBoxServices: Object.freeze({ ...(options.blackBoxServices || {}) }),
      credentialVault: options.credentialVault || null,
      resumeMacKey: blackBoxEnabled && options.resumeMacKey
        ? Buffer.from(options.resumeMacKey)
        : null,
      runBlackBox: options.runBlackBox || runBlackBoxFoundation,
      now: options.now || now,
      monotonicNow: options.monotonicNow || (() => performance.now()),
      createId: options.createId || id,
      policy: options.policy || PHASE1_EXECUTION_POLICY,
      v1Reviewers: options.v1Reviewers ?? configuredReviewers(),
      scoreV1Case: options.scoreV1Case || scoreV1ArenaCase,
      buildSkill: options.buildSkillFn || buildSkill,
      runSkill: options.runSkillFn || runSkill,
      pandaRuntimeEnabled: options.pandaRuntimeEnabled ?? (
        process.env.NODE_ENV !== 'test' && pandaConfig.ready
      ),
      pandaAllowedMethods: options.pandaAllowedMethods ?? pandaConfig.allowedMethods,
      pandaInterfaceLoader: options.pandaInterfaceLoader || loadPandaInterfaceReference,
      pandaInterfacePromise: null
    });
  }

  async pandaRuntimeContext() {
    const state = privateState(this);
    if (!state.pandaRuntimeEnabled) return undefined;
    if (!state.pandaInterfacePromise) {
      state.pandaInterfacePromise = Promise.resolve(
        state.pandaInterfaceLoader(state.pandaAllowedMethods)
      ).catch((error) => {
        state.pandaInterfacePromise = null;
        throw error;
      });
    }
    return {
      enabled: true,
      allowedMethods: [...state.pandaAllowedMethods],
      interfaceReference: await state.pandaInterfacePromise,
      query: this.dataQuery
    };
  }

  async create(input) {
    if (input?.schemaVersion === 2) {
      if (!privateState(this).blackBoxEnabled) throw v2DisabledError();
      return this.createV2(input);
    }
    const validation = validateAgentCard(input.agentCard);
    if (!validation.valid) throw Object.assign(new Error(`Agent Card 校验失败：${validation.errors.join('；')}`), { statusCode: 400 });
    if (input.seed !== undefined && (!Number.isSafeInteger(Number(input.seed)) || Number(input.seed) < 0 || Number(input.seed) > 2_147_483_646)) {
      throw Object.assign(new Error('Seed 必须是 0–2147483646 的整数'), { statusCode: 400 });
    }
    if (input.agentAuthorization !== undefined) {
      assertAgentAuthorization(input.agentAuthorization);
    }

    let agentExamples;
    let cases;
    if (input.agentExamples !== undefined) {
      try {
        agentExamples = normalizeAgentExamples(input.agentExamples);
        cases = normalizeTestCases(deriveCasesFromAgentExamples(agentExamples));
      } catch (error) {
        throw Object.assign(new Error(error.message || 'agentExamples 无效'), { statusCode: 400 });
      }
    } else if (
      Array.isArray(input.cases) &&
      input.cases.length &&
      input.cases.every((item) => typeof item?.prompt === 'string' && item.prompt.trim())
    ) {
      cases = normalizeTestCases(input.cases);
    } else {
      throw Object.assign(new Error('至少提供 agentExamples，或一个包含 prompt 的使用实例'), { statusCode: 400 });
    }

    const scoringConfig = normalizeV1ScoringConfig(input.scoringConfig);
    const reviewers = privateState(this).v1Reviewers;
    assertV1ScoringReady(scoringConfig, input.mode === 'live' ? 'live' : 'demo', reviewers);
    const seed = normalizeSeed(input.seed ?? process.env.EVALUATION_SEED);
    const temperature = normalizeTemperature(process.env.MODEL_TEMPERATURE, 0);
    const reviewPlan = publicReviewPlan(configuredReviewers());
    const runtimePlan = publicRuntimePlan();
    const evaluation = {
      id: id(), createdAt: now(), updatedAt: now(), status: 'queued', mode: input.mode === 'live' ? 'live' : 'demo',
      agentCard: input.agentCard, cases, validation, seed, temperature, reviewPlan, runtimePlan, scoringConfig, progress: 0, stage: '等待评测舱', activeWork: null, logs: [],
      ...(agentExamples ? { agentExamples } : {}),
      ...(input.agentAuthorization !== undefined ? { authorizationRequired: true } : {})
    };
    await this.store.set(evaluation);
    const state = privateState(this);
    if (input.agentAuthorization !== undefined) {
      if (!state.credentialVault) {
        throw Object.assign(new Error('Agent authorization vault is unavailable'), { statusCode: 503 });
      }
      state.credentialVault.put(evaluation.id, input.agentAuthorization);
    }
    const controller = new AbortController();
    this.activeRuns.set(evaluation.id, controller);
    queueMicrotask(() => this.run(evaluation.id, controller.signal)
      .catch((error) => this.fail(evaluation.id, error))
      .finally(() => {
        state.credentialVault?.delete(evaluation.id);
        if (this.activeRuns.get(evaluation.id) === controller) this.activeRuns.delete(evaluation.id);
      }));
    return evaluation;
  }

  async createV2(input) {
    const state = privateState(this);
    assertClosedObject(input, V2_CREATE_FIELDS, 'V2 create body');
    if (
      input.schemaVersion !== 2 ||
      !Object.hasOwn(input, 'agentCard') ||
      !Object.hasOwn(input, 'agentExamples')
    ) {
      throw httpError(
        400,
        'V2 create requires schemaVersion, agentCard, and agentExamples'
      );
    }
    if (input.agentAuthorization !== undefined) {
      assertAgentAuthorization(input.agentAuthorization);
    }
    if (input.skipHumanReview !== undefined && typeof input.skipHumanReview !== 'boolean') {
      throw httpError(400, 'skipHumanReview must be a boolean');
    }

    const createdAt = state.now();
    const cardValidation = validateAgentCard(input.agentCard);
    if (!cardValidation.valid) {
      const reason = cardValidation.interfaces.length > 0 &&
        cardValidation.selectedInterface === null &&
        cardValidation.errors.length > 0 &&
        cardValidation.errors.every((message) =>
          /at least one supported interface/iu.test(message)
        )
        ? 'unsupported-interface'
        : 'invalid-agent-card';
      throw transientIneligibleError(reason, createdAt);
    }
    let submission;
    try {
      submission = freezeSubmission({
        agentCard: input.agentCard,
        agentExamples: input.agentExamples,
        config: V2_CONFIG,
        frozenAt: createdAt
      });
    } catch (error) {
      throw httpError(400, error.message);
    }

    const evaluationId = state.createId('eval');
    const runIndex = compileBlackBoxRunPlan(submission, {
      policy: state.policy,
      createId: state.createId
    });
    const evaluation = createEvaluationRecord(submission, {
      id: evaluationId,
      createdAt,
      authorizationRequired: input.agentAuthorization !== undefined,
      endpointHash: sha256(submission.selectedInterface.url),
      agentVersion: submission.agentCard.value.version ?? null,
      serviceBuildId: null,
      runIndex,
      skipHumanReview: input.skipHumanReview === true
    });
    evaluation.auditEvents.push({
      id: state.createId('audit'),
      type: 'created',
      occurredAt: createdAt,
      summary: 'V2 black-box evaluation created'
    });
    const committed = await this.store.set(evaluation);
    this.events.emit(evaluationId, committed);
    if (input.agentAuthorization !== undefined) {
      state.credentialVault.put(evaluationId, input.agentAuthorization);
    }
    this.queueV2(committed);
    return committed;
  }

  authenticateResume(evaluationId) {
    const state = privateState(this);
    if (!state.blackBoxEnabled) throw v2DisabledError();
    const current = this.store.get(evaluationId);
    if (!current) return null;
    if (current.schemaVersion !== 2) {
      throw httpError(409, 'Resume is available only for V2 evaluations');
    }
    return current;
  }

  async resume(evaluationId, input = {}) {
    const state = privateState(this);
    let current = this.authenticateResume(evaluationId);
    if (!current) return null;
    const body = input.body === undefined ? {} : input.body;
    assertClosedObject(body, V2_RESUME_FIELDS, 'V2 resume body');
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (body.agentAuthorization !== undefined) {
      assertAgentAuthorization(body.agentAuthorization);
    }
    if (
      current.connection.authorizationRequired &&
      body.agentAuthorization === undefined
    ) {
      throw httpError(400, 'Fresh Agent authorization is required');
    }
    const keyHash = sha256(idempotencyKey);
    const requestMac = resumeRequestMac(state.resumeMacKey, body);
    const replay = findResumeReceipt(current, keyHash, requestMac);
    if (replay) return receiptResult(replay);
    assertResumable(current);
    try {
      assertFrozenSubmissionIntegrity(current.submission, V2_CONFIG);
    } catch {
      throw httpError(409, 'Frozen submission integrity check failed');
    }

    const acceptedAt = state.now();
    let committed;
    try {
      committed = await this.store.mutate(
        evaluationId,
        current.revision,
        (record) => {
          const existing = record.resumeReceipts.find(
            (receipt) => receipt.keyHash === keyHash
          );
          if (existing) {
            if (existing.requestMac !== requestMac) {
              throw httpError(409, 'Idempotency request does not match');
            }
            return record;
          }
          assertResumable(record);
          const acceptedRevision = record.revision + 1;
          const response = {
            schemaVersion: 2,
            id: evaluationId,
            accepted: true,
            revision: acceptedRevision
          };
          return {
            ...record,
            execution: {
              status: 'queued',
              stage: 'resume',
              progress: record.execution.progress
            },
            runtimeState: {
              ...record.runtimeState,
              runIndex: recoverDispatchedWork(
                record.runtimeState.runIndex,
                record.submission.agentExamples.value
              )
            },
            resumeReceipts: [...record.resumeReceipts, {
              keyHash,
              requestMac,
              acceptedAt,
              acceptedRevision,
              statusCode: 202,
              response
            }],
            auditEvents: appendAuditEvent(record.auditEvents, {
              id: state.createId('audit'),
              type: 'resume-accepted',
              occurredAt: acceptedAt,
              summary: 'Participant-authenticated resume accepted'
            })
          };
        }
      );
    } catch (error) {
      if (error.statusCode !== 409) throw error;
      current = this.store.get(evaluationId);
      const racedReplay = findResumeReceipt(current, keyHash, requestMac);
      if (racedReplay) return receiptResult(racedReplay);
      throw error;
    }
    const receipt = committed.resumeReceipts.find(
      (item) => item.keyHash === keyHash
    );
    if (body.agentAuthorization !== undefined) {
      state.credentialVault.put(evaluationId, body.agentAuthorization);
    }
    this.events.emit(evaluationId, committed);
    this.queueV2(committed);
    return receiptResult(receipt);
  }

  queueV2(evaluation) {
    const state = privateState(this);
    const previous = this.activeRuns.get(evaluation.id);
    if (previous && !previous.signal.aborted) {
      previous.abort(new Error('Superseded by a newer V2 dispatch'));
    }
    const controller = new AbortController();
    this.activeRuns.set(evaluation.id, controller);
    queueMicrotask(() => state.runBlackBox(evaluation, {
      ...state.blackBoxServices,
      store: this.store,
      events: this.events,
      credentialVault: state.credentialVault,
      signal: controller.signal,
      policy: state.policy
    }).catch(async (error) => {
      console.error(`[v2-pipeline] ${evaluation.id}`, error);
      try {
        const current = this.store.get(evaluation.id);
        const status = current?.execution?.status;
        if (
          current?.schemaVersion === 2 &&
          !['completed', 'cancelled', 'interrupted', 'failed'].includes(status)
        ) {
          const failedAt = state.now();
          const committed = await this.store.mutate(
            evaluation.id,
            current.revision,
            (record) => ({
              ...record,
              execution: {
                ...record.execution,
                status: 'interrupted',
                stage: record.execution?.stage || 'failed',
                progress: record.execution?.progress || 0,
                interruptedAt: failedAt
              },
              activeWork: null,
              runLog: [
                ...(Array.isArray(record.runLog) ? record.runLog : []),
                {
                  id: state.createId('log'),
                  at: failedAt,
                  level: 'error',
                  source: 'SYSTEM',
                  phase: 'failed',
                  text: '评测管道异常终止',
                  detail: String(error?.message || error)
                }
              ].slice(-500)
            })
          );
          this.events.emit(evaluation.id, committed);
        }
      } catch (commitError) {
        console.error(`[v2-pipeline] failed to persist terminal state for ${evaluation.id}`, commitError);
      }
    }).finally(() => {
      state.credentialVault?.delete(evaluation.id);
      if (this.activeRuns.get(evaluation.id) === controller) {
        this.activeRuns.delete(evaluation.id);
      }
    }));
  }

  async cancel(evaluationId) {
    const item = this.store.get(evaluationId);
    if (!item) return null;
    if (item.schemaVersion === 2) {
      const state = privateState(this);
      if (!state.blackBoxEnabled) {
        throw httpError(409, 'V2 cancellation service is not enabled');
      }
      if (item.archivedAt !== undefined) return item;
      const cancelledAt = state.now();
      const auditId = state.createId('audit');
      let current = item;
      let committed;
      while (!committed) {
        if (current.archivedAt !== undefined) return current;
        if (['completed', 'cancelled'].includes(current.execution.status)) {
          return current;
        }
        try {
          committed = await this.store.mutate(
            evaluationId,
            current.revision,
            (record) => {
              return {
                ...record,
                execution: {
                  status: 'cancelled',
                  stage: 'cancelled',
                  progress: record.execution.progress,
                  cancelledAt
                },
                runtimeState: {
                  ...record.runtimeState,
                  runIndex: cancelDispatchedWork(record.runtimeState.runIndex)
                },
                auditEvents: appendAuditEvent(record.auditEvents, {
                  id: auditId,
                  type: 'cancelled',
                  occurredAt: cancelledAt,
                  summary: 'V2 evaluation cancelled'
                })
              };
            }
          );
          break;
        } catch (error) {
          if (error.statusCode !== 409) throw error;
          current = this.store.get(evaluationId);
          if (!current) return null;
        }
      }
      const reason = new Error('V2 evaluation cancelled');
      reason.name = 'AbortError';
      this.activeRuns.get(evaluationId)?.abort(reason);
      state.credentialVault?.delete(evaluationId);
      this.events.emit(evaluationId, committed);
      return committed;
    }
    if (isTerminal(item.status)) return item;
    const reason = new Error('用户停止了本次评测');
    reason.name = 'AbortError';
    this.activeRuns.get(evaluationId)?.abort(reason);
    await this.update(item, { status: 'cancelled', stage: '评测已停止', stoppedAt: now(), retrying: null, activeWork: null }, {
      level: 'error', source: 'SYSTEM', phase: 'cancelled', text: '用户停止了本次评测', detail: '已保留停止前完成的所有阶段产物', mode: item.mode
    });
    return item;
  }

  async retry(evaluationId, input) {
    const item = this.store.get(evaluationId);
    if (!item) return null;
    if (item.schemaVersion === 2) {
      throw Object.assign(new Error('V2 retry service is not enabled'), { statusCode: 409 });
    }
    if (!isTerminal(item.status)) throw Object.assign(new Error('主评测仍在执行，请结束后再单独重试步骤'), { statusCode: 409 });
    const step = resolveRetryStep(item, input);
    const previous = retryTargetSummary(item, step);
    const previousStatus = item.status;
    const controller = new AbortController();
    this.activeRuns.set(evaluationId, controller);
    await this.update(item, { status: 'retrying', stage: step.label, retrying: step, activeWork: retryActivity(step) }, {
      level: 'info', source: 'RETRY', phase: step.type, text: step.label, detail: '旧结果保留至新结果返回，完成后自动重算总评', mode: item.mode
    });
    queueMicrotask(() => this.runRetry(item, step, previous, previousStatus, controller.signal)
      .catch((error) => this.failRetry(item, step, previous, previousStatus, error))
      .finally(() => { if (this.activeRuns.get(evaluationId) === controller) this.activeRuns.delete(evaluationId); }));
    return item;
  }

  async recoverInterrupted() {
    const state = privateState(this);
    for (const item of this.store.list()) {
      if (
        item.schemaVersion === 2 &&
        state.blackBoxEnabled &&
        ['queued', 'running'].includes(item.execution?.status)
      ) {
        const status = item.connection.authorizationRequired
          ? 'credentials-required'
          : 'interrupted';
        const occurredAt = state.now();
        const committed = await this.store.mutate(
          item.id,
          item.revision,
          (record) => ({
            ...record,
            execution: {
              status,
              stage: 'recovery',
              progress: record.execution.progress,
              interruptedAt: occurredAt
            },
            runtimeState: {
              ...record.runtimeState,
              runIndex: recoverDispatchedWork(
                record.runtimeState.runIndex,
                record.submission.agentExamples.value
              )
            },
            auditEvents: appendAuditEvent(record.auditEvents, {
              id: state.createId('audit'),
              type: status === 'credentials-required'
                ? 'credentials-required'
                : 'execution-interrupted',
              occurredAt,
              summary: status === 'credentials-required'
                ? 'Fresh Agent authorization is required after restart'
                : 'V2 execution interrupted by process restart'
            })
          })
        );
        this.events.emit(item.id, committed);
        continue;
      }
      if (
        item.schemaVersion !== 2 &&
        ['queued', 'running', 'retrying'].includes(item.status)
      ) {
        await this.update(item, { status: 'interrupted', stage: '服务重启，评测已中断', stoppedAt: now(), error: '执行进程在评测期间重启；已保留重启前完成的阶段产物。', activeWork: null }, {
          level: 'error', source: 'SYSTEM', phase: 'interrupted', text: '检测到未完成的遗留评测', detail: '执行进程已重启，旧任务不再实际运行', mode: item.mode
        });
      }
    }
  }

  async runRetry(item, step, previous, previousStatus, signal) {
    const startedAt = Date.now();
    signal.throwIfAborted();
    if (step.type === 'review') await this.retryReview(item, step, signal);
    if (step.type === 'build') await this.retryBuild(item, step, signal);
    if (step.type === 'benchmark') await this.retryBenchmark(item, step, signal);
    signal.throwIfAborted();
    const result = retryTargetSummary(item, step);
    appendRetryHistory(item, step, previous, result, Date.now() - startedAt);
    const derived = recalculateDerived(item);
    const completed = hasCompleteBenchmark(item);
    const scoringFailed = hasV1ModelScoring(item) && !completed;
    if (scoringFailed) {
      delete item.averages;
      delete item.roast;
      delete item.completedAt;
    }
    await this.update(item, {
      ...derived,
      status: completed ? 'completed' : scoringFailed ? 'failed' : previousStatus,
      stage: completed ? '单步复核完成，锐评已重算' : scoringFailed ? '单步复核完成，模型评分失败' : '单步复核完成',
      retrying: null,
      activeWork: null,
      ...(completed ? { completedAt: now() } : {})
    }, {
      level: result.error || scoringFailed ? 'error' : 'success', source: 'RETRY', phase: step.type,
      text: result.error
        ? `${step.shortLabel} 重试仍失败`
        : scoringFailed
          ? `${step.shortLabel} 重试输出已更新，但模型评分失败`
          : `${step.shortLabel} 重试完成，综合评分已更新`,
      detail: scoringFailed ? 'CASE 未形成完整正式分数，已移除旧的派生评级' : retryDeltaText(previous, result),
      mode: result.mode || item.mode,
      durationMs: Date.now() - startedAt
    });
  }

  async retryReview(item, step, signal) {
    const reviewer = configuredReviewers().find((candidate) => retryReviewerKey(candidate) === step.key || candidate.model === step.key || candidate.name === step.key);
    const reviews = [...(item.professional?.reviews || [])];
    const index = reviews.findIndex((review) => retryReviewResultKey(review) === step.key || review.model === step.key || review.reviewer === step.key || review.reviewer === step.reviewerName);
    const isCardReview = item.professional?.version === V1_CARD_REVIEW_VERSION;
    let next;
    try {
      next = { ...(await reviewAgent(reviewer, item.agentCard, item.complexity, item.mode, signal, {
        ...phaseSampling(item, `review:${reviewer.id}`),
        reviewVersion: isCardReview ? V1_CARD_REVIEW_VERSION : 'legacy'
      })), reviewerId: reviewer.id };
    } catch (error) {
      if (signal.aborted) throw signal.reason || error;
      next = {
        reviewerId: reviewer.id,
        reviewer: reviewer.name,
        model: reviewer.model,
        ...(isCardReview ? { version: V1_CARD_REVIEW_VERSION } : {}),
        score: 0,
        error: error.message,
        mode: 'failed'
      };
    }
    if (index === -1) reviews.push(next); else reviews[index] = next;
    item.professional = professionalSnapshot(reviews);
  }

  async retryBuild(item, step, signal) {
    const runtime = RUNTIMES.find((candidate) => candidate.id === step.key);
    const builds = [...(item.builds || [])];
    const index = builds.findIndex((build) => build.runtimeId === step.key);
    const buildContext = contextUsageCollector();
    let next;
    try {
      next = await privateState(this).buildSkill(runtime, item.agentCard.description, item.mode, {
        signal,
        ...phaseSampling(item, `build:${runtime.id}`),
        pandaData: await this.pandaRuntimeContext(),
        onContextUsage: buildContext.onContextUsage
      });
      next = { ...next, contextUsage: buildContext.contextUsage };
    } catch (error) {
      if (signal.aborted) throw signal.reason || error;
      next = { runtime: runtime.name, runtimeId: runtime.id, mode: item.mode, error: error.message, contextUsage: buildContext.contextUsage };
    }
    if (index === -1) builds.push(next); else builds[index] = next;
    item.builds = builds;
    await this.update(item, { builds, stage: `${step.shortLabel} 已重新直出，正在执行同 Prompt 对测`, activeWork: null }, {
      level: next.error ? 'error' : 'success', source: 'RETRY', phase: 'build',
      text: next.error ? `${step.shortLabel} 重建仍失败` : `${step.shortLabel} Skill 重建完成`,
      detail: next.error || next.skill?.name, mode: next.error ? 'failed' : next.mode
    });
    for (let caseIndex = 0; caseIndex < (item.benchmark || []).length; caseIndex += 1) {
      signal.throwIfAborted();
      await this.update(item, {
        activeWork: benchmarkActivity(step.key, step.shortLabel, item.benchmark[caseIndex].case, caseIndex, item.benchmark.length, true),
        stage: `${step.shortLabel} 对测 ${caseIndex + 1}/${item.benchmark.length}`
      });
      const outputRound = await this.replaceBenchmarkOutput(item, caseIndex, step.key, signal);
      const scoredRound = await this.scoreBenchmarkRound(item, caseIndex, signal, outputRound);
      this.commitBenchmarkRound(item, caseIndex, scoredRound);
      const entry = item.benchmark[caseIndex].entries.find((candidate) => candidate.id === step.key);
      await this.update(item, { benchmark: item.benchmark, stage: `${step.shortLabel} 对测 ${caseIndex + 1}/${item.benchmark.length}` }, {
        level: entry?.mode === 'failed' ? 'error' : 'success', source: 'RETRY', phase: 'benchmark',
        text: `${step.shortLabel} 完成「${item.benchmark[caseIndex].case.name}」重新对测`, detail: `score=${entry?.score ?? 0}`, mode: entry?.mode || item.mode,
        durationMs: entry?.execution?.durationMs
      });
    }
  }

  async retryBenchmark(item, step, signal) {
    const outputRound = await this.replaceBenchmarkOutput(item, step.caseIndex, step.key, signal);
    const scoredRound = await this.scoreBenchmarkRound(item, step.caseIndex, signal, outputRound);
    this.commitBenchmarkRound(item, step.caseIndex, scoredRound);
    const entry = item.benchmark[step.caseIndex].entries.find((candidate) => candidate.id === step.key);
    await this.update(item, { benchmark: item.benchmark }, {
      level: entry?.mode === 'failed' ? 'error' : 'success', source: 'RETRY', phase: 'benchmark',
      text: `${step.shortLabel} 完成「${item.benchmark[step.caseIndex].case.name}」重新对测`,
      detail: `score=${entry?.score ?? 0}`,
      mode: entry?.mode || item.mode,
      durationMs: entry?.execution?.durationMs
    });
  }

  async runSubmittedAgent(item, caseIndex, signal) {
    const authorization = privateState(this).credentialVault?.get(item.id);
    const example = Array.isArray(item.agentExamples) ? item.agentExamples[caseIndex] : null;
    if (example) {
      return callA2AAgentExample(item.agentCard, example, {
        timeoutMs: 45_000,
        signal,
        authorization
      });
    }
    const prompt = item.cases?.[caseIndex]?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error(`用例 ${caseIndex + 1} 缺少 prompt`);
    }
    return callA2AAgent(item.agentCard, prompt, 45_000, signal, { authorization });
  }

  async replaceBenchmarkOutput(item, caseIndex, competitorId, signal) {
    const currentRound = item.benchmark?.[caseIndex];
    if (!currentRound) throw new Error(`用例 ${caseIndex + 1} 不存在`);
    const roundItem = structuredClone(currentRound);
    const testCase = roundItem.case;
    let output;
    let mode = item.mode;
    let name = item.agentCard.name;
    const runtimeContext = contextUsageCollector();
    let execution;
    if (competitorId === 'submitted') {
      const measured = await measureV1Execution(
        privateState(this).monotonicNow,
        async () => item.mode === 'live'
          ? (await this.runSubmittedAgent(item, caseIndex, signal)).text
          : mockSubmittedOutput(item.agentCard, testCase)
      );
      if (measured.error) {
        if (signal.aborted) throw signal.reason || measured.error;
        output = `执行失败：${measured.error.message}`;
        mode = 'failed';
        execution = executionSnapshot('failed', measured.durationMs, runtimeContext.contextUsage);
      } else {
        output = measured.value;
        execution = executionSnapshot('succeeded', measured.durationMs, runtimeContext.contextUsage);
      }
    } else {
      const build = item.builds?.find((candidate) => candidate.runtimeId === competitorId);
      name = build?.runtime || competitorId;
      if (!build || build.error) {
        output = `执行失败：${build?.error || '对应 Runtime Skill 尚未生成'}`;
        mode = 'failed';
        execution = executionSnapshot('failed', 0, build?.contextUsage || [], 'skill-build');
      } else {
        mode = build.mode;
        const measured = await measureV1Execution(
          privateState(this).monotonicNow,
          async () => privateState(this).runSkill(build, testCase, item.mode, {
            signal,
            ...phaseSampling(item, `run:${caseIndex}:${competitorId}`),
            pandaData: await this.pandaRuntimeContext(),
            onContextUsage: runtimeContext.onContextUsage
          })
        );
        if (measured.error) {
          if (signal.aborted) throw signal.reason || measured.error;
          output = `执行失败：${measured.error.message}`;
          mode = 'failed';
          execution = executionSnapshot('failed', measured.durationMs, runtimeContext.contextUsage);
        } else {
          output = measured.value;
          execution = executionSnapshot('succeeded', measured.durationMs, runtimeContext.contextUsage);
        }
      }
    }
    const next = makeUnscoredEntry(
      competitorId, name, output, mode,
      deriveSeed(item.seed, `judge:${caseIndex}:${competitorId}`), roundItem.dataEvidence,
      execution
    );
    const entryIndex = roundItem.entries.findIndex((entry) => entry.id === competitorId);
    if (entryIndex === -1) roundItem.entries.push(next); else roundItem.entries[entryIndex] = next;
    signal?.throwIfAborted();
    return roundItem;
  }

  async scoreBenchmarkRound(item, caseIndex, signal, detachedRound) {
    const roundItem = detachedRound || structuredClone(item.benchmark?.[caseIndex]);
    if (!roundItem) throw new Error(`用例 ${caseIndex + 1} 不存在`);
    const scoring = await privateState(this).scoreV1Case({
      testCase: roundItem.case,
      entries: roundItem.entries,
      config: scoringConfigForRound(item, roundItem),
      reviewers: privateState(this).v1Reviewers,
      evaluationMode: item.mode,
      seed: deriveSeed(item.seed, `v1-case:${caseIndex}`),
      signal
    });
    signal?.throwIfAborted();
    return {
      ...roundItem,
      entries: scoring.entries,
      judging: scoring.judging
    };
  }

  commitBenchmarkRound(item, caseIndex, roundItem) {
    item.benchmark[caseIndex] = roundItem;
    const derived = recalculateDerived(item);
    Object.assign(item, derived);
    if (hasV1ModelScoring(item) && !hasCompleteBenchmark(item)) {
      delete item.averages;
      delete item.roast;
      delete item.completedAt;
    }
  }

  async failRetry(item, step, previous, previousStatus, error) {
    if (item.status === 'cancelled') return;
    appendRetryHistory(item, step, previous, { error: error.message }, 0);
    await this.update(item, { status: previousStatus, stage: '单步复核异常', retrying: null, activeWork: null }, {
      level: 'error', source: 'RETRY', phase: step.type, text: `${step.shortLabel} 重试异常`, detail: error.message, mode: item.mode
    });
  }

  async run(evaluationId, signal) {
    const item = this.store.get(evaluationId);
    signal?.throwIfAborted();
    const target = item.validation.interfaces[0];
    await this.update(item, { status: 'running', progress: 6, stage: 'A2A 协议体检', activeWork: { type: 'protocol', key: 'a2a', label: '正在校验 A2A 协议与接口声明', target: item.agentCard.name, detail: '确认 Card 结构、协议版本与调用入口', index: 1, total: 1, retry: false } }, {
      level: 'success', source: 'A2A', phase: 'protocol', text: 'Agent Card 结构与接口声明通过',
      detail: `${target.binding} · v${target.version} · seed=${item.seed} · temperature=${item.temperature} · ${redactUrl(target.url)}`, mode: item.mode
    });

    const complexity = scoreComplexity(item.agentCard, item.cases);
    await this.update(item, { complexity, progress: 22, stage: '判断是否值得 Agent 化' }, {
      level: 'info', source: 'SCORER', phase: 'complexity', text: `${complexity.verdict} · ${complexity.score}/100`,
      detail: Object.entries(complexity.dimensions).map(([key, value]) => `${key}=${value}`).join(' · '), mode: 'rules'
    });

    const reviewers = configuredReviewers();
    item.reviewPlan = publicReviewPlan(reviewers);
    item.runtimePlan = publicRuntimePlan();
    const professionalReviews = [];
    for (const reviewer of reviewers) {
      signal?.throwIfAborted();
      const startedAt = Date.now();
      await this.update(item, {
        progress: 28 + professionalReviews.length * 8,
        stage: `${reviewer.name} 正在审稿`,
        activeWork: { type: 'review', key: reviewer.id, label: `${reviewer.name} 正在审稿`, target: reviewer.model, detail: '定位、Skills、协议、输入输出与能力边界五项设计审稿中', index: professionalReviews.length + 1, total: reviewers.length, retry: false }
      }, {
        level: 'info', source: 'MODEL', phase: 'review', text: `${reviewer.model} 接过了答卷`, mode: item.mode
      });
      try {
        const review = { ...(await reviewAgent(reviewer, item.agentCard, complexity, item.mode, signal, phaseSampling(item, `review:${reviewer.id}`))), reviewerId: reviewer.id };
        professionalReviews.push(review);
        await this.update(item, { professional: professionalSnapshot(professionalReviews) }, { level: 'success', source: 'MODEL', phase: 'review', text: `${reviewer.model} 完成盲审 · ${review.score}/100`, mode: review.mode, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        professionalReviews.push({ reviewerId: reviewer.id, reviewer: reviewer.name, model: reviewer.model, version: V1_CARD_REVIEW_VERSION, score: 0, error: error.message, mode: 'failed' });
        await this.update(item, { professional: professionalSnapshot(professionalReviews) }, { level: 'error', source: 'MODEL', phase: 'review', text: `${reviewer.model} 调用失败`, detail: error.message, mode: 'failed', durationMs: Date.now() - startedAt });
      }
    }
    const validProfessional = professionalReviews.filter((review) => review.score > 0);
    const professional = professionalSnapshot(professionalReviews);
    const professionalMode = professional.mode;
    const pandaRuntime = await this.pandaRuntimeContext();
    const runtimeInputLabel = pandaRuntime
      ? 'description + Panda 接口文档'
      : 'description-only';
    await this.update(item, { professional, progress: 52, stage: `Runtime ${runtimeInputLabel} 直出`, activeWork: null }, { level: 'success', source: 'MODEL', phase: 'review', text: `${reviewers.length} 位模型评审已交卷`, detail: `有效评审 ${validProfessional.length} · 均分 ${professional.score}`, mode: professionalMode });

    const builds = [];
    for (const runtime of RUNTIMES) {
      signal?.throwIfAborted();
      const startedAt = Date.now();
      const buildContext = contextUsageCollector();
      await this.update(item, {
        activeWork: { type: 'build', key: runtime.id, label: `${runtime.name} 正在直出 Skill`, target: runtime.name, detail: `输入：Agent 顶层 description 原文${pandaRuntime ? ' + 主办方 Panda 白名单接口文档' : ''}`, index: builds.length + 1, total: RUNTIMES.length, retry: false }
      }, { level: 'info', source: 'RUNTIME', phase: 'build', text: `${runtime.name} 开始按 ${runtimeInputLabel} 直出 Skill`, mode: item.mode });
      try {
        const build = await privateState(this).buildSkill(runtime, item.agentCard.description, item.mode, {
          signal,
          ...phaseSampling(item, `build:${runtime.id}`),
          pandaData: pandaRuntime,
          onContextUsage: buildContext.onContextUsage
        });
        builds.push({ ...build, contextUsage: buildContext.contextUsage });
        await this.update(item, { builds: [...builds] }, { level: 'success', source: 'RUNTIME', phase: 'build', text: `${runtime.name} ${runtimeInputLabel} 直出完成`, detail: build.skill?.name, mode: build.mode, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        builds.push({ runtime: runtime.name, runtimeId: runtime.id, mode: item.mode, error: error.message, contextUsage: buildContext.contextUsage });
        await this.update(item, { builds: [...builds] }, { level: 'error', source: 'RUNTIME', phase: 'build', text: `${runtime.name} 复刻失败`, detail: error.message, mode: item.mode, durationMs: Date.now() - startedAt });
      }
    }
    const runtimeMode = summarizeModes(builds.map((build) => build.error ? 'failed' : build.mode));
    await this.update(item, { builds, progress: 66, stage: '同题竞技场', activeWork: null }, { level: 'success', source: 'RUNTIME', phase: 'build', text: 'Runtime 直出阶段结束', detail: builds.map((build) => `${build.runtime}:${build.mode}${build.error ? ':failed' : ''}`).join(' · '), mode: runtimeMode });

    const benchmark = [];
    for (let index = 0; index < item.cases.length; index += 1) {
      signal?.throwIfAborted();
      const testCase = item.cases[index];
      const entries = [];
      const dataPlan = buildDataPlan(testCase);
      let dataEvidence = { status: 'not-configured', source: 'pandaai', fetchedAt: null, queries: [] };
      if (dataPlan.length) {
        await this.update(item, {
          benchmark,
          stage: `参考数据验真 ${index + 1}/${item.cases.length}`,
          activeWork: { type: 'data', key: `case-${index}`, caseIndex: index, label: '正在获取 PandaAI 参考数据', target: testCase.name, detail: `${dataPlan.length} 个只读查询 · 仅用于独立验真，不进入评分 Prompt`, index: index + 1, total: item.cases.length, retry: false }
        }, { level: 'info', source: 'DATA', phase: 'evidence', text: `开始为「${testCase.name}」建立参考数据快照`, detail: dataPlan.map((query) => query.method).join(' · '), mode: item.mode });
        dataEvidence = await collectDataEvidence(testCase, {
          enabled: item.mode === 'live' && this.dataVerificationEnabled,
          query: (method, params, options) => this.dataQuery(method, params, options),
          signal
        });
        const successful = dataEvidence.queries.filter((query) => query.status === 'ready').length;
        await this.update(item, { benchmark, activeWork: null }, {
          level: dataEvidence.status === 'failed' ? 'error' : 'success', source: 'DATA', phase: 'evidence',
          text: dataEvidence.status === 'ready' ? `参考数据快照已锁定 · ${successful}/${dataEvidence.queries.length}` : `参考数据验真状态：${dataEvidence.status}`,
          detail: dataEvidence.queries.map((query) => `${query.label}:${query.status}${query.rowCount === undefined ? '' : `:${query.rowCount}行`}`).join(' · '),
          mode: dataEvidence.status === 'ready' ? 'live' : dataEvidence.status
        });
      }
      benchmark.push({ case: testCase, dataEvidence, entries });
      let submittedOutput;
      let submittedMode = item.mode;
      const submittedContext = contextUsageCollector();
      await this.update(item, {
        benchmark,
        stage: `对测 ${index + 1}/${item.cases.length} · 0/${builds.length + 1}`,
        activeWork: benchmarkActivity('submitted', item.agentCard.name, testCase, index, item.cases.length, false)
      }, { level: 'info', source: 'A2A', phase: 'benchmark', text: `${item.agentCard.name} 开始执行「${testCase.name}」`, mode: item.mode });
      const submittedExecution = await measureV1Execution(
        privateState(this).monotonicNow,
        async () => item.mode === 'live'
          ? (await this.runSubmittedAgent(item, index, signal)).text
          : mockSubmittedOutput(item.agentCard, testCase)
      );
      if (submittedExecution.error) {
        if (signal?.aborted) throw signal.reason || submittedExecution.error;
        submittedOutput = `执行失败：${submittedExecution.error.message}`;
        submittedMode = 'failed';
      } else {
        submittedOutput = submittedExecution.value;
      }
      entries.push(makeUnscoredEntry(
        'submitted', item.agentCard.name, submittedOutput, submittedMode,
        deriveSeed(item.seed, `judge:${index}:submitted`), dataEvidence,
        executionSnapshot(
          submittedMode === 'failed' ? 'failed' : 'succeeded',
          submittedExecution.durationMs,
          submittedContext.contextUsage
        )
      ));
      await this.update(item, { benchmark, progress: 70 + Math.round((index / item.cases.length) * 22), stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, {
        level: submittedMode === 'failed' ? 'error' : 'success', source: 'A2A', phase: 'benchmark', text: `${item.agentCard.name} 完成「${testCase.name}」`, detail: `scoreStatus=${entries.at(-1).scoreStatus}`, mode: submittedMode, durationMs: entries.at(-1).execution.durationMs
      });
      for (const build of builds) {
        signal?.throwIfAborted();
        await this.update(item, {
          benchmark,
          activeWork: benchmarkActivity(build.runtimeId, build.runtime, testCase, index, item.cases.length, false),
          stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}`
        }, { level: 'info', source: 'RUNTIME', phase: 'benchmark', text: `${build.runtime} 开始执行「${testCase.name}」`, mode: build.error ? 'failed' : build.mode });
        if (build.error) {
          entries.push(makeUnscoredEntry(
            build.runtimeId, build.runtime, `执行失败：${build.error}`, 'failed',
            deriveSeed(item.seed, `judge:${index}:${build.runtimeId}`), dataEvidence,
            executionSnapshot('failed', 0, build.contextUsage || [], 'skill-build')
          ));
          await this.update(item, { benchmark, stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, { level: 'error', source: 'RUNTIME', phase: 'benchmark', text: `${build.runtime} 无法进入「${testCase.name}」`, detail: build.error, mode: 'failed' });
          continue;
        }
        const runtimeContext = contextUsageCollector();
        const runtimeExecution = await measureV1Execution(
          privateState(this).monotonicNow,
          () => privateState(this).runSkill(build, testCase, item.mode, {
            signal,
            ...phaseSampling(item, `run:${index}:${build.runtimeId}`),
            pandaData: pandaRuntime,
            onContextUsage: runtimeContext.onContextUsage
          })
        );
        if (runtimeExecution.error) {
          if (signal?.aborted) throw signal.reason || runtimeExecution.error;
          entries.push(makeUnscoredEntry(
            build.runtimeId, build.runtime, `执行失败：${runtimeExecution.error.message}`, 'failed',
            deriveSeed(item.seed, `judge:${index}:${build.runtimeId}`), dataEvidence,
            executionSnapshot('failed', runtimeExecution.durationMs, runtimeContext.contextUsage)
          ));
        } else {
          entries.push(makeUnscoredEntry(
            build.runtimeId, build.runtime, runtimeExecution.value, build.mode,
            deriveSeed(item.seed, `judge:${index}:${build.runtimeId}`), dataEvidence,
            executionSnapshot('succeeded', runtimeExecution.durationMs, runtimeContext.contextUsage)
          ));
        }
        await this.update(item, { benchmark, stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, { level: entries.at(-1).mode === 'failed' ? 'error' : 'success', source: 'RUNTIME', phase: 'benchmark', text: `${build.runtime} 完成「${testCase.name}」`, detail: `scoreStatus=${entries.at(-1).scoreStatus}`, mode: entries.at(-1).mode, durationMs: entries.at(-1).execution.durationMs });
      }
      const scoring = await privateState(this).scoreV1Case({
        testCase,
        entries,
        config: item.scoringConfig,
        reviewers: privateState(this).v1Reviewers,
        evaluationMode: item.mode,
        seed: deriveSeed(item.seed, `v1-case:${index}`),
        signal
      });
      signal?.throwIfAborted();
      const roundItem = benchmark[index];
      roundItem.entries = scoring.entries;
      roundItem.judging = scoring.judging;
      const scoringLine = v1ScoringLine(item.scoringConfig, scoring.judging);
      if (scoring.status === 'failed') {
        signal?.throwIfAborted();
        await this.update(item, {
          benchmark,
          stage: `对测 ${index + 1}/${item.cases.length} · ${scoringLine} 评分失败`,
          activeWork: null
        }, {
          level: 'error',
          source: 'ARENA',
          phase: 'benchmark',
          text: `「${testCase.name || `案例 ${index + 1}`}」模型评分失败`,
          detail: `${scoringLine} · 成功席位 ${scoring.judging.successfulSeats}/${scoring.judging.requiredSeats}`,
          mode: summarizeModes(roundItem.entries.map((entry) => entry.mode))
        });
        throw Object.assign(
          new Error(`「${testCase.name || `案例 ${index + 1}`}」模型评分失败`),
          { statusCode: 502 }
        );
      }
      signal?.throwIfAborted();
      await this.update(item, { benchmark, progress: 70 + Math.round(((index + 1) / item.cases.length) * 22), stage: `对测 ${index + 1}/${item.cases.length} 完成 · ${scoringLine}`, activeWork: null }, { level: 'success', source: 'ARENA', phase: 'benchmark', text: `「${testCase.name || `案例 ${index + 1}`}」完成同 prompt 对打 · ${scoringLine}`, detail: `成功席位 ${scoring.judging.successfulSeats}/${scoring.judging.requiredSeats} · ${roundItem.entries.map((entry) => `${entry.name}=${entry.score}`).join(' · ')}`, mode: summarizeModes(roundItem.entries.map((entry) => entry.mode)) });
    }

    signal?.throwIfAborted();
    const averages = Object.fromEntries(['submitted', 'claude-code', 'cursor', 'doubao'].map((competitor) => {
      const scores = benchmark.flatMap((roundItem) => roundItem.entries.filter((entry) => entry.id === competitor).map((entry) => entry.score));
      return [competitor, round(average(scores), 1)];
    }));
    const roast = buildRoast(averages.submitted, averages['claude-code'], averages.doubao, professional.score, complexity);
    const coverage = coverageSnapshot(item, professionalMode, runtimeMode, benchmark);
    const overallMode = summarizeModes(Object.values(coverage));
    signal?.throwIfAborted();
    await this.update(item, { averages, roast, coverage, overallMode, status: 'completed', progress: 100, stage: '锐评出炉', completedAt: now(), activeWork: null }, { level: 'success', source: 'VERDICT', phase: 'complete', text: roast.headline, detail: `tier=${roast.tier.label} · submitted=${averages.submitted} · claude=${averages['claude-code']} · doubao=${averages.doubao}`, mode: overallMode });
  }

  async update(item, patch, log) {
    Object.assign(item, patch, { updatedAt: now() });
    const logs = Array.isArray(log) ? log : log ? [log] : [];
    logs.forEach((entry) => item.logs.push({ at: now(), level: 'info', source: 'SYSTEM', phase: 'pipeline', ...(typeof entry === 'string' ? { text: entry } : entry) }));
    await this.store.set(item);
    this.events.emit(item.id, item);
  }

  async fail(evaluationId, error) {
    const item = this.store.get(evaluationId);
    if (!item || ['cancelled', 'interrupted'].includes(item.status)) return;
    await this.update(item, { status: 'failed', stage: '评测中断', error: error.message, activeWork: null }, { level: 'error', source: 'SYSTEM', phase: 'failed', text: '评测中断', detail: error.message, mode: item.mode });
  }
}

function privateState(pipeline) {
  const state = PIPELINE_PRIVATE.get(pipeline);
  if (!state) throw new TypeError('invalid evaluation pipeline');
  return state;
}

function v2DisabledError() {
  return httpError(409, 'A2A black-box V2 is disabled');
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function transientIneligibleError(reason, completedAt) {
  const error = httpError(422, 'V2 Agent Card is not eligible');
  error.responseBody = {
    schemaVersion: 2,
    qualification: {
      status: 'ineligible',
      reason,
      attemptRunIds: [],
      selectedInterface: null,
      completedAt
    },
    objectiveCapability: {
      status: 'not-applicable',
      score: null
    },
    resultV2: null
  };
  return error;
}

function assertClosedObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.includes('cases')) {
    throw httpError(400, 'V2 requires agentExamples; cases is not supported');
  }
  if (unknown.length > 0) {
    throw httpError(400, `${label} contains unsupported fields`);
  }
}

function assertAgentAuthorization(value) {
  try {
    validateAgentAuthorization(value);
  } catch {
    throw httpError(400, 'Agent authorization is invalid');
  }
}

function normalizeIdempotencyKey(value) {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') < 16 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    !/^[\x20-\x7e]+$/u.test(value)
  ) {
    throw httpError(400, 'Idempotency-Key is invalid');
  }
  return value;
}

function resumeRequestMac(key, body) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw httpError(500, 'V2 resume service is unavailable');
  }
  return createHmac('sha256', key)
    .update(canonicalJson(body))
    .digest('hex');
}

function findResumeReceipt(record, keyHash, requestMac) {
  const receipt = record.resumeReceipts.find(
    (item) => item.keyHash === keyHash
  );
  if (!receipt) return null;
  if (receipt.requestMac !== requestMac) {
    throw httpError(409, 'Idempotency request does not match');
  }
  return receipt;
}

function receiptResult(receipt) {
  return {
    statusCode: receipt.statusCode,
    response: structuredClone(receipt.response)
  };
}

function assertResumable(record) {
  assertNotArchived(record);
  if (
    !['interrupted', 'credentials-required'].includes(
      record.execution?.status
    )
  ) {
    throw httpError(409, 'V2 evaluation is not resumable');
  }
}

function assertNotArchived(record) {
  if (record.archivedAt !== undefined) {
    throw httpError(409, 'Archived V2 evaluations cannot be resumed');
  }
}

function appendAuditEvent(events, event) {
  return events.some((item) => item.id === event.id)
    ? events
    : [...events, event];
}

function recoverDispatchedWork(runIndex, examples) {
  return runIndex.map((cell) => {
    let foundDispatched = false;
    const attempts = cell.attempts.map((attempt) => {
      if (!attempt.turns.some((turn) => turn.status === 'dispatched')) {
        return attempt;
      }
      foundDispatched = true;
      const turns = attempt.turns.map((turn) => {
        const criteria = examples[cell.exampleIndex]
          .turns[turn.turnIndex].acceptanceCriteria;
        return turn.status === 'dispatched'
          ? {
              ...turn,
              status: 'unavailable',
              outcome: {
                status: 'unknown',
                lifecycle: 'dispatched-before-restart'
              },
              acceptance: recoveryAcceptance(
                criteria,
                cell.identity.testId,
                turn.turnIndex
              ),
              attribution: 'pending',
              protocolObservation: null,
              evidenceIds: []
            }
          : turn.status === 'planned'
            ? {
                ...turn,
                status: 'skipped',
                acceptance: recoveryAcceptance(
                  criteria,
                  cell.identity.testId,
                  turn.turnIndex
                )
              }
            : turn;
      });
      const checks = turns.flatMap(
        (turn) => turn.acceptance?.checks || []
      );
      const passedRequiredExecutable = turns.reduce(
        (sum, turn) =>
          sum + (turn.acceptance?.passedRequiredExecutable || 0),
        0
      );
      return {
        ...attempt,
        attribution: 'pending',
        terminalSuccess: false,
        acceptance: {
          requiredExecutable: cell.requiredExecutable,
          passedRequiredExecutable,
          semanticSuccess: cell.requiredExecutable === 0
            ? null
            : passedRequiredExecutable === cell.requiredExecutable,
          checks
        },
        timing: {
          durationMs: null,
          firstEventMs: null,
          timedOut: false
        },
        evidenceIds: stableUnique(
          turns.flatMap((turn) => turn.evidenceIds || [])
        ),
        turns
      };
    });
    return foundDispatched
      ? {
          ...cell,
          status: 'attribution-pending',
          selectedAttemptIndex: null,
          attempts
        }
      : cell;
  });
}

function recoveryAcceptance(criteria, testId, turnIndex) {
  const checks = criteria.map((criterion, index) => ({
    id: `check_${createHash('sha256').update(canonicalJson({
      testId,
      turnIndex,
      index,
      submittedCriterionId: criterion.id
    })).digest('hex').slice(0, 32)}`,
    type: criterion.type,
    required: criterion.required !== false,
    status: criterion.type === 'model' ? 'not-executable' : 'failed'
  }));
  const requiredExecutable = checks.filter(
    (check) => check.required && check.status !== 'not-executable'
  ).length;
  return {
    checks,
    requiredExecutable,
    passedRequiredExecutable: 0,
    semanticSuccess: requiredExecutable === 0 ? null : false
  };
}

function cancelDispatchedWork(runIndex) {
  return runIndex.map((cell) => {
    let cancelled = false;
    const attempts = cell.attempts.map((attempt) => {
      if (!attempt.turns.some((turn) => turn.status === 'dispatched')) {
        return attempt;
      }
      cancelled = true;
      return {
        ...attempt,
        attribution: 'cancelled',
        terminalSuccess: false,
        turns: attempt.turns.map((turn) =>
          ['planned', 'dispatched'].includes(turn.status)
            ? {
                ...turn,
                status: 'cancelled',
                outcome: { status: 'cancelled', lifecycle: 'cancelled' },
                attribution: 'cancelled'
              }
            : turn
        )
      };
    });
    return cancelled
      ? {
          ...cell,
          status: 'cancelled',
          selectedAttemptIndex: null,
          attempts
        }
      : { ...cell, attempts };
  });
}

function stableUnique(values) {
  return [...new Set(values)];
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function professionalSnapshot(reviews) {
  if (reviews.some((review) => review?.version === V1_CARD_REVIEW_VERSION)) {
    return aggregateV1CardReviews(reviews);
  }
  const valid = reviews.filter((review) => review.score > 0);
  return { score: round(average(valid.map((review) => review.score)), 1), mode: summarizeModes(reviews.map((review) => review.error ? 'failed' : review.mode), 'failed'), reviews: [...reviews] };
}

function publicReviewPlan(reviewers) {
  return reviewers.map((reviewer) => ({ id: reviewer.id || reviewer.model || reviewer.name, name: reviewer.name, model: reviewer.model }));
}

function publicRuntimePlan() {
  return RUNTIMES.map((runtime) => ({ id: runtime.id, name: runtime.name, model: runtime.model }));
}

function resolveRetryStep(item, input = {}) {
  const type = String(input.type || '').trim();
  const key = String(input.key || '').trim();
  if (type === 'review') {
    const existing = item.professional?.reviews?.find((review) => [retryReviewResultKey(review), review.model, review.reviewer].includes(key));
    const reviewer = configuredReviewers().find((candidate) => [retryReviewerKey(candidate), candidate.model, candidate.name].includes(key) || (existing && candidate.name === existing.reviewer));
    if (!reviewer) throw badRetryRequest('评审模型不存在或当前未配置');
    return { type, key: retryReviewerKey(reviewer), reviewerName: reviewer.name, label: `重新审稿 · ${reviewer.model}`, shortLabel: reviewer.name };
  }
  if (type === 'build') {
    const runtime = RUNTIMES.find((candidate) => candidate.id === key);
    if (!runtime) throw badRetryRequest('Runtime 构建步骤不存在');
    return { type, key: runtime.id, label: `重新直出 · ${runtime.name}`, shortLabel: runtime.name };
  }
  if (type === 'benchmark') {
    const caseIndex = Number(input.caseIndex);
    const roundItem = item.benchmark?.[caseIndex];
    const allowed = new Set(['submitted', ...RUNTIMES.map((runtime) => runtime.id)]);
    if (!Number.isInteger(caseIndex) || !roundItem) throw badRetryRequest('对测用例不存在');
    if (!allowed.has(key)) throw badRetryRequest('对测选手不存在');
    const name = key === 'submitted'
      ? item.agentCard.name
      : item.builds?.find((build) => build.runtimeId === key)?.runtime || RUNTIMES.find((runtime) => runtime.id === key)?.name || key;
    return { type, key, caseIndex, label: `重新对测 · ${roundItem.case.name} / ${name}`, shortLabel: `${roundItem.case.name} / ${name}` };
  }
  throw badRetryRequest('不支持的重试类型；可选 review、build、benchmark');
}

function retryActivity(step) {
  const detail = step.type === 'review'
    ? '旧评语保持可见，新评语返回后替换并重算'
    : step.type === 'build'
      ? '重新直出 Skill，随后自动执行全部同 Prompt 对测'
      : '旧输出保持可见，新输出返回后替换并重算';
  return {
    type: step.type,
    key: step.key,
    ...(Number.isInteger(step.caseIndex) ? { caseIndex: step.caseIndex } : {}),
    label: step.label,
    target: step.shortLabel,
    detail,
    index: 1,
    total: 1,
    retry: true
  };
}

function benchmarkActivity(key, target, testCase, caseIndex, totalCases, retry) {
  return {
    type: 'benchmark',
    key,
    caseIndex,
    label: `${target} 正在执行同 Prompt 对测`,
    target,
    detail: `用例：${testCase?.name || `案例 ${caseIndex + 1}`}`,
    index: caseIndex + 1,
    total: totalCases,
    retry
  };
}

function badRetryRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function retryReviewerKey(reviewer) { return reviewer.id || reviewer.model || reviewer.name; }
function retryReviewResultKey(review) { return review.reviewerId || review.model || review.reviewer; }

function retryTargetSummary(item, step) {
  if (step.type === 'review') {
    const review = item.professional?.reviews?.find((candidate) => retryReviewResultKey(candidate) === step.key || candidate.model === step.key || candidate.reviewer === step.key || candidate.reviewer === step.reviewerName);
    return review ? { score: review.score, model: review.model, mode: review.mode, seed: review.seed, ...(review.error ? { error: review.error } : {}) } : { error: '暂无旧结果' };
  }
  if (step.type === 'build') {
    const build = item.builds?.find((candidate) => candidate.runtimeId === step.key);
    return build ? { model: build.model, mode: build.mode, seed: build.seed, skill: build.skill?.name, ...(build.error ? { error: build.error } : {}) } : { error: '暂无旧结果' };
  }
  const entry = item.benchmark?.[step.caseIndex]?.entries?.find((candidate) => candidate.id === step.key);
  return entry ? { score: entry.score, name: entry.name, mode: entry.mode, judgeSeed: entry.judgeSeed, ...(entry.mode === 'failed' ? { error: String(entry.output || '').slice(0, 300) } : {}) } : { error: '暂无旧结果' };
}

function appendRetryHistory(item, step, previous, result, durationMs) {
  const history = [...(item.retryHistory || []), {
    id: id('retry'), at: now(), type: step.type, key: step.key,
    ...(Number.isInteger(step.caseIndex) ? { caseIndex: step.caseIndex } : {}),
    label: step.label, previous, result, durationMs
  }];
  item.retryHistory = history.slice(-100);
}

function retryDeltaText(previous, result) {
  if (result.error) return result.error;
  if (Number.isFinite(previous?.score) && Number.isFinite(result?.score)) {
    const delta = round(result.score - previous.score, 1);
    return `score ${previous.score} → ${result.score}（${delta >= 0 ? '+' : ''}${delta}）`;
  }
  return previous?.error ? `旧结果失败；本次已恢复为 ${result.mode || '可用'} 模式` : '结果已替换并纳入综合评分';
}

function hasCompleteBenchmark(item) {
  const competitors = ['submitted', ...RUNTIMES.map((runtime) => runtime.id)];
  const hasEveryEntry = item.cases?.length > 0
    && item.benchmark?.length === item.cases.length
    && item.benchmark.every((roundItem) => competitors.every((competitor) => roundItem.entries?.some((entry) => entry.id === competitor)));
  if (!hasEveryEntry) return false;
  return item.benchmark.every((roundItem) =>
    !isV1ModelScoringRound(item, roundItem)
    || (
      roundItem.judging?.status === 'scored'
      && competitors.every((competitor) =>
        roundItem.entries.some((entry) => entry.id === competitor && Number.isFinite(entry.score))
      )
    )
  );
}

function hasV1ModelScoring(item) {
  return ['single', 'panel'].includes(item?.scoringConfig?.mode)
    || item.benchmark?.some((roundItem) => isV1ModelScoringRound(item, roundItem));
}

function isV1ModelScoringRound(item, roundItem) {
  if (['single', 'panel'].includes(item?.scoringConfig?.mode)) return true;
  return [V1_SCORING_VERSION, LEGACY_V1_SCORING_VERSION].includes(roundItem?.judging?.version)
    && ['single', 'panel'].includes(roundItem.judging.mode);
}

function scoringConfigForRound(item, roundItem) {
  if (item?.scoringConfig) return item.scoringConfig;
  const judging = roundItem?.judging;
  if (judging?.version === LEGACY_V1_SCORING_VERSION) {
    return legacyV1ScoringConfig(judging);
  }
  const looksLegacy = roundItem?.entries?.some((entry) =>
    entry?.dimensions && Object.hasOwn(entry.dimensions, 'taskConstraint')
  );
  return looksLegacy
    ? legacyV1ScoringConfig(judging)
    : normalizeV1ScoringConfig();
}

function legacyV1ScoringConfig(judging = {}) {
  return judging.mode === 'panel'
    ? { version: LEGACY_V1_SCORING_VERSION, mode: 'panel' }
    : {
        version: LEGACY_V1_SCORING_VERSION,
        mode: 'single',
        reviewerId: judging.reviewerId || 'deepseek'
      };
}

function recalculateDerived(item) {
  const professional = professionalSnapshot(item.professional?.reviews || []);
  const runtimeMode = summarizeModes((item.builds || []).map((build) => build.error ? 'failed' : build.mode), 'failed');
  const coverage = coverageSnapshot(item, professional.mode, runtimeMode, item.benchmark || []);
  const derived = { professional, coverage, overallMode: summarizeModes(Object.values(coverage)) };
  if (!hasCompleteBenchmark(item)) return derived;
  const competitorIds = ['submitted', ...RUNTIMES.map((runtime) => runtime.id)];
  const averages = Object.fromEntries(competitorIds.map((competitor) => {
    const scores = item.benchmark.flatMap((roundItem) => roundItem.entries.filter((entry) => entry.id === competitor).map((entry) => entry.score));
    return [competitor, round(average(scores), 1)];
  }));
  return {
    ...derived,
    averages,
    roast: buildRoast(averages.submitted, averages['claude-code'], averages.doubao, professional.score, item.complexity)
  };
}

function isTerminal(status) { return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status); }

function redactUrl(rawUrl) {
  try { const url = new URL(rawUrl); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return 'invalid-url'; }
}

function summarizeModes(modes, fallback = 'mixed') {
  const unique = new Set(modes.filter(Boolean));
  if (!unique.size) return fallback;
  if (unique.size === 1) return [...unique][0];
  return 'mixed';
}

function coverageSnapshot(item, professionalMode, runtimeFallback, benchmark) {
  const submittedModes = benchmark.flatMap((roundItem) => (roundItem.entries || []).filter((entry) => entry.id === 'submitted').map((entry) => entry.mode));
  const runtimeIds = new Set(RUNTIMES.map((runtime) => runtime.id));
  const runtimeModes = benchmark.flatMap((roundItem) => (roundItem.entries || []).filter((entry) => runtimeIds.has(entry.id)).map((entry) => entry.mode));
  return {
    agent: summarizeModes(submittedModes, item.mode === 'live' ? 'live' : 'demo'),
    models: professionalMode,
    runtimes: summarizeModes(runtimeModes, runtimeFallback)
  };
}

function phaseSampling(item, scope) {
  return { seed: deriveSeed(item.seed, scope), temperature: normalizeTemperature(item.temperature, 0) };
}

function makeUnscoredEntry(id, name, output, mode, seed, dataEvidence, execution) {
  if (!execution || typeof execution !== 'object') {
    throw new TypeError('V1 v2 benchmark entries require an execution record');
  }
  const dataVerification = verifyOutputAgainstEvidence(output, dataEvidence);
  return {
    id,
    name,
    output,
    mode,
    execution,
    judgeSeed: seed,
    dataVerification,
    scoreStatus: mode === 'failed' ? 'execution-failed' : 'pending',
    score: mode === 'failed' ? 0 : null,
    dimensions: null
  };
}

async function measureV1Execution(monotonicNow, invoke) {
  const startedAt = readMonotonic(monotonicNow);
  try {
    const value = await invoke();
    return { value, durationMs: elapsedMonotonic(monotonicNow, startedAt) };
  } catch (error) {
    return { error, durationMs: elapsedMonotonic(monotonicNow, startedAt) };
  }
}

function readMonotonic(monotonicNow) {
  const value = Number(monotonicNow());
  return Number.isFinite(value) ? value : 0;
}

function elapsedMonotonic(monotonicNow, startedAt) {
  return Math.max(0, Math.round(readMonotonic(monotonicNow) - startedAt));
}

function executionSnapshot(status, durationMs, contextUsage = [], failureStage) {
  return {
    status,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    timingScope: 'end-to-end-wall-clock',
    includesNetwork: true,
    toolObservation: 'unavailable',
    contextUsage: [...contextUsage],
    ...(failureStage ? { failureStage } : {})
  };
}

function contextUsageCollector() {
  const contextUsage = [];
  return {
    contextUsage,
    onContextUsage: (usage) => {
      contextUsage.push(structuredClone(usage));
    }
  };
}

function v1ScoringLine(config, judging) {
  if (config.mode === 'panel') return '四模型匿名盲评';
  const seat = judging?.seats?.find((candidate) => candidate.reviewerId === config.reviewerId);
  return seat?.model || seat?.reviewerName || config.reviewerId;
}

function mockSubmittedOutput(card, testCase) {
  const skillNames = (card.skills || []).map((skill) => skill.name).join('、');
  const quality = stableNumber(`${card.name}:${testCase.prompt}`, 0, 2);
  const detail = quality > 0 ? '\n4. 稳健性：检查基准、最大回撤、换手、手续费与滑点，并记录敏感性分析。' : '';
  return `已调用「${card.name}」处理该金融研究请求。\n1. 能力匹配：${skillNames}\n2. 数据口径：记录数据来源、样本区间、频率、复权方式与截至时点；未接入的数据不编造。\n3. 研究方法：按请求执行因子 IC / Rank IC、分组回测或风险归因，并区分事实、假设与推断。${detail}\n5. 风险提示：历史结果不代表未来收益，仅用于技术研究，不构成投资建议。`;
}
