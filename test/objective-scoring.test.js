import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateObjectiveCapability,
  buildObjectiveMetrics,
  durationScore
} from '../src/objective-scoring.js';
import { RUBRIC_V1 } from '../src/rubric.js';

const acceptance = ({
  requiredExecutable = 1,
  semanticSuccess = true,
  statuses = ['passed']
} = {}) => ({
  requiredExecutable,
  passedRequiredExecutable: semanticSuccess ? requiredExecutable : 0,
  semanticSuccess,
  checks: statuses.map((status, index) => ({
    id: `required-${index}`,
    type: 'exact',
    required: true,
    status
  }))
});

const run = (overrides = {}) => ({
  runId: 'run-0',
  repeatIndex: 0,
  attribution: 'agent',
  terminalSuccess: true,
  acceptance: acceptance(),
  schemaFingerprint: null,
  timing: {
    durationMs: 50,
    firstEventMs: null,
    timedOut: false
  },
  evidenceIds: ['ev_first'],
  ...overrides
});

const plannedTest = (overrides = {}) => ({
  testId: 'test-a',
  weight: 1,
  repeatCount: 1,
  requiredExecutable: 1,
  requiresState: false,
  timingPolicy: {
    targetMs: 100,
    timeoutMs: 300,
    streaming: false
  },
  runs: [run()],
  ...overrides
});

const metricInput = (overrides = {}) => ({
  plannedTests: [],
  contextChecks: [],
  a2aChecks: [],
  claimChecks: [],
  errorHandlingChecks: [],
  ...overrides
});

const observationCheck = (id, status, overrides = {}) => ({
  id,
  status,
  weight: 1,
  evidenceIds: [],
  ...overrides
});

function byId(metrics, id) {
  return metrics.find((metric) => metric.id === id);
}

