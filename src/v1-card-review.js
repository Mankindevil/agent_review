import { average, round } from './utils.js';

export const V1_CARD_REVIEW_VERSION = 'v1-card-review/v2';
export const CARD_REVIEW_DIMENSIONS = Object.freeze([
  'positioningClarity',
  'skillDesign',
  'protocolCoherence',
  'ioExampleQuality',
  'boundaryRiskDisclosure'
]);

const HAN_CHARACTER = /\p{Script=Han}/u;

export function normalizeV1CardReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent Card 评审必须返回 JSON 对象');
  }
  assertScore(value.score, 'score');
  if (!value.dimensions || typeof value.dimensions !== 'object' || Array.isArray(value.dimensions)) {
    throw new TypeError('Agent Card 评审缺少 dimensions 对象');
  }
  const suppliedKeys = Object.keys(value.dimensions);
  const unknown = suppliedKeys.filter((key) => !CARD_REVIEW_DIMENSIONS.includes(key));
  if (unknown.length) {
    throw new TypeError(`Agent Card 评审包含未知 dimensions：${unknown.join('、')}`);
  }
  const missing = CARD_REVIEW_DIMENSIONS.filter((key) => !Object.hasOwn(value.dimensions, key));
  if (missing.length) {
    throw new TypeError(`Agent Card 评审缺少 dimensions：${missing.join('、')}`);
  }
  const dimensions = Object.fromEntries(CARD_REVIEW_DIMENSIONS.map((key) => {
    const score = value.dimensions[key];
    assertScore(score, `dimensions.${key}`);
    return [key, Math.round(score)];
  }));
  const comment = normalizeChineseText(value.comment, 'comment');
  const risk = normalizeChineseText(value.risk, 'risk');
  return {
    version: V1_CARD_REVIEW_VERSION,
    score: round(average(CARD_REVIEW_DIMENSIONS.map((key) => dimensions[key]))),
    dimensions,
    comment,
    risk
  };
}

export function aggregateV1CardReviews(reviews) {
  const normalizedReviews = Array.isArray(reviews) ? [...reviews] : [];
  const valid = normalizedReviews.filter((review) =>
    review?.version === V1_CARD_REVIEW_VERSION &&
    !review.error &&
    Number.isFinite(review.score) &&
    review.score >= 0 &&
    review.score <= 100 &&
    CARD_REVIEW_DIMENSIONS.every((key) => Number.isFinite(review.dimensions?.[key]))
  );
  return {
    version: V1_CARD_REVIEW_VERSION,
    score: round(average(valid.map((review) => review.score)), 1),
    dimensions: Object.fromEntries(CARD_REVIEW_DIMENSIONS.map((key) => [
      key,
      round(average(valid.map((review) => review.dimensions[key])), 1)
    ])),
    mode: summarizeModes(normalizedReviews.map((review) => review?.error ? 'failed' : review?.mode), 'failed'),
    reviews: normalizedReviews
  };
}

function assertScore(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${field} 必须是 0–100 的数字`);
  }
}

function normalizeChineseText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`Agent Card 评审缺少 ${field}`);
  }
  const text = value.trim();
  if (!HAN_CHARACTER.test(text)) {
    throw new TypeError(`Agent Card 评审的 ${field} 必须使用简体中文`);
  }
  return text;
}

function summarizeModes(modes, fallback) {
  const valid = modes.filter(Boolean);
  if (!valid.length) return fallback;
  const unique = [...new Set(valid)];
  return unique.length === 1 ? unique[0] : 'mixed';
}
