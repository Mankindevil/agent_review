const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const EVIDENCE_VALUES = Object.freeze({
  A: 1,
  B: 0.8,
  C: 0.35,
  D: 0.1
});
const CONFIDENCE_STATUSES = new Set([
  'complete',
  'pending-model-review',
  'pending-human-review',
  'unavailable'
]);
const STATUS_PRIORITY = Object.freeze({
  complete: 0,
  unavailable: 1,
  'pending-human-review': 2,
  'pending-model-review': 3
});
const DIMENSION_IDS = Object.freeze([
  'scenarioValue',
  'professionalism',
  'agentCapability'
]);

export function computeSubcriterionConfidence(input) {
  assertClosedObject(input, new Set([
    'stage',
    'checks',
    'modelScores',
    'humanScores',
    'modelConfidences'
  ]), 'subcriterion confidence input');
  assertRequiredFields(input, [
    'stage',
    'checks',
    'modelScores',
    'humanScores',
    'modelConfidences'
  ], 'subcriterion confidence input');
  if (!['model', 'final'].includes(input.stage)) {
    throw new TypeError('confidence stage must be model or final');
  }

  const checks = normalizeEvidenceChecks(input.checks);
  const modelScores = numericSample(input.modelScores, 0, 100, 'modelScores');
  const humanScores = numericSample(input.humanScores, 0, 100, 'humanScores');
  const modelConfidences = numericSample(
    input.modelConfidences,
    0,
    1,
    'modelConfidences'
  );
  if (modelScores.length !== modelConfidences.length) {
    throw new TypeError('modelScores and modelConfidences must have equal length');
  }
  if (modelScores.length === 0) {
    return { status: 'pending-model-review', value: null };
  }
  if (input.stage === 'final' && humanScores.length === 0) {
    return { status: 'pending-human-review', value: null };
  }

  const evidenceStrength = mean(checks.map((check) =>
    check.evidenceGrades.reduce(
      (highest, grade) => Math.max(highest, EVIDENCE_VALUES[grade]),
      0
    )
  ));
  const modelAgreement = 1 - Math.min(
    1,
    (quantile(modelScores, 0.75) - quantile(modelScores, 0.25)) / 30
  );
  const humanAgreement = input.stage === 'final'
    ? 1 - Math.min(1, (Math.max(...humanScores) - Math.min(...humanScores)) / 30)
    : null;
  const agreement = input.stage === 'model'
    ? modelAgreement
    : 0.6 * modelAgreement + 0.4 * humanAgreement;
  const reviewerConfidence = quantile(modelConfidences, 0.5);
  const value = 0.5 * evidenceStrength +
    0.3 * agreement +
    0.2 * reviewerConfidence;

  return {
    status: 'complete',
    value,
    components: {
      evidenceStrength,
      modelAgreement,
      ...(humanAgreement === null ? {} : { humanAgreement }),
      agreement,
      reviewerConfidence
    }
  };
}

export function computeDimensionConfidence(items) {
  if (!Array.isArray(items)) throw new TypeError('dimension items must be an array');
  const ids = new Set();
  const normalized = items.map((item, index) => {
    const path = `dimension items[${index}]`;
    assertClosedObject(item, new Set([
      'id', 'weight', 'applicable', 'confidence'
    ]), path);
    assertRequiredFields(item, [
      'id', 'weight', 'applicable', 'confidence'
    ], path);
    assertSafeId(item.id, `${path}.id`);
    if (ids.has(item.id)) throw new TypeError(`duplicate dimension item id: ${item.id}`);
    ids.add(item.id);
    requireNonNegativeFinite(item.weight, `${path}.weight`);
    if (typeof item.applicable !== 'boolean') {
      throw new TypeError(`${path}.applicable must be boolean`);
    }
    const confidence = normalizeTaggedConfidence(item.confidence, `${path}.confidence`);
    return {
      id: item.id,
      weight: item.weight,
      applicable: item.applicable,
      confidence
    };
  });
  const applicable = normalized.filter((item) => item.applicable);
  if (applicable.length === 0) return { status: 'unavailable', value: null };
  const status = highestPriorityStatus(
    applicable.map((item) => item.confidence.status)
  );
  if (status !== 'complete') {
    return { status, value: null };
  }
  const totalWeight = applicable.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return { status: 'unavailable', value: null };
  const value = applicable.reduce(
    (sum, item) => sum + item.weight * item.confidence.value,
    0
  ) / totalWeight;
  return { status: 'complete', value };
}