function assertClose(actual, expected, epsilon = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test('exports the exact deeply frozen rubric', () => {
  assert.deepEqual(RUBRIC_V1, {
    version: 'a2a-black-box-v1',
    dimensions: {
      scenarioValue: {
        agentNecessity: 30,
        researchDecisionValue: 30,
        utilityReuse: 25,
        productNovelty: 15
      },
      professionalism: {
        taskCompletion: 25,
        methodAssumptions: 25,
        evidenceReasoning: 25,
        riskUncertainty: 15,
        artifactUsability: 10
      },
      agentCapability: {
        testSuccess: 30,
        robustness: 20,
        contextContinuity: 15,
        a2aCompliance: 15,
        efficiency: 10,
        claimErrorHandling: 10
      }
    },
    seatWeights: {
      scenarioValue: { model: 0.4, human: 0.6 },
      professionalism: { model: 0.4, human: 0.6 },
      agentCapability: { objective: 0.5, model: 0.2, human: 0.3 }
    }
  });
  for (const value of [
    RUBRIC_V1,
    RUBRIC_V1.dimensions,
    RUBRIC_V1.dimensions.agentCapability,
    RUBRIC_V1.seatWeights,
    RUBRIC_V1.seatWeights.agentCapability
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => {
    RUBRIC_V1.dimensions.agentCapability.testSuccess = 999;
  }, TypeError);
});

test('durationScore follows the locked linear boundaries and rejects invalid timing', () => {
  assert.equal(durationScore(50, 100, 300), 100);
  assert.equal(durationScore(100, 100, 300), 100);
  assert.equal(durationScore(200, 100, 300), 50);
  assert.equal(durationScore(300, 100, 300), 0);
  assert.equal(durationScore(350, 100, 300), 0);

  for (const args of [
    [null, 100, 300],
    ['50', 100, 300],
    [50, 100, 100],
    [50, -1, 300],
    [-1, 100, 300],
    [Number.NaN, 100, 300],
    [50, Number.POSITIVE_INFINITY, 300]
  ]) {
    assert.throws(() => durationScore(...args), /duration|target|timeout|finite/i);
  }
});

test('calculates weighted executable success while terminal-only tests stay uncovered', () => {
  const metrics = buildObjectiveMetrics(metricInput({
    plannedTests: [
      plannedTest({
        testId: 'test-a',
        weight: 2,
        runs: [run({ runId: 'run-a', evidenceIds: ['ev_a'] })]
      }),
      plannedTest({
        testId: 'test-b',
        weight: 1,
        runs: [run({
          runId: 'run-b',
          terminalSuccess: false,
          acceptance: acceptance({ semanticSuccess: false, statuses: ['failed'] }),
          evidenceIds: ['ev_b']
        })]
      }),
      plannedTest({
        testId: 'test-c',
        weight: 1,
        requiredExecutable: 0,
        runs: [run({
          runId: 'run-c',
          acceptance: acceptance({
            requiredExecutable: 0,
            semanticSuccess: null,
            statuses: []
          }),
          evidenceIds: ['ev_c']
        })]
      })
    ]
  }));
  const success = byId(metrics, 'testSuccess');

  assert.equal(success.applicable, true);
  assert.equal(success.numerator, 2);
  assert.equal(success.denominator, 3);
  assert.equal(success.score, 66.66666666666667);
  assert.equal(success.coverage, 0.75);
  assert.deepEqual(success.evidenceIds, ['ev_a', 'ev_b', 'ev_c']);
});

test('marks terminal-only success N/A and keeps platform/pending cells out of score', () => {
  const terminalOnly = buildObjectiveMetrics(metricInput({
    plannedTests: [plannedTest({
      requiredExecutable: 0,
      runs: [run({
        acceptance: acceptance({
          requiredExecutable: 0,
          semanticSuccess: null,
          statuses: []
        })
      })]
    })]
  }));
  assert.deepEqual(
    {
      applicable: byId(terminalOnly, 'testSuccess').applicable,
      score: byId(terminalOnly, 'testSuccess').score,
      numerator: byId(terminalOnly, 'testSuccess').numerator,
      denominator: byId(terminalOnly, 'testSuccess').denominator,
      coverage: byId(terminalOnly, 'testSuccess').coverage
    },
    { applicable: false, score: null, numerator: 0, denominator: 0, coverage: 0 }
  );

  const attributed = buildObjectiveMetrics(metricInput({
    plannedTests: [
      plannedTest({
        testId: 'test-a',
        weight: 2,
        repeatCount: 2,
        runs: [
          run({ runId: 'run-a0', repeatIndex: 0 }),
          run({
            runId: 'run-a1',
            repeatIndex: 1,
            attribution: 'platform',
            evidenceIds: ['ev_platform']
          })
        ]
      }),
      plannedTest({
        testId: 'test-b',
        weight: 1,
        runs: [run({
          runId: 'run-b',
          terminalSuccess: false,
          acceptance: acceptance({ semanticSuccess: false, statuses: ['failed'] })
        })]
      }),
      plannedTest({
        testId: 'test-c',
        weight: 1,
        requiredExecutable: 0,
        runs: [run({
          runId: 'run-c',
          acceptance: acceptance({
            requiredExecutable: 0,
            semanticSuccess: null,
            statuses: []
          })
        })]
      })
    ]
  }));
  const success = byId(attributed, 'testSuccess');
  assert.equal(success.numerator, 1);
  assert.equal(success.denominator, 2);
  assert.equal(success.score, 50);
  assert.equal(success.coverage, 0.5);
  assert.ok(success.gaps.includes('platform:test-a:1'));
});

test('uses planned executable criteria for applicability when every cell is unavailable', () => {
  const missing = buildObjectiveMetrics(metricInput({
    plannedTests: [plannedTest({
      requiredExecutable: 1,
      runs: []
    })]
  }));
  const success = byId(missing, 'testSuccess');
  assert.equal(success.applicable, true);
  assert.equal(success.score, null);
  assert.equal(success.coverage, 0);
  assert.ok(success.gaps.includes('missing:test-a:0'));

  const platform = buildObjectiveMetrics(metricInput({
    plannedTests: [plannedTest({
      requiredExecutable: 1,
      runs: [run({ attribution: 'platform' })]
    })]
  }));
  assert.equal(byId(platform, 'testSuccess').applicable, true);
  assert.ok(byId(platform, 'testSuccess').gaps.includes('platform:test-a:0'));
});

test('computes pairwise robustness with independent terminal and result components', () => {
  const metrics = buildObjectiveMetrics(metricInput({
    plannedTests: [plannedTest({
      repeatCount: 3,
      runs: [
        run({ runId: 'run-0', repeatIndex: 0 }),
        run({ runId: 'run-1', repeatIndex: 1 }),
        run({
          runId: 'run-2',
          repeatIndex: 2,
          terminalSuccess: false
        })
      ]
    })]
  }));
  const robustness = byId(metrics, 'robustness');

  assert.equal(robustness.applicable, true);
  assertClose(robustness.score, 66.66666666666666);
  assert.equal(robustness.coverage, 1);
});

test('robustness lowers coverage for missing pairs and redistributes observable component weight', () => {
  const partial = buildObjectiveMetrics(metricInput({
    plannedTests: [plannedTest({
      repeatCount: 3,
      requiredExecutable: 0,
      runs: [
        run({
          runId: 'run-0',
          repeatIndex: 0,
          acceptance: acceptance({
            requiredExecutable: 0,
            semanticSuccess: null,
            statuses: []
          }),
          schemaFingerprint: null
        }),
        run({
          runId: 'run-1',
          repeatIndex: 1,
          acceptance: acceptance({
            requiredExecutable: 0,
            semanticSuccess: null,
            statuses: []
          }),
          schemaFingerprint: null
        }),
        run({
          runId: 'run-2',
          repeatIndex: 2,
          attribution: 'platform',
          acceptance: acceptance({
            requiredExecutable: 0,
            semanticSuccess: null,
            statuses: []
          })
        })
      ]
    })]
  }));
  const robustness = byId(partial, 'robustness');

  assert.equal(robustness.score, 100);
  assertClose(robustness.coverage, 1 / 6);
  assert.ok(robustness.gaps.some((gap) => gap.includes('result')));
  assert.ok(robustness.gaps.some((gap) => gap.includes('platform')));
});

test('scores explicit context, A2A, and claim/error observations only', () => {
  const metrics = buildObjectiveMetrics(metricInput({
    contextChecks: [
      observationCheck('retention', 'passed', { kind: 'retention' }),
      observationCheck('correction', 'failed', { kind: 'correction' }),
      observationCheck('isolation', 'unavailable', { kind: 'isolation' })
    ],
    a2aChecks: [
      observationCheck('lifecycle-failed-task', 'passed'),
      observationCheck('malformed-part', 'failed')
    ],
    claimChecks: [
      observationCheck('optional-claim', 'not-applicable')
    ],
    errorHandlingChecks: [
      observationCheck('invalid-request', 'passed'),
      observationCheck('timeout-recovery', 'failed')
    ]
  }));

  const context = byId(metrics, 'contextContinuity');
  assert.equal(context.applicable, true);
  assert.equal(context.score, 50);
  assertClose(context.coverage, 2 / 3);
  assert.ok(context.gaps.includes('unavailable:isolation'));

  const compliance = byId(metrics, 'a2aCompliance');
  assert.equal(compliance.applicable, true);
  assert.equal(compliance.score, 50);
  assert.equal(compliance.coverage, 1);

  const claimError = byId(metrics, 'claimErrorHandling');
  assert.equal(claimError.applicable, true);
  assert.equal(claimError.score, 50);
  assert.equal(claimError.coverage, 1);
});

test('context applicability comes from explicit planned checks, including isolation-only checks', () => {
  const none = buildObjectiveMetrics(metricInput({
    plannedTests: [plannedTest({ requiresState: true })]
  }));
  assert.equal(byId(none, 'contextContinuity').applicable, false);

  const isolation = buildObjectiveMetrics(metricInput({
    plannedTests: [plannedTest({ requiresState: false })],
    contextChecks: [
      observationCheck('isolation-only', 'passed', { kind: 'isolation' })
    ]
  }));
  assert.equal(byId(isolation, 'contextContinuity').applicable, true);
  assert.equal(byId(isolation, 'contextContinuity').score, 100);
});

test('scores non-streaming, streaming, timeout, platform, and pending efficiency attribution', () => {
  const metrics = buildObjectiveMetrics(metricInput({
    plannedTests: [
      plannedTest({
        testId: 'nonstream',
        weight: 1,
        runs: [run({
          runId: 'run-nonstream',
          timing: { durationMs: 200, firstEventMs: null, timedOut: false }
        })]
      }),
      plannedTest({
        testId: 'stream',
        weight: 1,
        timingPolicy: { targetMs: 100, timeoutMs: 300, streaming: true },
        runs: [run({
          runId: 'run-stream',
          timing: { durationMs: 200, firstEventMs: 50, timedOut: false }
        })]
      }),
      plannedTest({
        testId: 'timeout',
        weight: 1,
        timingPolicy: { targetMs: 100, timeoutMs: 300, streaming: true },
        runs: [run({
          runId: 'run-timeout',
          timing: { durationMs: 300, firstEventMs: 50, timedOut: true }
        })]
      }),
      plannedTest({
        testId: 'platform',
        weight: 1,
        runs: [run({
          runId: 'run-platform',
          attribution: 'platform',
          timing: { durationMs: null, firstEventMs: null, timedOut: false }
        })]
      }),
      plannedTest({
        testId: 'pending',
        weight: 1,
        runs: [run({
          runId: 'run-pending',
          attribution: 'pending',
          timing: { durationMs: null, firstEventMs: null, timedOut: false }
        })]
      })
    ]
  }));
  const efficiency = byId(metrics, 'efficiency');

  assert.equal(efficiency.numerator, 115);
  assert.equal(efficiency.denominator, 3);
  assertClose(efficiency.score, 115 / 3);
  assert.equal(efficiency.coverage, 0.6);
  assert.ok(efficiency.gaps.includes('platform:platform:0'));
  assert.ok(efficiency.gaps.includes('pending:pending:0'));
});

test('keeps perfect efficiency inside 0..100 across fractional test weights', () => {
  const plannedTests = Array.from({ length: 8 }, (_, testIndex) =>
    plannedTest({
      testId: `fractional-${testIndex}`,
      weight: 0.125,
      repeatCount: 3,
      runs: Array.from({ length: 3 }, (_, repeatIndex) => run({
        runId: `fractional-${testIndex}-${repeatIndex}`,
        repeatIndex
      }))
    })
  );
  const metrics = buildObjectiveMetrics(metricInput({ plannedTests }));
  const efficiency = byId(metrics, 'efficiency');

  assert.equal(efficiency.score, 100);
  assert.doesNotThrow(() => aggregateObjectiveCapability(metrics));
});

test('missing streaming first-event timing is unavailable rather than coerced', () => {
  const metrics = buildObjectiveMetrics(metricInput({
    plannedTests: [plannedTest({
      timingPolicy: { targetMs: 100, timeoutMs: 300, streaming: true },
      runs: [run({
        timing: { durationMs: 200, firstEventMs: null, timedOut: false }
      })]
    })]
  }));
  const efficiency = byId(metrics, 'efficiency');
  assert.equal(efficiency.score, null);
  assert.equal(efficiency.coverage, 0);
  assert.ok(efficiency.gaps.includes('missing-first-event:test-a:0'));
});

test('rejects duplicate planned cells instead of selecting a best result', () => {
  assert.throws(
    () => buildObjectiveMetrics(metricInput({
      plannedTests: [plannedTest({
        runs: [
          run({
            runId: 'run-failed',
            terminalSuccess: false,
            acceptance: acceptance({ semanticSuccess: false, statuses: ['failed'] })
          }),
          run({ runId: 'run-passed' })
        ]
      })]
    })),
    /duplicate|repeat|cell/i
  );
});

test('rejects contradictory acceptance observations and plan mismatches', () => {
  const contradictory = [
    acceptance({
      requiredExecutable: 1,
      semanticSuccess: true,
      statuses: ['failed']
    }),
    {
      ...acceptance(),
      passedRequiredExecutable: 0,
      semanticSuccess: true
    },
    {
      ...acceptance(),
      checks: [
        {
          id: 'duplicate',
          type: 'exact',
          required: true,
          status: 'passed'
        },
        {
          id: 'duplicate',
          type: 'contains',
          required: true,
          status: 'passed'
        }
      ],
      requiredExecutable: 2,
      passedRequiredExecutable: 2
    }
  ];
  for (const item of contradictory) {
    assert.throws(
      () => buildObjectiveMetrics(metricInput({
        plannedTests: [plannedTest({
          requiredExecutable: item.requiredExecutable,
          runs: [run({ acceptance: item })]
        })]
      })),
      /acceptance|required|passed|semantic|duplicate|check/i
    );
  }

  assert.throws(
    () => buildObjectiveMetrics(metricInput({
      plannedTests: [plannedTest({
        requiredExecutable: 2,
        runs: [run({ acceptance: acceptance() })]
      })]
    })),
    /planned|requiredExecutable|acceptance/i
  );

  assert.throws(
    () => buildObjectiveMetrics(metricInput({
      plannedTests: [plannedTest({
        runs: [run({
          acceptance: {
            ...acceptance(),
            injected: 'not part of the closed observation'
          }
        })]
      })]
    })),
    /unknown|acceptance/i
  );

  const withInjectedCheck = acceptance();
  withInjectedCheck.checks[0].evidenceId = 'agent-controlled';
  assert.throws(
    () => buildObjectiveMetrics(metricInput({
      plannedTests: [plannedTest({
        runs: [run({ acceptance: withInjectedCheck })]
      })]
    })),
    /unknown|check/i
  );
});

test('rejects unknown or missing acceptance check types', () => {
  for (const mutate of [
    (check) => { check.type = 'bogus'; },
    (check) => { delete check.type; }
  ]) {
    const observed = acceptance();
    mutate(observed.checks[0]);
    assert.throws(
      () => buildObjectiveMetrics(metricInput({
        plannedTests: [plannedTest({
          runs: [run({ acceptance: observed })]
        })]
      })),
      /acceptance|check|type/i
    );
  }
});

test('validates safe observation IDs and stably deduplicates prevalidated evidence IDs', () => {
  const metrics = buildObjectiveMetrics(metricInput({
    a2aChecks: [
      observationCheck('binding', 'passed', {
        evidenceIds: ['ev_second', 'ev_first', 'ev_second']
      }),
      observationCheck('lifecycle', 'passed', {
        evidenceIds: ['ev_first', 'ev_third']
      })
    ]
  }));
  assert.deepEqual(
    byId(metrics, 'a2aCompliance').evidenceIds,
    ['ev_second', 'ev_first', 'ev_third']
  );

  assert.throws(
    () => buildObjectiveMetrics(metricInput({
      a2aChecks: [
        observationCheck('binding', 'passed', { evidenceIds: ['../agent-id'] })
      ]
    })),
    /evidence|identifier/i
  );
});

test('does not mutate deeply frozen objective input', () => {
  const input = metricInput({
    plannedTests: [plannedTest({
      repeatCount: 2,
      runs: [
        run({ runId: 'run-1', repeatIndex: 1 }),
        run({ runId: 'run-0', repeatIndex: 0 })
      ]
    })],
    a2aChecks: [observationCheck('binding', 'passed')]
  });
  const before = structuredClone(input);
  deepFreeze(input);

  assert.doesNotThrow(() => buildObjectiveMetrics(input));
  assert.deepEqual(input, before);
});

test('aggregates exact canonical weights, N/A redistribution, and original coverage', () => {
  const metrics = [
    metric('testSuccess', false, null, 0),
    metric('robustness', true, 80, 1),
    metric('contextContinuity', false, null, 0),
    metric('a2aCompliance', true, 100, 1),
    metric('efficiency', true, 50, 1),
    metric('claimErrorHandling', true, 60, 0.5)
  ];
  const before = structuredClone(metrics);
  const result = aggregateObjectiveCapability(metrics, RUBRIC_V1);

  assert.equal(result.status, 'complete');
  assert.equal(result.score, 76.36363636363636);
  assert.equal(result.coverage, 0.5);
  assert.equal(result.provisional, true);
  assert.equal(byId(result.metrics, 'a2aCompliance').weight, 15);
  assert.deepEqual(metrics, before);
});

test('aggregate distinguishes incomplete applicable metrics from unavailable scoring', () => {
  const incomplete = aggregateObjectiveCapability([
    metric('testSuccess', true, null, 0),
    metric('robustness', true, 80, 1),
    metric('contextContinuity', false, null, 0),
    metric('a2aCompliance', true, 100, 1),
    metric('efficiency', true, 50, 1),
    metric('claimErrorHandling', true, 60, 1)
  ], RUBRIC_V1);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.score, 76.36363636363636);

  const unavailable = aggregateObjectiveCapability([
    metric('testSuccess', true, null, 0),
    metric('robustness', false, null, 0),
    metric('contextContinuity', false, null, 0),
    metric('a2aCompliance', true, null, 0),
    metric('efficiency', true, null, 0),
    metric('claimErrorHandling', true, null, 0)
  ], RUBRIC_V1);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.score, null);
});

