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
  return candidate.found && candidate.valid
    ? validate(candidate.value) === true
    : false;
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
  if (!candidate.found || !candidate.valid) return false;
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
  const direct = ownDataProperty(normalizedOutput, 'data');
  if (direct.status === 'invalid') return invalidCandidate();
  if (
    direct.status === 'value' &&
    direct.value !== null &&
    direct.value !== undefined
  ) {
    return cloneCandidate(direct.value);
  }

  const artifactsProperty = ownDataProperty(normalizedOutput, 'artifacts', {
    inheritedIsInvalid: true
  });
  if (artifactsProperty.status === 'invalid') return invalidCandidate();
  if (artifactsProperty.status === 'missing') return missingCandidate();
  const artifacts = denseArrayValues(artifactsProperty.value);
  if (!artifacts.valid) return invalidCandidate();

  for (const artifact of artifacts.values) {
    if (!isPlainObject(artifact)) return invalidCandidate();
    const partsProperty = ownDataProperty(artifact, 'parts', {
      inheritedIsInvalid: true
    });
    if (partsProperty.status === 'invalid') return invalidCandidate();
    if (partsProperty.status === 'missing') continue;
    const parts = denseArrayValues(partsProperty.value);
    if (!parts.valid) return invalidCandidate();
    for (const part of parts.values) {
      if (!isPlainObject(part)) return invalidCandidate();
      const data = ownDataProperty(part, 'data');
      if (data.status === 'invalid') return invalidCandidate();
      if (data.status === 'missing') continue;
      const kind = ownDataProperty(part, 'kind');
      const type = ownDataProperty(part, 'type');
      if (kind.status === 'invalid' || type.status === 'invalid') {
        return invalidCandidate();
      }
      const nativeV1 = kind.status === 'missing' && type.status === 'missing';
      const nativeV03 = kind.status === 'value' && kind.value === 'data';
      if (nativeV1 || nativeV03) return cloneCandidate(data.value);
    }
  }
  return missingCandidate();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownDataProperty(value, key, { inheritedIsInvalid = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    return inheritedIsInvalid && key in value
      ? { status: 'invalid' }
      : { status: 'missing' };
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    return { status: 'invalid' };
  }
  return { status: 'value', value: descriptor.value };
}

function denseArrayValues(value) {
  if (!Array.isArray(value)) return { valid: false, values: [] };
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) {
    return { valid: false, values: [] };
  }
  const expected = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index))
  ]);
  if (keys.some((key) => !expected.has(key)) || keys.length !== expected.size) {
    return { valid: false, values: [] };
  }
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return { valid: false, values: [] };
    }
    values.push(descriptor.value);
  }
  return { valid: true, values };
}

function cloneCandidate(value) {
  const cloned = cloneInertJson(value, new Set());
  return cloned.valid
    ? { found: true, valid: true, value: cloned.value }
    : invalidCandidate();
}

function cloneInertJson(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { valid: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { valid: true, value }
      : { valid: false };
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    return { valid: false };
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    const array = denseArrayValues(value);
    if (!array.valid) return { valid: false };
    const result = [];
    for (const item of array.values) {
      const cloned = cloneInertJson(item, nextAncestors);
      if (!cloned.valid) return { valid: false };
      result.push(cloned.value);
    }
    return { valid: true, value: result };
  }
  if (!isPlainObject(value)) return { valid: false };
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) return { valid: false };
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return { valid: false };
    }
    const cloned = cloneInertJson(descriptor.value, nextAncestors);
    if (!cloned.valid) return { valid: false };
    Object.defineProperty(result, key, {
      value: cloned.value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return { valid: true, value: result };
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function missingCandidate() {
  return { found: false, valid: true, value: undefined };
}

function invalidCandidate() {
  return { found: true, valid: false, value: undefined };
}
