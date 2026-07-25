const CONTROL_PROBES = [
  ['scheduler', 'scheduler control probe failed'],
  ['evidenceStore', 'evidence-store control probe failed'],
  ['organizerEndpoint', 'organizer control-endpoint probe failed']
];

export function attributeFailure(probes) {
  if (!probes || typeof probes !== 'object') {
    throw new TypeError('failure probes are required');
  }
  const evidenceIds = Object.values(probes)
    .filter((probe) => probe && typeof probe.evidenceId === 'string')
    .map((probe) => probe.evidenceId);
  const failedControl = CONTROL_PROBES.find(([key]) => probes[key]?.ok === false);
  if (failedControl) {
    return {
      attribution: 'platform',
      reasons: [failedControl[1]],
      evidenceIds
    };
  }
  if (probes.unrelatedAgentHealth?.ok === false) {
    return {
      attribution: 'platform',
      reasons: ['contemporaneous unrelated Agent health probe failed'],
      evidenceIds
    };
  }
  if (probes.subject === 'replica') {
    return {
      attribution: 'replica',
      reasons: ['Replica Skill failure is not a platform replacement basis'],
      evidenceIds
    };
  }
  const repeatedTargetFailure = probes.independentWorker?.ok === false &&
    probes.independentWorker?.targetFailed === true &&
    probes.independentWorker?.attempts >= 2 &&
    probes.targetFailures >= 2;
  if (repeatedTargetFailure) {
    return {
      attribution: 'agent',
      reasons: ['controls passed while the target Agent repeatedly failed'],
      evidenceIds
    };
  }
  return {
    attribution: 'pending',
    reasons: ['failure attribution is inconclusive'],
    evidenceIds
  };
}