test('aggregate uses an exact 0.70 provisional boundary and rejects metric set drift', () => {
  const complete = [
    metric('testSuccess', true, 100, 1),
    metric('robustness', true, 100, 1),
    metric('contextContinuity', true, 100, 0),
    metric('a2aCompliance', true, 100, 1),
    metric('efficiency', true, 100, 0.5),
    metric('claimErrorHandling', true, 100, 0)
  ];
  const exact = aggregateObjectiveCapability(complete, RUBRIC_V1);
  assert.equal(exact.coverage, 0.7);
  assert.equal(exact.provisional, false);

  const below = structuredClone(complete);
  byId(below, 'efficiency').coverage = 0.49999;
  assert.equal(
    aggregateObjectiveCapability(below, RUBRIC_V1).provisional,
    true
  );

  assert.throws(
    () => aggregateObjectiveCapability(complete.slice(0, -1), RUBRIC_V1),
    /six|metric|missing/i
  );
  assert.throws(
    () => aggregateObjectiveCapability([...complete, complete[0]], RUBRIC_V1),
    /six|metric|duplicate/i
  );
});

test('aggregate rejects unknown fields and non-canonical caller weights', () => {
  const complete = [
    metric('testSuccess', true, 100, 1),
    metric('robustness', true, 100, 1),
    metric('contextContinuity', true, 100, 1),
    metric('a2aCompliance', true, 100, 1),
    metric('efficiency', true, 100, 1),
    metric('claimErrorHandling', true, 100, 1)
  ];

  const injected = structuredClone(complete);
  injected[0].extra = { callerOwned: true };
  assert.throws(
    () => aggregateObjectiveCapability(injected, RUBRIC_V1),
    /unknown|metric|field/i
  );

  const reweighted = structuredClone(complete);
  byId(reweighted, 'a2aCompliance').weight = 999;
  assert.throws(
    () => aggregateObjectiveCapability(reweighted, RUBRIC_V1),
    /weight|canonical|metric/i
  );
});

