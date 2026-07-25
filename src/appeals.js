import { createHash, randomUUID } from 'node:crypto';

const GROUNDS = new Set(['platform-error', 'evidence-missing', 'rubric-misapplied']);
const TARGET_KINDS = new Set(['test', 'evidence', 'score']);

export function createAppeal(evaluation, participant, input, options = {}) {
  requireParticipant(evaluation, participant);
  const normalized = normalizeCreateInput(evaluation, input);
  const idempotency = appealIdempotency(evaluation);
  const fingerprint = hash({ principalId: participant.principalId, input: normalized });
  const replay = idempotency[normalized.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw conflict('Idempotency-Key is already bound to a different appeal');
    return appealById(evaluation, replay.appealId);
  }
  const now = (options.now || (() => new Date().toISOString()))();
  assertWindow(evaluation, now, options.windowHours ?? 72);
  const appeal = {
    appealId: `appeal_${randomUUID().replaceAll('-', '')}`,
    version: 1,
    status: 'submitted',
    target: normalized.target,
    grounds: normalized.grounds,
    statement: normalized.statement,
    evidenceIds: normalized.evidenceIds,
    originalSnapshot: snapshot(evaluation),
    events: [],
    replacementRunIds: [],
    decision: null,
    participantId: participant.principalId,
    createdAt: now
  };
  appendAppeal(evaluation, appeal);
  appendEvent(evaluation, appeal, 'submitted', participant.principalId, { statementHash: hash(appeal.statement) }, now);
  idempotency[normalized.idempotencyKey] = { fingerprint, appealId: appeal.appealId };
  return appeal;
}

export function triageAppeal(evaluation, appealId, input, admin, options = {}) {
  requireAdmin(admin);
  const appeal = appealById(evaluation, appealId);
  if (appeal.status !== 'submitted') throw conflict('appeal is not awaiting triage');
  const attribution = input?.attribution;
  if (!attribution || !['platform', 'agent', 'replica', 'pending'].includes(attribution.attribution)) {
    throw validation('triage requires a valid failure attribution');
  }
  appeal.triage = structuredClone(attribution);
  appeal.status = 'triaged';
  appendEvent(evaluation, appeal, 'triaged', admin.principalId, attribution, options.now?.() || new Date().toISOString());
  return appeal;
}

export function authorizeReplacementRun(evaluation, appealId, runId, admin, options = {}) {
  requireAdmin(admin);
  const appeal = appealById(evaluation, appealId);
  if (appeal.triage?.attribution !== 'platform') {
    throw conflict('only a confirmed platform failure may authorize replacement');
  }
  if (appeal.replacementRunIds.length > 0) throw conflict('appeal already has an authorized replacement');
  const original = findRun(evaluation, runId);
  const previous = (evaluation.replacementRuns || []).find((run) => run.replacementForRunId === runId);
  if (previous) throw conflict('invalid run already has a replacement');
  const replacement = {
    runId: `run_replacement_${randomUUID().replaceAll('-', '')}`,
    replacementForRunId: runId,
    appealId,
    status: 'authorized',
    config: sameConfig(original.cell),
    authorizedAt: options.now?.() || new Date().toISOString()
  };
  if (!Array.isArray(evaluation.replacementRuns)) evaluation.replacementRuns = [];
  evaluation.replacementRuns.push(replacement);
  appeal.replacementRunIds.push(replacement.runId);
  appeal.status = 'replacement-authorized';
  appendEvent(evaluation, appeal, 'replacement-authorized', admin.principalId, {
    replacementRunId: replacement.runId, replacementForRunId: runId
  }, replacement.authorizedAt);
  return replacement;
}

export function decideAppeal(evaluation, appealId, input, admin, options = {}) {
  requireAdmin(admin);
  const appeal = appealById(evaluation, appealId);
  if (!['upheld', 'rejected'].includes(input?.outcome) || !String(input?.rationale || '').trim()) {
    throw validation('appeal decision requires an outcome and rationale');
  }
  if (['upheld', 'rejected'].includes(appeal.status)) throw conflict('appeal is already decided');
  appeal.decision = {
    outcome: input.outcome,
    rationale: input.rationale.trim(),
    decidedBy: admin.principalId,
    decidedAt: options.now?.() || new Date().toISOString()
  };
  appeal.status = input.outcome;
  appendEvent(evaluation, appeal, input.outcome, admin.principalId, {
    rationaleHash: hash(appeal.decision.rationale)
  }, appeal.decision.decidedAt);
  return appeal;
}

