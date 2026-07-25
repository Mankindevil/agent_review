const ALL_HIDDEN_VARIANTS = Object.freeze(['equivalent', 'boundary', 'multi-turn']);
const NO_MULTI_TURN_VARIANTS = Object.freeze(['equivalent', 'boundary']);

export function readA2AExecutionTuning(env = {}) {
  const multiTurnEnabled = env.A2A_MULTI_TURN_ENABLED !== 'false';
  const parsed = Number(env.A2A_REPEAT_COUNT);
  const repeatCount = Number.isInteger(parsed) && parsed >= 1 ? parsed : 3;
  return Object.freeze({
    multiTurnEnabled,
    repeatCount,
    requiredHiddenVariants: multiTurnEnabled
      ? ALL_HIDDEN_VARIANTS
      : NO_MULTI_TURN_VARIANTS
  });
}

export function scoredVariantCount(requiredHiddenVariants) {
  return 1 + requiredHiddenVariants.length;
}
