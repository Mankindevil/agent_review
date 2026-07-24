export const CONTRACT_VERSIONS = Object.freeze({
  store: '1.0',
  evaluation: '2.0',
  submission: '1.0',
  evidence: '1.0',
  rubric: 'a2a-black-box-v1'
});

export function createEvaluationRecord(snapshot, options) {
  return {
    schemaVersion: 2,
    id: options.id,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
    execution: { status: 'queued', stage: 'qualification', progress: 0 },
    governance: { phase: 'waiting_model' },
    submission: snapshot,
    participantAccess: options.participantAccess,
    connection: { authorizationRequired: options.authorizationRequired },
    resumeReceipts: [],
    runtimeState: {
      version: 'phase1-runtime/v1',
      endpointHash: options.endpointHash,
      agentVersion: options.agentVersion ?? null,
      serviceBuildId: options.serviceBuildId ?? null,
      responseFingerprints: [],
      runIndex: options.runIndex
    },
    evaluationWindow: { firstRunAt: null, lastRunAt: null },
    qualification: { status: 'pending', attemptRunIds: [] },
    evidenceManifest: { version: '1.0', items: [] },
    objectiveCapability: { status: 'pending' },
    absoluteReview: { status: 'pending-model-review' },
    replicaArena: { status: 'disabled' },
    resultV2: null,
    revision: 0,
    auditEvents: []
  };
}

export function migrateStoredEvaluation(raw) {
  if (!Array.isArray(raw)) throw new TypeError('Stored evaluations must be an array');
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Stored evaluation entries must be objects');
    }
    if (entry.schemaVersion !== undefined) return { ...entry };
    return { ...entry, schemaVersion: 1 };
  });
}
