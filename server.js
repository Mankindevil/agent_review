import './src/env.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { EvaluationPipeline } from './src/pipeline.js';
import { EvaluationStore } from './src/store.js';
import {
  normalizeSeed,
  normalizeTemperature,
  readJsonBody,
  readJsonBodyWithSize
} from './src/utils.js';
import { resolveAgentCard } from './src/a2a.js';
import { runAgentDiagnostics } from './src/agent-diagnostics.js';
import { createDiagnosticsGuard } from './src/diagnostics-guard.js';
import { getRuntimeStatus } from './src/runtime-status.js';
import { createSkillBundle } from './src/runtimes.js';
import {
  loadReplicaCaseOutputs,
  loadReplicaSkillBundle
} from './src/replica-public-detail.js';
import { getPandaDataStatus, pandaDataConfig, queryPandaData } from './src/panda-data.js';
import { resolveServerAddress } from './src/server-address.js';
import {
  projectEvaluation,
  projectEvidenceRecord
} from './src/evaluation-projection.js';
import {
  buildAbsoluteReviewDossier,
  buildReplicaReviewDossier
} from './src/review-dossier.js';
import {
  authenticatePrincipal,
  isReviewGovernanceEnabled,
  requireRole
} from './src/review-access.js';
import {
  finalizeDualTrack,
  lockAndReleaseAbsoluteResult,
  lockReplicaHumanReview,
  setReplicaReviewPolicy,
  skipHumanReview,
  submitOpenHumanReview,
  submitReplicaHumanReview
} from './src/review-governance.js';
import {
  authorizeReplacementRun,
  createAppeal,
  decideAppeal,
  triageAppeal
} from './src/appeals.js';
import { runAppealResultVersion } from './src/appeal-recalculation.js';
import { getAccessAuditStore } from './src/access-audit-store.js';
import {
  copyEvidenceEncryptionKey,
  copyResumeMacKey,
  PHASE1_EXECUTION_POLICY,
  readBlackBoxRuntimeConfig
} from './src/black-box-pipeline.js';
import { EphemeralCredentialVault } from './src/credential-vault.js';
import { EvidenceVault } from './src/evidence-vault.js';
import { readA2AExecutionTuning } from './src/execution-tuning.js';
import { createPhase2Services } from './src/phase2-services.js';
import {
  assertReplicaRuntimesReady,
  createPhase3Services
} from './src/phase3-services.js';

export { releaseReplicaArena } from './src/arena-release.js';

let replicaCreateGate = defaultReplicaCreateGate;

async function defaultReplicaCreateGate() {
  await assertReplicaRuntimesReady({ env: process.env });
}

/** Test-only: skip or replace the V2 create-time Replica readiness gate. */
export function setReplicaCreateGateForTests(fn) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setReplicaCreateGateForTests is only available when NODE_ENV=test');
  }
  replicaCreateGate = typeof fn === 'function' ? fn : defaultReplicaCreateGate;
}

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
const LEGACY_EVALUATION_BODY_LIMIT = 1_000_000;
const V2_EVALUATION_BODY_LIMIT = 3 * 1024 * 1024;
export const blackBoxRuntimeConfig = readBlackBoxRuntimeConfig(process.env, {
  serverRoot: root
});
export const a2aExecutionTuning = readA2AExecutionTuning(process.env);
export const evaluationStore = new EvaluationStore(
  process.env.DATA_FILE || path.join(root, 'data/evaluations.json')
);
const store = evaluationStore;
const events = new EventEmitter();
events.setMaxListeners(100);
let injectedAppealRecalculationServices = null;
let injectedReplicaReleaseServices = null;
const credentialVault = new EphemeralCredentialVault();
const resumeMacKey = copyResumeMacKey(blackBoxRuntimeConfig);
export const accessAuditStore = getAccessAuditStore(process.env);
export const pipeline = new EvaluationPipeline(evaluationStore, events, {
  blackBoxEnabled: blackBoxRuntimeConfig.enabled,
  credentialVault,
  resumeMacKey,
  policy: Object.freeze({
    ...PHASE1_EXECUTION_POLICY,
    repeatCount: a2aExecutionTuning.repeatCount
  }),
  blackBoxServices: blackBoxRuntimeConfig.enabled
    ? {
        phase2: createPhase2Services({ env: process.env }),
        phase3: createPhase3Services({ env: process.env }),
        evidenceVaultFactory: (evaluationId) => {
          const key = copyEvidenceEncryptionKey(blackBoxRuntimeConfig);
          try {
            return new EvidenceVault({
              root: blackBoxRuntimeConfig.evidenceRoot,
              evaluationId,
              key
            });
          } finally {
            key.fill(0);
          }
        }
      }
    : {}
});
resumeMacKey?.fill(0);
const diagnosticsGuard = createDiagnosticsGuard();
await evaluationStore.load();
await pipeline.recoverInterrupted();

