import { createHash } from 'node:crypto';
import {
  LEGACY_V1_ARENA_SYSTEM_PROMPT,
  V1_ARENA_SYSTEM_PROMPT,
  legacyV1ArenaPrompt,
  v1ArenaPrompt
} from './prompts.js';
import { requestJson } from './providers.js';
import { deriveSeed, round, stableNumber } from './utils.js';

export const LEGACY_V1_SCORING_VERSION = 'v1-model-arena/v1';
export const V1_SCORING_VERSION = 'v1-model-arena/v2';
export const V1_REVIEWER_IDS = Object.freeze(['gpt', 'claude', 'doubao', 'deepseek']);

const LEGACY_DIMENSION_KEYS = Object.freeze([
  'taskConstraint',
  'professionalQuality',
  'evidenceRisk',
  'artifactUsability'
]);
const LEGACY_SCORE_ITEM_KEYS = Object.freeze([
  'candidateId',
  'dimensions',
  'total',
  'rationale',
  'uncertainties'
]);
const LEGACY_WEIGHTS = Object.freeze({
  taskConstraint: 0.4,
  professionalQuality: 0.3,
  evidenceRisk: 0.2,
  artifactUsability: 0.1
});
const SCENARIO_DIMENSION_KEYS = Object.freeze(['problemComplexity', 'agentSuitability']);
const PROFESSIONAL_DIMENSION_KEYS = Object.freeze([
  'taskCompletion',
  'methodProfessionalism',
  'evidenceDataQuality',
  'riskUncertainty',
  'artifactUsability'
]);
const SCENARIO_WEIGHTS = Object.freeze({ problemComplexity: 0.5, agentSuitability: 0.5 });
const PROFESSIONAL_WEIGHTS = Object.freeze({
  taskCompletion: 0.3,
  methodProfessionalism: 0.25,
  evidenceDataQuality: 0.2,
  riskUncertainty: 0.15,
  artifactUsability: 0.1
});
const TOTAL_WEIGHTS = Object.freeze({ scenarioValue: 0.2, professionalQuality: 0.6, agentCapability: 0.2 });
const V2_SCORE_ITEM_KEYS = Object.freeze(['candidateId', 'dimensions', 'rationale', 'uncertainties']);
const V2_SCENARIO_KEYS = Object.freeze(['dimensions', 'rationale', 'uncertainties']);
const LIVE_REVIEWER_KINDS = Object.freeze([
  'openai-compatible',
  'anthropic'
]);
const LIVE_REVIEWER_FIELDS = Object.freeze([
  'baseUrl',
  'model',
  'apiKeyEnv'
]);

export function normalizeV1ScoringConfig(value) {
  if (value === undefined) {
    return { version: V1_SCORING_VERSION, mode: 'single', reviewerId: 'deepseek' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'scoringConfig must be an object');
  }
  const version = value.version === undefined ? V1_SCORING_VERSION : value.version;
  if (![V1_SCORING_VERSION, LEGACY_V1_SCORING_VERSION].includes(version)) {
    throw httpError(400, 'scoringConfig.version is unsupported');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = (mode) => [
    ...(value.version === undefined ? [] : ['version']),
    'mode',
    ...(mode === 'single' ? ['reviewerId'] : [])
  ].sort();
  if (value.mode === 'single') {
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys('single'))) {
      throw httpError(400, 'single scoringConfig requires only mode and reviewerId');
    }
    if (!V1_REVIEWER_IDS.includes(value.reviewerId)) {
      throw httpError(400, 'scoringConfig.reviewerId is not registered');
    }
    return { version, mode: 'single', reviewerId: value.reviewerId };
  }
  if (value.mode === 'panel') {
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys('panel'))) {
      throw httpError(400, 'panel scoringConfig does not accept reviewerId');
    }
    return { version, mode: 'panel' };
  }
  throw httpError(400, 'scoringConfig.mode must be single or panel');
}

export function assertV1ScoringReady(config, evaluationMode, reviewers) {
  if (evaluationMode !== 'live') return;
  const reviewerById = new Map(Array.isArray(reviewers)
    ? reviewers.map((reviewer) => [reviewer?.id, reviewer])
    : []);
  const requiredIds = config?.mode === 'panel'
    ? V1_REVIEWER_IDS
    : [config?.reviewerId];
  const unavailable = requiredIds.flatMap((id) => {
    const reviewer = reviewerById.get(id);
    const reason = liveReviewerReadinessFailure(reviewer);
    return reason ? [`${id} (${reason})`] : [];
  });
  if (unavailable.length) {
    throw httpError(503, `V1 model scoring is unavailable; reviewer seats: ${unavailable.join(', ')}`);
  }
}