function normalizeCreateInput(evaluation, input) {
  if (!input || typeof input !== 'object') throw validation('appeal input is required');
  const target = input.target;
  if (!target || !TARGET_KINDS.has(target.kind) || !text(target.id) || !text(target.path) ||
      !targetExists(evaluation, target)) throw validation('appeal target is invalid');
  if (!GROUNDS.has(input.grounds)) throw validation('appeal grounds are invalid');
  if (!text(input.statement)) throw validation('appeal statement is required');
  if (!text(input.idempotencyKey)) throw validation('idempotency key is required');
  const visible = new Set((evaluation.evidenceManifest?.items || []).map((item) => item.evidenceId));
  const evidenceIds = [...new Set(input.evidenceIds || [])];
  if (evidenceIds.some((id) => !visible.has(id))) throw validation('appeal cites unavailable evidence');
  return {
    target: { kind: target.kind, id: target.id, path: target.path },
    grounds: input.grounds,
    statement: input.statement.trim(),
    evidenceIds,
    idempotencyKey: input.idempotencyKey.trim()
  };
}

function targetExists(evaluation, target) {
  if (target.kind === 'evidence') return (evaluation.evidenceManifest?.items || []).some((item) => item.evidenceId === target.id);
  if (target.kind === 'test') return (evaluation.runtimeState?.runIndex || []).some((cell) => cell.identity?.testId === target.id);
  return target.id === evaluation.resultV2?.absolute?.resultHash || target.id === 'absolute';
}

function findRun(evaluation, runId) {
  for (const cell of evaluation.runtimeState?.runIndex || []) {
    for (const attempt of cell.attempts || []) {
      if ((attempt.turns || []).some((turn) => turn.runId === runId)) return { cell, attempt };
    }
  }
  throw validation('replacement target run does not exist');
}

function sameConfig(cell) {
  return {
    inputHash: cell.identity.inputHash,
    seed: cell.identity.seed,
    temperature: cell.policy.temperature ?? 0,
    timeoutMs: cell.policy.timeoutMs,
    targetMs: cell.policy.targetMs,
    protocolConfigHash: cell.identity.protocolConfigHash,
    runtimeConfigVersion: cell.policy.version,
    acceptanceCriteriaHash: cell.identity.testContractHash || null,
    weight: cell.weight ?? 1
  };
}

function snapshot(evaluation) {
  return {
    resultHash: evaluation.governance?.resultHash || evaluation.resultV2?.absolute?.resultHash || null,
    evidenceManifestHash: evaluation.governance?.evidenceManifestHash || hash(evaluation.evidenceManifest || {}),
    runIds: (evaluation.runtimeState?.runIndex || []).flatMap((cell) =>
      (cell.attempts || []).flatMap((attempt) => (attempt.turns || []).map((turn) => turn.runId))
    )
  };
}

function appendAppeal(evaluation, appeal) {
  if (!Array.isArray(evaluation.appeals)) evaluation.appeals = [];
  evaluation.appeals.push(appeal);
}

function appendEvent(evaluation, appeal, type, actorId, payload, at) {
  const event = {
    eventId: `appeal_event_${randomUUID().replaceAll('-', '')}`,
    appealId: appeal.appealId, type, actorId, at, payloadHash: hash(payload)
  };
  appeal.events.push(event);
  if (!Array.isArray(evaluation.appealEvents)) evaluation.appealEvents = [];
  evaluation.appealEvents.push(event);
}

function appealIdempotency(evaluation) {
  if (!evaluation.governance) evaluation.governance = {};
  if (!evaluation.governance.appealIdempotency) evaluation.governance.appealIdempotency = {};
  return evaluation.governance.appealIdempotency;
}

function appealById(evaluation, appealId) {
  const appeal = (evaluation.appeals || []).find((item) => item.appealId === appealId);
  if (!appeal) throw Object.assign(new Error('appeal does not exist'), { statusCode: 404 });
  return appeal;
}

function requireParticipant(evaluation, participant) {
  if (participant?.role !== 'participant' ||
      participant.principalId !== (evaluation.participantAccess?.ownerId || 'participant')) {
    throw Object.assign(new Error('participant owner access is required'), { statusCode: 403 });
  }
}
function requireAdmin(admin) {
  if (admin?.role !== 'admin' || !text(admin.principalId)) {
    throw Object.assign(new Error('admin access is required'), { statusCode: 403 });
  }
}
function assertWindow(evaluation, now, windowHours) {
  const finalized = evaluation.finalizedAt || evaluation.governance?.absoluteLockedAt;
  if (!finalized || Date.parse(now) > Date.parse(finalized) + windowHours * 3_600_000) {
    throw validation('appeal window has expired');
  }
}
function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function text(value) { return typeof value === 'string' && value.trim(); }
function validation(message) { return Object.assign(new TypeError(message), { statusCode: 422 }); }
function conflict(message) { return Object.assign(new Error(message), { statusCode: 409 }); }