export const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, {
      ok: true, mode: 'full-stack', time: new Date().toISOString(),
      a2aBlackBoxV1Enabled: blackBoxRuntimeConfig.enabled,
      evaluationSeed: normalizeSeed(process.env.EVALUATION_SEED), modelTemperature: normalizeTemperature(process.env.MODEL_TEMPERATURE, 0),
      dataSource: await getPandaDataStatus()
    });
    if (request.method === 'GET' && url.pathname === '/api/runtimes') return json(response, 200, await getRuntimeStatus());
    if (request.method === 'GET' && url.pathname === '/api/data-source') {
      return json(response, 200, await getPandaDataStatus({ probe: url.searchParams.get('probe') === '1' }));
    }
    if (request.method === 'POST' && url.pathname === '/api/data-source/query') {
      const config = pandaDataConfig();
      if (!config.accessProtected) return json(response, 503, { error: 'PANDA_DATA_ACCESS_KEY 未配置，数据查询网关保持关闭' });
      if (!authorizedDataRequest(request, config.accessKey)) return json(response, 401, { error: 'PandaAI 数据查询鉴权失败' });
      const input = await readJsonBody(request, 100_000);
      return json(response, 200, await queryPandaData(String(input.method || ''), input.params || {}));
    }
    if (request.method === 'POST' && url.pathname === '/api/agent-diagnostics') {
      response.setHeader('cache-control', 'no-store');
      const release = diagnosticsGuard.enter();
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once('aborted', abort);
      response.once('close', () => { if (!response.writableEnded) abort(); });
      try {
        const input = await readJsonBody(request, Math.floor(1.25 * 1024 * 1024));
        return json(response, 200, await runAgentDiagnostics(input, {
          signal: controller.signal
        }));
      } finally {
        request.off('aborted', abort);
        release();
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/agent-cards/resolve') {
      const input = await readJsonBody(request);
      try {
        return json(response, 200, await resolveAgentCard(input.sourceType, input.url));
      } catch (error) {
        error.statusCode = /获取失败|fetch|timeout/i.test(error.message) ? 502 : 400;
        throw error;
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/evaluations') {
      return json(response, 200, store.list().map((item) =>
        item.schemaVersion === 2
          ? projectForRequest(item, request)
          : summary(item)
      ));
    }
    if (request.method === 'POST' && url.pathname === '/api/evaluations') {
      const body = await readEvaluationCreateBody(request);
      if (body?.schemaVersion === 2 && blackBoxRuntimeConfig.enabled) {
        await replicaCreateGate(body);
      }
      const item = await pipeline.create(body);
      if (item?.schemaVersion === 2) {
        response.setHeader('cache-control', 'no-store');
      }
      return json(response, 202, serializeEvaluationForResponse(item));
    }
    const resumeMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/resume$/);
    if (request.method === 'POST' && resumeMatch) {
      if (!blackBoxRuntimeConfig.enabled) {
        return json(response, 409, { error: 'A2A black-box V2 is disabled' });
      }
      response.setHeader('cache-control', 'no-store');
      const authorized = pipeline.authenticateResume(resumeMatch[1]);
      if (!authorized) {
        return json(response, 404, {
          error: 'Evaluation does not exist'
        });
      }
      const resumed = await pipeline.resume(resumeMatch[1], {
        idempotencyKey: request.headers['idempotency-key'],
        body: await readJsonBody(request, 16 * 1024)
      });
      return resumed
        ? json(response, resumed.statusCode, resumed.response)
        : json(response, 404, { error: 'Evaluation does not exist' });
    }
    const cancelMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const item = await pipeline.cancel(cancelMatch[1]);
      return item
        ? json(response, 200, serializeEvaluationForResponse(item))
        : json(response, 404, { error: '评测不存在' });
    }
    const retryMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/retry$/);
    if (request.method === 'POST' && retryMatch) {
      if (store.get(retryMatch[1])?.schemaVersion === 2) {
        return json(response, 409, { error: 'V2 retry service is not enabled' });
      }
      const item = await pipeline.retry(retryMatch[1], await readJsonBody(request));
      return item
        ? json(response, 202, serializeEvaluationForResponse(item))
        : json(response, 404, { error: '评测不存在' });
    }
    const appealsMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/appeals$/);
    if (appealsMatch && request.method === 'POST') {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(appealsMatch[1]);
      const principal = participantPrincipalForRequest(request, item);
      const idempotencyKey = requiredIdempotencyKey(request);
      const payload = await readJsonBody(request, 64_000);
      const committed = await store.mutate(item.id, undefined, (current) => {
        createAppeal(current, principal, { ...payload, idempotencyKey }, {
          windowHours: appealWindowHours()
        });
        return current;
      });
      const appeal = committed.appeals.at(-1);
      const replayed = committed.appeals.find((candidate) =>
        candidate.appealId === committed.governance.appealIdempotency[idempotencyKey]?.appealId
      );
      return json(response, 201, projectAppeal(replayed || appeal));
    }
    if (appealsMatch && request.method === 'GET') {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(appealsMatch[1]);
      const principal = participantPrincipalForRequest(request, item);
      const appeals = (item.appeals || []).filter((appeal) =>
        principal.role === 'admin' || appeal.participantId === principal.principalId
      ).map(projectAppeal);
      return json(response, 200, { evaluationId: item.id, appeals });
    }
    const appealTriageMatch = url.pathname.match(/^\/api\/admin\/appeals\/([^/]+)\/triage$/);
    const appealReplacementMatch = url.pathname.match(/^\/api\/admin\/appeals\/([^/]+)\/replacement-run$/);
    const appealDecisionMatch = url.pathname.match(/^\/api\/admin\/appeals\/([^/]+)\/decision$/);
    if (request.method === 'POST' && (appealTriageMatch || appealReplacementMatch || appealDecisionMatch)) {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const appealId = (appealTriageMatch || appealReplacementMatch || appealDecisionMatch)[1];
      const item = evaluationForAppeal(appealId);
      const principal = requireRole(authenticatePrincipal(request, item, process.env), 'admin');
      const idempotencyKey = requiredIdempotencyKey(request);
      const payload = await readJsonBody(request, 64_000);
      const action = appealTriageMatch ? 'triage' : appealReplacementMatch ? 'replacement' : 'decision';
      const fingerprint = governanceIdempotencyFingerprint(item.id, `appeal-${action}`, principal.principalId, payload);
      const committed = await store.mutate(item.id, undefined, async (current) => {
        const replies = governanceIdempotency(current, `appeal-${action}`);
        if (idempotencyResponse(replies, idempotencyKey, fingerprint)) return current;
        const result = action === 'triage'
          ? triageAppeal(current, appealId, payload, principal)
          : action === 'replacement'
            ? authorizeReplacementRun(current, appealId, payload, principal)
            : decideAppeal(current, appealId, payload, principal);
        const appeal = action === 'replacement'
          ? current.appeals.find((candidate) => candidate.appealId === appealId)
          : result;
        if (
          action === 'replacement' ||
          (action === 'decision' && payload.outcome === 'upheld' && payload.recalculate === true)
        ) {
          const version = await runAppealResultVersion(
            current,
            appeal,
            appealRecalculationServices()
          );
          appeal.resultVersion = {
            version: version.version,
            beforeResultHash: version.supersedesResultHash,
            afterResultHash: version.resultHash
          };
        }
        replies[idempotencyKey] = { fingerprint, response: projectAppeal(
          appeal
        ) };
        return current;
      });
      return json(response, 200, idempotencyResponse(
        governanceIdempotency(committed, `appeal-${action}`), idempotencyKey, fingerprint
      ));
    }
    const adminEvaluationMatch = url.pathname.match(/^\/api\/admin\/evaluations\/([^/]+)$/);
    if (request.method === 'GET' && adminEvaluationMatch) {
      response.setHeader('cache-control', 'no-store');
      if (!isReviewGovernanceEnabled(process.env)) {
        return json(response, 403, { error: 'Review governance is disabled' });
      }
      const item = store.get(adminEvaluationMatch[1]);
      if (!item || item.schemaVersion !== 2) {
        return json(response, 404, { error: 'Evaluation does not exist' });
      }
      const principal = requireRole(
        authenticatePrincipal(request, item, process.env),
        'admin'
      );
      return json(response, 200, projectEvaluation(item, {
        audience: 'admin',
        principal
      }));
    }
    const absoluteLockMatch =
      url.pathname.match(/^\/api\/admin\/evaluations\/([^/]+)\/lock-absolute$/);
    if (request.method === 'POST' && absoluteLockMatch) {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(absoluteLockMatch[1]);
      const principal = requireRole(authenticatePrincipal(request, item, process.env), 'admin');
      const idempotencyKey = requiredIdempotencyKey(request);
      const payload = await readJsonBody(request, 16_000);
      const fingerprint = governanceIdempotencyFingerprint(
        item.id, 'lock-absolute', principal.principalId, payload
      );
      const committed = await store.mutate(item.id, undefined, async (current) => {
        const replies = governanceIdempotency(current, 'absoluteLocks');
        if (idempotencyResponse(replies, idempotencyKey, fingerprint)) return current;
        const result = await lockAndReleaseAbsoluteResult(current, replicaReleaseServices(), {
          principalId: principal.principalId,
          idempotencyKey
        });
        replies[idempotencyKey] = {
          fingerprint,
          response: {
            absolute: result.absolute,
            replica: result.replica,
            rating: result.rating,
            phase: current.governance.phase
          }
        };
        return current;
      });
      return json(response, 200, idempotencyResponse(
        governanceIdempotency(committed, 'absoluteLocks'), idempotencyKey, fingerprint
      ));
    }
    if (request.method === 'GET' && url.pathname === '/api/review-queue') {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const openItems = store.list().filter((item) => item.schemaVersion === 2 && (
        item.governance?.phase === 'human_open' ||
        (item.governance?.replicaHumanPhase === 'replica_human_open' &&
          !item.governance?.replicaHumanLockedAt)
      ));
      const queue = await Promise.all(openItems.map(async (item) => {
        const projected = projectEvaluation(item, {
          audience: 'participant',
          principal: { principalId: 'open-judge', role: 'participant' }
        });
        const reviewDossier = {};
        const absolute = buildAbsoluteReviewDossier(item);
        if (absolute) reviewDossier.absolute = absolute;
        if (
          item.governance?.replicaHumanPhase === 'replica_human_open' &&
          !item.governance?.replicaHumanLockedAt
        ) {
          const replica = await buildReplicaReviewDossier(item, {
            evidenceVault: evidenceVaultForRead(item.id)
          });
          if (replica) reviewDossier.replica = replica;
        }
        if (Object.keys(reviewDossier).length) {
          projected.reviewDossier = reviewDossier;
        }
        return projected;
      }));
      return json(response, 200, queue);
    }
    const skipHumanReviewMatch =
      url.pathname.match(/^\/api\/evaluations\/([^/]+)\/skip-human-review$/);
    if (request.method === 'POST' && skipHumanReviewMatch) {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(skipHumanReviewMatch[1]);
      const principal = openReviewPrincipal(request);
      const idempotencyKey = requiredIdempotencyKey(request);
      const payload = await readJsonBody(request, 4_000);
      // Anonymous callers get a fresh principal per request, so the replay
      // fingerprint must not depend on actor identity here.
      const fingerprint = governanceIdempotencyFingerprint(
        item.id, 'skip-human-review', 'open', payload
      );
      const committed = await store.mutate(item.id, undefined, async (current) => {
        const replies = governanceIdempotency(current, 'humanReviewSkips');
        if (idempotencyResponse(replies, idempotencyKey, fingerprint)) return current;
        skipHumanReview(current, principal);
        const result = await lockAndReleaseAbsoluteResult(current, replicaReleaseServices(), {
          principalId: principal.principalId,
          idempotencyKey
        });
        replies[idempotencyKey] = {
          fingerprint,
          response: {
            absolute: result.absolute,
            replica: result.replica,
            rating: result.rating,
            phase: current.governance.phase
          }
        };
        return current;
      });
      return json(response, 200, idempotencyResponse(
        governanceIdempotency(committed, 'humanReviewSkips'), idempotencyKey, fingerprint
      ));
    }
    const humanReviewsMatch =
      url.pathname.match(/^\/api\/evaluations\/([^/]+)\/human-reviews$/);
    if (request.method === 'POST' && humanReviewsMatch) {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(humanReviewsMatch[1]);
      const principal = openReviewPrincipal(request);
      const payload = await readJsonBody(request, 250_000);
      let lockResult = null;
      const committed = await store.mutate(item.id, undefined, async (current) => {
        const { review } = submitOpenHumanReview(current, principal, payload);
        lockResult = await lockAndReleaseAbsoluteResult(current, replicaReleaseServices(), {
          principalId: principal.principalId,
          idempotencyKey: `human-review-${review.reviewId}`
        });
        return current;
      });
      const review = committed.humanReviews.find((candidate) =>
        candidate.judgeId === principal.principalId && candidate.status === 'submitted'
      );
      return json(response, 201, {
        reviewId: review?.reviewId,
        status: review?.status,
        submittedAt: review?.submittedAt,
        humanReviewAggregate: committed.humanReviewAggregate,
        absolute: lockResult?.absolute,
        replica: lockResult?.replica,
        rating: lockResult?.rating,
        governance: { phase: committed.governance.phase }
      });
    }
    const replicaReviewPolicyMatch =
      url.pathname.match(/^\/api\/evaluations\/([^/]+)\/replica-review-policy$/);
    if (request.method === 'PUT' && replicaReviewPolicyMatch) {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(replicaReviewPolicyMatch[1]);
      const principal = openReviewPrincipal(request);
      const payload = await readJsonBody(request, 4_000);
      const committed = await store.mutate(item.id, undefined, (current) => {
        setReplicaReviewPolicy(current, principal, payload);
        return current;
      });
      return json(response, 200, {
        replicaReviewPolicy: committed.governance.replicaReviewPolicy
      });
    }
    const replicaHumanReviewsMatch =
      url.pathname.match(/^\/api\/evaluations\/([^/]+)\/replica-human-reviews$/);
    if (request.method === 'POST' && replicaHumanReviewsMatch) {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(replicaHumanReviewsMatch[1]);
      const principal = openReviewPrincipal(request);
      const payload = await readJsonBody(request, 250_000);
      const committed = await store.mutate(item.id, undefined, (current) => {
        submitReplicaHumanReview(current, principal, payload);
        return current;
      });
      const review = committed.replicaHumanReviews.find((candidate) =>
        candidate.principalId === principal.principalId
      );
      return json(response, 201, {
        reviewId: review?.reviewId,
        role: review?.role,
        status: review?.status,
        submittedAt: review?.submittedAt,
        governance: { phase: committed.governance.phase }
      });
    }
    const replicaHumanReviewLockMatch =
      url.pathname.match(/^\/api\/evaluations\/([^/]+)\/replica-human-reviews\/lock$/);
    if (request.method === 'POST' && replicaHumanReviewLockMatch) {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(replicaHumanReviewLockMatch[1]);
      const principal = openReviewPrincipal(request);
      const idempotencyKey = requiredIdempotencyKey(request);
      const payload = await readJsonBody(request, 4_000);
      // Anonymous callers get a fresh principal per request, so the replay
      // fingerprint must not depend on actor identity here.
      const fingerprint = governanceIdempotencyFingerprint(
        item.id, 'replica-human-review-lock', 'open', payload
      );
      const committed = await store.mutate(item.id, undefined, async (current) => {
        const replies = governanceIdempotency(current, 'replicaHumanReviewLocks');
        if (idempotencyResponse(replies, idempotencyKey, fingerprint)) return current;
        const actor = { principalId: principal.principalId, idempotencyKey };
        const locked = lockReplicaHumanReview(current, actor);
        let finalizeResult = null;
        if (current.governance?.absoluteLockedAt) {
          finalizeResult = await finalizeDualTrack(current, replicaReleaseServices(), actor);
        }
        replies[idempotencyKey] = {
          fingerprint,
          response: {
            replicaHumanReviewAggregate: locked,
            replica: finalizeResult?.replica ?? current.resultV2.replica,
            rating: finalizeResult?.rating ?? current.resultV2.rating,
            phase: current.governance.phase
          }
        };
        return current;
      });
      return json(response, 200, idempotencyResponse(
        governanceIdempotency(committed, 'replicaHumanReviewLocks'), idempotencyKey, fingerprint
      ));
    }
    const finalizeDualTrackMatch =
      url.pathname.match(/^\/api\/evaluations\/([^/]+)\/finalize-dual-track$/);
    if (request.method === 'POST' && finalizeDualTrackMatch) {
      response.setHeader('cache-control', 'no-store');
      requireGovernanceEnabled();
      const item = requireV2Evaluation(finalizeDualTrackMatch[1]);
      const principal = openReviewPrincipal(request);
      const idempotencyKey = requiredIdempotencyKey(request);
      const payload = await readJsonBody(request, 4_000);
      const fingerprint = governanceIdempotencyFingerprint(
        item.id, 'finalize-dual-track', 'open', payload
      );
      const committed = await store.mutate(item.id, undefined, async (current) => {
        const replies = governanceIdempotency(current, 'dualTrackFinalizes');
        if (idempotencyResponse(replies, idempotencyKey, fingerprint)) return current;
        const result = await finalizeDualTrack(current, replicaReleaseServices(), {
          principalId: principal.principalId,
          idempotencyKey
        });
        replies[idempotencyKey] = {
          fingerprint,
          response: {
            replica: result.replica,
            rating: result.rating,
            phase: current.governance.phase
          }
        };
        return current;
      });
      return json(response, 200, idempotencyResponse(
        governanceIdempotency(committed, 'dualTrackFinalizes'), idempotencyKey, fingerprint
      ));
    }
    const evidenceMatch =
      url.pathname.match(/^\/api\/evaluations\/([^/]+)\/evidence\/([^/]+)$/);
    if (request.method === 'GET' && evidenceMatch) {
      return serveEvidenceItem(request, response, evidenceMatch[1], evidenceMatch[2]);
    }
    const evidenceManifestMatch =
      url.pathname.match(/^\/api\/evaluations\/([^/]+)\/evidence-manifest$/);
    if (request.method === 'GET' && evidenceManifestMatch) {
      return serveEvidenceManifest(request, response, evidenceManifestMatch[1]);
    }
    const resultMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/result$/);
    if (request.method === 'GET' && resultMatch) {
      return serveResult(request, response, resultMatch[1]);
    }
    const skillMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/builds\/([^/]+)\/skill$/);
    if (request.method === 'GET' && skillMatch) {
      const item = store.get(skillMatch[1]);
      if (item?.schemaVersion === 2) {
        return json(response, 404, { error: 'V2 evaluation build artifacts are not public' });
      }
      if (!item) return json(response, 404, { error: '评测不存在' });
      const runtimeId = decodeURIComponent(skillMatch[2]);
      const build = item.builds?.find((candidate) => candidate.runtimeId === runtimeId);
      if (!build) return json(response, 404, { error: 'Runtime 复刻记录不存在' });
      if (build.error || !build.skill) return json(response, 409, { error: build.error || '该 Runtime 没有 Skill 产物' });
      try {
        return json(response, 200, createSkillBundle(build, item.agentCard.description));
      } catch (error) {
        return json(response, 409, { error: error.message || 'Skill 产物无法标准化' });
      }
    }
    const replicaSkillMatch = url.pathname.match(
      /^\/api\/evaluations\/([^/]+)\/replica\/runtimes\/([^/]+)\/skill$/
    );
    if (request.method === 'GET' && replicaSkillMatch) {
      const item = store.get(replicaSkillMatch[1]);
      if (!item) return json(response, 404, { error: '评测不存在' });
      if (item.schemaVersion !== 2) {
        return json(response, 404, { error: 'Not a V2 evaluation' });
      }
      try {
        const bundle = await loadReplicaSkillBundle(
          item,
          decodeURIComponent(replicaSkillMatch[2]),
          replicaReleaseServices()
        );
        return json(response, 200, bundle);
      } catch (error) {
        return json(response, error.statusCode || 409, {
          error: error.message || 'Replica Skill 不可用'
        });
      }
    }
    const replicaOutputMatch = url.pathname.match(
      /^\/api\/evaluations\/([^/]+)\/replica\/cases\/([^/]+)\/([^/]+)\/outputs$/
    );
    if (request.method === 'GET' && replicaOutputMatch) {
      const item = store.get(replicaOutputMatch[1]);
      if (!item) return json(response, 404, { error: '评测不存在' });
      if (item.schemaVersion !== 2) {
        return json(response, 404, { error: 'Not a V2 evaluation' });
      }
      try {
        const payload = await loadReplicaCaseOutputs(
          item,
          decodeURIComponent(replicaOutputMatch[2]),
          decodeURIComponent(replicaOutputMatch[3]),
          replicaReleaseServices()
        );
        return json(response, 200, payload);
      } catch (error) {
        return json(response, error.statusCode || 409, {
          error: error.message || 'Replica 输出不可用'
        });
      }
    }
    const match = url.pathname.match(/^\/api\/evaluations\/([^/]+)$/);
    if (request.method === 'DELETE' && match) {
      const item = store.get(match[1]);
      if (!item) return json(response, 404, { error: '评测不存在' });
      if (item.schemaVersion === 2) {
        const status = item.execution?.status;
        if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
          return json(response, 409, { error: '运行中的评测不能删除，请先停止本次评测' });
        }
        await store.delete(match[1]);
        return json(response, 200, { id: match[1], deleted: true });
      }
      const status = item.status;
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
        return json(response, 409, { error: '运行中的评测不能删除，请先停止本次评测' });
      }
      await store.delete(match[1]);
      return json(response, 200, { id: match[1], deleted: true });
    }
    if (request.method === 'GET' && match) {
      const item = store.get(match[1]);
      if (item?.schemaVersion === 2) {
        return json(response, 200, projectForRequest(item, request));
      }
      return item ? json(response, 200, item) : json(response, 404, { error: '评测不存在' });
    }
    const eventMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/events$/);
    if (request.method === 'GET' && eventMatch) return streamEvents(request, response, eventMatch[1]);
    if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
    if (request.method === 'GET') return staticFile(url.pathname, response);
    return json(response, 404, { error: '接口不存在' });
  } catch (error) {
    if (error.retryAfter) response.setHeader('retry-after', String(error.retryAfter));
    if (error.responseBody) {
      response.setHeader('cache-control', 'no-store');
      return json(response, error.statusCode || 500, error.responseBody);
    }
    if (!error.statusCode || error.statusCode === 500) console.error(error);
    return json(response, error.statusCode || 500, { error: error.message || '服务器内部错误' });
  }
});

