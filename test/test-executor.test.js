import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObjectiveInputFromExecution,
  executeTestPlan
} from '../src/test-executor.js';
import { buildObjectiveMetrics } from '../src/objective-scoring.js';

function plan() {
  const variants = ['original', 'equivalent', 'boundary', 'multi-turn'];
  return {
    testPlanVersion: 'black-box-test-plan/v1',
    rubricVersion: 'a2a-black-box-v1',
    tests: variants.map((variantType) => ({
      testId: `risk:${variantType}`,
      sourceExampleId: 'risk',
      variantType,
      contextPolicy: variantType === 'multi-turn' ? 'reuse-within-example' : 'fresh',
      repeatCount: 3,
      normalizedInputHash: `${variantType}-input`,
      timing: { targetMs: 100, timeoutMs: 300 },
      criteria: [{
        id: 'done',
        type: 'contains',
        description: 'Completes the task.',
        expected: ['done'],
        required: true
      }],
      turns: variantType === 'multi-turn'
        ? [
            { input: { parts: [{ type: 'text', text: 'first' }] } },
            { input: { parts: [{ type: 'text', text: 'second' }] } }
          ]
        : [{ input: { parts: [{ type: 'text', text: variantType }] } }]
    }))
  };
}

function succeeded(options, suffix = '') {
  return {
    runId: options.runId,
    testId: options.testId,
    turnIndex: options.turnIndex,
    repeatIndex: options.repeatIndex,
    outcome: { status: 'succeeded' },
    response: {
      normalized: {
        contextId: options.contextId || `ctx-${options.testId}-${options.repeatIndex}`,
        taskId: null
      },
      currentOutput: { text: `done${suffix}`, data: null, artifacts: [] }
    },
    timing: { durationMs: 50, firstEventMs: null }
  };
}

const baseOptions = {
  card: { name: 'Agent' },
  protocolConfigHash: 'protocol-v1',
  seed: 123,
  createId: (() => {
    let index = 0;
    return () => `run-${index += 1}`;
  })()
};

test('executes the exact four-test by three-repeat matrix and scopes context per cell', async () => {
  const calls = [];
  const result = await executeTestPlan(plan(), {
    ...baseOptions,
    executeTurn: async (options) => {
      calls.push(structuredClone(options));
      return succeeded(options);
    }
  });

  assert.equal(result.testRuns.length, 12);
  assert.deepEqual(
    [...new Set(result.testRuns.map((run) => run.repeatIndex))],
    [0, 1, 2]
  );
  const multiCalls = calls.filter((call) => call.testId === 'risk:multi-turn');
  assert.equal(multiCalls.length, 6);
  for (let index = 0; index < multiCalls.length; index += 2) {
    assert.equal(Object.hasOwn(multiCalls[index], 'contextId'), false);
    assert.equal(
      multiCalls[index + 1].contextId,
      `ctx-risk:multi-turn-${multiCalls[index].repeatIndex}`
    );
  }
  assert.equal(
    calls.filter((call) => call.testId !== 'risk:multi-turn')
      .every((call) => !Object.hasOwn(call, 'contextId')),
    true
  );
});

test('reuses only exact locked existing cells and executes missing hidden cells once', async () => {
  const firstPlan = plan();
  const existingRunIndex = [0, 1, 2].map((repeatIndex) => ({
    cellIdentity: {
      testId: 'risk:original',
      repeatIndex,
      inputHash: 'original-input',
      timingPolicyHash: 'timing-v1',
      seed: 123,
      protocolConfigHash: 'protocol-v1',
      rubricVersion: 'a2a-black-box-v1'
    },
    testRun: {
      testId: 'risk:original',
      repeatIndex,
      status: 'scored-agent',
      runs: []
    }
  }));
  const calls = [];
  const result = await executeTestPlan(firstPlan, {
    ...baseOptions,
    timingPolicyHash: 'timing-v1',
    existingRunIndex,
    executeTurn: async (options) => {
      calls.push(options);
      return succeeded(options);
    }
  });

  assert.equal(result.testRuns.length, 12);
  assert.equal(calls.length, 3 + 3 + 6);
  assert.equal(calls.some((call) => call.testId === 'risk:original'), false);
  assert.equal(result.reusedCells.length, 3);
});

test('retains Agent failures, replaces one platform failure, and leaves unknown attribution pending', async () => {
  const oneCellPlan = plan();
  oneCellPlan.tests = [oneCellPlan.tests[0]];
  let mode = 'agent';
  let calls = 0;
  const executeTurn = async (options) => {
    calls += 1;
    if (mode === 'platform' && calls === 1) {
      return { ...succeeded(options), outcome: { status: 'platform-error' } };
    }
    if (mode === 'unknown') {
      return { ...succeeded(options), outcome: { status: 'unknown' } };
    }
    if (mode === 'agent') {
      return { ...succeeded(options), outcome: { status: 'agent-error' } };
    }
    return succeeded(options);
  };

  const agent = await executeTestPlan(
    { ...oneCellPlan, tests: [{ ...oneCellPlan.tests[0], repeatCount: 1 }] },
    { ...baseOptions, executeTurn }
  );
  assert.equal(agent.testRuns[0].status, 'scored-agent');
  assert.equal(calls, 1);

  mode = 'platform';
  calls = 0;
  const platform = await executeTestPlan(
    { ...oneCellPlan, tests: [{ ...oneCellPlan.tests[0], repeatCount: 1 }] },
    { ...baseOptions, executeTurn }
  );
  assert.equal(platform.testRuns[0].status, 'scored-agent');
  assert.equal(platform.testRuns[0].attempts.length, 2);
  assert.equal(calls, 2);

  mode = 'unknown';
  calls = 0;
  const unknown = await executeTestPlan(
    { ...oneCellPlan, tests: [{ ...oneCellPlan.tests[0], repeatCount: 1 }] },
    { ...baseOptions, executeTurn }
  );
  assert.equal(unknown.testRuns[0].status, 'attribution-pending');
  assert.equal(calls, 1);
});

test('persists each completed turn before dispatching the next one', async () => {
  const events = [];
  const multi = plan().tests.at(-1);
  await executeTestPlan(
    { ...plan(), tests: [{ ...multi, repeatCount: 1 }] },
    {
      ...baseOptions,
      executeTurn: async (options) => {
        events.push(`run:${options.turnIndex}`);
        return succeeded(options);
      },
      persistTurn: async ({ run }) => {
        events.push(`persist:${run.turnIndex}`);
      }
    }
  );

  assert.deepEqual(events, ['run:0', 'persist:0', 'run:1', 'persist:1']);
});

test('projects repeated execution into all six objective capability metrics', async () => {
  const execution = await executeTestPlan(plan(), {
    ...baseOptions,
    executeTurn: async (options) => ({
      ...succeeded(options),
      protocol: { validated: true },
      evidenceIds: [`ev-${options.testId}-${options.repeatIndex}`]
    })
  });
  const objectiveInput = buildObjectiveInputFromExecution(plan(), execution);
  const metrics = buildObjectiveMetrics(objectiveInput);

  assert.deepEqual(metrics.map((metric) => metric.id), [
    'testSuccess',
    'robustness',
    'contextContinuity',
    'a2aCompliance',
    'efficiency',
    'claimErrorHandling'
  ]);
  assert.equal(metrics.find((metric) => metric.id === 'testSuccess').score, 100);
  assert.equal(metrics.find((metric) => metric.id === 'robustness').score, 100);
  assert.equal(metrics.find((metric) => metric.id === 'contextContinuity').score, 100);
});