test('aggregate rejects incoherent metric arithmetic and non-applicable values', () => {
  const complete = [
    metric('testSuccess', true, 100, 1),
    metric('robustness', true, 100, 1),
    metric('contextContinuity', true, 100, 1),
    metric('a2aCompliance', true, 100, 1),
    metric('efficiency', true, 100, 1),
    metric('claimErrorHandling', true, 100, 1)
  ];
  const incoherent = [
    { id: 'testSuccess', overrides: { score: 100, numerator: 0, denominator: 0 } },
    { id: 'robustness', overrides: { score: null, numerator: 1, denominator: 0 } },
    { id: 'a2aCompliance', overrides: { score: null, numerator: 1, denominator: 2 } },
    { id: 'efficiency', overrides: { score: 40, numerator: 50, denominator: 1 } }
  ];
  for (const { id, overrides } of incoherent) {
    const metrics = structuredClone(complete);
    Object.assign(byId(metrics, id), overrides);
    assert.throws(
      () => aggregateObjectiveCapability(metrics, RUBRIC_V1),
      /metric|score|numerator|denominator|coherent/i
    );
  }

  for (const overrides of [
    { coverage: 0.1 },
    { score: 0 },
    { numerator: 0.1 },
    { denominator: 1 }
  ]) {
    const metrics = structuredClone(complete);
    Object.assign(
      byId(metrics, 'contextContinuity'),
      { applicable: false, score: null, coverage: 0, numerator: 0, denominator: 0 },
      overrides
    );
    assert.throws(
      () => aggregateObjectiveCapability(metrics, RUBRIC_V1),
      /non-applicable|metric|zero|null/i
    );
  }
});