function streamEvents(request, response, evaluationId) {
  const item = store.get(evaluationId);
  if (!item) return json(response, 404, { error: '评测不存在' });
  const projectionOptions = item.schemaVersion === 2
    ? projectionOptionsForRequest(item, request)
    : null;
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (value) => {
    const body = item.schemaVersion === 2 || value?.schemaVersion === 2
      ? projectEvaluation(value, projectionOptions)
      : value;
    response.write(`data: ${JSON.stringify(body)}\n\n`);
  };
  send(item);
  const listener = (value) => send(value);
  events.on(evaluationId, listener);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
  request.on('close', () => { clearInterval(heartbeat); events.off(evaluationId, listener); });
}

async function staticFile(pathname, response) {
  const requested = pathname === '/'
    ? '/index.html'
    : pathname === '/agent-check'
      ? '/agent-check.html'
      : pathname === '/judge'
        ? '/judge.html'
      : pathname;
  const target = path.resolve(publicRoot, `.${requested}`);
  if (target !== publicRoot && !target.startsWith(`${publicRoot}${path.sep}`)) return json(response, 403, { error: '禁止访问' });
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not file');
    response.writeHead(200, { 'content-type': contentType(target), 'cache-control': 'no-cache' });
    createReadStream(target).pipe(response);
  } catch {
    if (!path.extname(pathname)) return staticFile('/index.html', response);
    return json(response, 404, { error: '文件不存在' });
  }
}

