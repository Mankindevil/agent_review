import { createHash, randomUUID } from 'node:crypto';

const EVIDENCE_GRADES = new Set(['A', 'B', 'C', 'D']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CREATE_FIELDS = new Set([
  'evidenceId', 'runId', 'grade', 'kind', 'testId', 'turnIndex', 'repeatIndex',
  'capturedAt', 'payload'
]);
const RECORD_FIELDS = new Set([
  ...CREATE_FIELDS, 'evidenceVersion', 'payloadHash'
]);
export const EVIDENCE_KIND_GRADES = Object.freeze({
  'platform-timing': 'A',
  'transport-fact': 'A',
  'protocol-object': 'B',
  'protocol-request': 'B',
  'protocol-response': 'B',
  'protocol-event': 'B',
  'agent-output': 'B',
  'agent-card-claim': 'C',
  'agent-example-claim': 'C',
  'agent-claim': 'C',
  'reviewer-inference': 'D'
});
const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const BASIC_PATTERN = /\bBasic\s+[A-Za-z0-9+/=]+/giu;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/gu;
const COOKIE_HEADER_PATTERN = /((?:^|[\s;,])(?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]*/giu;
const SENSITIVE_ASSIGNMENT_PATTERN = /\b(?:authorization|authentication|authenticate|hidden(?:[-_\s]+)input|(?:access[-_\s]*)?token|secret)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const MAINLAND_PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;

export function createEvidenceRecord(input = {}) {
  const values = readEvidenceFields(input, CREATE_FIELDS, 'evidence input');
  const evidenceId = values.evidenceId ?? `ev_${randomUUID()}`;
  const {
    runId,
    grade,
    kind,
    testId,
    turnIndex,
    repeatIndex,
    capturedAt,
    payload
  } = values;
  assertSafeId(evidenceId, 'evidenceId');
  assertSafeId(runId, 'runId');
  assertSafeId(testId, 'testId');
  if (!EVIDENCE_GRADES.has(grade)) throw new TypeError('invalid evidence grade');
  if (!Object.hasOwn(EVIDENCE_KIND_GRADES, kind)) throw new TypeError('invalid evidence kind');
  if (EVIDENCE_KIND_GRADES[kind] !== grade) {
    throw new TypeError(`evidence grade ${grade} does not match kind ${kind}`);
  }
  assertIsoTimestamp(capturedAt, 'capturedAt');
  assertOptionalIndex(turnIndex, 'turnIndex');
  assertOptionalIndex(repeatIndex, 'repeatIndex');
  const immutablePayload = canonicalClone(payload, 'payload');
  return deepFreeze({
    evidenceId,
    evidenceVersion: '1.0',
    runId,
    grade,
    kind,
    testId,
    turnIndex,
    repeatIndex,
    capturedAt,
    payloadHash: sha256(JSON.stringify(immutablePayload)),
    payload: immutablePayload
  });
}

export function canonicalizeEvidenceRecord(record) {
  const values = readEvidenceFields(record, RECORD_FIELDS, 'evidence record');
  if (values.evidenceVersion !== '1.0') throw new TypeError('invalid evidence version');
  const canonical = createEvidenceRecord({
    evidenceId: values.evidenceId,
    runId: values.runId,
    grade: values.grade,
    kind: values.kind,
    testId: values.testId,
    turnIndex: values.turnIndex,
    repeatIndex: values.repeatIndex,
    capturedAt: values.capturedAt,
    payload: values.payload
  });
  if (values.payloadHash !== canonical.payloadHash) {
    throw new TypeError('evidence payload hash mismatch');
  }
  return canonical;
}

export function redactEvidence(value, secrets = []) {
  const explicitSecrets = [...new Set(
    (Array.isArray(secrets) ? secrets : [secrets])
      .filter((secret) => typeof secret === 'string' && secret.length > 0)
      .sort((left, right) => right.length - left.length)
  )];
  return redactValue(value, explicitSecrets, new Set());
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalClone(value, 'value'));
}

export function hashEvidencePayload(payload) {
  return sha256(canonicalJson(payload));
}

export function deepFreezeEvidence(value) {
  return deepFreeze(value);
}

function redactValue(value, secrets, ancestors) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    assertNoCycle(value, ancestors);
    const nextAncestors = new Set(ancestors).add(value);
    return arrayDataValues(value, 'Evidence').map((item) =>
      redactValue(item, secrets, nextAncestors)
    );
  }
  if (isPlainObject(value)) {
    assertNoCycle(value, ancestors);
    const nextAncestors = new Set(ancestors).add(value);
    const result = {};
    const usedKeys = new Set();
    for (const [key, child] of objectDataEntries(value, 'Evidence')) {
      const outputKey = redactObjectKey(key, secrets, usedKeys);
      defineJsonProperty(result, outputKey, isSensitiveField(key)
        ? '[REDACTED]'
        : redactValue(child, secrets, nextAncestors));
    }
    return result;
  }
  throw new TypeError('Evidence must contain only JSON values');
}

