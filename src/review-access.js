import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyParticipantAccess } from './participant-access.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ROLES = new Set(['judge', 'admin']);

export function isReviewGovernanceEnabled(env = process.env) {
  return String(env?.REVIEW_GOVERNANCE_ENABLED || '').toLowerCase() === 'true';
}

export function authenticatePrincipal(request, evaluation, env = process.env) {
  ignoreBodyIdentityFields(request);
  const token = bearerToken(request?.headers?.authorization);
  if (!token) return null;

  const tokenHash = sha256Buffer(token);
  for (const configured of readPrincipals(env?.REVIEW_PRINCIPALS_JSON)) {
    if (!sameHash(tokenHash, configured.tokenSha256)) continue;
    return {
      principalId: configured.principalId,
      displayName: configured.displayName,
      role: configured.role
    };
  }
  const participantHash = evaluation?.participantAccess?.tokenHash;
  if (verifyParticipantAccess(token, participantHash)) {
    return { principalId: 'participant', role: 'participant' };
  }
  return null;
}

export function requireRole(principal, roles) {
  if (!principal) throw accessError(401, 'authentication required');
  const allowed = new Set(Array.isArray(roles) ? roles : [roles]);
  if (!allowed.has(principal.role)) throw accessError(403, 'insufficient role');
  return principal;
}

export function isConfiguredJudge(principalId, env = process.env) {
  return readPrincipals(env?.REVIEW_PRINCIPALS_JSON).some((principal) =>
    principal.principalId === principalId && principal.role === 'judge'
  );
}

function readPrincipals(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) =>
    item &&
    typeof item.principalId === 'string' &&
    item.principalId.length > 0 &&
    typeof item.displayName === 'string' &&
    ROLES.has(item.role) &&
    typeof item.tokenSha256 === 'string' &&
    HASH_PATTERN.test(item.tokenSha256)
  );
}

function bearerToken(value) {
  const match = typeof value === 'string' ? value.match(/^Bearer ([^\s]+)$/u) : null;
  return match?.[1] ?? '';
}

function sha256Buffer(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function sameHash(actual, expectedHex) {
  if (typeof expectedHex !== 'string' || !HASH_PATTERN.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function accessError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function ignoreBodyIdentityFields(_request) {
  // Identity comes only from Authorization bearer tokens and configured hashes.
  // Client-supplied judgeId, role, or principalId fields in bodies are ignored.
}
