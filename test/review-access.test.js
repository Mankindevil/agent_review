import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  authenticatePrincipal,
  requireRole
} from '../src/review-access.js';

const participantToken = 'P'.repeat(43);
const judgeToken = 'judge-secret';
const env = {
  REVIEW_PRINCIPALS_JSON: JSON.stringify([
    {
      principalId: 'judge-1',
      displayName: '评委一',
      role: 'judge',
      tokenSha256: sha256(judgeToken)
    },
    {
      principalId: 'admin-1',
      displayName: '管理员',
      role: 'admin',
      tokenSha256: sha256('admin-secret')
    }
  ])
};
const evaluation = {
  participantAccess: { tokenHash: sha256(participantToken) }
};

function request(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('authenticates configured judge tokens without trusting a client judgeId', () => {
  const principal = authenticatePrincipal(request(judgeToken), evaluation, env);

  assert.deepEqual(principal, {
    principalId: 'judge-1',
    displayName: '评委一',
    role: 'judge'
  });
  assert.doesNotMatch(JSON.stringify(principal), /judge-secret/u);
});

test('authenticates the existing per-evaluation participant token', () => {
  assert.deepEqual(
    authenticatePrincipal(request(participantToken), evaluation, env),
    { principalId: 'participant', role: 'participant' }
  );
});

test('returns no principal for missing, malformed, or invalid tokens', () => {
  for (const token of [undefined, 'wrong-secret', 'bad token']) {
    assert.equal(authenticatePrincipal(request(token), evaluation, env), null);
  }
  assert.equal(authenticatePrincipal(request(judgeToken), evaluation, {
    REVIEW_PRINCIPALS_JSON: '{not-json}'
  }), null);
});

test('requires a server-authenticated matching role', () => {
  const judge = authenticatePrincipal(request(judgeToken), evaluation, env);

  assert.doesNotThrow(() => requireRole(judge, ['judge', 'admin']));
  assert.throws(
    () => requireRole(judge, ['admin']),
    (error) => error.statusCode === 403
  );
  assert.throws(
    () => requireRole(null, ['judge']),
    (error) => error.statusCode === 401
  );
});
