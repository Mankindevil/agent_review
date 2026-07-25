const INFRASTRUCTURE_CODES = new Set([
  'HEALTH_FAILED', 'SANDBOX_STARTUP_FAILED', 'ADAPTER_TRANSPORT_FAILED', 'PLATFORM_STORAGE_FAILED',
  'BUILD_FAILED', 'UNSAFE_REPLICA_ARTIFACT', 'EXECUTION_BOUNDARY_NOT_STARTED',
  'REPLICA_ENFORCEMENT_UNPROVEN', 'REPLICA_TOKEN_USAGE_UNPROVEN',
  'REPLICA_WALL_CLOCK_EXCEEDED', 'REPLICA_OUTPUT_BYTES_EXCEEDED', 'REPLICA_TOKEN_CAP_EXCEEDED', 'NETWORK_DENIED',
  'TIMEOUT', 'SKILL_CRASH', 'INVALID_REPLICA_OUTPUT'
]);
const SKILL_CODES = new Set([
  'TIMEOUT', 'SKILL_CRASH', 'INVALID_REPLICA_OUTPUT', 'NETWORK_DENIED',
  'REPLICA_WALL_CLOCK_EXCEEDED', 'REPLICA_OUTPUT_BYTES_EXCEEDED', 'REPLICA_TOKEN_CAP_EXCEEDED'
]);

export function classifyReplicaFailure(error, healthEvidence = {}) {
  const code = error?.code || inferCode(error?.message) || 'UNKNOWN_REPLICA_FAILURE';
  if (SKILL_CODES.has(code) && healthEvidence?.artifactValid === true && healthEvidence?.executionStarted === true) {
    return { source: 'replica-skill', code, scoreSemantics: 'score-zero' };
  }
  if (INFRASTRUCTURE_CODES.has(code) || healthEvidence?.ready === false) {
    return { source: 'replica-infrastructure', code, scoreSemantics: 'invalidate-replica' };
  }
  return { source: 'unknown', code, scoreSemantics: 'hold-for-review' };
}

function inferCode(message) {
  const value = String(message || '');
  if (/timed?\s*out|timeout/iu.test(value)) return 'TIMEOUT';
  if (/invalid.*output/iu.test(value)) return 'INVALID_REPLICA_OUTPUT';
  return null;
}
