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

test('resumes a partially committed cell at its first missing turn with stable identities', async () => {
  const multi = {
    ...plan().tests.at(-1),
    repeatCount: 1
  };
  const cellIdentity = {
    testId: multi.testId,
    repeatIndex: 0,
    inputHash: multi.normalizedInputHash,
    timingPolicyHash: 'timing-v1',
    seed: 123,
    protocolConfigHash: 'protocol-v1',
    rubricVersion: 'a2a-black-box-v1'
  };
  const firstRun = succeeded({
    runId: 'persisted-run',
    testId: multi.testId,
    turnIndex: 0,
    repeatIndex: 0
  });
  const calls = [];
  const result = await executeTestPlan(
    { ...plan(), tests: [multi] },
    {
      ...baseOptions,
      timingPolicyHash: 'timing-v1',
      existingPartialIndex: [{
        cellIdentity,
        partialTestRun: {
          testId: multi.testId,
          repeatIndex: 0,
          attempts: [{
            attemptIndex: 0,
            runs: [firstRun]
          }]
        }
      }],
      executeTurn: async (options) => {
        calls.push(structuredClone(options));
        return succeeded(options);
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].turnIndex, 1);
  assert.equal(calls[0].contextId, firstRun.response.normalized.contextId);
  assert.match(calls[0].runId, /^run_[a-f0-9]{32}$/u);
  assert.match(calls[0].requestId, /^request_[a-f0-9]{32}$/u);
  assert.match(calls[0].messageId, /^message_[a-f0-9]{32}$/u);
  assert.equal(result.testRuns[0].runs[0].runId, 'persisted-run');
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

test('continues an interrupted Task only on the immediately following turn', async () => {
  const calls = [];
  const multi = {
    ...plan().tests.at(-1),
    repeatCount: 1,
    turns: [
      { input: { parts: [{ type: 'text', text: 'first' }] } },
      { input: { parts: [{ type: 'text', text: 'continue' }] } },
      { input: { parts: [{ type: 'text', text: 'new task' }] } }
    ]
  };
  await executeTestPlan(
    { ...plan(), tests: [multi] },
    {
      ...baseOptions,
      executeTurn: async (options) => {
        calls.push(structuredClone(options));
        const run = succeeded(options);
        run.response.normalized.taskId = `task-${options.turnIndex}`;
        run.outcome.lifecycle = options.turnIndex === 0
          ? 'interrupted'
          : 'completed';
        return run;
      }
    }
  );

  assert.equal(calls[0].taskId, undefined);
  assert.equal(calls[1].taskId, 'task-0');
  assert.equal(calls[2].taskId, undefined);
});

test('persists each completed cell before dispatching the next cell', async () => {
  const events = [];
  const original = plan().tests[0];
  await executeTestPlan(
    { ...plan(), tests: [{ ...original, repeatCount: 2 }] },
    {
      ...baseOptions,
      executeTurn: async (options) => {
        events.push(`run:${options.repeatIndex}`);
        return succeeded(options);
      },
      persistCell: async ({ testRun }) => {
        events.push(`cell:${testRun.repeatIndex}`);
      }
    }
  );

  assert.deepEqual(events, ['run:0', 'cell:0', 'run:1', 'cell:1']);
});

test('routes protocol recovery probes through the malformed-request executor', async () => {
  const recovery = {
    ...plan(),
    tests: [{
      ...plan().tests[0],
      testId: 'protocol_error_recovery',
      variantType: 'protocol-recovery',
      repeatCount: 1,
      criteria: [],
      protocolProbe: {
        malformedFirst: true,
        nextValidInputUsesFreshContext: true
      }
    }]
  };
  let normalCalls = 0;
  let recoveryCalls = 0;
  const execution = await executeTestPlan(recovery, {
    ...baseOptions,
    executeTurn: async (options) => {
      normalCalls += 1;
      return succeeded(options);
    },
    executeProtocolRecovery: async (options) => {
      recoveryCalls += 1;
      return {
        ...succeeded(options),
        protocolRecovery: {
          malformedRejected: true,
          validRequestUsedFreshContext: true
        }
      };
    }
  });
  const objective = buildObjectiveInputFromExecution(recovery, execution);

  assert.equal(normalCalls, 0);
  assert.equal(recoveryCalls, 1);
  assert.equal(objective.errorHandlingChecks[0].status, 'passed');
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