export async function scoreV1ArenaCase({
  testCase,
  entries,
  config,
  reviewers,
  evaluationMode,
  seed,
  signal,
  invokeJudge
} = {}) {
  assertResolvedConfig(config);
  return config.version === LEGACY_V1_SCORING_VERSION
    ? scoreLegacyV1ArenaCase({ testCase, entries, config, reviewers, evaluationMode, seed, signal, invokeJudge })
    : scoreV2ArenaCase({ testCase, entries, config, reviewers, evaluationMode, seed, signal, invokeJudge });
}

async function scoreLegacyV1ArenaCase({
  testCase,
  entries,
  config,
  reviewers,
  evaluationMode,
  seed,
  signal,
  invokeJudge
}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (!Array.isArray(reviewers)) throw new TypeError('reviewers must be an array');
  assertV1ScoringReady(config, evaluationMode, reviewers);
  signal?.throwIfAborted();

  const normalizedEntries = entries.map((entry) => ({ ...structuredClone(entry) }));
  const successfulEntries = normalizedEntries.filter((entry) => !isLegacyExecutionFailed(entry));
  const failedEntries = normalizedEntries.filter(isLegacyExecutionFailed);
  for (const entry of failedEntries) {
    entry.score = 0;
    entry.scoreStatus = 'execution-failed';
    entry.dimensions = null;
    entry.judgeReviews = [];
  }

  if (!successfulEntries.length) {
    return {
      status: 'scored',
      entries: normalizedEntries,
      judging: judgingSummary(config, 'scored', 0, [])
    };
  }

  const reviewerById = new Map(reviewers.map((reviewer) => [reviewer?.id, reviewer]));
  const seatReviewers = (config.mode === 'panel' ? V1_REVIEWER_IDS : [config.reviewerId])
    .map((id) => reviewerById.get(id) || demoReviewer(id));
  const settled = await Promise.allSettled(seatReviewers.map((reviewer) => scoreSeat({
    reviewer,
    testCase,
    entries: successfulEntries,
    evaluationMode,
    seed,
    signal,
    invokeJudge
  })));
  signal?.throwIfAborted();
  const seats = settled.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : failedSeat(seatReviewers[index], evaluationMode, result.reason));
  const successfulSeats = seats.filter((seat) => seat.status === 'scored');
  const minimumSeats = config.mode === 'panel' ? 2 : 1;

  if (successfulSeats.length < minimumSeats) {
    for (const entry of successfulEntries) {
      entry.score = null;
      entry.scoreStatus = 'model-failed';
      entry.dimensions = null;
      entry.judgeReviews = successfulSeats.map((seat) => publicJudgeReview(
        seat,
        seat.reviewsByEntryId.get(entry.id)
      ));
    }
    return {
      status: 'failed',
      entries: normalizedEntries,
      judging: judgingSummary(config, 'failed', successfulSeats.length, seats)
    };
  }

  for (const entry of successfulEntries) {
    const reviews = successfulSeats.map((seat) => seat.reviewsByEntryId.get(entry.id));
    const dimensions = Object.fromEntries(LEGACY_DIMENSION_KEYS.map((key) => [
      key,
      median(reviews.map((review) => review.dimensions[key]))
    ]));
    entry.score = median(reviews.map((review) => review.total));
    entry.scoreStatus = 'scored';
    entry.dimensions = dimensions;
    entry.judgeReviews = reviews.map((review, index) => publicJudgeReview(successfulSeats[index], review));
  }
  return {
    status: 'scored',
    entries: normalizedEntries,
    judging: judgingSummary(config, 'scored', successfulSeats.length, seats)
  };
}