function redactString(value, secrets) {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join('[SECRET_REDACTED]');
  result = result.replace(URL_PATTERN, redactUrl);
  result = result.replace(BEARER_PATTERN, '[BEARER_REDACTED]');
  result = result.replace(BASIC_PATTERN, '[BASIC_REDACTED]');
  result = result.replace(JWT_PATTERN, redactJwt);
  result = result.replace(COOKIE_HEADER_PATTERN, '$1[COOKIE_REDACTED]');
  result = result.replace(SENSITIVE_ASSIGNMENT_PATTERN, '[SENSITIVE_REDACTED]');
  result = result.replace(EMAIL_PATTERN, '[EMAIL_REDACTED]');
  result = result.replace(MAINLAND_PHONE_PATTERN, '[PHONE_REDACTED]');
  return result;
}

function isSensitiveField(field) {
  const tokens = String(field)
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (tokens.some((token) => [
    'authorization', 'authentication', 'authenticate', 'auth', 'cookie', 'jwt',
    'token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'session'
  ].includes(token))) return true;
  return tokens.some((token, index) =>
    token === 'key' && ['api', 'access', 'private', 'signing'].includes(tokens[index - 1])
  );
}

function redactObjectKey(key, secrets, usedKeys) {
  const redacted = redactString(key, secrets);
  const base = redacted === key ? key : '[REDACTED_KEY]';
  if (!usedKeys.has(base)) {
    usedKeys.add(base);
    return base;
  }
  let suffix = 2;
  let candidate = `${base.slice(0, -1)}_${suffix}]`;
  while (usedKeys.has(candidate)) {
    suffix += 1;
    candidate = `${base.slice(0, -1)}_${suffix}]`;
  }
  usedKeys.add(candidate);
  return candidate;
}

function redactJwt(candidate) {
  const [header, payload] = candidate.split('.');
  try {
    if (isJsonObject(decodeBase64UrlJson(header)) && isJsonObject(decodeBase64UrlJson(payload))) {
      return '[JWT_REDACTED]';
    }
  } catch {
    // Non-JWT dotted data remains useful evidence.
  }
  return candidate;
}

function decodeBase64UrlJson(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError('invalid base64url');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactUrl(candidate) {
  try {
    const url = new URL(candidate);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
    return url.toString();
  } catch {
    return '[URL_REDACTED]';
  }
}

function canonicalClone(value, field, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${field} must contain only JSON values`);
    return value;
  }
  if (Array.isArray(value)) {
    assertNoCycle(value, ancestors, field);
    const nextAncestors = new Set(ancestors).add(value);
    return arrayDataValues(value, field)
      .map((item, index) => canonicalClone(item, `${field}[${index}]`, nextAncestors));
  }
  if (isPlainObject(value)) {
    assertNoCycle(value, ancestors, field);
    const nextAncestors = new Set(ancestors).add(value);
    const result = {};
    for (const [key, child] of objectDataEntries(value, field)) {
      if (child === undefined) throw new TypeError(`${field}.${key} must contain only JSON values`);
      defineJsonProperty(
        result,
        key,
        canonicalClone(child, `${field}.${key}`, nextAncestors)
      );
    }
    return result;
  }
  throw new TypeError(`${field} must contain only JSON values`);
}

function assertNoCycle(value, ancestors, field = 'Evidence') {
  if (ancestors.has(value)) throw new TypeError(`${field} must contain only JSON values`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readEvidenceFields(value, allowed, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be an object`);
  const result = {};
  for (const [key, child] of objectDataEntries(value, field)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${field} field: ${key}`);
    defineJsonProperty(result, key, child);
  }
  return result;
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
}

function assertIsoTimestamp(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
}

function assertOptionalIndex(value, field) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
}

function objectDataEntries(value, field) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${field} must not contain symbol properties`);
  }
  return keys.sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      throw new TypeError(`${field}.${key} must be an enumerable JSON property`);
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${field}.${key} must not be an accessor`);
    }
    return [key, descriptor.value];
  });
}

function arrayDataValues(value, field) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${field} must not contain symbol properties`);
  }
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (keys.some((key) => !expected.has(key)) || keys.length !== expected.size) {
    throw new TypeError(`${field} must be a dense JSON array`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable) {
      throw new TypeError(`${field}[${index}] must be an enumerable JSON property`);
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${field}[${index}] must not be an accessor`);
    }
    return descriptor.value;
  });
}

function defineJsonProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
