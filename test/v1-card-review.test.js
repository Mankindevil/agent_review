import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_REVIEW_DIMENSIONS,
  V1_CARD_REVIEW_VERSION,
  aggregateV1CardReviews,
  normalizeV1CardReview
} from '../src/v1-card-review.js';

const validDimensions = {
  positioningClarity: 80,
  skillDesign: 70,
  protocolCoherence: 60,
  ioExampleQuality: 50,
  boundaryRiskDisclosure: 40
};

test('Card review recomputes an equal-weight score and drops provider prose', () => {
  const review = normalizeV1CardReview({
    score: 1,
    dimensions: validDimensions,
    comment: 'Skills 边界清楚，但示例不足。',
    risk: '未声明数据失败状态。',
    providerNote: 'ignored'
  });
  assert.equal(review.version, V1_CARD_REVIEW_VERSION);
  assert.equal(review.score, 60);
  assert.equal(review.providerNote, undefined);
  assert.deepEqual(CARD_REVIEW_DIMENSIONS, [
    'positioningClarity',
    'skillDesign',
    'protocolCoherence',
    'ioExampleQuality',
    'boundaryRiskDisclosure'
  ]);
});

test('Card review rejects a changed design contract and non-Chinese findings', () => {
  assert.throws(
    () => normalizeV1CardReview({
      dimensions: validDimensions,
      comment: '边界明确。',
      risk: '风险已说明。'
    }),
    /score.*0–100/u
  );
  assert.throws(
    () => normalizeV1CardReview({
      score: '60',
      dimensions: validDimensions,
      comment: '边界明确。',
      risk: '风险已说明。'
    }),
    /score.*0–100/u
  );
  assert.throws(
    () => normalizeV1CardReview({
      score: 101,
      dimensions: validDimensions,
      comment: '边界明确。',
      risk: '风险已说明。'
    }),
    /score.*0–100/u
  );
  assert.throws(
    () => normalizeV1CardReview({
      score: 60,
      dimensions: { ...validDimensions, extra: 20 },
      comment: '边界明确。',
      risk: '风险已说明。'
    }),
    /未知|dimensions/u
  );
  assert.throws(
    () => normalizeV1CardReview({
      score: 60,
      dimensions: { ...validDimensions, skillDesign: undefined },
      comment: '边界明确。',
      risk: '风险已说明。'
    }),
    /0–100/u
  );
  const missing = { ...validDimensions };
  delete missing.skillDesign;
  assert.throws(
    () => normalizeV1CardReview({
      score: 60,
      dimensions: missing,
      comment: '边界明确。',
      risk: '风险已说明。'
    }),
    /缺少 dimensions/u
  );
  assert.throws(
    () => normalizeV1CardReview({
      score: 60,
      dimensions: validDimensions,
      comment: 'English only comment',
      risk: '风险已说明。'
    }),
    /简体中文/u
  );
  assert.throws(
    () => normalizeV1CardReview({
      score: 60,
      dimensions: validDimensions,
      comment: '边界明确。',
      risk: 'English only risk'
    }),
    /简体中文/u
  );
  assert.throws(
    () => normalizeV1CardReview({
      score: 60,
      dimensions: { ...validDimensions, positioningClarity: 101 },
      comment: '边界明确。',
      risk: '风险已说明。'
    }),
    /0–100/u
  );
});

test('Card review rounds decimal dimensions before recomputing the official score', () => {
  const review = normalizeV1CardReview({
    score: 20.5,
    dimensions: { ...validDimensions, positioningClarity: 80.6, skillDesign: 70.6 },
    comment: '定位清晰。',
    risk: '边界完整。'
  });
  assert.equal(review.dimensions.positioningClarity, 81);
  assert.equal(review.dimensions.skillDesign, 71);
  assert.equal(review.score, 60);
});

test('Card review aggregation retains the version and averages valid seats', () => {
  const snapshot = aggregateV1CardReviews([
    { ...normalizeV1CardReview({ score: 0, dimensions: validDimensions, comment: '定位清晰。', risk: '风险充分。' }), mode: 'demo' },
    { ...normalizeV1CardReview({ score: 0, dimensions: { ...validDimensions, positioningClarity: 100 }, comment: '协议清晰。', risk: '边界完整。' }), mode: 'live' },
    { score: 0, mode: 'failed', error: 'timeout', version: V1_CARD_REVIEW_VERSION }
  ]);
  assert.equal(snapshot.version, V1_CARD_REVIEW_VERSION);
  assert.equal(snapshot.score, 62);
  assert.deepEqual(snapshot.dimensions, {
    positioningClarity: 90,
    skillDesign: 70,
    protocolCoherence: 60,
    ioExampleQuality: 50,
    boundaryRiskDisclosure: 40
  });
  assert.equal(snapshot.mode, 'mixed');
  assert.equal(snapshot.reviews.length, 3);
});