test('aggregate returns a canonical result without aliasing frozen caller metrics', () => {
  const metrics = [
    metric('testSuccess', true, 100, 1, {
      evidenceIds: ['ev_first'],
      gaps: ['gap:first']
    }),
    metric('robustness', true, 80, 1),
    metric('contextContinuity', false, null, 0),
    metric('a2aCompliance', true, 100, 1),
    metric('efficiency', true, 50, 1),
    metric('claimErrorHandling', true, 60, 0.5)
  ];
  const before = structuredClone(metrics);
  deepFreeze(metrics);

  const result = aggregateObjectiveCapability(metrics, RUBRIC_V1);
  const output = byId(result.metrics, 'testSuccess');
  assert.deepEqual(Object.keys(output), [
    'id', 'weight', 'applicable', 'coverage', 'score',
    'numerator', 'denominator', 'evidenceIds', 'gaps'
  ]);
  assert.notStrictEqual(output, metrics[0]);
  assert.notStrictEqual(output.evidenceIds, metrics[0].evidenceIds);
  assert.notStrictEqual(output.gaps, metrics[0].gaps);

  output.evidenceIds.push('ev_second');
  output.gaps.push('gap:second');
  output.coverage = 0;
  assert.deepEqual(metrics, before);
});

test('aggregate rejects a frozen metric accessor without invoking it', () => {
  let scoreReads = 0;
  const dynamic = metric('testSuccess', true, 50, 1);
  Object.defineProperty(dynamic, 'score', {
    enumerable: true,
    configurable: true,
    get() {
      scoreReads += 1;
      return scoreReads < 5 ? 50 : 100;
    }
  });
  Object.freeze(dynamic.evidenceIds);
  Object.freeze(dynamic.gaps);
  Object.freeze(dynamic);
  const metrics = [
    dynamic,
    metric('robustness', true, 50, 1),
    metric('contextContinuity', true, 50, 1),
    metric('a2aCompliance', true, 50, 1),
    metric('efficiency', true, 50, 1),
    metric('claimErrorHandling', true, 50, 1)
  ];

  assert.throws(
    () => aggregateObjectiveCapability(metrics, RUBRIC_V1),
    /accessor|descriptor|metric|data/i
  );
  assert.equal(scoreReads, 0);
});

