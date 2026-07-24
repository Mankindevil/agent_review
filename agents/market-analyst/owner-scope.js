import { createHash } from 'node:crypto';

const OWNER_SCOPE_PATTERN = /^owner-sha256:[a-f0-9]{64}$/;
const MAX_PRINCIPAL_BYTES = 64 * 1024;
const MARKET_AGENT_PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
export const DEFAULT_MARKET_AGENT_PRINCIPAL_ID = 'panda-market-analyst';

export function ownerScope(value) {
  const principal = String(value || '');
  if (!principal || Buffer.byteLength(principal) > MAX_PRINCIPAL_BYTES) {
    throw new TypeError('owner principal must be nonempty and bounded');
  }
  return `owner-sha256:${createHash('sha256').update(principal).digest('hex')}`;
}

export function normalizeMarketAgentPrincipalId(value) {
  const principalId = value === undefined || value === ''
    ? DEFAULT_MARKET_AGENT_PRINCIPAL_ID
    : String(value);
  if (!MARKET_AGENT_PRINCIPAL_PATTERN.test(principalId)) {
    throw new TypeError(
      'MARKET_AGENT_PRINCIPAL_ID must be a stable non-secret identifier'
    );
  }
  return principalId;
}

export function principalOwnerScope(value) {
  const principalId = normalizeMarketAgentPrincipalId(value);
  return ownerScope(`market-agent-principal:${principalId}`);
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