async function scoreV2ArenaCase({
  testCase,
  entries,
  config,
  reviewers,
  evaluationMode,
  seed,
  signal,
  invokeJudge
}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (!Array.isArray(reviewers)) throw new TypeError('reviewers must be an array');
  assertV1ScoringReady(config, evaluationMode, reviewers);
  signal?.throwIfAborted();

  const normalizedEntries = entries.map((entry) => ({ ...structuredClone(entry) }));
  for (const entry of normalizedEntries) assertAuthoritativeExecution(entry.execution);
  const successfulEntries = normalizedEntries.filter((entry) => !isV2ExecutionFailed(entry));
  const failedEntries = normalizedEntries.filter(isV2ExecutionFailed);
  for (const entry of failedEntries) applyFailedV2Score(entry);

  if (!successfulEntries.length) {
    return {
      status: 'scored',
      entries: normalizedEntries,
      judging: v2JudgingSummary(config, 'scored', 0, [], null)
    };
  }

  const reviewerById = new Map(reviewers.map((reviewer) => [reviewer?.id, reviewer]));
  const seatReviewers = (config.mode === 'panel' ? V1_REVIEWER_IDS : [config.reviewerId])
    .map((id) => reviewerById.get(id) || demoReviewer(id));
  const settled = await Promise.allSettled(seatReviewers.map((reviewer) => scoreV2Seat({
    reviewer,
    testCase,
    entries: successfulEntries,
    evaluationMode,
    seed,
    signal,
    invokeJudge
  })));
  signal?.throwIfAborted();
  const seats = settled.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : failedSeat(seatReviewers[index], evaluationMode, result.reason));
  const successfulSeats = seats.filter((seat) => seat.status === 'scored');
  const minimumSeats = config.mode === 'panel' ? 2 : 1;
  const scenario = successfulSeats.length
    ? aggregateScenario(successfulSeats)
    : null;

  if (successfulSeats.length < minimumSeats) {
    for (const entry of successfulEntries) {
      entry.score = null;
      entry.scoreStatus = 'model-failed';
      entry.dimensions = null;
      entry.detail = { scenario: null, professionalism: null, capability: capabilityDetails(entry) };
      entry.judgeReviews = successfulSeats.map((seat) => publicV2JudgeReview(
        seat,
        seat.reviewsByEntryId.get(entry.id)
      ));
    }
    return {
      status: 'failed',
      entries: normalizedEntries,
      judging: v2JudgingSummary(config, 'failed', successfulSeats.length, seats, scenario)
    };
  }

  for (const entry of successfulEntries) {
    const reviews = successfulSeats.map((seat) => seat.reviewsByEntryId.get(entry.id));
    const professionalDimensions = medianDimensions(reviews, PROFESSIONAL_DIMENSION_KEYS);
    const scenarioValue = scenario.score;
    const professionalQuality = weightedTotal(professionalDimensions, PROFESSIONAL_WEIGHTS);
    const capability = capabilityDetails(entry);
    const agentCapability = capability.capabilityScore;
    entry.dimensions = { scenarioValue, professionalQuality, agentCapability };
    entry.detail = {
      scenario: structuredClone(scenario),
      professionalism: {
        dimensions: professionalDimensions,
        score: professionalQuality
      },
      capability
    };
    entry.score = round(
      scenarioValue * TOTAL_WEIGHTS.scenarioValue
      + professionalQuality * TOTAL_WEIGHTS.professionalQuality
      + agentCapability * TOTAL_WEIGHTS.agentCapability,
      1
    );
    entry.scoreStatus = 'scored';
    entry.judgeReviews = reviews.map((review, index) => publicV2JudgeReview(successfulSeats[index], review));
  }
  return {
    status: 'scored',
    entries: normalizedEntries,
    judging: v2JudgingSummary(config, 'scored', successfulSeats.length, seats, scenario)
  };
}

async function scoreV2Seat({ reviewer, testCase, entries, evaluationMode, seed, signal, invokeJudge }) {
  const candidateRecords = deterministicShuffle(entries.map((entry) => ({
    entryId: entry.id,
    candidateId: opaqueCandidateId(seed, reviewer.id, entry.id),
    output: entry.output
  })), deriveSeed(seed, `v1-arena:${reviewer.id}`));
  const revealMap = new Map(candidateRecords.map((candidate) => [candidate.candidateId, candidate.entryId]));
  const candidateIds = candidateRecords.map((candidate) => candidate.candidateId);
  const prompt = v1ArenaPrompt({
    testCase: publicTestCase(testCase),
    candidates: candidateRecords.map(({ candidateId, output }) => ({ candidateId, output }))
  });
  const response = evaluationMode === 'live'
    ? await invokeV2LiveJudge({ reviewer, prompt, candidateIds, seed, signal, invokeJudge })
    : deterministicV2DemoJudge({ reviewer, candidateIds, seed, testCase });
  const { scenario, scores } = validateV2JudgeResponse(response, candidateIds);
  const reviewsByEntryId = new Map(scores.map((score) => [
    revealMap.get(score.candidateId),
    score
  ]));
  return {
    reviewer,
    mode: evaluationMode === 'live' ? 'live' : 'demo',
    status: 'scored',
    scenario,
    reviewsByEntryId
  };
}

