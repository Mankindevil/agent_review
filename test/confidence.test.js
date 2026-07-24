import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDimensionConfidence,
  computeSubcriterionConfidence,
  computeTotalConfidence
} from '../src/confidence.js';

const mainInput = (stage) => ({
  stage,
  checks: [
    { id: 'check-a', evidenceGrades: ['C', 'A', 'A'] },
    { id: 'check-b', evidenceGrades: ['B'] },
    { id: 'check-none', evidenceGrades: [] }
  ],
  modelScores: [60, 70, 80, 90],
  humanScores: [50, 80],
  modelConfidences: [0.6, 0.8, 0.9, 1.0]
});

function assertClose(actual, expected, epsilon = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test('computes the exact model-stage and final subcriterion confidence formulas', () => {
  const model = computeSubcriterionConfidence(mainInput('model'));
  const final = computeSubcriterionConfidence(mainInput('final'));

  assert.equal(model.status, 'complete');
  assertClose(model.value, 0.62);
  assert.equal(final.status, 'complete');
  assertClose(final.value, 0.56);
});

test('returns exact pending states for missing model or final human review', () => {
  assert.deepEqual(computeSubcriterionConfidence({
    stage: 'model',
    checks: [{ id: 'check-a', evidenceGrades: ['A'] }],
    modelScores: [],
    humanScores: [],
    modelConfidences: []
  }), {
    status: 'pending-model-review',
    value: null
  });

  assert.deepEqual(computeSubcriterionConfidence({
    stage: 'final',
    checks: [{ id: 'check-a', evidenceGrades: ['A'] }],
    modelScores: [80],
    humanScores: [],
    modelConfidences: [0.9]
  }), {
    status: 'pending-human-review',
    value: null
  });
});

test('uses interpolated quartiles and medians at small sample sizes', () => {
  const single = computeSubcriterionConfidence({
    stage: 'model',
    checks: [{ id: 'check-a', evidenceGrades: [] }],
    modelScores: [70],
    humanScores: [],
    modelConfidences: [0.2]
  });
  assertClose(single.value, 0.34);

  const wide = computeSubcriterionConfidence({
    stage: 'model',
    checks: [{ id: 'check-a', evidenceGrades: [] }],
    modelScores: [0, 100],
    humanScores: [],
    modelConfidences: [0.2, 0.8]
  });
  assertClose(wide.value, 0.1);
});

test('validates planned checks, sample ranges, and complete model sample shape', () => {
  const valid = mainInput('model');
  for (const patch of [
    { stage: 'unknown' },
    { checks: [] },
    {
      checks: [
        { id: 'duplicate', evidenceGrades: ['A'] },
        { id: 'duplicate', evidenceGrades: ['B'] }
      ]
    },
    { checks: [{ id: 'check-a', evidenceGrades: ['E'] }] },
    { modelScores: [101], modelConfidences: [0.9] },
    { humanScores: [-1] },
    { modelConfidences: [1.1, 0.8, 0.9, 1] },
    { modelScores: [80], modelConfidences: [] },
    { modelScores: [80, 90], modelConfidences: [0.9] }
  ]) {
    assert.throws(
      () => computeSubcriterionConfidence({ ...valid, ...patch }),
      /stage|check|duplicate|grade|score|confidence|range|length|sample/i
    );
  }
});

test('does not mutate frozen checks or score samples while sorting', () => {
  const input = {
    stage: 'final',
    checks: [
      { id: 'check-b', evidenceGrades: ['C', 'A'] },
      { id: 'check-a', evidenceGrades: ['D'] }
    ],
    modelScores: [90, 60, 80, 70],
    humanScores: [80, 50],
    modelConfidences: [1, 0.6, 0.9, 0.8]
  };
  const before = structuredClone(input);
  deepFreeze(input);

  assert.doesNotThrow(() => computeSubcriterionConfidence(input));
  assert.deepEqual(input, before);
});

test('computes applicable rubric-weighted dimension confidence and excludes N/A', () => {
  const result = computeDimensionConfidence([
    confidenceItem('first', 30, true, { status: 'complete', value: 0.8 }),
    confidenceItem('second', 20, true, { status: 'complete', value: 0.5 }),
    confidenceItem('not-applicable', 50, false, {
      status: 'unavailable',
      value: null
    })
  ]);

  assert.deepEqual(result, { status: 'complete', value: 0.68 });
});

test('composes subcriterion confidence directly into dimension confidence', () => {
  const subcriterion = computeSubcriterionConfidence(mainInput('model'));
  const result = computeDimensionConfidence([
    confidenceItem('composed', 1, true, subcriterion)
  ]);

  assert.deepEqual(result, {
    status: 'complete',
    value: subcriterion.value
  });
  assert.equal(Object.hasOwn(result, 'components'), false);
});

test('dimension status precedence is deterministic across every input permutation', () => {
  const statuses = [
    { status: 'complete', value: 0.8 },
    { status: 'unavailable', value: null },
    { status: 'pending-human-review', value: null },
    { status: 'pending-model-review', value: null }
  ];
  for (const order of permutations(statuses)) {
    const result = computeDimensionConfidence(order.map((confidence, index) =>
      confidenceItem(`item-${index}`, 1, true, confidence)
    ));
    assert.deepEqual(result, {
      status: 'pending-model-review',
      value: null
    });
  }

  for (const order of permutations(statuses.slice(0, 3))) {
    const result = computeDimensionConfidence(order.map((confidence, index) =>
      confidenceItem(`human-item-${index}`, 1, true, confidence)
    ));
    assert.deepEqual(result, {
      status: 'pending-human-review',
      value: null
    });
  }
});

test('dimension confidence propagates pending, preserves zero, and tags no applicable items', () => {
  assert.deepEqual(computeDimensionConfidence([
    confidenceItem('pending', 30, true, {
      status: 'pending-model-review',
      value: null
    }),
    confidenceItem('complete', 20, true, {
      status: 'complete',
      value: 0.8
    })
  ]), {
    status: 'pending-model-review',
    value: null
  });

  assert.deepEqual(computeDimensionConfidence([
    confidenceItem('zero', 10, true, { status: 'complete', value: 0 })
  ]), {
    status: 'complete',
    value: 0
  });

  assert.deepEqual(computeDimensionConfidence([
    confidenceItem('n-a', 10, false, { status: 'unavailable', value: null })
  ]), {
    status: 'unavailable',
    value: null
  });
});

test('dimension confidence validates exact item shape and duplicate IDs', () => {
  assert.throws(
    () => computeDimensionConfidence([
      confidenceItem('duplicate', 10, true, { status: 'complete', value: 0.5 }),
      confidenceItem('duplicate', 10, true, { status: 'complete', value: 0.5 })
    ]),
    /duplicate|id/i
  );
  assert.throws(
    () => computeDimensionConfidence([
      confidenceItem('bad-weight', -1, true, { status: 'complete', value: 0.5 })
    ]),
    /weight|negative/i
  );
  assert.throws(
    () => computeDimensionConfidence([
      confidenceItem('bad-value', 10, true, { status: 'complete', value: 1.1 })
    ]),
    /value|range/i
  );
});

test('computes total geometric confidence from the three named dimensions', () => {
  const result = computeTotalConfidence({
    scenarioValue: { status: 'complete', value: 0.8 },
    professionalism: { status: 'complete', value: 0.5 },
    agentCapability: { status: 'complete', value: 0.2 }
  });
  assert.equal(result.status, 'complete');
  assertClose(result.value, 0.43088693800637673);

  assert.deepEqual(computeTotalConfidence({
    scenarioValue: { status: 'complete', value: 0 },
    professionalism: { status: 'complete', value: 0.5 },
    agentCapability: { status: 'complete', value: 0.2 }
  }), {
    status: 'complete',
    value: 0
  });
});

test('total confidence propagates pending or unavailable named dimensions', () => {
  assert.deepEqual(computeTotalConfidence({
    scenarioValue: { status: 'complete', value: 0.8 },
    professionalism: { status: 'pending-human-review', value: null },
    agentCapability: { status: 'complete', value: 0.2 }
  }), {
    status: 'pending-human-review',
    value: null
  });

  assert.deepEqual(computeTotalConfidence({
    scenarioValue: { status: 'complete', value: 0.8 },
    professionalism: { status: 'complete', value: 0.5 }
  }), {
    status: 'unavailable',
    value: null
  });
});

test('total status precedence is deterministic across dimension assignments', () => {
  const statuses = [
    { status: 'pending-model-review', value: null },
    { status: 'pending-human-review', value: null },
    { status: 'unavailable', value: null }
  ];
  for (const order of permutations(statuses)) {
    assert.deepEqual(computeTotalConfidence({
      scenarioValue: order[0],
      professionalism: order[1],
      agentCapability: order[2]
    }), {
      status: 'pending-model-review',
      value: null
    });
  }

  assert.deepEqual(computeTotalConfidence({
    professionalism: { status: 'pending-model-review', value: null },
    agentCapability: { status: 'complete', value: 0.8 }
  }), {
    status: 'pending-model-review',
    value: null
  });
});

function confidenceItem(id, weight, applicable, confidence) {
  return { id, weight, applicable, confidence };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index))
      .map((tail) => [value, ...tail])
  );
}