function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
}
function authorizedDataRequest(request, expected) {
  const authorization = String(request.headers.authorization || '');
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : String(request.headers['x-panda-data-access-key'] || '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function authorizedBearer(request, expected) {
  const authorization = String(request.headers.authorization || '');
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload)); }
function summary(item) { return { id: item.id, name: item.agentCard.name, createdAt: item.createdAt, status: item.status, progress: item.progress, tier: item.roast?.tier, score: item.averages?.submitted }; }

export function serializeEvaluationForResponse(item) {
  return item?.schemaVersion === 2
    ? projectEvaluation(item, { audience: 'public' })
    : item;
}

export function setAppealRecalculationServicesForTest(services) {
  injectedAppealRecalculationServices = services;
}

function projectForRequest(evaluation, request) {
  return projectEvaluation(evaluation, projectionOptionsForRequest(evaluation, request));
}

function projectionOptionsForRequest(evaluation, request) {
  const principal = authenticatePrincipal(request, evaluation, process.env);
  if (principal?.role === 'judge' || principal?.role === 'admin') {
    if (!isReviewGovernanceEnabled(process.env)) {
      throw Object.assign(new Error('review governance is disabled'), { statusCode: 403 });
    }
    return { audience: principal.role, principal };
  }
  return {
    audience: 'participant',
    principal: { principalId: 'participant', role: 'participant' }
  };
}