async function invokeV2LiveJudge({ reviewer, prompt, candidateIds, seed, signal, invokeJudge }) {
  const sampling = {
    seed: deriveSeed(seed, `v1-arena-seat:${reviewer.id}`),
    temperature: 0,
    requiredKeys: ['scenario', 'scores']
  };
  if (typeof invokeJudge === 'function') {
    return invokeJudge({
      reviewer,
      system: V1_ARENA_SYSTEM_PROMPT,
      prompt,
      candidateIds,
      signal,
      sampling
    });
  }
  return requestJson(reviewer, V1_ARENA_SYSTEM_PROMPT, prompt, signal, sampling);
}

function deterministicV2DemoJudge({ reviewer, candidateIds, seed, testCase }) {
  const scope = `${seed}:${reviewer.id}:${JSON.stringify(publicTestCase(testCase))}`;
  return {
    scenario: {
      dimensions: Object.fromEntries(SCENARIO_DIMENSION_KEYS.map((key) => [
        key,
        stableNumber(`${scope}:scenario:${key}`, 45, 85)
      ])),
      rationale: '确定性演示评分，仅用于展示共享场景判断。',
      uncertainties: ['演示模式未调用真实评审模型。']
    },
    scores: candidateIds.map((candidateId) => ({
      candidateId,
      dimensions: Object.fromEntries(PROFESSIONAL_DIMENSION_KEYS.map((key) => [
        key,
        stableNumber(`${scope}:${candidateId}:${key}`, 45, 85)
      ])),
      rationale: '确定性演示评分，仅用于展示专业质量评分流程。',
      uncertainties: ['演示模式未调用真实评审模型。']
    }))
  };
}

function validateV2JudgeResponse(value, candidateIds) {
  if (!isObject(value) || !hasKeys(value, ['scenario', 'scores']) || !Array.isArray(value.scores)) {
    throw new TypeError('judge response must contain scenario and scores');
  }
  const scenario = validateV2Scenario(value.scenario);
  if (value.scores.length !== candidateIds.length) {
    throw new TypeError('judge response must score every candidate exactly once');
  }
  const allowed = new Set(candidateIds);
  const seen = new Set();
  const scores = value.scores.map((item) => {
    if (!isObject(item) || !hasKeys(item, V2_SCORE_ITEM_KEYS)) {
      throw new TypeError('judge score item is missing required keys');
    }
    if (!allowed.has(item.candidateId) || seen.has(item.candidateId)) {
      throw new TypeError('judge response has an unknown or duplicate candidateId');
    }
    seen.add(item.candidateId);
    if (!isObject(item.dimensions) || !sameKeys(item.dimensions, PROFESSIONAL_DIMENSION_KEYS)) {
      throw new TypeError('judge score dimensions have invalid keys');
    }
    return {
      candidateId: item.candidateId,
      dimensions: normalizeDimensions(item.dimensions, PROFESSIONAL_DIMENSION_KEYS),
      rationale: normalizeChineseText(item.rationale, 'judge rationale'),
      uncertainties: normalizeUncertainties(item.uncertainties)
    };
  });
  return { scenario, scores };
}

function validateV2Scenario(value) {
  if (!isObject(value) || !hasKeys(value, V2_SCENARIO_KEYS)) {
    throw new TypeError('judge scenario is missing required keys');
  }
  if (!isObject(value.dimensions) || !sameKeys(value.dimensions, SCENARIO_DIMENSION_KEYS)) {
    throw new TypeError('judge scenario dimensions have invalid keys');
  }
  return {
    dimensions: normalizeDimensions(value.dimensions, SCENARIO_DIMENSION_KEYS),
    rationale: normalizeChineseText(value.rationale, 'judge scenario rationale'),
    uncertainties: normalizeUncertainties(value.uncertainties)
  };
}

