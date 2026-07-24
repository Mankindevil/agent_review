import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceRecord, redactEvidence } from '../src/evidence.js';

test('creates deterministic deeply immutable evidence records without retaining mutable payload input', () => {
  const payload = { z: [1, { ok: true }], a: 'value' };
  const record = createEvidenceRecord({
    evidenceId: 'ev_immutable',
    runId: 'run_1',
    grade: 'A',
    kind: 'transport',
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
    kind: 'protocol',
    capturedAt: '2026-07-24T10:00:01.000Z',
    payload: { a: 'value', z: [1, { ok: true }] }
  });

  assert.equal(record.evidenceVersion, '1.0');
  assert.match(record.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(record.payloadHash, samePayload.payloadHash);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.payload), true);
  assert.equal(Object.isFrozen(record.payload.z), true);
  payload.z[1].ok = false;
  payload.a = 'changed';
  assert.deepEqual(record.payload, { z: [1, { ok: true }], a: 'value' });
  assert.throws(() => { record.payload.z.push(2); }, TypeError);
});

test('rejects invalid evidence grades and non-JSON payloads', () => {
  assert.throws(() => createEvidenceRecord({ grade: 'E', payload: {} }), /invalid evidence grade/i);
  assert.throws(() => createEvidenceRecord({ grade: 'A', payload: { value: undefined } }), /JSON/i);
});

test('recursively redacts credentials, URL secrets, PII, JWTs, cookies, and explicit run secrets', () => {
  const input = {
    headers: {
      authorization: 'Bearer aaa.bbb.ccc',
      cookie: 'sid=cookie-value',
      harmless: 'keep-me'
    },
    url: 'https://agent-user:agent-pass@agent.example/file?signature=url-secret&plain=also-secret',
    message: 'mail analyst@example.com or call 13800138000; token aaa.bbb.ccc',
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
    'aaa.bbb.ccc', 'cookie-value', 'agent-user', 'agent-pass',
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