export function computeTotalConfidence(dimensions) {
  if (!isPlainObject(dimensions)) {
    throw new TypeError('dimensions must be a named object');
  }
  for (const key of Object.keys(dimensions)) {
    if (!DIMENSION_IDS.includes(key)) {
      throw new TypeError(`unknown confidence dimension: ${key}`);
    }
  }
  const confidences = [];
  for (const id of DIMENSION_IDS) {
    if (!Object.hasOwn(dimensions, id)) {
      confidences.push({ status: 'unavailable', value: null });
      continue;
    }
    confidences.push(normalizeTaggedConfidence(
      dimensions[id],
      `dimensions.${id}`
    ));
  }
  const status = highestPriorityStatus(
    confidences.map((confidence) => confidence.status)
  );
  if (status !== 'complete') {
    return { status, value: null };
  }
  const values = confidences.map((confidence) => confidence.value);
  return {
    status: 'complete',
    value: Math.cbrt(values[0] * values[1] * values[2])
  };
}

function normalizeEvidenceChecks(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('confidence checks must be a non-empty array');
  }
  const ids = new Set();
  return value.map((check, index) => {
    const path = `checks[${index}]`;
    assertClosedObject(check, new Set(['id', 'evidenceGrades']), path);
    assertRequiredFields(check, ['id', 'evidenceGrades'], path);
    assertSafeId(check.id, `${path}.id`);
    if (ids.has(check.id)) throw new TypeError(`duplicate confidence check id: ${check.id}`);
    ids.add(check.id);
    if (!Array.isArray(check.evidenceGrades)) {
      throw new TypeError(`${path}.evidenceGrades must be an array`);
    }
    for (const grade of check.evidenceGrades) {
      if (!Object.hasOwn(EVIDENCE_VALUES, grade)) {
        throw new TypeError(`${path} contains an unknown evidence grade`);
      }
    }
    return {
      id: check.id,
      evidenceGrades: [...check.evidenceGrades]
    };
  });
}

function normalizeTaggedConfidence(value, path) {
  assertClosedObject(value, new Set(['status', 'value', 'components']), path);
  assertRequiredFields(value, ['status', 'value'], path);
  if (!CONFIDENCE_STATUSES.has(value.status)) {
    throw new TypeError(`${path}.status is invalid`);
  }
  if (value.status === 'complete') {
    requireRange(value.value, 0, 1, `${path}.value`);
  } else if (value.value !== null) {
    throw new TypeError(`${path}.value must be null while confidence is pending`);
  }
  return { status: value.status, value: value.value };
}

function highestPriorityStatus(statuses) {
  return statuses.reduce((highest, status) =>
    STATUS_PRIORITY[status] > STATUS_PRIORITY[highest] ? status : highest
  , 'complete');
}

function numericSample(value, minimum, maximum, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  for (const item of value) requireRange(item, minimum, maximum, field);
  return [...value];
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] +
    (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function requireRange(value, minimum, maximum, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must contain finite numbers`);
  }
  if (value < minimum || value > maximum) {
    throw new RangeError(`${field} must be within ${minimum}..${maximum}`);
  }
}

function requireNonNegativeFinite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  if (value < 0) throw new RangeError(`${field} cannot be negative`);
}

function assertClosedObject(value, allowed, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${field} field: ${key}`);
  }
}

function assertRequiredFields(value, fields, path) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${path} requires ${field}`);
  }
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