function normalizeDimensions(dimensions, keys) {
  return Object.fromEntries(keys.map((key) => [
    key,
    normalizeScore(dimensions[key], `dimensions.${key}`)
  ]));
}

function normalizeChineseText(value, field) {
  if (typeof value !== 'string' || !containsCjk(value)) {
    throw new TypeError(`${field} must be written in Simplified Chinese`);
  }
  return value;
}

function normalizeUncertainties(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError('judge uncertainties must be an array of strings');
  }
  if (value.some((text) => text.trim() && !containsCjk(text))) {
    throw new TypeError('judge uncertainties must be written in Simplified Chinese');
  }
  return [...value];
}

function aggregateScenario(seats) {
  const dimensions = medianDimensions(seats.map((seat) => seat.scenario), SCENARIO_DIMENSION_KEYS);
  return { dimensions, score: weightedTotal(dimensions, SCENARIO_WEIGHTS) };
}

function medianDimensions(reviews, keys) {
  return Object.fromEntries(keys.map((key) => [
    key,
    median(reviews.map((review) => review.dimensions[key]))
  ]));
}

function applyFailedV2Score(entry) {
  entry.score = 0;
  entry.scoreStatus = 'execution-failed';
  entry.dimensions = null;
  entry.detail = { scenario: null, professionalism: null, capability: capabilityDetails(entry) };
  entry.judgeReviews = [];
}

function capabilityDetails(entry) {
  const execution = assertAuthoritativeExecution(entry?.execution);
  const executionSuccessScore = execution.status === 'succeeded' ? 100 : 0;
  const latency = latencyScore(execution.durationMs);
  return {
    status: execution.status,
    durationMs: execution.durationMs,
    timingScope: execution.timingScope || 'end-to-end-wall-clock',
    includesNetwork: execution.includesNetwork !== false,
    toolObservation: execution.toolObservation || 'unavailable',
    executionSuccessScore,
    latencyScore: latency,
    capabilityScore: capabilityScore(execution)
  };
}

export function latencyScore(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs >= 600_000) return 0;
  if (durationMs <= 60_000) return 100;
  return round(100 * (600_000 - durationMs) / 540_000, 1);
}

export function capabilityScore(execution) {
  const normalized = assertAuthoritativeExecution(execution);
  if (normalized.status !== 'succeeded') return 0;
  return round(70 + latencyScore(normalized.durationMs) * 0.3, 1);
}

function assertAuthoritativeExecution(value) {
  if (!isObject(value)) {
    throw new TypeError('V2 scoring requires an authoritative execution record');
  }
  if (!['succeeded', 'failed'].includes(value.status)) {
    throw new TypeError('V2 scoring requires authoritative execution.status');
  }
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0) {
    throw new TypeError('V2 scoring requires authoritative execution.durationMs as a finite non-negative number');
  }
  return value;
}

function publicTestCase(testCase) {
  const value = isObject(testCase) ? testCase : {};
  return {
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    ...(Array.isArray(value.constraints) ? { constraints: value.constraints.filter((item) => typeof item === 'string') } : {}),
    ...(typeof value.expectedDeliverable === 'string' ? { expectedDeliverable: value.expectedDeliverable } : {})
  };
}

async function scoreSeat({ reviewer, testCase, entries, evaluationMode, seed, signal, invokeJudge }) {
  const candidateRecords = deterministicShuffle(entries.map((entry) => ({
    entryId: entry.id,
    candidateId: opaqueCandidateId(seed, reviewer.id, entry.id),
    output: entry.output
  })), deriveSeed(seed, `v1-arena:${reviewer.id}`));
  const revealMap = new Map(candidateRecords.map((candidate) => [candidate.candidateId, candidate.entryId]));
  const candidateIds = candidateRecords.map((candidate) => candidate.candidateId);
  const prompt = legacyV1ArenaPrompt({
    testCase,
    candidates: candidateRecords.map(({ candidateId, output }) => ({ candidateId, output }))
  });
  const response = evaluationMode === 'live'
    ? await invokeLiveJudge({ reviewer, prompt, candidateIds, seed, signal, invokeJudge })
    : deterministicDemoJudge({ reviewer, candidateIds, seed, testCase });
  const scores = validateLegacyJudgeResponse(response, candidateIds);
  const reviewsByEntryId = new Map(scores.map((score) => [
    revealMap.get(score.candidateId),
    {
      dimensions: score.dimensions,
      total: weightedTotal(score.dimensions, LEGACY_WEIGHTS),
      rationale: score.rationale,
      uncertainties: score.uncertainties
    }
  ]));
  return {
    reviewer,
    mode: evaluationMode === 'live' ? 'live' : 'demo',
    status: 'scored',
    reviewsByEntryId
  };
}

