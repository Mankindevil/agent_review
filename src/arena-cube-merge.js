import { median } from './statistics.js';

/**
 * Broadcasts each human primary's per-source composite onto every
 * (testId, repeatIndex) cell already present in the model Arena cube,
 * producing one extra judge row per cell with judgeId `human:{principalId}`.
 * Invalid Replica IDs (absent from validReplicaIds) are dropped from both
 * the human reviews and any pre-existing model cube rows.
 */
export function mergeHumanJudgesIntoCube(modelCube, humanReviews, validReplicaIds) {
  const cube = requiredArray(modelCube, 'modelCube');
  if (cube.length === 0) throw new TypeError('modelCube must be a non-empty array');
  const allowed = allowedSourceKeys(validReplicaIds);
  const cellKeys = uniqueCellKeys(cube);
  const normalizedModelRows = cube.map((row) => normalizeJudgementRow(row, allowed));

  const reviews = requiredArray(humanReviews, 'humanReviews');
  assertDistinct(
    reviews.map((review) => requiredText(review?.principalId, 'humanReview.principalId')),
    'human review principal IDs'
  );

  const humanRows = [];
  for (const review of reviews) {
    const principalId = requiredText(review.principalId, 'humanReview.principalId');
    const filtered = filterScores(requiredObject(review?.scores, 'humanReview.scores'), allowed, 'humanReview.scores');
    if (!Object.hasOwn(filtered, 'submitted')) {
      throw new TypeError('humanReview.scores requires a submitted composite');
    }
    const judgeId = `human:${principalId}`;
    for (const { testId, repeatIndex } of cellKeys) {
      humanRows.push({ testId, repeatIndex, judgeId, scores: { ...filtered } });
    }
  }

  return [...normalizedModelRows, ...humanRows];
}

/**
 * Collapses a merged cube (model + human judge rows) into
 * bootstrapReplicaAdvantage-compatible scoreCells: for each
 * (testId, repeatIndex) cell, the per-source-key median across all judges.
 */
export function collapseCubeToScoreCells(cube) {
  const rows = requiredArray(cube, 'cube');
  if (rows.length === 0) throw new TypeError('cube must be a non-empty array');

  const cells = new Map();
  for (const row of rows) {
    const judgement = requiredObject(row, 'cube row');
    const testId = requiredText(judgement.testId, 'cube row.testId');
    const repeatIndex = requiredNonNegativeInteger(judgement.repeatIndex, 'cube row.repeatIndex');
    const scores = requiredObject(judgement.scores, 'cube row.scores');
    const key = cellKey(testId, repeatIndex);
    if (!cells.has(key)) cells.set(key, { testId, repeatIndex, valuesByKey: new Map() });
    const cell = cells.get(key);
    for (const [sourceKey, value] of Object.entries(scores)) {
      assertFiniteScore(value, `cube row.scores.${sourceKey}`);
      if (!cell.valuesByKey.has(sourceKey)) cell.valuesByKey.set(sourceKey, []);
      cell.valuesByKey.get(sourceKey).push(value);
    }
  }

  return [...cells.values()]
    .sort((left, right) => left.testId.localeCompare(right.testId) || left.repeatIndex - right.repeatIndex)
    .map(({ testId, repeatIndex, valuesByKey }) => {
      const scores = {};
      for (const [sourceKey, values] of valuesByKey) {
        scores[sourceKey] = median(values);
      }
      if (!Object.hasOwn(scores, 'submitted')) {
        throw new TypeError(`cube cell ${cellKey(testId, repeatIndex)} requires a submitted score`);
      }
      return { testId, repeatIndex, scores };
    });
}

function allowedSourceKeys(validReplicaIds) {
  const replicaIds = requiredArray(validReplicaIds, 'validReplicaIds')
    .map((id) => requiredText(id, 'validReplicaId'));
  assertDistinct(replicaIds, 'validReplicaIds');
  return new Set(['submitted', ...replicaIds.map((id) => `replica:${id}`)]);
}

function normalizeJudgementRow(row, allowed) {
  const judgement = requiredObject(row, 'modelCube row');
  const testId = requiredText(judgement.testId, 'modelCube row.testId');
  const repeatIndex = requiredNonNegativeInteger(judgement.repeatIndex, 'modelCube row.repeatIndex');
  const judgeId = requiredText(judgement.judgeId, 'modelCube row.judgeId');
  const scores = filterScores(requiredObject(judgement.scores, 'modelCube row.scores'), allowed, 'modelCube row.scores');
  if (!Object.hasOwn(scores, 'submitted')) {
    throw new TypeError('modelCube row.scores requires a submitted score');
  }
  return { testId, repeatIndex, judgeId, scores };
}

function filterScores(scores, allowed, field) {
  const filtered = {};
  for (const key of allowed) {
    if (Object.hasOwn(scores, key)) {
      assertFiniteScore(scores[key], `${field}.${key}`);
      filtered[key] = scores[key];
    }
  }
  return filtered;
}

function uniqueCellKeys(cube) {
  const seen = new Map();
  for (const row of cube) {
    const judgement = requiredObject(row, 'modelCube row');
    const testId = requiredText(judgement.testId, 'modelCube row.testId');
    const repeatIndex = requiredNonNegativeInteger(judgement.repeatIndex, 'modelCube row.repeatIndex');
    const key = cellKey(testId, repeatIndex);
    if (!seen.has(key)) seen.set(key, { testId, repeatIndex });
  }
  return [...seen.values()];
}

function cellKey(testId, repeatIndex) {
  return `${testId}:${repeatIndex}`;
}

function requiredObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function requiredArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requiredNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function assertFiniteScore(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${field} must be a finite 0–100 number`);
  }
}

function assertDistinct(values, field) {
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must be distinct`);
}
