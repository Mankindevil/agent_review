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

export function projectEvaluation(evaluation, { audience = 'public', principal = null, secrets = [] } = {}) {
  if (!['public', 'participant', 'judge', 'admin', 'judge-preview'].includes(audience)) {
    throw new TypeError('unsupported evaluation projection audience');
  }
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    throw new TypeError('evaluation must be an object');
  }
  assertAudiencePrincipal(audience, principal);

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
      'resultHash', 'replicaReleasedAt'
    ], secrets),
    qualification: projectQualification(evaluation.qualification, secrets),
    evidenceManifest: projectManifest(
      evaluation.evidenceManifest,
      audience,
      secrets
    ),
    objectiveCapability: pickResult(evaluation.objectiveCapability, COMMON_RESULT_FIELDS, secrets),
    absoluteReview: projectAbsoluteReview(
      evaluation.absoluteReview,
      secrets,
      audience === 'judge' || audience === 'judge-preview'
    ),
    resultV2: evaluation.resultV2 === null
      ? null
      : projectResultV2(
          evaluation.resultV2,
          secrets,
          false,
          evaluation.replicaArena,
          evaluation.governance
        )
  };
  if (evaluation.archivedAt !== undefined) {
    projection.archivedAt = projectPrimitive(evaluation.archivedAt, secrets);
  }

  if (audience === 'admin') {
    projection.submission = projectSubmissionMetadata(evaluation.submission, secrets);
    projection.auditEvents = (Array.isArray(evaluation.auditEvents) ? evaluation.auditEvents : [])
      .map((event) => projectAuditEvent(event, secrets));
  } else if (audience === 'judge' || audience === 'judge-preview') {
    projection.submission = projectJudgeSubmission(evaluation.submission, secrets);
  } else if (audience === 'participant') {
    projection.submission = projectSubmissionMetadata(evaluation.submission, secrets);
  }
  return projection;
}

function assertAudiencePrincipal(audience, principal) {
  if (audience === 'public' || audience === 'judge-preview') return;
  const expected = audience === 'participant' ? 'participant' : audience;
  if (!principal || principal.role !== expected) {
    throw new TypeError(`unsupported audience principal role for ${audience} projection`);
  }
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

function projectAbsoluteReview(value, secrets, includeModelPanel = false) {
  return pick(value, includeModelPanel
    ? ['status', 'confidence', 'modelPanel']
    : ['status', 'confidence'], {
    confidence: (confidence, nestedSecrets) => pick(
      confidence,
      ['status', 'value'],
      {},
      nestedSecrets
    ),
    modelPanel: projectModelPanel
  }, secrets);
}

function projectResultV2(
  value,
  secrets,
  omitReplica = false,
  replicaArena = null,
  governance = null
) {
  const replicaStatus = value?.replica?.status || replicaArena?.status;
  const absoluteLocked = hasAbsoluteLock(governance, value?.absolute);
  const releaseAllowed = absoluteLocked &&
    replicaStatus === 'released' &&
    typeof governance?.replicaReleasedAt === 'string';
  const staleRelease = replicaStatus === 'released' && !releaseAllowed;
  return pick(value, omitReplica
    ? ['absolute', 'rating']
    : ['absolute', 'replica', 'rating'], {
    absolute: (item, nestedSecrets) => pick(
      item,
      [
        'status', 'total', 'dimensions', 'confidence', 'resultHash',
        'testSummary', 'modelReviewSummary'
      ],
      {
        dimensions: projectLockedDimensions,
        testSummary: projectTestSummary,
        modelReviewSummary: projectModelReviewSummary
      },
      nestedSecrets
    ),
    replica: (item, nestedSecrets) => projectReplica(
      item,
      replicaArena,
      nestedSecrets,
      releaseAllowed,
      staleRelease
    ),
    rating: (item, nestedSecrets) => staleRelease
      ? { status: 'sealed' }
      : pick(item, ['status', 'code', 'label', 'differenceStable'], {}, nestedSecrets)
  }, secrets);
}

function projectLockedDimensions(value, secrets) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(['scenarioValue', 'professionalism', 'agentCapability']
    .flatMap((key) => {
      const projected = pick(value[key], [
        'score', 'confidence', 'objectiveCoverage', 'provisional'
      ], {}, secrets);
      return Object.keys(projected).length ? [[key, projected]] : [];
    }));
}