async function invokeLiveJudge({ reviewer, prompt, candidateIds, seed, signal, invokeJudge }) {
  const sampling = {
    seed: deriveSeed(seed, `v1-arena-seat:${reviewer.id}`),
    temperature: 0,
    requiredKeys: ['scores']
  };
  if (typeof invokeJudge === 'function') {
    return invokeJudge({
      reviewer,
      system: LEGACY_V1_ARENA_SYSTEM_PROMPT,
      prompt,
      candidateIds,
      signal,
      sampling
    });
  }
  return requestJson(reviewer, LEGACY_V1_ARENA_SYSTEM_PROMPT, prompt, signal, sampling);
}

function deterministicDemoJudge({ reviewer, candidateIds, seed, testCase }) {
  const scope = `${seed}:${reviewer.id}:${JSON.stringify(testCase || {})}`;
  return {
    scores: candidateIds.map((candidateId) => {
      const dimensions = Object.fromEntries(LEGACY_DIMENSION_KEYS.map((key) => [
        key,
        stableNumber(`${scope}:${candidateId}:${key}`, 45, 85)
      ]));
      return {
        candidateId,
        dimensions,
        total: weightedTotal(dimensions, LEGACY_WEIGHTS),
        rationale: '确定性演示评分，仅用于展示竞技评分流程。',
        uncertainties: ['演示模式未调用真实评审模型。']
      };
    })
  };
}

function validateLegacyJudgeResponse(value, candidateIds) {
  if (!isObject(value) || !sameKeys(value, ['scores']) || !Array.isArray(value.scores)) {
    throw new TypeError('judge response must contain only scores');
  }
  if (value.scores.length !== candidateIds.length) {
    throw new TypeError('judge response must score every candidate exactly once');
  }
  const allowed = new Set(candidateIds);
  const seen = new Set();
  return value.scores.map((item) => {
    if (!isObject(item) || !hasKeys(item, LEGACY_SCORE_ITEM_KEYS)) {
      throw new TypeError('judge score item is missing required keys');
    }
    if (!allowed.has(item.candidateId) || seen.has(item.candidateId)) {
      throw new TypeError('judge response has an unknown or duplicate candidateId');
    }
    seen.add(item.candidateId);
    if (!isObject(item.dimensions) || !sameKeys(item.dimensions, LEGACY_DIMENSION_KEYS)) {
      throw new TypeError('judge score dimensions have invalid keys');
    }
    const dimensions = Object.fromEntries(LEGACY_DIMENSION_KEYS.map((key) => [
      key,
      normalizeScore(item.dimensions[key], `dimensions.${key}`)
    ]));
    normalizeScore(item.total, 'total');
    if (typeof item.rationale !== 'string' || !containsCjk(item.rationale)) {
      throw new TypeError('judge rationale must be written in Simplified Chinese');
    }
    if (!Array.isArray(item.uncertainties) || item.uncertainties.some((item) => typeof item !== 'string')) {
      throw new TypeError('judge uncertainties must be an array of strings');
    }
    if (item.uncertainties.some((text) => text.trim() && !containsCjk(text))) {
      throw new TypeError('judge uncertainties must be written in Simplified Chinese');
    }
    return {
      candidateId: item.candidateId,
      dimensions,
      rationale: item.rationale,
      uncertainties: [...item.uncertainties]
    };
  });
}

function containsCjk(value) {
  return /[\p{Script=Han}]/u.test(String(value || ''));
}

function weightedTotal(dimensions, weights) {
  return round(Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + dimensions[key] * weight,
    0
  ), 1);
}

function deterministicShuffle(items, seed) {
  return items.map((item) => ({
    item,
    order: stableNumber(`${seed}:${item.candidateId}`, 1, 2_147_483_646)
  })).sort((left, right) => (
    left.order - right.order || left.item.candidateId.localeCompare(right.item.candidateId)
  )).map(({ item }) => item);
}

function opaqueCandidateId(seed, reviewerId, entryId) {
  return createHash('sha256')
    .update(`${seed}:${reviewerId}:${entryId}`)
    .digest('hex');
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : round((sorted[middle - 1] + sorted[middle]) / 2, 1);
}

