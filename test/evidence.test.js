import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVIDENCE_KIND_GRADES,
  createEvidenceManifestItem,
  createEvidenceRecord,
  redactEvidence,
  validateEvidenceManifestItem
} from '../src/evidence.js';

const VALID_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signature';
const UNSECURED_JWT = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxMjMifQ.';

function manifestRecord(overrides = {}) {
  return createEvidenceRecord({
    evidenceId: 'ev_manifest',
    runId: 'run_manifest',
    grade: 'A',
    kind: 'platform-timing',
    testId: 'test_manifest',
    turnIndex: 1,
    repeatIndex: 2,
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: { durationMs: 30 },
    ...overrides
  });
}

test('creates deterministic deeply immutable evidence records without retaining mutable payload input', () => {
  const payload = { z: [1, { ok: true }], a: 'value' };
  const record = createEvidenceRecord({
    evidenceId: 'ev_immutable',
    runId: 'run_1',
    grade: 'A',
    kind: 'transport-fact',
    testId: 'test_1',
    turnIndex: 0,
    repeatIndex: 0,
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload
  });
  const samePayload = createEvidenceRecord({
    evidenceId: 'ev_same_payload',
    runId: 'run_1',
    grade: 'B',
    testId: 'test_same_payload',
    kind: 'protocol-object',
    capturedAt: '2026-07-24T10:00:01.000Z',
    payload: { a: 'value', z: [1, { ok: true }] }
  });

  assert.equal(record.evidenceVersion, '1.0');
  assert.match(record.payloadHash, /^[a-f0-9]{64}$/);
  assert.match(record.recordHash, /^[a-f0-9]{64}$/);
  assert.equal(record.payloadHash, samePayload.payloadHash);
  assert.notEqual(record.recordHash, samePayload.recordHash);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.payload), true);
  assert.equal(Object.isFrozen(record.payload.z), true);
  payload.z[1].ok = false;
  payload.a = 'changed';
  assert.deepEqual(record.payload, { z: [1, { ok: true }], a: 'value' });
  assert.throws(() => { record.payload.z.push(2); }, TypeError);
});

test('recordHash commits every evidence identity and metadata field', () => {
  const base = {
    evidenceId: 'ev_record_commitment',
    runId: 'run_record_commitment',
    grade: 'B',
    kind: 'protocol-response',
    testId: 'test_record_commitment',
    turnIndex: 1,
    repeatIndex: 2,
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: { same: 'payload' }
  };
  const original = createEvidenceRecord(base);
  const alternatives = [
    { evidenceId: 'ev_record_commitment_changed' },
    { runId: 'run_record_commitment_changed' },
    { grade: 'D', kind: 'reviewer-inference' },
    { testId: 'test_record_commitment_changed' },
    { turnIndex: 3 },
    { repeatIndex: 4 },
    { capturedAt: '2026-07-24T11:00:00.000Z' }
  ];

  for (const patch of alternatives) {
    const changed = createEvidenceRecord({ ...base, ...patch });
    assert.equal(changed.payloadHash, original.payloadHash);
    assert.notEqual(changed.recordHash, original.recordHash, JSON.stringify(patch));
  }
});

test('builds a strict redacted manifest item from one canonical evidence record', () => {
  const record = manifestRecord();
  const manifest = createEvidenceManifestItem(record, {
    summary: 'Completed using manifest-secret',
    visibility: 'public',
    secrets: ['manifest-secret']
  });

  assert.deepEqual(manifest, {
    evidenceId: record.evidenceId,
    runId: record.runId,
    grade: record.grade,
    kind: record.kind,
    testId: record.testId,
    turnIndex: record.turnIndex,
    repeatIndex: record.repeatIndex,
    occurredAt: record.capturedAt,
    summary: 'Completed using [SECRET_REDACTED]',
    payloadHash: record.payloadHash,
    recordHash: record.recordHash,
    visibility: 'public',
    redaction: { status: 'applied', count: 1 }
  });
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.redaction), true);
  assert.deepEqual(validateEvidenceManifestItem(manifest), manifest);

  const withoutCoordinates = createEvidenceManifestItem(manifestRecord({
    evidenceId: 'ev_manifest_without_coordinates',
    turnIndex: undefined,
    repeatIndex: undefined
  }), {
    summary: 'No sensitive data',
    visibility: 'admin'
  });
  assert.equal(withoutCoordinates.turnIndex, null);
  assert.equal(withoutCoordinates.repeatIndex, null);
  assert.deepEqual(withoutCoordinates.redaction, { status: 'not-required', count: 0 });
});