test('aggregate rejects hidden and symbol metric fields', () => {
  const hidden = metric('testSuccess', true, 100, 1);
  Object.defineProperty(hidden, 'extra', {
    value: 'hidden',
    enumerable: false
  });
  const symbol = metric('testSuccess', true, 100, 1);
  symbol[Symbol('extra')] = 'symbol';

  for (const item of [hidden, symbol]) {
    const metrics = [
      item,
      metric('robustness', true, 100, 1),
      metric('contextContinuity', true, 100, 1),
      metric('a2aCompliance', true, 100, 1),
      metric('efficiency', true, 100, 1),
      metric('claimErrorHandling', true, 100, 1)
    ];
    assert.throws(
      () => aggregateObjectiveCapability(metrics, RUBRIC_V1),
      /unknown|metric|field|symbol/i
    );
  }
});

test('aggregate accepts deeply frozen canonical data-descriptor metrics', () => {
  const metrics = [
    metric('testSuccess', true, 50, 1),
    metric('robustness', true, 50, 1),
    metric('contextContinuity', true, 50, 1),
    metric('a2aCompliance', true, 50, 1),
    metric('efficiency', true, 50, 1),
    metric('claimErrorHandling', true, 50, 1)
  ];
  deepFreeze(metrics);

  const result = aggregateObjectiveCapability(metrics, RUBRIC_V1);
  assert.equal(result.status, 'complete');
  assert.equal(result.score, 50);
  assert.equal(result.coverage, 1);
});

