import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseCubeToScoreCells, mergeHumanJudgesIntoCube } from '../src/arena-cube-merge.js';

const MODEL_CUBE = [
  { testId: 't1', repeatIndex: 0, judgeId: 'gpt', scores: { submitted: 80, 'replica:alpha': 60 } },
  { testId: 't1', repeatIndex: 1, judgeId: 'gpt', scores: { submitted: 70, 'replica:alpha': 50 } },
  { testId: 't1', repeatIndex: 0, judgeId: 'claude', scores: { submitted: 90, 'replica:alpha': 70 } },
  { testId: 't1', repeatIndex: 1, judgeId: 'claude', scores: { submitted: 60, 'replica:alpha': 40 } }
];

test('broadcasts a single human primary composite onto every model cube cell as human:{principalId}', () => {
  const merged = mergeHumanJudgesIntoCube(MODEL_CUBE, [
    { principalId: 'p1', scores: { submitted: 85, 'replica:alpha': 55 } }
  ], ['alpha']);

  assert.equal(merged.length, MODEL_CUBE.length + 2);
  const humanRows = merged.filter((row) => row.judgeId === 'human:p1');
  assert.equal(humanRows.length, 2);
  assert.deepEqual(humanRows.map((row) => [row.testId, row.repeatIndex]).sort(), [['t1', 0], ['t1', 1]]);
  for (const row of humanRows) {
    assert.deepEqual(row.scores, { submitted: 85, 'replica:alpha': 55 });
  }
  assert.deepEqual(merged.slice(0, MODEL_CUBE.length), MODEL_CUBE);
});

test('broadcasts every human primary independently when requiredPrimaries is greater than one', () => {
  const merged = mergeHumanJudgesIntoCube(MODEL_CUBE, [
    { principalId: 'p1', scores: { submitted: 85, 'replica:alpha': 55 } },
    { principalId: 'p2', scores: { submitted: 75, 'replica:alpha': 65 } }
  ], ['alpha']);

  const judgeIds = new Set(merged.map((row) => row.judgeId));
  assert.ok(judgeIds.has('human:p1'));
  assert.ok(judgeIds.has('human:p2'));
  assert.equal(merged.length, MODEL_CUBE.length + 4);
});

test('rejects duplicate human principal IDs', () => {
  assert.throws(() => mergeHumanJudgesIntoCube(MODEL_CUBE, [
    { principalId: 'p1', scores: { submitted: 85, 'replica:alpha': 55 } },
    { principalId: 'p1', scores: { submitted: 60, 'replica:alpha': 40 } }
  ], ['alpha']), TypeError);
});

test('omits invalid replica composites from human reviews instead of throwing', () => {
  const merged = mergeHumanJudgesIntoCube(MODEL_CUBE, [
    { principalId: 'p1', scores: { submitted: 85, 'replica:alpha': 55, 'replica:invalid': 100 } }
  ], ['alpha']);

  const humanRow = merged.find((row) => row.judgeId === 'human:p1' && row.testId === 't1' && row.repeatIndex === 0);
  assert.deepEqual(humanRow.scores, { submitted: 85, 'replica:alpha': 55 });
});

test('drops invalid replica keys already present on model cube rows', () => {
  const cubeWithStaleReplica = [
    { testId: 't1', repeatIndex: 0, judgeId: 'gpt', scores: { submitted: 80, 'replica:alpha': 60, 'replica:invalid': 42 } }
  ];
  const merged = mergeHumanJudgesIntoCube(cubeWithStaleReplica, [], ['alpha']);
  assert.deepEqual(merged[0].scores, { submitted: 80, 'replica:alpha': 60 });
});

test('requires a submitted score on every human review', () => {
  assert.throws(() => mergeHumanJudgesIntoCube(MODEL_CUBE, [
    { principalId: 'p1', scores: { 'replica:alpha': 55 } }
  ], ['alpha']), TypeError);
});

test('collapses per (testId, repeatIndex) cell to the median across model and human judges', () => {
  const merged = mergeHumanJudgesIntoCube(MODEL_CUBE, [
    { principalId: 'p1', scores: { submitted: 85, 'replica:alpha': 55 } }
  ], ['alpha']);
  const cells = collapseCubeToScoreCells(merged);

  assert.equal(cells.length, 2);
  const cellZero = cells.find((cell) => cell.testId === 't1' && cell.repeatIndex === 0);
  const cellOne = cells.find((cell) => cell.testId === 't1' && cell.repeatIndex === 1);

  assert.deepEqual(cellZero, {
    testId: 't1',
    repeatIndex: 0,
    scores: { submitted: 85, 'replica:alpha': 60 }
  });
  assert.deepEqual(cellOne, {
    testId: 't1',
    repeatIndex: 1,
    scores: { submitted: 70, 'replica:alpha': 50 }
  });
});

test('produces bootstrapReplicaAdvantage-compatible scoreCells shape', () => {
  const merged = mergeHumanJudgesIntoCube(MODEL_CUBE, [
    { principalId: 'p1', scores: { submitted: 85, 'replica:alpha': 55 } }
  ], ['alpha']);
  const cells = collapseCubeToScoreCells(merged);

  for (const cell of cells) {
    assert.equal(typeof cell.scores.submitted, 'number');
    assert.equal(typeof cell.scores['replica:alpha'], 'number');
    assert.ok(cell.scores.submitted >= 0 && cell.scores.submitted <= 100);
    assert.ok(cell.scores['replica:alpha'] >= 0 && cell.scores['replica:alpha'] <= 100);
  }
});

test('collapse rejects a cube with no rows', () => {
  assert.throws(() => collapseCubeToScoreCells([]), TypeError);
});

test('collapse rejects a cell missing a submitted score', () => {
  assert.throws(() => collapseCubeToScoreCells([
    { testId: 't1', repeatIndex: 0, judgeId: 'gpt', scores: { 'replica:alpha': 60 } }
  ]), TypeError);
});

test('merge validates finite 0-100 scores', () => {
  assert.throws(() => mergeHumanJudgesIntoCube(MODEL_CUBE, [
    { principalId: 'p1', scores: { submitted: 185 } }
  ], ['alpha']), RangeError);
});

test('merge rejects an empty model cube', () => {
  assert.throws(() => mergeHumanJudgesIntoCube([], [], ['alpha']), TypeError);
});