test('rejects manifest fields that are missing, malformed, or detached from the record commitment', () => {
  const manifest = createEvidenceManifestItem(manifestRecord(), {
    summary: 'Completed',
    visibility: 'public'
  });
  const { recordHash: _recordHash, ...withoutRecordHash } = manifest;
  const invalidItems = [
    withoutRecordHash,
    { ...manifest, recordHash: '0'.repeat(64) },
    { ...manifest, payloadHash: '0'.repeat(64) },
    { ...manifest, grade: 'B', kind: 'protocol-object' },
    { ...manifest, kind: 'timing' },
    { ...manifest, occurredAt: '2026-07-24T10:00:01.000Z' },
    { ...manifest, turnIndex: 3 },
    { ...manifest, visibility: 'private' },
    { ...manifest, redaction: { status: 'applied', count: -1 } },
    { ...manifest, unknownField: true }
  ];

  for (const item of invalidItems) {
    assert.throws(
      () => validateEvidenceManifestItem(item),
      /manifest|record hash|commitment|grade|kind|timestamp|visibility|redaction|unknown/i
    );
  }
});

test('rejects invalid evidence grades and non-JSON payloads', () => {
  const valid = {
    evidenceId: 'ev_validation',
    runId: 'run_validation',
    testId: 'test_validation',
    grade: 'A',
    kind: 'transport-fact',
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: {}
  };
  assert.throws(() => createEvidenceRecord({ ...valid, grade: 'E' }), /grade/i);
  assert.throws(() => createEvidenceRecord({ ...valid, payload: { value: undefined } }), /JSON/i);
});

test('exports and enforces the closed evidence kind-to-grade contract', () => {
  assert.deepEqual(EVIDENCE_KIND_GRADES, {
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
  assert.equal(Object.isFrozen(EVIDENCE_KIND_GRADES), true);

  for (const [kind, grade] of Object.entries(EVIDENCE_KIND_GRADES)) {
    const record = createEvidenceRecord({
      evidenceId: `ev_${kind.replaceAll('-', '_')}`,
      runId: 'run_kind_contract',
      testId: 'test_kind_contract',
      grade,
      kind,
      capturedAt: '2026-07-24T10:00:00.000Z',
      payload: {}
    });
    assert.equal(record.grade, grade);
    assert.equal(record.kind, kind);
  }

  assert.throws(() => createEvidenceRecord({
    evidenceId: 'ev_grade_escalation',
    runId: 'run_grade_escalation',
    testId: 'test_grade_escalation',
    grade: 'A',
    kind: 'reviewer-inference',
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: {}
  }), /grade.*kind|kind.*grade/i);
});

test('grades a response envelope as B but its Agent-authored content as C', () => {
  const common = {
    runId: 'run_response_grades',
    testId: 'test_response_grades',
    capturedAt: '2026-07-24T10:00:00.000Z'
  };
  const envelope = createEvidenceRecord({
    ...common,
    evidenceId: 'ev_response_envelope',
    grade: 'B',
    kind: 'protocol-response',
    payload: { status: 200, artifactCount: 1 }
  });
  const content = createEvidenceRecord({
    ...common,
    evidenceId: 'ev_response_content',
    grade: 'C',
    kind: 'agent-output',
    payload: { claim: 'I used ten private subagents' }
  });

  assert.equal(envelope.grade, 'B');
  assert.equal(content.grade, 'C');
  assert.throws(
    () => createEvidenceRecord({ ...common, evidenceId: 'ev_output_escalated', grade: 'B', kind: 'agent-output', payload: {} }),
    /grade.*kind|kind.*grade/i
  );
  assert.throws(
    () => createEvidenceRecord({ ...common, evidenceId: 'ev_protocol_downgraded', grade: 'C', kind: 'protocol-response', payload: {} }),
    /grade.*kind|kind.*grade/i
  );
});

test('validates evidence identifiers, timestamp, coordinates, and unknown fields', () => {
  const valid = {
    evidenceId: 'ev_fields',
    runId: 'run_fields',
    testId: 'test_fields',
    grade: 'B',
    kind: 'protocol-object',
    capturedAt: '2026-07-24T10:00:00.000Z',
    turnIndex: 0,
    repeatIndex: 0,
    payload: {}
  };
  for (const patch of [
    { evidenceId: '../escape' },
    { runId: '' },
    { testId: 42 },
    { kind: 'unknown-kind' },
    { capturedAt: 'not-a-timestamp' },
    { turnIndex: -1 },
    { repeatIndex: 1.5 },
    { unknownField: 'not-allowed' }
  ]) {
    assert.throws(() => createEvidenceRecord({ ...valid, ...patch }), /evidence|runId|testId|kind|capturedAt|index|unknown/i);
  }
});

test('preserves and freezes prototype-named JSON keys in canonical evidence', () => {
  const payload = JSON.parse(
    '{"__proto__":{"claim":"grade-A-looking"},"constructor":{"safe":1},"prototype":{"safe":2}}'
  );
  const record = createEvidenceRecord({
    evidenceId: 'ev_prototype_keys',
    runId: 'run_prototype_keys',
    testId: 'test_prototype_keys',
    grade: 'B',
    kind: 'protocol-object',
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload
  });
  const empty = createEvidenceRecord({
    evidenceId: 'ev_empty',
    runId: 'run_empty',
    testId: 'test_empty',
    grade: 'B',
    kind: 'protocol-object',
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: {}
  });

  assert.deepEqual(Object.keys(record.payload).sort(), ['__proto__', 'constructor', 'prototype']);
  assert.equal(Object.hasOwn(record.payload, '__proto__'), true);
  assert.equal(record.payload.__proto__.claim, 'grade-A-looking');
  assert.equal(Object.isFrozen(record.payload.__proto__), true);
  assert.notEqual(record.payloadHash, empty.payloadHash);
  assert.match(JSON.stringify(record.payload), /"__proto__"/);
  assert.throws(() => { record.payload.__proto__.claim = 'mutated'; }, TypeError);

  const nullPrototype = Object.create(null);
  Object.defineProperty(nullPrototype, '__proto__', {
    value: { preserved: true },
    enumerable: true,
    writable: true,
    configurable: true
  });
  const nullRecord = createEvidenceRecord({
    evidenceId: 'ev_null_prototype',
    runId: 'run_null_prototype',
    testId: 'test_null_prototype',
    grade: 'B',
    kind: 'protocol-object',
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: nullPrototype
  });
  assert.equal(Object.hasOwn(nullRecord.payload, '__proto__'), true);
  assert.equal(nullRecord.payload.__proto__.preserved, true);
});

test('rejects accessors, symbols, and non-enumerable properties without invoking getters', () => {
  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    get() { getterReads += 1; return 'secret'; },
    enumerable: true
  });
  const symbol = { value: 'safe' };
  symbol[Symbol('hidden')] = 'secret';
  const nonEnumerable = { value: 'safe' };
  Object.defineProperty(nonEnumerable, 'hidden', { value: 'secret', enumerable: false });

  for (const value of [accessor, symbol, nonEnumerable]) {
    assert.throws(
      () => createEvidenceRecord({
        evidenceId: 'ev_invalid_descriptor',
        runId: 'run_invalid_descriptor',
        testId: 'test_invalid_descriptor',
        grade: 'B',
        kind: 'protocol-object',
        capturedAt: '2026-07-24T10:00:00.000Z',
        payload: value
      }),
      /JSON|accessor|symbol|enumerable/i
    );
    assert.throws(() => redactEvidence(value), /JSON|accessor|symbol|enumerable/i);
  }
  assert.equal(getterReads, 0);
});

