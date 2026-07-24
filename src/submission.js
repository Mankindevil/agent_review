import { createHash } from 'node:crypto';
import { validateAgentCard } from './a2a.js';
import { validateSafeUrl } from './safe-http.js';

const INTERNAL_SUBMISSION_LIMITS = Object.freeze({
  examples: 20,
  turnsPerExample: 20,
  partsPerTurn: 50,
  criteriaPerTurn: 50,
  totalCanonicalBytes: 2 * 1024 * 1024
});
const PART_TYPE_VALUES = Object.freeze(['text', 'data', 'raw', 'url']);
const CRITERION_TYPE_VALUES = Object.freeze([
  'model', 'contains', 'exact', 'json-schema', 'numeric'
]);

export const SUBMISSION_LIMITS = Object.freeze({ ...INTERNAL_SUBMISSION_LIMITS });
export const PART_TYPES = new Set(PART_TYPE_VALUES);
export const CRITERION_TYPES = new Set(CRITERION_TYPE_VALUES);

export function normalizeAgentExamples(rawExamples) {
  if (!Array.isArray(rawExamples)) {
    if (isObject(rawExamples) && Object.hasOwn(rawExamples, 'cases')) {
      throw new TypeError('Formal V2 submissions must use agentExamples; cases is not supported');
    }
    throw new TypeError('agentExamples must be an array');
  }
  if (rawExamples.length === 0 || rawExamples.length > INTERNAL_SUBMISSION_LIMITS.examples) {
    throw new RangeError(`agentExamples exceeds examples limit of ${INTERNAL_SUBMISSION_LIMITS.examples}`);
  }

  const exampleIds = new Set();
  const normalized = rawExamples.map((example, exampleIndex) => {
    requireObject(example, `agentExamples[${exampleIndex}]`);
    const id = requireString(example.id, `agentExamples[${exampleIndex}].id`);
    if (exampleIds.has(id)) throw new TypeError(`duplicate example id: ${id}`);
    exampleIds.add(id);
    const name = requireString(example.name, `agentExamples[${exampleIndex}].name`);
    if (!Array.isArray(example.turns) || example.turns.length === 0) {
      throw new TypeError(`agentExamples[${exampleIndex}].turns must be a non-empty array`);
    }
    if (example.turns.length > INTERNAL_SUBMISSION_LIMITS.turnsPerExample) {
      throw new RangeError(`turns exceeds limit of ${INTERNAL_SUBMISSION_LIMITS.turnsPerExample}`);
    }

    const result = {
      id,
      name,
      turns: example.turns.map((turn, turnIndex) =>
        normalizeTurn(turn, `agentExamples[${exampleIndex}].turns[${turnIndex}]`)
      )
    };
    if (example.constraints !== undefined) {
      result.constraints = normalizeStringArray(
        example.constraints,
        `agentExamples[${exampleIndex}].constraints`
      );
    }
    return result;
  });

  assertCanonicalSize(normalized);
  return deepFreeze(normalized);
}

export function freezeSubmission({
  agentCard,
  agentExamples,
  validation,
  config,
  frozenAt
}) {
  void validation;
  const actualValidation = validateAgentCard(agentCard);
  if (!actualValidation.valid) throw new TypeError('A valid Agent Card is required');
  const selectedInterface = actualValidation.selectedInterface;

  const canonicalCard = canonicalClone(agentCard, 'agentCard');
  const canonicalExamples = normalizeAgentExamples(agentExamples);
  const normalizedConfig = normalizeConfig(config);
  const snapshot = {
    submissionVersion: '1.0',
    frozenAt: requireString(frozenAt, 'frozenAt'),
    agentCard: {
      schemaVersion: actualValidation.schemaVersion || actualValidation.version,
      value: canonicalCard,
      sha256: hashCanonical(canonicalCard)
    },
    agentExamples: {
      schemaVersion: '1.0',
      value: canonicalExamples,
      sha256: hashCanonical(canonicalExamples)
    },
    selectedInterface: canonicalClone(selectedInterface, 'selectedInterface'),
    config: normalizedConfig,
    evaluationWindow: {
      firstRunAt: null,
      lastRunAt: null
    }
  };
  return deepFreeze(snapshot);
}

function normalizeTurn(turn, path) {
  requireObject(turn, path);
  requireObject(turn.input, `${path}.input`);
  if (!Array.isArray(turn.input.parts) || turn.input.parts.length === 0) {
    throw new TypeError(`${path}.input.parts must be a non-empty array`);
  }
  if (turn.input.parts.length > INTERNAL_SUBMISSION_LIMITS.partsPerTurn) {
    throw new RangeError(`parts exceeds limit of ${INTERNAL_SUBMISSION_LIMITS.partsPerTurn}`);
  }
  if (!Array.isArray(turn.acceptanceCriteria) || turn.acceptanceCriteria.length === 0) {
    throw new TypeError(`${path}.acceptanceCriteria must be a non-empty array`);
  }
  if (turn.acceptanceCriteria.length > INTERNAL_SUBMISSION_LIMITS.criteriaPerTurn) {
    throw new RangeError(`criteria exceeds limit of ${INTERNAL_SUBMISSION_LIMITS.criteriaPerTurn}`);
  }

  const criterionIds = new Set();
  const acceptanceCriteria = turn.acceptanceCriteria.map((criterion, criterionIndex) => {
    const criterionPath = `${path}.acceptanceCriteria[${criterionIndex}]`;
    const result = normalizeCriterion(criterion, criterionPath);
    if (criterionIds.has(result.id)) throw new TypeError(`duplicate criterion id within turn: ${result.id}`);
    criterionIds.add(result.id);
    return result;
  });

  return {
    input: {
      parts: turn.input.parts.map((part, partIndex) =>
        normalizePart(part, `${path}.input.parts[${partIndex}]`)
      )
    },
    expectedDeliverable: requireString(turn.expectedDeliverable, `${path}.expectedDeliverable`),
    acceptanceCriteria
  };
}