test('aggregate rejects frozen gap index accessors without invoking them', () => {
  let getterReads = 0;
  const gaps = [];
  Object.defineProperty(gaps, '0', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return getterReads === 1 ? 'validated-gap' : { unvalidated: true };
    }
  });
  Object.freeze(gaps);
  const first = metric('testSuccess', true, 50, 1, { gaps });
  Object.freeze(first.evidenceIds);
  Object.freeze(first);

  assert.throws(
    () => aggregateObjectiveCapability(completeMetricSet(first), RUBRIC_V1),
    /accessor|descriptor|gap|array|data/i
  );
  assert.equal(getterReads, 0);
});

test('aggregate rejects frozen evidence index accessors without invoking them', () => {
  let getterReads = 0;
  const evidenceIds = [];
  Object.defineProperty(evidenceIds, '0', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return getterReads === 1 ? 'ev_first' : { unvalidated: true };
    }
  });
  Object.freeze(evidenceIds);
  const first = metric('testSuccess', true, 50, 1, { evidenceIds });
  Object.freeze(first.gaps);
  Object.freeze(first);

  assert.throws(
    () => aggregateObjectiveCapability(completeMetricSet(first), RUBRIC_V1),
    /accessor|descriptor|evidence|array|data/i
  );
  assert.equal(getterReads, 0);
});