test('recursively redacts credentials, URL secrets, PII, JWTs, cookies, and explicit run secrets', () => {
  const input = {
    headers: {
      authorization: `Bearer ${VALID_JWT}`,
      cookie: 'sid=cookie-value',
      harmless: 'keep-me'
    },
    url: 'https://agent-user:agent-pass@agent.example/file?signature=url-secret&plain=also-secret',
    message: `mail analyst@example.com or call 13800138000; token ${VALID_JWT}`,
    nested: {
      token: 'run-secret',
      agentAuthorization: 'agent-auth-secret',
      refreshToken: 'refresh-secret',
      cookieHeader: 'cookie-header-secret',
      list: ['prefix run-secret suffix', { apiKey: 'api-secret' }]
    }
  };
  const original = structuredClone(input);

  const redacted = redactEvidence(input, ['run-secret']);
  const serialized = JSON.stringify(redacted);

  for (const secret of [
    VALID_JWT, 'cookie-value', 'agent-user', 'agent-pass',
    'url-secret', 'also-secret', 'run-secret', 'api-secret',
    'agent-auth-secret', 'refresh-secret', 'cookie-header-secret',
    'analyst@example.com', '13800138000'
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.match(redacted.message, /\[EMAIL_REDACTED\]/);
  assert.match(redacted.message, /\[PHONE_REDACTED\]/);
  assert.equal(redacted.headers.authorization, '[REDACTED]');
  assert.equal(redacted.headers.cookie, '[REDACTED]');
  assert.equal(redacted.headers.harmless, 'keep-me');
  assert.deepEqual(input, original);
  assert.notEqual(redacted, input);
  assert.notEqual(redacted.nested, input.nested);
});

test('redacts secret-bearing keys, auth schemes, and cookie headers with stable collision keys', () => {
  const input = JSON.parse(`{
    "[REDACTED_KEY]": "kept",
    "run-secret": "first",
    "other run-secret": "second",
    "analyst@example.com": "third",
    "authentication": "opaque-authentication-value",
    "authenticate": "opaque-authenticate-value",
    "jwt": "opaque-jwt-value",
    "basicDocumentation": "Use a basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== example in documentation",
    "ordinaryText": "The cookie: chocolate improves UX; final score=9",
    "headersText": "Authorization: Basic dXNlcjpwYXNzd29yZA==\\nSet-Cookie: prefs=\\"private-value\\"; Path=/\\nCookie: theme=dark; arbitrary=\\"quoted-value\\"",
    "proxyHeadersText": "Proxy-Authorization: Basic cHJveHk6c2VjcmV0",
    "flatHeaderText": "upstream response Set-Cookie: session=flat-cookie-secret",
    "flatAssignments": "password=flat-password-secret; passwd=flat-passwd-secret; credential=flat-credential-secret; credentials=flat-credentials-secret; session=flat-session-secret; apiKey=flat-api-secret; api_key=flat-api-snake-secret; api-key=flat-api-kebab-secret; accessKey=flat-access-secret; access_key=flat-access-snake-secret; privateKey=flat-private-camel-secret; private-key=flat-private-secret; signingKey=flat-signing-camel-secret; signing_key=flat-signing-secret",
    "claim": "${VALID_JWT}",
    "unsecuredClaim": "${UNSECURED_JWT}",
    "ordinary": "build 10.20.30; monkey=banana; aaa.bbb.ccc"
  }`);

  const redacted = redactEvidence(input, ['run-secret']);
  const serialized = JSON.stringify(redacted);

  for (const secret of [
    'run-secret', 'analyst@example.com', 'opaque-authentication-value',
    'opaque-authenticate-value', 'opaque-jwt-value', 'dXNlcjpwYXNzd29yZA==',
    'cHJveHk6c2VjcmV0',
    'private-value', 'quoted-value', 'flat-cookie-secret', VALID_JWT, UNSECURED_JWT,
    'flat-password-secret', 'flat-passwd-secret', 'flat-credential-secret',
    'flat-credentials-secret', 'flat-session-secret', 'flat-api-secret',
    'flat-api-snake-secret', 'flat-api-kebab-secret', 'flat-access-secret',
    'flat-access-snake-secret', 'flat-private-camel-secret', 'flat-private-secret',
    'flat-signing-camel-secret', 'flat-signing-secret'
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.deepEqual(
    Object.keys(redacted).filter((key) => key.startsWith('[REDACTED_KEY')).sort(),
    ['[REDACTED_KEY]', '[REDACTED_KEY_2]', '[REDACTED_KEY_3]', '[REDACTED_KEY_4]']
  );
  assert.equal(redacted.authentication, '[REDACTED]');
  assert.equal(redacted.authenticate, '[REDACTED]');
  assert.equal(redacted.jwt, '[REDACTED]');
  assert.equal(redacted.ordinary, 'build 10.20.30; monkey=banana; aaa.bbb.ccc');
  assert.equal(
    redacted.basicDocumentation,
    'Use a basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== example in documentation'
  );
  assert.equal(
    redacted.ordinaryText,
    'The cookie: chocolate improves UX; final score=9'
  );
  assert.match(redacted.claim, /\[JWT_REDACTED\]/);
  assert.match(redacted.unsecuredClaim, /\[JWT_REDACTED\]/);
  assert.match(redacted.headersText, /Set-Cookie: \[COOKIE_REDACTED\]/);
  assert.match(redacted.headersText, /Cookie: \[COOKIE_REDACTED\]/);
  assert.match(redacted.flatHeaderText, /Set-Cookie: \[COOKIE_REDACTED\]/);
});

test('redacts prototype-named JSON keys as own properties without prototype mutation', () => {
  const input = JSON.parse(
    '{"__proto__":{"authorization":"proto-secret"},"constructor":"safe","prototype":"safe"}'
  );
  const redacted = redactEvidence(input);

  assert.equal(Object.getPrototypeOf(redacted), Object.prototype);
  assert.equal(Object.hasOwn(redacted, '__proto__'), true);
  assert.equal(redacted.__proto__.authorization, '[REDACTED]');
  assert.equal(Object.hasOwn(redacted, 'constructor'), true);
  assert.equal(redacted.constructor, 'safe');
  assert.equal(redacted.prototype, 'safe');
  assert.equal(JSON.stringify(redacted).includes('proto-secret'), false);
});