function normalizePart(part, path) {
  requireObject(part, path);
  if (!PART_TYPE_VALUES.includes(part.type)) throw new TypeError(`${path} has unsupported part type`);
  let result;
  if (part.type === 'text') {
    result = { type: 'text', text: requireString(part.text, `${path}.text`) };
  } else if (part.type === 'data') {
    if (!Object.hasOwn(part, 'data')) throw new TypeError(`${path}.data must be JSON data`);
    result = { type: 'data', data: canonicalClone(part.data, `${path}.data`) };
  } else if (part.type === 'raw') {
    if (!isValidBase64(part.raw)) throw new TypeError(`${path}.raw must be valid base64`);
    result = {
      type: 'raw',
      raw: part.raw,
      mediaType: requireString(part.mediaType, `${path}.mediaType`)
    };
  } else {
    let safeUrl;
    try {
      safeUrl = validateSafeUrl(part.url);
    } catch (error) {
      throw new TypeError(`${path}.url is not a safe HTTP(S) URL: ${error.message}`);
    }
    result = { type: 'url', url: safeUrl.toString() };
  }
  copyOptionalString(part, result, 'mediaType', path);
  copyOptionalString(part, result, 'filename', path);
  return result;
}

function normalizeCriterion(criterion, path) {
  requireObject(criterion, path);
  const id = requireString(criterion.id, `${path}.id`);
  if (!CRITERION_TYPE_VALUES.includes(criterion.type)) {
    throw new TypeError(`${path} has unsupported criterion type`);
  }
  const result = {
    id,
    type: criterion.type,
    description: requireString(criterion.description, `${path}.description`),
    required: criterion.required === undefined ? true : requireBoolean(criterion.required, `${path}.required`)
  };

  if (criterion.type === 'contains') {
    if (!Array.isArray(criterion.expected) || criterion.expected.length === 0) {
      throw new TypeError(`${path}.expected must be a non-empty string array`);
    }
    result.expected = normalizeStringArray(criterion.expected, `${path}.expected`);
  } else if (criterion.type === 'exact') {
    result.expected = requireString(criterion.expected, `${path}.expected`);
  } else if (criterion.type === 'json-schema') {
    requireObject(criterion.schema, `${path}.schema`);
    result.schema = canonicalClone(criterion.schema, `${path}.schema`);
  } else if (criterion.type === 'numeric') {
    result.path = requireString(criterion.path, `${path}.path`);
    result.expected = requireFiniteNumber(criterion.expected, `${path}.expected`);
    if (criterion.tolerance !== undefined) {
      result.tolerance = requireFiniteNumber(criterion.tolerance, `${path}.tolerance`);
      if (result.tolerance < 0) throw new RangeError(`${path}.tolerance cannot be negative`);
    }
  }
  return result;
}

function normalizeConfig(config) {
  requireObject(config, 'config');
  const allowed = [
    'rubricVersion',
    'hiddenTestPackageVersion',
    'modelConfigVersion',
    'runtimeConfigVersion'
  ];
  const result = {};
  for (const key of allowed) {
    const value = config[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new TypeError(`config.${key} must be a string or null`);
    }
    result[key] = value ?? null;
  }
  return result;
}

function canonicalClone(value, path, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only JSON values`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} must contain only JSON values`);
    const nextAncestors = new Set(ancestors).add(value);
    return value.map((item, index) => canonicalClone(item, `${path}[${index}]`, nextAncestors));
  }
  if (!isObject(value)) throw new TypeError(`${path} must contain only JSON values`);
  if (ancestors.has(value)) throw new TypeError(`${path} must contain only JSON values`);
  const nextAncestors = new Set(ancestors).add(value);

  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`${path}.${key} must contain only JSON values`);
    Object.defineProperty(result, key, {
      value: canonicalClone(value[key], `${path}.${key}`, nextAncestors),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return result;
}

function hashCanonical(value) {
  return createHash('sha256').update(JSON.stringify(canonicalClone(value, 'value')), 'utf8').digest('hex');
}

function assertCanonicalSize(value) {
  const size = Buffer.byteLength(JSON.stringify(canonicalClone(value, 'agentExamples')), 'utf8');
  if (size > INTERNAL_SUBMISSION_LIMITS.totalCanonicalBytes) {
    throw new RangeError(`agentExamples exceeds total canonical bytes limit of ${INTERNAL_SUBMISSION_LIMITS.totalCanonicalBytes}`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function copyOptionalString(source, target, key, path) {
  if (source[key] !== undefined) target[key] = requireString(source[key], `${path}.${key}`);
}

function normalizeStringArray(value, path) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((item, index) => requireString(item, `${path}[${index}]`));
}

function requireObject(value, path) {
  if (!isObject(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`);
  return value;
}

function requireFiniteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path} expected value must be a finite number`);
  }
  return value;
}

function isObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}