test('aggregate rejects non-canonical evidence and gap array structures', () => {
  const cases = [
    (array) => Object.defineProperty(array, 'extra', { value: 'hidden' }),
    (array) => { array[Symbol('extra')] = 'symbol'; },
    (array) => { array.extra = 'enumerable'; },
    (array) => {
      Object.defineProperty(array, '0', {
        value: array[0],
        enumerable: false,
        writable: true,
        configurable: true
      });
    },
    () => new Array(1)
  ];

  for (const field of ['evidenceIds', 'gaps']) {
    for (const mutate of cases) {
      const canonical = [field === 'evidenceIds' ? 'ev_first' : 'gap:first'];
      const altered = mutate(canonical) ?? canonical;
      const first = metric('testSuccess', true, 50, 1, {
        [field]: altered
      });
      assert.throws(
        () => aggregateObjectiveCapability(completeMetricSet(first), RUBRIC_V1),
        /array|evidence|gap|index|field|canonical|string/i
      );
    }
  }
});

test('aggregate snapshots deeply frozen canonical string arrays without aliasing', () => {
  const first = metric('testSuccess', true, 50, 1, {
    evidenceIds: ['ev_first'],
    gaps: ['gap:first']
  });
  const metrics = completeMetricSet(first);
  deepFreeze(metrics);

  const result = aggregateObjectiveCapability(metrics, RUBRIC_V1);
  const output = byId(result.metrics, 'testSuccess');
  assert.deepEqual(output.evidenceIds, ['ev_first']);
  assert.deepEqual(output.gaps, ['gap:first']);
  assert.notStrictEqual(output.evidenceIds, first.evidenceIds);
  assert.notStrictEqual(output.gaps, first.gaps);
  output.evidenceIds.push('ev_second');
  output.gaps.push('gap:second');
  assert.deepEqual(first.evidenceIds, ['ev_first']);
  assert.deepEqual(first.gaps, ['gap:first']);
});

function completeMetricSet(first) {
  return [
    first,
    metric('robustness', true, 50, 1),
    metric('contextContinuity', true, 50, 1),
    metric('a2aCompliance', true, 50, 1),
    metric('efficiency', true, 50, 1),
    metric('claimErrorHandling', true, 50, 1)
  ];
}

function metric(id, applicable, score, coverage, overrides = {}) {
  const denominator = score === null ? 0 : 1;
  const numerator = score === null
    ? 0
    : id === 'efficiency'
      ? score
      : score / 100;
  return {
    id,
    weight: RUBRIC_V1.dimensions.agentCapability[id],
    applicable,
    coverage,
    score,
    numerator,
    denominator,
    evidenceIds: [],
    gaps: [],
    ...overrides
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
