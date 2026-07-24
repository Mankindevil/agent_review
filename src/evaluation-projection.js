import {
  redactEvidence,
  validateEvidenceManifestItem
} from './evidence.js';

const COMMON_RESULT_FIELDS = [
  'id', 'status', 'stage', 'progress', 'score', 'confidence', 'coverage',
  'provisional', 'applicable', 'weight', 'numerator', 'denominator', 'reason',
  'startedAt', 'completedAt', 'failedAt', 'cancelledAt', 'interruptedAt',
  'attemptRunIds', 'evidenceIds', 'gaps', 'dimensions', 'metrics', 'checks',
  'findings', 'uncertainties', 'repairSuggestion'
];
const DIMENSION_FIELDS = new Set(['scenarioValue', 'professionalism', 'agentCapability']);

export function projectEvaluation(evaluation, { audience = 'public', secrets = [] } = {}) {
  if (audience !== 'public' && audience !== 'admin') {
    throw new TypeError('unsupported evaluation projection audience');
  }
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    throw new TypeError('evaluation must be an object');
  }

  const projection = {
    schemaVersion: projectPrimitive(evaluation.schemaVersion, secrets),
    id: projectPrimitive(evaluation.id, secrets),
    createdAt: projectPrimitive(evaluation.createdAt, secrets),
    updatedAt: projectPrimitive(evaluation.updatedAt, secrets),
    revision: projectPrimitive(evaluation.revision, secrets),
    evaluationWindow: pick(evaluation.evaluationWindow, [
      'firstRunAt', 'lastRunAt'
    ], {}, secrets),
    execution: pickResult(evaluation.execution, [
      'status', 'stage', 'progress', 'startedAt', 'completedAt', 'failedAt',
      'cancelledAt', 'interruptedAt'
    ], secrets),
    governance: pickResult(evaluation.governance, [
      'phase', 'modelLockedAt', 'humanLockedAt', 'absoluteLockedAt',
      'replicaReleasedAt'
    ], secrets),
    qualification: projectQualification(evaluation.qualification, secrets),
    evidenceManifest: projectManifest(evaluation.evidenceManifest, audience, secrets),
    objectiveCapability: pickResult(evaluation.objectiveCapability, COMMON_RESULT_FIELDS, secrets),
    absoluteReview: projectAbsoluteReview(evaluation.absoluteReview, secrets),
    resultV2: evaluation.resultV2 === null
      ? null
      : projectResultV2(evaluation.resultV2, secrets)
  };
  if (evaluation.archivedAt !== undefined) {
    projection.archivedAt = projectPrimitive(evaluation.archivedAt, secrets);
  }

  if (audience === 'admin') {
    projection.submission = projectSubmissionMetadata(evaluation.submission, secrets);
    projection.auditEvents = (Array.isArray(evaluation.auditEvents) ? evaluation.auditEvents : [])
      .map((event) => projectAuditEvent(event, secrets));
  }
  return projection;
}

function projectQualification(value, secrets) {
  return pick(value, [
    'status', 'reason', 'attemptRunIds', 'selectedInterface', 'completedAt',
    'failureCode'
  ], {
    attemptRunIds: projectPrimitiveArray,
    selectedInterface: (selected, nestedSecrets) => pick(
      selected,
      ['binding', 'version', 'endpointHash'],
      {},
      nestedSecrets
    )
  }, secrets);
}

function projectAbsoluteReview(value, secrets) {
  return pick(value, ['status', 'confidence'], {
    confidence: (confidence, nestedSecrets) => pick(
      confidence,
      ['status', 'value'],
      {},
      nestedSecrets
    )
  }, secrets);
}

function projectResultV2(value, secrets) {
  return pick(value, ['absolute', 'replica', 'rating'], {
    absolute: (item, nestedSecrets) => pick(item, ['status'], {}, nestedSecrets),
    replica: (item, nestedSecrets) => pick(item, ['status'], {}, nestedSecrets),
    rating: (item, nestedSecrets) => pick(
      item,
      ['status', 'code', 'label'],
      {},
      nestedSecrets
    )
  }, secrets);
}

function projectManifest(manifest, audience, secrets) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return {
    version: projectPrimitive(manifest?.version, secrets),
    items: items
      .flatMap((item) => {
        try {
          const canonical = validateEvidenceManifestItem(item);
          if (audience !== 'admin' && canonical.visibility !== 'public') return [];
          return [projectManifestItem(canonical, secrets)];
        } catch {
          return [];
        }
      })
  };
}

function projectManifestItem(item, secrets) {
  const fields = [
    'evidenceId', 'runId', 'grade', 'kind', 'testId', 'turnIndex', 'repeatIndex',
    'occurredAt'
  ];
  if (item?.visibility === 'public') fields.push('summary');
  fields.push('payloadHash', 'recordHash', 'visibility', 'redaction');
  return pick(item, fields, {
    redaction: (value, nestedSecrets) => pick(value, ['status', 'count'], {}, nestedSecrets)
  }, secrets);
}

function projectSubmissionMetadata(submission, secrets) {
  if (!submission || typeof submission !== 'object') return undefined;
  return {
    submissionVersion: projectPrimitive(submission.submissionVersion, secrets),
    frozenAt: projectPrimitive(submission.frozenAt, secrets),
    agentCard: pick(submission.agentCard, ['sha256'], {}, secrets),
    agentExamples: pick(submission.agentExamples, ['sha256'], {}, secrets),
    config: pick(submission.config, [
      'rubricVersion', 'modelConfigVersion', 'runtimeConfigVersion'
    ], {}, secrets)
  };
}

function projectAuditEvent(event, secrets) {
  return pick(event, ['id', 'type', 'occurredAt', 'summary'], {}, secrets);
}

function pickResult(value, fields = COMMON_RESULT_FIELDS, secrets = []) {
  return pick(value, fields, {
    attemptRunIds: projectPrimitiveArray,
    evidenceIds: projectPrimitiveArray,
    gaps: projectPrimitiveArray,
    dimensions: projectNamedResults,
    metrics: projectResultArray,
    checks: projectResultArray,
    findings: projectPrimitiveArray,
    uncertainties: projectPrimitiveArray,
    repairSuggestion: projectPrimitive
  }, secrets);
}

function projectNamedResults(value, secrets) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (DIMENSION_FIELDS.has(key)) result[key] = pickResult(child, COMMON_RESULT_FIELDS, secrets);
  }
  return result;
}

function projectResultArray(value, secrets) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => pickResult(item, COMMON_RESULT_FIELDS, secrets));
}

function projectPrimitiveArray(value, secrets) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => projectPrimitive(item, secrets))
    .filter((item) => item !== undefined);
}

function projectPrimitive(value, secrets = []) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return redactEvidence(value, secrets);
  return undefined;
}

function pick(source, fields, transforms = {}, secrets = []) {
  const result = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) continue;
    const value = transforms[field]
      ? transforms[field](source[field], secrets)
      : projectPrimitive(source[field], secrets);
    if (value !== undefined) result[field] = value;
  }
  return result;
}
