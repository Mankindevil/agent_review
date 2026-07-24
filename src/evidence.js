import { createHash, randomUUID } from 'node:crypto';

const EVIDENCE_GRADES = new Set(['A', 'B', 'C', 'D']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CREATE_FIELDS = new Set([
  'evidenceId', 'runId', 'grade', 'kind', 'testId', 'turnIndex', 'repeatIndex',
  'capturedAt', 'payload'
]);
const RECORD_FIELDS = new Set([
  ...CREATE_FIELDS, 'evidenceVersion', 'payloadHash', 'recordHash'
]);
const MANIFEST_FIELDS = new Set([
  'evidenceId', 'runId', 'grade', 'kind', 'testId', 'turnIndex', 'repeatIndex',
  'occurredAt', 'summary', 'payloadHash', 'recordHash', 'visibility', 'redaction'
]);
const MANIFEST_OPTION_FIELDS = new Set(['summary', 'visibility', 'secrets']);
const REDACTION_FIELDS = new Set(['status', 'count']);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MANIFEST_VISIBILITIES = new Set(['public', 'admin']);
const REDACTION_MARKER_PATTERN = /\[(?:SECRET|AUTHORIZATION|BEARER|JWT|COOKIE|SENSITIVE|EMAIL|PHONE|URL)_REDACTED\]|\[REDACTED\]|%5BREDACTED%5D/giu;
export const EVIDENCE_KIND_GRADES = Object.freeze({
  'platform-timing': 'A',
  'transport-fact': 'A',
  'protocol-object': 'B',
  'protocol-request': 'B',
  'protocol-response': 'B',
  'protocol-event': 'B',
  'agent-output': 'C',
  'agent-card-claim': 'C',
  'agent-example-claim': 'C',
  'agent-claim': 'C',
  'reviewer-inference': 'D'
});
const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const AUTHORIZATION_HEADER_PATTERN = /(\b(?:Proxy-)?Authorization\s*:\s*)(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])/gu;
const COOKIE_LINE_HEADER_PATTERN = /(^|[\r\n])(\s*(?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]*/giu;
const COOKIE_CONTEXT_HEADER_PATTERN = /(\b(?:request|response)\s+(?:headers?\s+)?(?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]*/giu;
const ASSIGNMENT_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]*(?:[ \t]+[A-Za-z][A-Za-z0-9_-]*)?)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const MAINLAND_PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const SENSITIVE_TOKENS = new Set([
  'authorization', 'authentication', 'authenticate', 'auth', 'cookie', 'jwt',
  'token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'session'
]);
const SENSITIVE_KEY_PREFIXES = new Set(['api', 'access', 'private', 'signing']);

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
  const payloadHash = sha256(JSON.stringify(immutablePayload));
  const recordHash = hashRecordCommitment({
    evidenceId,
    evidenceVersion: '1.0',
    runId,
    grade,
    kind,
    testId,
    turnIndex,
    repeatIndex,
    capturedAt,
    payloadHash
  });
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
    payloadHash,
    recordHash,
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
  if (values.recordHash !== canonical.recordHash) {
    throw new TypeError('evidence record hash mismatch');
  }
  return canonical;
}

export function createEvidenceManifestItem(record, options = {}) {
  const canonicalRecord = canonicalizeEvidenceRecord(record);
  const values = readEvidenceFields(
    options,
    MANIFEST_OPTION_FIELDS,
    'evidence manifest options'
  );
  assertSummary(values.summary);
  assertManifestVisibility(values.visibility);
  const summary = redactEvidence(values.summary, values.secrets ?? []);
  const count = countInsertedRedactions(values.summary, summary);
  return validateEvidenceManifestItem({
    evidenceId: canonicalRecord.evidenceId,
    runId: canonicalRecord.runId,
    grade: canonicalRecord.grade,
    kind: canonicalRecord.kind,
    testId: canonicalRecord.testId,
    turnIndex: canonicalRecord.turnIndex ?? null,
    repeatIndex: canonicalRecord.repeatIndex ?? null,
    occurredAt: canonicalRecord.capturedAt,
    summary,
    payloadHash: canonicalRecord.payloadHash,
    recordHash: canonicalRecord.recordHash,
    visibility: values.visibility,
    redaction: {
      status: count > 0 ? 'applied' : 'not-required',
      count
    }
  });
}