function participantPrincipalForRequest(request, evaluation) {
  const principal = authenticatePrincipal(request, evaluation, process.env);
  if (principal?.role === 'admin') return principal;
  return { principalId: 'participant', role: 'participant' };
}

function requireGovernanceEnabled() {
  if (!isReviewGovernanceEnabled(process.env)) {
    throw Object.assign(new Error('Review governance is disabled'), { statusCode: 403 });
  }
}

function requireV2Evaluation(evaluationId) {
  const item = store.get(evaluationId);
  if (!item || item.schemaVersion !== 2) {
    throw Object.assign(new Error('Evaluation does not exist'), { statusCode: 404 });
  }
  return item;
}

function openReviewPrincipal(request) {
  const authenticated = authenticatePrincipal(request, null, process.env);
  if (authenticated) return authenticated;
  return { principalId: `open_${randomUUID().replaceAll('-', '')}`, role: 'public' };
}

function replicaReleaseServices() {
  return {
    evidenceVaultFactory: (evaluationId) => {
      const key = copyEvidenceEncryptionKey(blackBoxRuntimeConfig);
      try {
        return new EvidenceVault({
          root: blackBoxRuntimeConfig.evidenceRoot,
          evaluationId,
          key
        });
      } finally {
        key.fill(0);
      }
    },
    ...injectedReplicaReleaseServices
  };
}

