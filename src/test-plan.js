import { hashCanonical } from './submission.js';

const REQUIRED_VARIANTS = Object.freeze(['equivalent', 'boundary', 'multi-turn']);
const SCOPE_CHECKS = Object.freeze([
  'sameDomain',
  'declaredOrDemonstratedCapabilityOnly',
  'noExternalTruthDependency',
  'difficultyFromAllowedTransformation',
  'sameInputForAgentAndReplica'
]);

export const TEST_TIMING_POLICY_V1 = deepFreeze({
  // Match agent-check / Phase 1 formal max window (20 minutes).
  singleTurn: { targetMs: 45_000, timeoutMs: 1_200_000 },
  multiTurnPerTurn: { targetMs: 45_000, timeoutMs: 1_200_000 }
});

export function finalizeTestPlan(compilation, candidates, decisions, policy = {}) {
  if (!Array.isArray(compilation?.contracts) || compilation.contracts.length === 0) {
    throw new TypeError('compilation contracts are required');
  }
  if (!Array.isArray(candidates) || !Array.isArray(decisions)) {
    throw new TypeError('candidates and decisions must be arrays');
  }
  const decisionById = new Map();
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object' || decisionById.has(decision.candidateId)) {
      throw new TypeError('scope decisions must have unique candidate IDs');
    }
    decisionById.set(decision.candidateId, decision);
  }
  const approved = [];
  const rejected = [];
  for (const candidate of candidates) {
    validateCandidate(candidate, compilation);
    const decision = decisionById.get(candidate.candidateId);
    if (!decision) throw new TypeError(`missing scope decision for ${candidate.candidateId}`);
    const valid = isApprovedDecision(decision);
    (valid ? approved : rejected).push({
      candidate: structuredClone(candidate),
      decision: structuredClone(decision)
    });
  }

  const candidateBySlot = new Map(
    approved.map(({ candidate }) => [
      `${candidate.sourceExampleId}:${candidate.variantType}`,
      candidate
    ])
  );
  const complete = compilation.contracts.every((contract) =>
    REQUIRED_VARIANTS.every((variantType) =>
      candidateBySlot.has(`${contract.exampleId}:${variantType}`)
    )
  );
  const exampleWeight = 1 / compilation.contracts.length;
  const tests = [];
  for (const contract of compilation.contracts) {
    tests.push(buildOriginalTest(contract, exampleWeight / 4, policy));
    for (const variantType of REQUIRED_VARIANTS) {
      const candidate = candidateBySlot.get(`${contract.exampleId}:${variantType}`);
      if (candidate) {
        tests.push(buildHiddenTest(contract, candidate, exampleWeight / 4, policy));
      }
    }
  }
  tests.push(buildProtocolRecoveryProbe(policy));

  return deepFreeze({
    status: complete ? 'ready' : 'scope-incomplete',
    testPlanVersion: 'black-box-test-plan/v1',
    rubricVersion: compilation.rubricVersion,
    defaultRepeatCount: 3,
    generatedAt: requireString(policy.generatedAt, 'generatedAt'),
    generatorIdentity: requireString(policy.generatorIdentity, 'generatorIdentity'),
    scopeReviewerIdentity: requireString(
      policy.scopeReviewerIdentity,
      'scopeReviewerIdentity'
    ),
    timingPolicy: structuredClone(policy.timingPolicy || TEST_TIMING_POLICY_V1),
    tests,
    scopeAudit: { approved, rejected }
  });
}

function validateCandidate(candidate, compilation) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('hidden candidate must be an object');
  }
  requireString(candidate.candidateId, 'candidateId');
  const source = compilation.contracts.find(
    (contract) => contract.exampleId === candidate.sourceExampleId
  );
  if (!source) throw new TypeError('hidden candidate has an unknown source example');
  if (!REQUIRED_VARIANTS.includes(candidate.variantType)) {
    throw new TypeError('hidden candidate has an unsupported variant type');
  }
  if (!Array.isArray(candidate.turns) || candidate.turns.length === 0) {
    throw new TypeError('hidden candidate turns are required');
  }
  const expectedTimingClass = candidate.variantType === 'multi-turn'
    ? 'multiTurn'
    : 'singleTurn';
  if (
    candidate.variantType === 'multi-turn' &&
    candidate.turns.length < 2
  ) {
    throw new TypeError('multi-turn hidden candidates require at least two turns');
  }
  if (candidate.timingClass !== expectedTimingClass) {
    throw new TypeError(
      `hidden candidate timingClass must be ${expectedTimingClass}`
    );
  }
}

export function inputForTurn(test, turnIndex) {
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= test.turns.length) {
    throw new RangeError('turnIndex is outside the planned test');
  }
  return structuredClone(test.turns[turnIndex].input);
}

function buildOriginalTest(contract, weight, policy) {
  return buildTest({
    testId: `${safeSegment(contract.exampleId)}__original`,
    sourceExampleId: contract.exampleId,
    variantType: 'original',
    visibility: 'public',
    turns: contract.sourceTurns,
    criteria: flattenCriteria(contract.sourceTurns),
    weight,
    timingClass: contract.turnCount > 1 ? 'multiTurn' : 'singleTurn',
    scopeDecisionId: null
  }, policy);
}

function buildHiddenTest(contract, candidate, weight, policy) {
  const sourceCriteria = flattenCriteria(contract.sourceTurns);
  const inherited = new Set(candidate.inheritedCriteriaIds);
  return buildTest({
    testId: `${safeSegment(contract.exampleId)}__${safeSegment(candidate.variantType)}`,
    candidateId: candidate.candidateId,
    sourceExampleId: contract.exampleId,
    variantType: candidate.variantType,
    visibility: 'hidden',
    turns: candidate.turns,
    criteria: [
      ...sourceCriteria.filter((criterion) => inherited.has(criterion.id)),
      ...structuredClone(candidate.proposedCriteria)
    ],
    weight,
    timingClass: candidate.timingClass,
    scopeDecisionId: candidate.candidateId
  }, policy);
}

function buildProtocolRecoveryProbe(policy) {
  return buildTest({
    testId: 'protocol_error_recovery',
    sourceExampleId: null,
    variantType: 'protocol-recovery',
    visibility: 'hidden',
    turns: [{
      input: { parts: [{ type: 'text', text: 'protocol-recovery-probe' }] }
    }],
    criteria: [],
    weight: 0,
    timingClass: 'singleTurn',
    scopeDecisionId: null,
    protocolProbe: {
      malformedFirst: true,
      nextValidInputUsesFreshContext: true
    }
  }, policy);
}

function buildTest(input, policy) {
  const timingPolicy = policy.timingPolicy || TEST_TIMING_POLICY_V1;
  const timing = input.timingClass === 'multiTurn'
    ? timingPolicy.multiTurnPerTurn
    : timingPolicy.singleTurn;
  return {
    ...structuredClone(input),
    contextPolicy: input.timingClass === 'multiTurn' ? 'reuse-within-example' : 'fresh',
    repeatCount: 3,
    timing: structuredClone(timing),
    normalizedInputHash: hashCanonical(input.turns.map((turn) => turn.input))
  };
}

function flattenCriteria(turns) {
  return turns.flatMap((turn) => structuredClone(turn.acceptanceCriteria || []));
}

function isApprovedDecision(decision) {
  if (!decision.checks || typeof decision.checks !== 'object') return false;
  return decision.approved === true
    && SCOPE_CHECKS.every((check) => decision.checks[check] === true);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function safeSegment(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9_-]/gu, '_');
  return /^[A-Za-z0-9]/u.test(normalized) ? normalized : `id_${normalized}`;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