export function validateEvidenceManifestItem(item) {
  const values = readEvidenceFields(item, MANIFEST_FIELDS, 'evidence manifest item');
  for (const field of MANIFEST_FIELDS) {
    if (!Object.hasOwn(values, field)) {
      throw new TypeError(`evidence manifest item requires ${field}`);
    }
  }
  assertSafeId(values.evidenceId, 'evidenceId');
  assertSafeId(values.runId, 'runId');
  assertSafeId(values.testId, 'testId');
  if (!EVIDENCE_GRADES.has(values.grade)) throw new TypeError('invalid evidence manifest grade');
  if (!Object.hasOwn(EVIDENCE_KIND_GRADES, values.kind)) {
    throw new TypeError('invalid evidence manifest kind');
  }
  if (EVIDENCE_KIND_GRADES[values.kind] !== values.grade) {
    throw new TypeError('evidence manifest grade does not match kind');
  }
  assertManifestIndex(values.turnIndex, 'turnIndex');
  assertManifestIndex(values.repeatIndex, 'repeatIndex');
  assertIsoTimestamp(values.occurredAt, 'occurredAt');
  assertSummary(values.summary);
  assertHash(values.payloadHash, 'payloadHash');
  assertHash(values.recordHash, 'recordHash');
  assertManifestVisibility(values.visibility);
  const redaction = validateManifestRedaction(values.redaction);
  const expectedRecordHash = hashRecordCommitment({
    evidenceId: values.evidenceId,
    evidenceVersion: '1.0',
    runId: values.runId,
    grade: values.grade,
    kind: values.kind,
    testId: values.testId,
    turnIndex: values.turnIndex ?? undefined,
    repeatIndex: values.repeatIndex ?? undefined,
    capturedAt: values.occurredAt,
    payloadHash: values.payloadHash
  });
  if (values.recordHash !== expectedRecordHash) {
    throw new TypeError('evidence manifest record hash commitment mismatch');
  }
  return deepFreeze({
    evidenceId: values.evidenceId,
    runId: values.runId,
    grade: values.grade,
    kind: values.kind,
    testId: values.testId,
    turnIndex: values.turnIndex,
    repeatIndex: values.repeatIndex,
    occurredAt: values.occurredAt,
    summary: values.summary,
    payloadHash: values.payloadHash,
    recordHash: values.recordHash,
    visibility: values.visibility,
    redaction
  });
}

function hashRecordCommitment(record) {
  const commitment = {
    evidenceId: record.evidenceId,
    evidenceVersion: record.evidenceVersion,
    runId: record.runId,
    grade: record.grade,
    kind: record.kind,
    testId: record.testId,
    capturedAt: record.capturedAt,
    payloadHash: record.payloadHash
  };
  if (record.turnIndex !== undefined) commitment.turnIndex = record.turnIndex;
  if (record.repeatIndex !== undefined) commitment.repeatIndex = record.repeatIndex;
  return sha256(canonicalJson(commitment));
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

function countInsertedRedactions(original, redacted) {
  if (original === redacted) return 0;
  return Math.max(1, countRedactionMarkers(redacted) - countRedactionMarkers(original));
}

function countRedactionMarkers(value) {
  return value.match(REDACTION_MARKER_PATTERN)?.length ?? 0;
}

function assertSummary(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('evidence manifest summary must be a non-empty string');
  }
}

function assertManifestVisibility(value) {
  if (!MANIFEST_VISIBILITIES.has(value)) {
    throw new TypeError('invalid evidence manifest visibility');
  }
}

function assertManifestIndex(value, field) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`evidence manifest ${field} must be null or a non-negative integer`);
  }
}

function assertHash(value, field) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new TypeError(`evidence manifest ${field} must be a SHA-256 hash`);
  }
}

function validateManifestRedaction(value) {
  const redaction = readEvidenceFields(value, REDACTION_FIELDS, 'evidence manifest redaction');
  for (const field of REDACTION_FIELDS) {
    if (!Object.hasOwn(redaction, field)) {
      throw new TypeError(`evidence manifest redaction requires ${field}`);
    }
  }
  if (
    !Number.isSafeInteger(redaction.count) ||
    redaction.count < 0 ||
    (redaction.status === 'applied' && redaction.count === 0) ||
    (redaction.status === 'not-required' && redaction.count !== 0) ||
    !['applied', 'not-required'].includes(redaction.status)
  ) {
    throw new TypeError('invalid evidence manifest redaction status or count');
  }
  return { status: redaction.status, count: redaction.count };
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
  result = result.replace(AUTHORIZATION_HEADER_PATTERN, '$1[AUTHORIZATION_REDACTED]');
  result = result.replace(BEARER_PATTERN, '[BEARER_REDACTED]');
  result = result.replace(JWT_PATTERN, redactJwt);
  result = result.replace(COOKIE_LINE_HEADER_PATTERN, '$1$2[COOKIE_REDACTED]');
  result = result.replace(COOKIE_CONTEXT_HEADER_PATTERN, '$1[COOKIE_REDACTED]');
  result = result.replace(ASSIGNMENT_PATTERN, redactSensitiveAssignment);
  result = result.replace(EMAIL_PATTERN, '[EMAIL_REDACTED]');
  result = result.replace(MAINLAND_PHONE_PATTERN, '[PHONE_REDACTED]');
  return result;
}

function isSensitiveField(field) {
  const tokens = tokenizeFieldName(field);
  if (tokens.some((token) => SENSITIVE_TOKENS.has(token))) return true;
  if (tokens.some((token, index) =>
    token === 'key' && SENSITIVE_KEY_PREFIXES.has(tokens[index - 1])
  )) return true;
  return tokens.some((token, index) =>
    token === 'input' && tokens[index - 1] === 'hidden'
  );
}

function tokenizeFieldName(field) {
  return String(field)
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function redactSensitiveAssignment(match, field) {
  const tokens = tokenizeFieldName(field);
  return !tokens.includes('cookie') && isSensitiveField(field)
    ? '[SENSITIVE_REDACTED]'
    : match;
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
