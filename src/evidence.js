import { createHash, randomUUID } from 'node:crypto';

const EVIDENCE_GRADES = new Set(['A', 'B', 'C', 'D']);
const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/gu;
const COOKIE_VALUE_PATTERN = /(\b[A-Za-z0-9_.-]*(?:sid|session|token|auth|key|secret)[A-Za-z0-9_.-]*=)[^;\s]+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const MAINLAND_PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;

export function createEvidenceRecord({
  evidenceId = `ev_${randomUUID()}`,
  runId,
  grade,
  kind,
  testId,
  turnIndex,
  repeatIndex,
  capturedAt,
  payload
}) {
  if (!EVIDENCE_GRADES.has(grade)) throw new TypeError('invalid evidence grade');
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
    return value.map((item) => redactValue(item, secrets, nextAncestors));
  }
  if (isPlainObject(value)) {
    assertNoCycle(value, ancestors);
    const nextAncestors = new Set(ancestors).add(value);
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSensitiveField(key)
        ? '[REDACTED]'
        : redactValue(child, secrets, nextAncestors);
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
  result = result.replace(JWT_PATTERN, '[JWT_REDACTED]');
  result = result.replace(COOKIE_VALUE_PATTERN, '$1[COOKIE_REDACTED]');
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
    'authorization', 'auth', 'cookie', 'token', 'secret', 'password', 'passwd',
    'credential', 'credentials', 'session'
  ].includes(token))) return true;
  return tokens.some((token, index) =>
    token === 'key' && ['api', 'access', 'private', 'signing'].includes(tokens[index - 1])
  );
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
    return value.map((item, index) => canonicalClone(item, `${field}[${index}]`, nextAncestors));
  }
  if (isPlainObject(value)) {
    assertNoCycle(value, ancestors, field);
    const nextAncestors = new Set(ancestors).add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`${field}.${key} must contain only JSON values`);
      result[key] = canonicalClone(value[key], `${field}.${key}`, nextAncestors);
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
