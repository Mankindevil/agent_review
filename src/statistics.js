import { normalizeSeed } from './utils.js';

const DEFAULT_ITERATIONS = 10_000;
const CONFIDENCE_LEVEL = 0.95;

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('median values must be a non-empty array');
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('median values must be finite numbers');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function bootstrapReplicaAdvantage(scoreCells, validReplicaIds, options = {}) {
  const cells = normalizeScoreCells(scoreCells, validReplicaIds);
  const replicaIds = normalizeReplicaIds(validReplicaIds);
  if (replicaIds.length === 0) {
    return { status: 'unavailable' };
  }
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new TypeError('iterations must be a positive integer');
  }
  const seed = normalizeSeed(options.seed);
  const pointEstimate = calculateAdvantage(cells);
  const random = seededRandom(seed);
  const draws = Array.from({ length: iterations }, () =>
    calculateAdvantage(sampleCells(cells, random)).delta
  ).sort((left, right) => left - right);
  const interval = {
    confidenceLevel: CONFIDENCE_LEVEL,
    low: percentile(draws, 0.025),
    high: percentile(draws, 0.975)
  };

  return {
    status: 'ready',
    seed,
    iterations,
    submittedMedian: pointEstimate.submittedMedian,
    bestReplicaId: pointEstimate.bestReplicaId,
    bestReplicaMedian: pointEstimate.bestReplicaMedian,
    delta: pointEstimate.delta,
    interval,
    conservativeDelta: interval.low,
    draws
  };
}

export function intervalCrossesThreshold(interval, threshold) {
  if (!interval || !Number.isFinite(interval.low) || !Number.isFinite(interval.high)) {
    throw new TypeError('interval must contain finite low and high values');
  }
  if (!Number.isFinite(threshold)) throw new TypeError('threshold must be a finite number');
  if (interval.low > interval.high) throw new RangeError('interval low must not exceed high');
  return interval.low < threshold && interval.high > threshold;
}

function calculateAdvantage(cells) {
  const submittedMedian = median(cells.map((cell) => cell.submitted));
  const replicaMedians = new Map();
  for (const replicaId of Object.keys(cells[0].replicas)) {
    replicaMedians.set(replicaId, median(cells.map((cell) => cell.replicas[replicaId])));
  }
  const [bestReplicaId, bestReplicaMedian] = [...replicaMedians.entries()]
    .sort(([leftId, leftMedian], [rightId, rightMedian]) =>
      rightMedian - leftMedian || leftId.localeCompare(rightId))[0];
  return {
    submittedMedian,
    bestReplicaId,
    bestReplicaMedian,
    delta: submittedMedian - bestReplicaMedian
  };
}

function normalizeScoreCells(scoreCells, validReplicaIds) {
  if (!Array.isArray(scoreCells) || scoreCells.length === 0) {
    throw new TypeError('scoreCells must be a non-empty array');
  }
  const replicaIds = normalizeReplicaIds(validReplicaIds);
  return scoreCells.map((cell, index) => {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell) || !cell.scores || typeof cell.scores !== 'object') {
      throw new TypeError(`scoreCells[${index}] must contain scores`);
    }
    const submitted = cell.scores.submitted;
    assertScore(submitted, `scoreCells[${index}].scores.submitted`);
    const replicas = Object.fromEntries(replicaIds.map((replicaId) => {
      const score = cell.scores[`replica:${replicaId}`];
      assertScore(score, `scoreCells[${index}].scores.replica:${replicaId}`);
      return [replicaId, score];
    }));
    return { submitted, replicas };
  });
}

function normalizeReplicaIds(validReplicaIds) {
  if (!Array.isArray(validReplicaIds)) throw new TypeError('validReplicaIds must be an array');
  if (new Set(validReplicaIds).size !== validReplicaIds.length) {
    throw new TypeError('validReplicaIds must be distinct');
  }
  for (const replicaId of validReplicaIds) {
    if (typeof replicaId !== 'string' || !replicaId.trim()) {
      throw new TypeError('validReplicaIds must contain non-empty strings');
    }
  }
  return validReplicaIds;
}

function assertScore(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${field} must be a finite 0–100 number`);
  }
}

function sampleCells(cells, random) {
  return Array.from({ length: cells.length }, () => cells[Math.floor(random() * cells.length)]);
}

function percentile(sortedValues, proportion) {
  return sortedValues[Math.ceil(proportion * sortedValues.length) - 1];
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}