function projectReplica(value, replicaArena, secrets, releaseAllowed, staleRelease) {
  const status = projectPrimitive(value?.status || replicaArena?.status, secrets);
  if (status === 'released' && releaseAllowed) {
    return pick(value, [
      'status', 'submittedMedian', 'runtimes', 'bestBaseline', 'delta',
      'conservativeDelta', 'ci95', 'differenceStable'
    ], {
      runtimes: projectReplicaRuntimes,
      bestBaseline: projectReplicaBaseline,
      ci95: projectReplicaInterval
    }, secrets);
  }
  if (staleRelease) {
    const summaries = Array.isArray(replicaArena?.runtimeSummaries)
      ? replicaArena.runtimeSummaries
      : [];
    return {
      status: 'sealed',
      validReplicaCount: summaries.filter((item) => item?.validity === 'valid').length,
      pendingAttributionCount: summaries.filter(
        (item) => item?.validity === 'attribution-pending'
      ).length
    };
  }
  if (status !== 'sealed') return status === undefined ? undefined : { status };
  const summaries = Array.isArray(replicaArena?.runtimeSummaries)
    ? replicaArena.runtimeSummaries
    : [];
  return {
    status: 'sealed',
    validReplicaCount: summaries.filter((item) => item?.validity === 'valid').length,
    pendingAttributionCount: summaries.filter(
      (item) => item?.validity === 'attribution-pending'
    ).length
  };
}

function hasAbsoluteLock(governance, absolute) {
  return ['absolute_locked', 'replica_released', 'final'].includes(governance?.phase) &&
    typeof governance.absoluteLockedAt === 'string' &&
    /^[a-f0-9]{64}$/u.test(governance.resultHash || '') &&
    absolute?.status === 'locked' &&
    absolute.resultHash === governance.resultHash;
}

function projectReplicaRuntimes(value, secrets) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => pick(item, [
    'runtimeId', 'valid', 'median'
  ], {}, secrets));
}

function projectReplicaBaseline(value, secrets) {
  return pick(value, ['runtimeId', 'median'], {}, secrets);
}

function projectReplicaInterval(value, secrets) {
  return pick(value, ['confidenceLevel', 'low', 'high'], {}, secrets);
}

function projectTestSummary(value, secrets) {
  return pick(value, [
    'totalTests', 'repeatCount', 'plannedCells', 'completedCells',
    'variantCounts'
  ], {
    variantCounts: (counts, nestedSecrets) => pick(counts, [
      'original', 'equivalent', 'boundary', 'multiTurn', 'protocolRecovery'
    ], {}, nestedSecrets)
  }, secrets);
}

function projectModelReviewSummary(value, secrets) {
  return pick(value, [
    'primarySeatsLocked', 'arbitrationStatus'
  ], {}, secrets);
}

function projectJudgeSubmission(submission, secrets) {
  const metadata = projectSubmissionMetadata(submission, secrets);
  if (!metadata) return undefined;
  metadata.agentCard.value = projectAgentCard(
    submission.agentCard?.value,
    secrets
  );
  metadata.agentExamples.value = redactEvidence(
    structuredClone(submission.agentExamples?.value || []),
    secrets
  );
  return metadata;
}

function projectAgentCard(card, secrets) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return {};
  const safe = {};
  for (const field of [
    'name', 'description', 'version', 'capabilities',
    'defaultInputModes', 'defaultOutputModes', 'skills'
  ]) {
    if (Object.hasOwn(card, field)) {
      safe[field] = redactEvidence(structuredClone(card[field]), secrets);
    }
  }
  return safe;
}

function projectModelPanel(panel, secrets) {
  return pick(panel, [
    'status', 'dimensions', 'primary', 'arbitration',
    'disputedSubcriterionIds'
  ], {
    dimensions: projectPanelDimensions,
    primary: projectPanelRuns,
    arbitration: projectPanelRun,
    disputedSubcriterionIds: projectPrimitiveArray
  }, secrets);
}