function publicJudgeReview(seat, review) {
  return {
    reviewerId: seat.reviewer.id,
    reviewerName: seat.reviewer.name,
    model: seat.reviewer.model,
    mode: seat.mode,
    status: seat.status,
    rationale: review.rationale,
    uncertainties: review.uncertainties
  };
}

function publicV2JudgeReview(seat, review) {
  return {
    reviewerId: seat.reviewer.id,
    reviewerName: seat.reviewer.name,
    model: seat.reviewer.model,
    mode: seat.mode,
    status: seat.status,
    dimensions: review.dimensions,
    score: weightedTotal(review.dimensions, PROFESSIONAL_WEIGHTS),
    rationale: review.rationale,
    uncertainties: review.uncertainties
  };
}

function publicScenarioReview(seat) {
  return {
    reviewerId: seat.reviewer.id,
    reviewerName: seat.reviewer.name,
    model: seat.reviewer.model,
    mode: seat.mode,
    status: seat.status,
    dimensions: seat.scenario.dimensions,
    score: weightedTotal(seat.scenario.dimensions, SCENARIO_WEIGHTS),
    rationale: seat.scenario.rationale,
    uncertainties: seat.scenario.uncertainties
  };
}

function judgingSummary(config, status, successfulSeats, seats) {
  return {
    version: config.version,
    status,
    mode: config.mode,
    ...(config.mode === 'single' ? { reviewerId: config.reviewerId } : {}),
    requiredSeats: config.mode === 'panel' ? V1_REVIEWER_IDS.length : 1,
    successfulSeats,
    seats: seats.map(publicSeat)
  };
}

function v2JudgingSummary(config, status, successfulSeats, seats, scenario) {
  return {
    ...judgingSummary(config, status, successfulSeats, seats),
    scenario: {
      ...(scenario ? { dimensions: scenario.dimensions, score: scenario.score } : {}),
      reviews: seats.filter((seat) => seat.status === 'scored').map(publicScenarioReview)
    }
  };
}

function publicSeat(seat) {
  return {
    reviewerId: seat.reviewer.id,
    reviewerName: seat.reviewer.name,
    model: seat.reviewer.model,
    mode: seat.mode,
    status: seat.status,
    ...(seat.failure ? { failure: seat.failure } : {})
  };
}

function failedSeat(reviewer, evaluationMode, error) {
  return {
    reviewer,
    mode: evaluationMode === 'live' ? 'live' : 'demo',
    status: 'failed',
    failure: error instanceof Error ? error.message : String(error)
  };
}

function demoReviewer(id) {
  return { id, name: id, model: 'Deterministic Demo', kind: 'mock' };
}

function liveReviewerReadinessFailure(reviewer) {
  if (!reviewer || reviewer.kind === 'mock') return 'missing live reviewer';
  if (!LIVE_REVIEWER_KINDS.includes(reviewer.kind)) {
    return `unsupported kind ${String(reviewer.kind || 'missing')}`;
  }
  const missingField = LIVE_REVIEWER_FIELDS.find((field) =>
    typeof reviewer[field] !== 'string' || !reviewer[field].trim()
  );
  if (missingField) return `missing ${missingField}`;
  if (!process.env[reviewer.apiKeyEnv]) {
    return `missing secret ${reviewer.apiKeyEnv}`;
  }
  return null;
}

function isLegacyExecutionFailed(entry) {
  return entry?.mode === 'failed'
    || entry?.scoreStatus === 'execution-failed';
}

function isV2ExecutionFailed(entry) {
  return entry?.execution?.status === 'failed';
}

function assertResolvedConfig(config) {
  if (!config || ![V1_SCORING_VERSION, LEGACY_V1_SCORING_VERSION].includes(config.version)) {
    throw new TypeError('unsupported V1 scoring config version');
  }
  if (config.mode === 'single' && V1_REVIEWER_IDS.includes(config.reviewerId)) return;
  if (config.mode === 'panel' && config.reviewerId === undefined) return;
  throw new TypeError('invalid normalized V1 scoring config');
}

function normalizeScore(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${field} must be a finite 0-100 number`);
  }
  return value;
}

function sameKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function hasKeys(value, expected) {
  return expected.every((key) => Object.hasOwn(value, key));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
