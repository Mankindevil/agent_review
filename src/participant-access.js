import {
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export function createParticipantAccess() {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: createHash('sha256').update(token, 'utf8').digest('hex')
  };
}

export function verifyParticipantAccess(token, storedHash) {
  if (
    typeof token !== 'string' ||
    !TOKEN_PATTERN.test(token) ||
    typeof storedHash !== 'string' ||
    !HASH_PATTERN.test(storedHash)
  ) {
    return false;
  }
  const suppliedHash = createHash('sha256').update(token, 'utf8').digest();
  const expectedHash = Buffer.from(storedHash, 'hex');
  return suppliedHash.length === expectedHash.length &&
    timingSafeEqual(suppliedHash, expectedHash);
}
