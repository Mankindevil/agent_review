import test from 'node:test';
import assert from 'node:assert/strict';
import { readA2AExecutionTuning } from '../src/execution-tuning.js';

test('defaults to multi-turn on and three repeats', () => {
  assert.deepEqual(readA2AExecutionTuning({}), {
    multiTurnEnabled: true,
    repeatCount: 3,
    requiredHiddenVariants: ['equivalent', 'boundary', 'multi-turn']
  });
});

test('exact false disables multi-turn; valid repeat count overrides', () => {
  assert.deepEqual(readA2AExecutionTuning({
    A2A_MULTI_TURN_ENABLED: 'false',
    A2A_REPEAT_COUNT: '1'
  }), {
    multiTurnEnabled: false,
    repeatCount: 1,
    requiredHiddenVariants: ['equivalent', 'boundary']
  });
});

test('rejects invalid repeat counts and non-exact false for multi-turn', () => {
  assert.equal(readA2AExecutionTuning({ A2A_MULTI_TURN_ENABLED: 'FALSE' }).multiTurnEnabled, true);
  assert.equal(readA2AExecutionTuning({ A2A_REPEAT_COUNT: '0' }).repeatCount, 3);
  assert.equal(readA2AExecutionTuning({ A2A_REPEAT_COUNT: '1.5' }).repeatCount, 3);
  assert.equal(readA2AExecutionTuning({ A2A_REPEAT_COUNT: 'abc' }).repeatCount, 3);
});