function projectPanelDimensions(value, secrets) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const projected = pick(item, ['score'], {}, secrets);
    return Object.keys(projected).length ? [[key, projected]] : [];
  }));
}

function projectPanelRuns(value, secrets) {
  if (!Array.isArray(value)) return undefined;
  return value.map((run) => projectPanelRun(run, secrets));
}

function projectPanelRun(value, secrets) {
  if (value === null) return null;
  return pick(value, ['reviewRunId', 'reviews'], {
    reviews: projectPanelReviews
  }, secrets);
}

function projectPanelReviews(value, secrets) {
  if (!Array.isArray(value)) return undefined;
  return value.map((review) => pick(review, [
    'subcriterionId', 'score', 'confidence', 'evidenceIds',
    'checkEvidence', 'findings', 'counterEvidence', 'uncertainties',
    'repairSuggestion', 'conclusions'
  ], {
    evidenceIds: projectPrimitiveArray,
    checkEvidence: projectCheckEvidence,
    findings: projectFindings,
    counterEvidence: projectFindings,
    uncertainties: projectPrimitiveArray,
    conclusions: projectConclusions
  }, secrets));
}

function projectCheckEvidence(value, secrets) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => pick(item, ['checkId', 'evidenceIds'], {
    evidenceIds: projectPrimitiveArray
  }, secrets));
}

function projectFindings(value, secrets) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => pick(
    item,
    ['findingId', 'text', 'evidenceIds'],
    { evidenceIds: projectPrimitiveArray },
    secrets
  ));
}

function projectConclusions(value, secrets) {
  return pick(value, ['taskCompleted', 'criticalRisk'], {}, secrets);
}

function projectManifest(manifest, audience, secrets) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return {
    version: projectPrimitive(manifest?.version, secrets),
    items: items
      .flatMap((item) => {
        try {
          const canonical = validateEvidenceManifestItem(item);
          if (!canReadManifestItem(canonical, audience)) return [];
          return [projectManifestItem(canonical, secrets)];
        } catch {
          return [];
        }
      })
  };
}

function canReadManifestItem(item, audience) {
  if (audience === 'admin') return true;
  if (audience === 'public') return item.visibility === 'public';
  if (isReplicaManifestItem(item)) return false;
  return audience === 'participant' || audience === 'judge' || audience === 'judge-preview';
}

function isReplicaManifestItem(item) {
  return /(?:replica|runtime|arena)/iu.test([
    item.evidenceId,
    item.runId,
    item.kind,
    item.testId
  ].join(':'));
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

export function assertNoReplicaLeak(value) {
  assertNoForbiddenShape(value, /^(?:replicaArena|anonymousMapping|encryptedRevealMap|revealMap|scoreCube|replicaLogs|runtimeIdentity|runtimeName)$/iu, 'Replica');
}

export function assertNoSecretShape(value) {
  assertNoForbiddenShape(value, /(?:authorization|credential|password|secret|token|cookie|private|rawEvidence|signedUrl)/iu, 'secret');
}

export function projectEvidenceRecord(record, manifestItem, secrets = []) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('evidence record must be an object');
  }
  const manifest = validateEvidenceManifestItem(manifestItem);
  if (
    record.evidenceId !== manifest.evidenceId ||
    record.recordHash !== manifest.recordHash ||
    record.payloadHash !== manifest.payloadHash
  ) {
    throw new TypeError('evidence record does not match projected manifest commitment');
  }
  return {
    evidenceId: manifest.evidenceId,
    runId: manifest.runId,
    grade: manifest.grade,
    kind: manifest.kind,
    testId: manifest.testId,
    turnIndex: manifest.turnIndex,
    repeatIndex: manifest.repeatIndex,
    occurredAt: manifest.occurredAt,
    summary: manifest.summary,
    payloadHash: manifest.payloadHash,
    recordHash: manifest.recordHash,
    redaction: manifest.redaction,
    payload: redactEvidence(structuredClone(record.payload), secrets)
  };
}

function assertNoForbiddenShape(value, forbiddenKey, label) {
  const visit = (current) => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (forbiddenKey.test(key)) throw new Error(`${label} shape leaked: ${key}`);
      visit(child);
    }
  };
  visit(value);
  return value;
}