export function setReplicaReleaseServicesForTest(services) {
  injectedReplicaReleaseServices = services;
}

function appealRecalculationServices() {
  if (injectedAppealRecalculationServices) return injectedAppealRecalculationServices;
  throw Object.assign(
    new Error('appeal recalculation services are not configured'),
    { statusCode: 503 }
  );
}

function requiredIdempotencyKey(request) {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('Idempotency-Key is required'), { statusCode: 422 });
  }
  return value.trim();
}

function governanceIdempotency(evaluation, type) {
  if (!evaluation.governance.idempotency) evaluation.governance.idempotency = {};
  if (!evaluation.governance.idempotency[type]) evaluation.governance.idempotency[type] = {};
  return evaluation.governance.idempotency[type];
}

function governanceIdempotencyFingerprint(evaluationId, action, actorId, payload) {
  return createHash('sha256').update(canonicalJson({
    evaluationId,
    action,
    actorId,
    payload
  })).digest('hex');
}

function idempotencyResponse(replies, key, fingerprint) {
  const entry = replies[key];
  if (!entry) return null;
  if (entry.fingerprint !== fingerprint || !entry.response) {
    throw Object.assign(new Error('Idempotency-Key is already bound to a different request'), {
      statusCode: 409
    });
  }
  return entry.response;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function evaluationForAppeal(appealId) {
  const item = store.list().find((candidate) =>
    candidate.schemaVersion === 2 &&
    (candidate.appeals || []).some((appeal) => appeal.appealId === appealId)
  );
  if (!item) throw Object.assign(new Error('Appeal does not exist'), { statusCode: 404 });
  return item;
}

function projectAppeal(appeal) {
  return {
    appealId: appeal.appealId,
    version: appeal.version,
    status: appeal.status,
    target: appeal.target,
    grounds: appeal.grounds,
    statement: appeal.statement,
    evidenceIds: appeal.evidenceIds,
    originalSnapshot: appeal.originalSnapshot,
    replacementRunIds: appeal.replacementRunIds,
    triage: appeal.triage,
    decision: appeal.decision,
    resultVersion: appeal.resultVersion,
    events: appeal.events
  };
}

function appealWindowHours() {
  const value = Number(process.env.APPEAL_WINDOW_HOURS || 72);
  return Number.isFinite(value) && value > 0 ? value : 72;
}

async function serveEvidenceItem(request, response, evaluationId, evidenceId) {
  response.setHeader('cache-control', 'no-store');
  const item = store.get(evaluationId);
  if (!item || item.schemaVersion !== 2) {
    return json(response, 404, { error: 'Evaluation does not exist' });
  }
  const options = projectionOptionsForRequest(item, request);
  const projected = projectEvaluation(item, options);
  const manifestItem = projected.evidenceManifest?.items?.find(
    (entry) => entry.evidenceId === evidenceId
  );
  if (!manifestItem) {
    return json(response, 404, { error: 'Evidence does not exist' });
  }
  const evidenceVault = evidenceVaultForRead(item.id);
  const record = await evidenceVault.get(manifestItem.evidenceId, manifestItem.recordHash);
  const projectedRecord = projectEvidenceRecord(record, manifestItem);
  await accessAuditStore.append({
    principalId: options.principal?.principalId || 'participant',
    evaluationId: item.id,
    evidenceId: manifestItem.evidenceId,
    role: options.audience
  });
  return json(response, 200, { item: projectedRecord });
}

function serveEvidenceManifest(request, response, evaluationId) {
  response.setHeader('cache-control', 'no-store');
  const item = store.get(evaluationId);
  if (!item || item.schemaVersion !== 2) {
    return json(response, 404, { error: 'Evaluation does not exist' });
  }
  const options = projectionOptionsForRequest(item, request);
  const projected = projectEvaluation(item, options);
  return json(response, 200, {
    evaluationId: item.id,
    version: projected.evidenceManifest?.version,
    items: projected.evidenceManifest?.items || []
  });
}

function serveResult(request, response, evaluationId) {
  response.setHeader('cache-control', 'no-store');
  const item = store.get(evaluationId);
  if (!item || item.schemaVersion !== 2) {
    return json(response, 404, { error: 'Evaluation does not exist' });
  }
  return json(response, 200, projectForRequest(item, request));
}

function evidenceVaultForRead(evaluationId) {
  const key = blackBoxRuntimeConfig.enabled
    ? copyEvidenceEncryptionKey(blackBoxRuntimeConfig)
    : process.env.EVIDENCE_ENCRYPTION_KEY;
  const evidenceRoot = blackBoxRuntimeConfig.enabled
    ? blackBoxRuntimeConfig.evidenceRoot
    : path.resolve(root, process.env.EVIDENCE_ROOT || 'data/evidence');
  try {
    return new EvidenceVault({ root: evidenceRoot, evaluationId, key });
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
  }
}

function bearerToken(value) {
  const match = typeof value === 'string'
    ? value.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)
    : null;
  return match?.[1] ?? '';
}

async function readEvaluationCreateBody(request) {
  if (!blackBoxRuntimeConfig.enabled) {
    return readJsonBody(request, LEGACY_EVALUATION_BODY_LIMIT);
  }
  let parsed;
  try {
    parsed = await readJsonBodyWithSize(
      request,
      V2_EVALUATION_BODY_LIMIT
    );
  } catch (error) {
    if (
      error.statusCode === 400 &&
      error.bodySize > LEGACY_EVALUATION_BODY_LIMIT
    ) {
      throw Object.assign(
        new Error('Legacy evaluation request body exceeds the size limit'),
        { statusCode: 413 }
      );
    }
    throw error;
  }
  const { value, size } = parsed;
  if (value?.schemaVersion !== 2 && size > LEGACY_EVALUATION_BODY_LIMIT) {
    throw Object.assign(
      new Error('Legacy evaluation request body exceeds the size limit'),
      { statusCode: 413 }
    );
  }
  return value;
}

if (process.env.NODE_ENV !== 'test') {
  const { host, port } = resolveServerAddress();
  server.listen(port, host, () => {
    const displayHost = host || 'localhost';
    console.log(`Agent 锐评系统已启动：http://${displayHost}:${port}`);
  });
}
