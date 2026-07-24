import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createParticipantAccess,
  verifyParticipantAccess
} from '../src/participant-access.js';

test('creates one 32-byte base64url participant token and stable SHA-256 identity', () => {
  const access = createParticipantAccess();
  assert.match(access.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(access.hash, /^[a-f0-9]{64}$/u);
  assert.equal(verifyParticipantAccess(access.token, access.hash), true);
  const wrong = `${access.token.slice(0, -1)}${access.token.at(-1) === 'x' ? 'y' : 'x'}`;
  assert.equal(verifyParticipantAccess(wrong, access.hash), false);
});

test('participant verification rejects attacker-controlled malformed values without throwing', () => {
  for (const [token, hash] of [
    [undefined, '0'.repeat(64)],
    ['short', '0'.repeat(64)],
    ['a'.repeat(43) + '=', '0'.repeat(64)],
    ['a'.repeat(43), 'not-a-hash'],
    ['a'.repeat(43), '0'.repeat(63)]
  ]) {
    assert.doesNotThrow(() => verifyParticipantAccess(token, hash));
    assert.equal(verifyParticipantAccess(token, hash), false);
  }
});
