import { createHash } from 'node:crypto';

const OWNER_SCOPE_PATTERN = /^owner-sha256:[a-f0-9]{64}$/;
const MAX_PRINCIPAL_BYTES = 64 * 1024;

export function ownerScope(value) {
  const principal = String(value || '');
  if (!principal || Buffer.byteLength(principal) > MAX_PRINCIPAL_BYTES) {
    throw new TypeError('owner principal must be nonempty and bounded');
  }
  return `owner-sha256:${createHash('sha256').update(principal).digest('hex')}`;
}

export function normalizeOwnerScope(value) {
  const candidate = String(value || '');
  return OWNER_SCOPE_PATTERN.test(candidate) ? candidate : ownerScope(candidate);
}

export function requireOwnerScope(value) {
  const candidate = String(value || '');
  if (!OWNER_SCOPE_PATTERN.test(candidate)) {
    throw new TypeError('owner scope is invalid');
  }
  return candidate;
}

export function isOwnerScope(value) {
  return OWNER_SCOPE_PATTERN.test(String(value || ''));
}
