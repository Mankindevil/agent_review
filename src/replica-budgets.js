export const REPLICA_BUILD_BUDGET_V1 = Object.freeze({
  wallClockMs: 300_000,
  maxTokens: 16_000,
  maxOutputBytes: 2 * 1024 * 1024,
  toolAllowlist: Object.freeze(['workspace-read', 'workspace-write']),
  network: 'none'
});

export const REPLICA_RUN_BUDGET_V1 = Object.freeze({
  maxTokens: 8_000,
  maxOutputBytes: 2 * 1024 * 1024,
  toolAllowlist: Object.freeze(['workspace-read', 'workspace-write']),
  network: 'none'
});
