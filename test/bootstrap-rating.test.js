import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapReplicaAdvantage,
  intervalCrossesThreshold,
  median
} from '../src/statistics.js';
import { classifyDualTrackRating } from '../src/rating.js';

const scoreCells = [
  { scores: { submitted: 80, 'replica:alpha': 70, 'replica:invalid': 100 } },
  { scores: { submitted: 60, 'replica:alpha': 65, 'replica:invalid': 100 } },
  { scores: { submitted: 90, 'replica:alpha': 75, 'replica:invalid': 100 } },
  { scores: { submitted: 70, 'replica:alpha': 60, 'replica:invalid': 100 } }
];

test('calculates medians without mutating score samples', () => {
  const values = [90, 60, 70, 80];
  assert.equal(median(values), 75);
  assert.deepEqual(values, [90, 60, 70, 80]);
});

test('bootstraps a deterministic conservative advantage against valid Replicas only', () => {
  const first = bootstrapReplicaAdvantage(scoreCells, ['alpha'], { seed: 42, iterations: 200 });
  const second = bootstrapReplicaAdvantage(scoreCells, ['alpha'], { seed: 42, iterations: 200 });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.status, 'ready');
  assert.equal(first.iterations, 200);
  assert.equal(first.submittedMedian, 75);
  assert.equal(first.bestReplicaId, 'alpha');
  assert.equal(first.bestReplicaMedian, 67.5);
  assert.equal(first.delta, 7.5);
  assert.equal(first.conservativeDelta, first.interval.low);
  assert.ok(first.interval.low <= first.interval.high);
  assert.ok(first.interval.low <= first.delta);
  assert.ok(first.interval.high >= first.delta);
});

test('uses ten thousand bootstrap draws and 2.5th/97.5th percentiles by default', () => {
  const result = bootstrapReplicaAdvantage(scoreCells, ['alpha'], { seed: 7 });

  assert.equal(result.iterations, 10_000);
  assert.equal(result.interval.confidenceLevel, 0.95);
  assert.equal(result.interval.low, percentile(result.draws, 0.025));
  assert.equal(result.interval.high, percentile(result.draws, 0.975));
});

test('reselects the best valid Replica inside each bootstrap draw', () => {
  const result = bootstrapReplicaAdvantage([
    { scores: { submitted: 80, 'replica:alpha': 70, 'replica:beta': 10 } },
    { scores: { submitted: 80, 'replica:alpha': 10, 'replica:beta': 70 } }
  ], ['alpha', 'beta'], { seed: 2, iterations: 20 });

  assert.equal(result.bestReplicaId, 'alpha');
  assert.ok(result.draws.some((delta) => delta === 10));
  assert.ok(result.draws.every((delta) => delta <= 70));
});

test('recognizes confidence intervals that cross rating thresholds', () => {
  assert.equal(intervalCrossesThreshold({ low: 4, high: 6 }, 5), true);
  assert.equal(intervalCrossesThreshold({ low: 5, high: 7 }, 5), false);
  assert.equal(intervalCrossesThreshold({ low: 3, high: 5 }, 5), false);
});

test('classifies every inclusive dual-track rating boundary', () => {
  assert.equal(classifyDualTrackRating(ratingInput({
    absoluteTotal: 80,
    scenarioScore: 60,
    objectiveCoverage: 0.70,
    conservativeDelta: 5
  })).label, '夯');
  assert.equal(classifyDualTrackRating(ratingInput({
    absoluteTotal: 79.99,
    scenarioScore: 60,
    objectiveCoverage: 0.70,
    conservativeDelta: 5
  })).label, '人上人');
  assert.equal(classifyDualTrackRating(ratingInput({
    absoluteTotal: 80,
    scenarioScore: 60,
    objectiveCoverage: 0.6999,
    conservativeDelta: 5
  })).label, '人上人');
  assert.equal(classifyDualTrackRating(ratingInput({
    absoluteTotal: 70,
    scenarioScore: 50,
    conservativeDelta: -2
  })).label, '人上人');
  assert.equal(classifyDualTrackRating(ratingInput({
    absoluteTotal: 55,
    scenarioScore: 36,
    conservativeDelta: -10
  })).label, 'NPC');
  assert.equal(classifyDualTrackRating(ratingInput({
    absoluteTotal: 100,
    scenarioScore: 35.99,
    objectiveCoverage: 1,
    conservativeDelta: 100
  })).label, '拉');
});

test('keeps ineligible and unavailable Replica outcomes distinct', () => {
  const ineligible = classifyDualTrackRating(ratingInput({
    eligibilityStatus: 'ineligible',
    conservativeDelta: 100
  }));
  assert.deepEqual(ineligible, {
    status: 'ineligible',
    code: 'INELIGIBLE',
    label: '未通过参评资格',
    reasons: ['参评资格未通过'],
    rubricVersion: 'a2a-black-box-v1',
    differenceStable: null
  });

  const pending = classifyDualTrackRating(ratingInput({
    replicaAdvantage: { status: 'unavailable' }
  }));
  assert.equal(pending.status, 'pending-replica');
  assert.equal(pending.code, 'PENDING_REPLICA');
  assert.equal(pending.label, '待复刻');
});

test('reports unstable differences without changing conservative classification', () => {
  const result = classifyDualTrackRating(ratingInput({
    conservativeDelta: 5,
    interval: { low: 5, high: 6 }
  }));
  assert.equal(result.code, 'HARD');
  assert.equal(result.differenceStable, true);

  const unstable = classifyDualTrackRating(ratingInput({
    conservativeDelta: 5,
    interval: { low: 4.9, high: 6 }
  }));
  assert.equal(unstable.code, 'HARD');
  assert.equal(unstable.differenceStable, false);
});

function ratingInput({
  eligibilityStatus = 'eligible',
  absoluteTotal = 80,
  scenarioScore = 60,
  objectiveCoverage = 0.7,
  conservativeDelta = 5,
  interval = { low: conservativeDelta, high: conservativeDelta },
  replicaAdvantage
} = {}) {
  return {
    eligibilityStatus,
    absoluteTotal,
    scenarioScore,
    objectiveCoverage,
    replicaAdvantage: replicaAdvantage ?? {
      status: 'ready',
      conservativeDelta,
      interval
    }
  };
}

function percentile(values, proportion) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(proportion * sorted.length) - 1];
}
