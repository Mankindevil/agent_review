import Ajv2020 from 'ajv/dist/2020.js';

export function evaluateAcceptance(criteria, normalizedOutput) {
  if (!Array.isArray(criteria)) throw new TypeError('criteria must be an array');
  if (!isObject(normalizedOutput)) {
    throw new TypeError('normalizedOutput must be an object');
  }

  const checks = criteria.map((item) => evaluateCriterion(item, normalizedOutput));
  const requiredChecks = checks.filter(
    (check) => check.required && check.status !== 'not-executable'
  );
  const passedRequiredExecutable = requiredChecks.filter(
    (check) => check.status === 'passed'
  ).length;

  return {
    checks,
    requiredExecutable: requiredChecks.length,
    passedRequiredExecutable,
    semanticSuccess: requiredChecks.length === 0
      ? null
      : passedRequiredExecutable === requiredChecks.length
  };
}

function evaluateCriterion(criterion, normalizedOutput) {
  if (!isObject(criterion)) throw new TypeError('criterion must be an object');
  const base = {
    id: criterion.id,
    type: criterion.type,
    required: criterion.required !== false
  };

  if (criterion.type === 'model') {
    return { ...base, status: 'not-executable' };
  }

  let passed;
  if (criterion.type === 'contains') {
    passed = evaluateContains(criterion, normalizedOutput.text);
  } else if (criterion.type === 'exact') {
    passed = normalizeExact(normalizedOutput.text) === normalizeExact(criterion.expected);
  } else if (criterion.type === 'json-schema') {
    passed = evaluateJsonSchema(criterion.schema, selectStructuredCandidate(normalizedOutput));
  } else if (criterion.type === 'numeric') {
    passed = evaluateNumeric(criterion, selectStructuredCandidate(normalizedOutput));
  } else {
    throw new TypeError(`unsupported acceptance criterion type: ${criterion.type}`);
  }
  return { ...base, status: passed ? 'passed' : 'failed' };
}

function evaluateContains(criterion, actualText) {
  const actual = normalizeContainsValue(actualText, criterion.caseSensitive);
  if (!Array.isArray(criterion.expected)) {
    throw new TypeError('contains criterion expected must be an array');
  }
  return criterion.expected.every((token) =>
    actual.includes(normalizeContainsValue(token, criterion.caseSensitive))
  );
}

function normalizeContainsValue(value, caseSensitive) {
  const normalized = String(value ?? '').normalize('NFC');
  return caseSensitive === false ? normalized.toLowerCase() : normalized;
}

function normalizeExact(value) {
  return String(value ?? '')
    .replace(/\r\n?|\n/gu, '\n')
    .replace(/[ \t]+(?=\n|$)/gu, '');
}

function evaluateJsonSchema(schema, candidate) {
  assertLocalReferences(schema);
  if (schema.$async === true) {
    throw new TypeError('async JSON Schemas are not supported');
  }
  let validate;
  try {
    const ajv = new Ajv2020({
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false
    });
    validate = ajv.compile(structuredClone(schema));
  } catch (error) {
    throw new TypeError(`invalid or unsupported JSON Schema: ${error.message}`, {
      cause: error
    });
  }
  return candidate.found ? validate(candidate.value) === true : false;
}

function assertLocalReferences(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertLocalReferences(item);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#'))) {
      throw new TypeError('JSON Schema $ref must be a local fragment beginning with #');
    }
    assertLocalReferences(child);
  }
}

function evaluateNumeric(criterion, candidate) {
  const tolerance = criterion.tolerance ?? 0;
  if (
    typeof criterion.expected !== 'number' ||
    !Number.isFinite(criterion.expected) ||
    typeof tolerance !== 'number' ||
    !Number.isFinite(tolerance) ||
    tolerance < 0
  ) {
    throw new TypeError('numeric criterion requires finite expected and non-negative tolerance');
  }
  if (!candidate.found) return false;
  const resolved = resolveOwnPath(candidate.value, criterion.path);
  return resolved.found &&
    typeof resolved.value === 'number' &&
    Number.isFinite(resolved.value) &&
    Math.abs(resolved.value - criterion.expected) <= tolerance;
}

function resolveOwnPath(value, path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('numeric criterion path must be a non-empty string');
  }
  const segments = path.split('.');
  if (segments.some((segment) => segment.length === 0)) return { found: false };
  let current = value;
  for (const segment of segments) {
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null) {
      return { found: false };
    }
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return { found: false };
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return { found: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { found: false };
    current = descriptor.value;
  }
  return { found: true, value: current };
}

function selectStructuredCandidate(normalizedOutput) {
  const direct = Object.getOwnPropertyDescriptor(normalizedOutput, 'data');
  if (
    direct &&
    Object.hasOwn(direct, 'value') &&
    direct.value !== null &&
    direct.value !== undefined
  ) {
    return { found: true, value: direct.value };
  }
  for (const artifact of Array.isArray(normalizedOutput.artifacts)
    ? normalizedOutput.artifacts
    : []) {
    if (!isObject(artifact) || !Array.isArray(artifact.parts)) continue;
    for (const part of artifact.parts) {
      if (!isObject(part) || !Object.hasOwn(part, 'data')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(part, 'data');
      const kind = Object.getOwnPropertyDescriptor(part, 'kind');
      const type = Object.getOwnPropertyDescriptor(part, 'type');
      const nativeV1 = kind === undefined && type === undefined;
      const nativeV03 = kind &&
        Object.hasOwn(kind, 'value') &&
        kind.value === 'data';
      if (
        descriptor &&
        Object.hasOwn(descriptor, 'value') &&
        (nativeV1 || nativeV03)
      ) {
        return { found: true, value: descriptor.value };
      }
    }
  }
  return { found: false, value: undefined };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
