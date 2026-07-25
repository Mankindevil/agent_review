import {
  hiddenScopeReviewPrompt,
  hiddenVariantGenerationPrompt
} from './prompts.js';
import {
  normalizeAgentExamples,
  SUBMISSION_LIMITS
} from './submission.js';

const VARIANT_TYPES = Object.freeze(['equivalent', 'boundary', 'multi-turn']);
const SCOPE_CHECKS = Object.freeze([
  'sameDomain',
  'declaredOrDemonstratedCapabilityOnly',
  'noExternalTruthDependency',
  'difficultyFromAllowedTransformation',
  'sameInputForAgentAndReplica'
]);
const EXTERNAL_TRUTH_PATTERN =
  /\b(?:current|latest|today(?:'s)?|live)\s+(?:market|price|quote|rate)|external\s+(?:truth|answer|fact)/iu;

export function reviewerIdentityKey(reviewer) {
  if (!reviewer || typeof reviewer !== 'object') {
    throw new TypeError('reviewer identity is required');
  }
  const kind = requireString(reviewer.kind, 'reviewer.kind');
  const model = requireString(reviewer.model, 'reviewer.model');
  let host;
  try {
    host = new URL(requireString(reviewer.baseUrl, 'reviewer.baseUrl')).host.toLowerCase();
  } catch {
    throw new TypeError('reviewer.baseUrl must be an absolute URL');
  }
  return `${kind}:${host}:${model}`;
}

export async function generateHiddenVariants(compilation, {
  generator,
  requestJson,
  requiredVariants = VARIANT_TYPES
}) {
  reviewerIdentityKey(generator);
  if (typeof requestJson !== 'function') throw new TypeError('requestJson is required');
  const required = Object.freeze([...requiredVariants]);
  const value = await requestJson(
    generator,
    'Generate closed-scope hidden tests. Return one JSON object only. '
      + 'Copy sourceExampleId and inheritedCriteriaIds verbatim from ALLOWED_SLOTS. '
      + 'Never invent criterion ids.',
    hiddenVariantGenerationPrompt(compilation)
  );
  if (!isPlainObject(value) || !Array.isArray(value.candidates)) {
    throw new TypeError('generator response must contain candidates');
  }

  const candidates = value.candidates
    .map((candidate, index) => normalizeCandidate(compilation, candidate, index))
    .filter((candidate) => required.includes(candidate.variantType));
  assertRequiredSlots(compilation, candidates, required);
  return deepFreeze({
    generatorIdentity: reviewerIdentityKey(generator),
    candidates
  });
}

export async function reviewHiddenVariantScopes(compilation, candidates, {
  generator,
  scopeReviewer,
  requestJson
}) {
  const generatorIdentity = reviewerIdentityKey(generator);
  const scopeReviewerIdentity = reviewerIdentityKey(scopeReviewer);
  if (generatorIdentity === scopeReviewerIdentity) {
    throw new TypeError('generator and scope reviewer must use distinct model identities');
  }
  if (typeof requestJson !== 'function') throw new TypeError('requestJson is required');
  const normalizedCandidates = candidates.map((candidate, index) =>
    normalizeCandidate(compilation, candidate, index)
  );
  const value = await requestJson(
    scopeReviewer,
    'Independently enforce the closed test scope. JSON only.',
    hiddenScopeReviewPrompt(compilation, normalizedCandidates)
  );
  if (!isPlainObject(value) || !Array.isArray(value.decisions)) {
    throw new TypeError('scope response must contain decisions');
  }
  if (value.decisions.length !== normalizedCandidates.length) {
    throw new TypeError('scope response must decide every candidate exactly once');
  }

  const expected = new Set(normalizedCandidates.map((candidate) => candidate.candidateId));
  const seen = new Set();
  const decisions = value.decisions.map((decision, index) => {
    if (!isPlainObject(decision)) throw new TypeError(`decision ${index} must be an object`);
    const candidateId = requireString(decision.candidateId, `decision ${index} candidateId`);
    if (!expected.has(candidateId) || seen.has(candidateId)) {
      throw new TypeError('scope decision has an unknown or duplicate candidate');
    }
    seen.add(candidateId);
    if (!isPlainObject(decision.checks)) throw new TypeError('scope decision checks are required');
    if (
      Object.keys(decision.checks).sort().join('|') !==
      [...SCOPE_CHECKS].sort().join('|')
    ) {
      throw new TypeError('scope decision must contain exactly five checks');
    }
    const checks = {};
    for (const key of SCOPE_CHECKS) {
      if (typeof decision.checks[key] !== 'boolean') {
        throw new TypeError(`scope check ${key} must be boolean`);
      }
      checks[key] = decision.checks[key];
    }
    const reasons = normalizeStringArray(decision.reasons || [], 'decision reasons');
    return {
      candidateId,
      checks,
      approved: SCOPE_CHECKS.every((key) => checks[key] === true),
      reasons
    };
  });
  return deepFreeze({
    generatorIdentity,
    scopeReviewerIdentity,
    decisions
  });
}

function normalizeCandidate(compilation, candidate, index) {
  if (!isPlainObject(candidate)) throw new TypeError(`candidate ${index} must be an object`);
  const sourceExampleId = requireString(
    candidate.sourceExampleId ?? candidate.source_example_id,
    `candidate ${index} sourceExampleId`
  );
  const candidateId = resolveCandidateId(candidate, sourceExampleId, index);
  const source = compilation.contracts?.find(
    (contract) => contract.exampleId === sourceExampleId
  );
  if (!source) throw new TypeError(`candidate ${candidateId} has an unknown source example`);
  const variantType = candidate.variantType ?? candidate.variant_type;
  if (!VARIANT_TYPES.includes(variantType)) {
    throw new TypeError(`candidate ${candidateId} has an unsupported variant type`);
  }
  if (!Array.isArray(candidate.turns) || candidate.turns.length === 0) {
    throw new TypeError(`candidate ${candidateId} turns are required`);
  }
  if (variantType === 'multi-turn' && candidate.turns.length < 2) {
    throw new TypeError(`candidate ${candidateId} multi-turn variants require at least two turns`);
  }
  const turns = normalizeHiddenTurns(candidate.turns, candidateId);
  assertCandidateUrls(source, turns);
  const knownCriteria = new Set([
    ...source.executableCriteria.map((criterion) => criterion.criterionId),
    ...source.modelCriteria.map((criterion) => criterion.criterionId)
  ]);
  // Live generators often invent criterion ids; keep only ids that exist on the
  // closed source contract instead of aborting the whole evaluation.
  const inheritedCriteriaIds = normalizeStringArray(
    candidate.inheritedCriteriaIds || candidate.inherited_criteria_ids || [],
    `candidate ${candidateId} inheritedCriteriaIds`
  ).filter((id) => knownCriteria.has(id));
  const rawProposed =
    candidate.proposedCriteria ?? candidate.proposed_criteria ?? [];
  if (!Array.isArray(rawProposed)) {
    throw new TypeError(`candidate ${candidateId} proposedCriteria must be an array`);
  }
  const proposedCriteria = normalizeProposedCriteria(rawProposed, candidateId);
  const candidatePayload = { turns, proposedCriteria };
  if (
    Buffer.byteLength(JSON.stringify(candidatePayload), 'utf8') >
      SUBMISSION_LIMITS.totalCanonicalBytes
  ) {
    throw new RangeError(
      `candidate ${candidateId} exceeds total canonical bytes limit`
    );
  }
  if (EXTERNAL_TRUTH_PATTERN.test(JSON.stringify(candidatePayload))) {
    throw new TypeError(`candidate ${candidateId} introduces external truth`);
  }
  const timingClass = candidate.timingClass ?? candidate.timing_class;
  if (!['singleTurn', 'multiTurn'].includes(timingClass)) {
    throw new TypeError(`candidate ${candidateId} has an invalid timingClass`);
  }
  const expectedTimingClass = variantType === 'multi-turn'
    ? 'multiTurn'
    : 'singleTurn';
  if (timingClass !== expectedTimingClass) {
    throw new TypeError(
      `candidate ${candidateId} timingClass must be ${expectedTimingClass}`
    );
  }
  return {
    candidateId,
    sourceExampleId,
    variantType,
    changeSummary: requireString(
      candidate.changeSummary ?? candidate.change_summary,
      `candidate ${candidateId} changeSummary`
    ),
    turns,
    inheritedCriteriaIds,
    proposedCriteria,
    timingClass
  };
}

function normalizeHiddenTurns(turns, candidateId) {
  const [normalized] = normalizeAgentExamples([{
    id: 'hidden-candidate',
    name: 'Hidden candidate',
    turns
  }]);
  return structuredClone(normalized.turns);
}

function normalizeProposedCriteria(criteria, candidateId) {
  if (!Array.isArray(criteria)) {
    throw new TypeError(`candidate ${candidateId} proposedCriteria must be an array`);
  }
  if (criteria.some((criterion) => criterion?.type !== 'model')) {
    throw new TypeError(
      `candidate ${candidateId} proposed criteria may only add non-executable model checks`
    );
  }
  const [normalized] = normalizeAgentExamples([{
    id: 'hidden-criteria',
    name: 'Hidden criteria',
    turns: [{
      input: { parts: [{ type: 'text', text: 'schema validation sentinel' }] },
      acceptanceCriteria: criteria
    }]
  }]);
  return structuredClone(normalized.turns[0].acceptanceCriteria);
}

function assertRequiredSlots(compilation, candidates, requiredVariants = VARIANT_TYPES) {
  const expected = new Set(
    compilation.contracts.flatMap((contract) =>
      requiredVariants.map((variantType) => `${contract.exampleId}:${variantType}`)
    )
  );
  const actual = new Set();
  for (const candidate of candidates) {
    const slot = `${candidate.sourceExampleId}:${candidate.variantType}`;
    if (actual.has(slot)) throw new TypeError(`duplicate hidden candidate slot: ${slot}`);
    actual.add(slot);
  }
  if (actual.size !== expected.size || [...expected].some((slot) => !actual.has(slot))) {
    throw new TypeError('generator must fill every required hidden candidate slot');
  }
}

function assertCandidateUrls(source, turns) {
  const allowed = new Set(collectUrls(source.sourceTurns || []));
  for (const url of collectUrls(turns)) {
    if (!allowed.has(url)) throw new TypeError('candidate introduces a new URL outside source scope');
  }
}

function collectUrls(value) {
  if (Array.isArray(value)) return value.flatMap(collectUrls);
  if (!isPlainObject(value)) return [];
  const own = value.type === 'url' && typeof value.url === 'string' ? [value.url] : [];
  return own.concat(Object.values(value).flatMap(collectUrls));
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item) => requireString(item, field));
}

function resolveCandidateId(candidate, sourceExampleId, index) {
  const raw =
    candidate.candidateId ??
    candidate.candidate_id ??
    candidate.id;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  const variantType = typeof candidate.variantType === 'string'
    ? candidate.variantType.trim()
    : typeof candidate.variant_type === 'string'
      ? candidate.variant_type.trim()
      : '';
  if (!VARIANT_TYPES.includes(variantType)) {
    throw new TypeError(`candidate ${index} candidateId must be a non-empty string`);
  }
  return `${sourceExampleId}_${variantType.replace(/-/g, '_')}_${index}`;
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
