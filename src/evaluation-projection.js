const COMMON_RESULT_FIELDS = [
  'status', 'stage', 'progress', 'score', 'confidence', 'coverage', 'provisional',
  'reason', 'startedAt', 'completedAt', 'failedAt', 'cancelledAt', 'interruptedAt',
  'attemptRunIds', 'evidenceIds', 'gaps', 'dimensions', 'metrics', 'checks',
  'findings', 'uncertainties', 'repairSuggestion'
];

export function projectEvaluation(evaluation, { audience = 'public' } = {}) {
  if (audience !== 'public' && audience !== 'admin') {
    throw new TypeError('unsupported evaluation projection audience');
  }
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    throw new TypeError('evaluation must be an object');
  }

  const projection = {
    schemaVersion: evaluation.schemaVersion,
    id: evaluation.id,
    createdAt: evaluation.createdAt,
    updatedAt: evaluation.updatedAt,
    revision: evaluation.revision,
    execution: pickResult(evaluation.execution, [
      'status', 'stage', 'progress', 'startedAt', 'completedAt', 'failedAt',
      'cancelledAt', 'interruptedAt'
    ]),
    governance: pickResult(evaluation.governance, [
      'phase', 'modelLockedAt', 'humanLockedAt', 'absoluteLockedAt',
      'replicaReleasedAt'
    ]),
    qualification: pickResult(evaluation.qualification, [
      'status', 'attemptRunIds', 'completedAt', 'failureCode'
    ]),
    evidenceManifest: projectManifest(evaluation.evidenceManifest, audience),
    objectiveCapability: pickResult(evaluation.objectiveCapability),
    absoluteReview: pickResult(evaluation.absoluteReview),
    resultV2: evaluation.resultV2 === null ? null : pickResult(evaluation.resultV2)
  };
  if (evaluation.archivedAt !== undefined) projection.archivedAt = evaluation.archivedAt;

  if (audience === 'admin') {
    projection.submission = projectSubmissionMetadata(evaluation.submission);
    projection.auditEvents = (Array.isArray(evaluation.auditEvents) ? evaluation.auditEvents : [])
      .map(projectAuditEvent);
  }
  return projection;
}

function projectManifest(manifest, audience) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return {
    version: manifest?.version,
    items: items
      .filter((item) => audience === 'admin' || item?.visibility === 'public')
      .map(projectManifestItem)
  };
}

function projectManifestItem(item) {
  return pick(item, [
    'evidenceId', 'runId', 'grade', 'kind', 'testId', 'turnIndex', 'repeatIndex',
    'occurredAt', 'summary', 'payloadHash', 'visibility', 'redaction'
  ], {
    redaction: (value) => pick(value, ['status', 'count'])
  });
}

function projectSubmissionMetadata(submission) {
  if (!submission || typeof submission !== 'object') return undefined;
  return {
    submissionVersion: submission.submissionVersion,
    frozenAt: submission.frozenAt,
    agentCard: pick(submission.agentCard, ['sha256']),
    agentExamples: pick(submission.agentExamples, ['sha256']),
    config: pick(submission.config, [
      'rubricVersion', 'modelConfigVersion', 'runtimeConfigVersion'
    ])
  };
}

function projectAuditEvent(event) {
  return pick(event, ['id', 'type', 'occurredAt', 'summary']);
}

function pickResult(value, fields = COMMON_RESULT_FIELDS) {
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
  });
}

function projectNamedResults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)) result[key] = pickResult(child);
  }
  return result;
}

function projectResultArray(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => pickResult(item));
}

function projectPrimitiveArray(value) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
}

function projectPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? value
    : undefined;
}

function pick(source, fields, transforms = {}) {
  const result = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) continue;
    const value = transforms[field] ? transforms[field](source[field]) : projectPrimitive(source[field]);
    if (value !== undefined) result[field] = value;
  }
  return result;
}
