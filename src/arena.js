import { createHash } from 'node:crypto';
import { createEvidenceRecord } from './evidence.js';
import { configuredArenaReviewers, requestJson } from './providers.js';
import { ANONYMOUS_ARENA_SYSTEM_PROMPT, arenaComparisonPrompt } from './prompts.js';
import { deriveSeed, normalizeSeed } from './utils.js';

const DIMENSION_KEYS = Object.freeze([
  'taskConstraint',
  'professionalQuality',
  'evidenceRisk',
  'artifactUsability'
]);
const SCORE_WEIGHTS = Object.freeze({
  taskConstraint: 0.4,
  professionalQuality: 0.3,
  evidenceRisk: 0.2,
  artifactUsability: 0.1
});

export function buildArenaCells(options = {}) {
  const testPlan = requiredObject(options.testPlan, 'testPlan');
  const tests = requiredArray(testPlan.tests, 'testPlan.tests');
  const submittedOutputs = indexOutputs(
    requiredArray(options.submittedOutputs, 'submittedOutputs'),
    'submittedOutputs'
  );
  const replicas = requiredArray(options.replicas, 'replicas')
    .filter((replica) => replica?.validity === 'valid')
    .map((replica) => ({
      runtimeId: requiredText(replica.runtimeId, 'replica.runtimeId'),
      outputs: indexOutputs(requiredArray(replica.outputs, 'replica.outputs'), 'replica.outputs')
    }));
  assertDistinct(replicas.map((replica) => replica.runtimeId), 'valid replica runtime IDs');

  const cells = [];
  for (const test of tests) {
    const testId = requiredText(test?.testId, 'test.testId');
    const repeatCount = requiredPositiveInteger(test?.repeatCount ?? testPlan.defaultRepeatCount ?? 1, 'test.repeatCount');
    const task = {
      input: structuredClone(test.input ?? { turns: test.turns }),
      constraints: Array.isArray(test.constraints) ? structuredClone(test.constraints) : [],
      expectedDeliverable: typeof test.expectedDeliverable === 'string'
        ? test.expectedDeliverable
        : undefined
    };
    for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
      const outputKey = cellKey(testId, repeatIndex);
      const candidates = [{
        sourceId: 'submitted',
        output: projectOutput(requiredOutput(submittedOutputs, outputKey, 'submitted'))
      }];
      for (const replica of replicas) {
        candidates.push({
          sourceId: `replica:${replica.runtimeId}`,
          output: projectOutput(requiredOutput(replica.outputs, outputKey, `replica:${replica.runtimeId}`))
        });
      }
      cells.push({ testId, repeatIndex, task, candidates });
    }
  }
  return cells;
}

export function createArenaJudgePacket(cell, reviewer, seed) {
  const normalizedCell = normalizeCell(cell);
  const reviewerId = requiredText(reviewer?.id, 'reviewer.id');
  const labelSeed = normalizeSeed(seed);
  const labels = new Set();
  const candidates = normalizedCell.candidates.map((candidate) => {
    const candidateId = opaqueCandidateId(labelSeed, reviewerId, candidate.sourceId);
    if (labels.has(candidateId)) throw new Error('opaque candidate label collision');
    labels.add(candidateId);
    return { candidateId, output: structuredClone(candidate.output) };
  });
  return {
    task: structuredClone(normalizedCell.task),
    candidates: deterministicShuffle(candidates, deriveSeed(labelSeed, `candidate-order:${reviewerId}`))
  };
}

export async function runAnonymousArena(options = {}) {
  const cells = options.cells
    ? requiredArray(options.cells, 'cells').map(normalizeCell)
    : buildArenaCells(options);
  const reviewers = options.reviewers
    ? requiredArray(options.reviewers, 'reviewers')
    : configuredArenaReviewers(options.env);
  if (!reviewers.length) throw new TypeError('at least one arena reviewer is required');
  const evidenceVault = options.evidenceVault;
  if (!evidenceVault || typeof evidenceVault.put !== 'function') {
    throw new TypeError('arena reveal maps require an encrypted evidenceVault');
  }
  const seed = normalizeSeed(options.seed);
  const anonymousCells = [];
  const revealedJudgements = [];

  for (const cell of cells) {
    for (const reviewer of reviewers) {
      const reviewerId = requiredText(reviewer?.id, 'reviewer.id');
      const judgeSeed = deriveSeed(seed, `arena:${cell.testId}:${cell.repeatIndex}:${reviewerId}`);
      const packet = createArenaJudgePacket(cell, reviewer, judgeSeed);
      const value = options.invokeJudge
        ? await options.invokeJudge({
          reviewer,
          system: ANONYMOUS_ARENA_SYSTEM_PROMPT,
          prompt: arenaComparisonPrompt(packet),
          packet: structuredClone(packet),
          seed: judgeSeed,
          signal: options.signal
        })
        : await requestJson(
          reviewer,
          ANONYMOUS_ARENA_SYSTEM_PROMPT,
          arenaComparisonPrompt(packet),
          options.signal,
          { seed: judgeSeed, temperature: 0, maxTokens: options.maxTokens ?? 4000 }
        );
      const anonymousScores = normalizeArenaJudgement(value, packet.candidates.map((item) => item.candidateId));
      const revealMap = revealMapFor(cell, reviewerId, judgeSeed);
      const evidence = await persistRevealMap({
        evidenceVault,
        cell,
        reviewerId,
        revealMap,
        now: options.now
      });
      anonymousCells.push({
        testId: cell.testId,
        repeatIndex: cell.repeatIndex,
        judgeId: reviewerId,
        anonymousScores,
        encryptedRevealMapEvidenceId: evidence.evidenceId
      });
      revealedJudgements.push({
        testId: cell.testId,
        repeatIndex: cell.repeatIndex,
        judgeId: reviewerId,
        scores: Object.fromEntries(anonymousScores.map((score) => [
          revealMap[score.candidateId],
          score.total
        ]))
      });
    }
  }

  const validReplicaIds = uniqueReplicaIds(cells);
  return {
    arenaVersion: 'anonymous-arena/v1',
    cells: anonymousCells,
    scoringCube: aggregateArenaScores(revealedJudgements, validReplicaIds)
  };
}

export function aggregateArenaScores(judgements, validReplicaIds) {
  const allowed = new Set([
    'submitted',
    ...requiredArray(validReplicaIds, 'validReplicaIds').map((id) => `replica:${requiredText(id, 'validReplicaId')}`)
  ]);
  return requiredArray(judgements, 'judgements').map((judgement) => {
    const scores = requiredObject(judgement?.scores, 'judgement.scores');
    const filtered = {};
    for (const key of allowed) {
      if (Object.hasOwn(scores, key)) {
        assertFiniteScore(scores[key], `judgement.scores.${key}`);
        filtered[key] = scores[key];
      }
    }
    if (!Object.hasOwn(filtered, 'submitted')) throw new TypeError('judgement requires submitted score');
    return {
      testId: requiredText(judgement?.testId, 'judgement.testId'),
      repeatIndex: requiredNonNegativeInteger(judgement?.repeatIndex, 'judgement.repeatIndex'),
      judgeId: requiredText(judgement?.judgeId, 'judgement.judgeId'),
      scores: filtered
    };
  });
}

function normalizeArenaJudgement(value, expectedCandidateIds) {
  const judgement = requiredObject(value, 'arena judgement');
  assertExactKeys(judgement, ['scores'], 'arena judgement');
  const scores = requiredArray(judgement.scores, 'arena judgement.scores');
  if (scores.length !== expectedCandidateIds.length) throw new TypeError('arena judgement has missing or duplicate candidates');
  const expected = new Set(expectedCandidateIds);
  const seen = new Set();
  return scores.map((score) => {
    const item = requiredObject(score, 'arena score');
    assertExactKeys(item, ['candidateId', 'dimensions', 'total', 'rationale', 'uncertainties'], 'arena score');
    const candidateId = requiredText(item.candidateId, 'arena score.candidateId');
    if (!expected.has(candidateId) || seen.has(candidateId)) {
      throw new TypeError('arena judgement has unknown or duplicate candidate');
    }
    seen.add(candidateId);
    const dimensions = requiredObject(item.dimensions, 'arena score.dimensions');
    assertExactKeys(dimensions, DIMENSION_KEYS, 'arena score.dimensions');
    const normalizedDimensions = Object.fromEntries(DIMENSION_KEYS.map((key) => {
      assertFiniteScore(dimensions[key], `arena score.dimensions.${key}`);
      return [key, dimensions[key]];
    }));
    if (!Number.isFinite(item.total)) {
      throw new TypeError('arena score.total must be a finite number');
    }
    if (typeof item.rationale !== 'string') throw new TypeError('arena score.rationale must be a string');
    if (!Array.isArray(item.uncertainties)) throw new TypeError('arena score.uncertainties must be an array');
    if (item.uncertainties.some((uncertainty) => typeof uncertainty !== 'string')) {
      throw new TypeError('arena score.uncertainties must contain strings');
    }
    return {
      candidateId,
      dimensions: normalizedDimensions,
      total: weightedTotal(normalizedDimensions),
      rationale: item.rationale,
      uncertainties: structuredClone(item.uncertainties)
    };
  });
}

function normalizeCell(cell) {
  const value = requiredObject(cell, 'arena cell');
  const candidates = requiredArray(value.candidates, 'arena cell.candidates').map((candidate) => ({
    sourceId: requiredText(candidate?.sourceId, 'arena candidate.sourceId'),
    output: projectOutput(candidate?.output)
  }));
  if (!candidates.some((candidate) => candidate.sourceId === 'submitted')) {
    throw new TypeError('arena cell requires submitted candidate');
  }
  assertDistinct(candidates.map((candidate) => candidate.sourceId), 'arena candidate source IDs');
  return {
    testId: requiredText(value.testId, 'arena cell.testId'),
    repeatIndex: requiredNonNegativeInteger(value.repeatIndex, 'arena cell.repeatIndex'),
    task: structuredClone(requiredObject(value.task, 'arena cell.task')),
    candidates
  };
}

function projectOutput(value) {
  const output = requiredObject(value, 'candidate output');
  const projected = {};
  if (Array.isArray(output.messageParts)) projected.messageParts = projectParts(output.messageParts);
  if (Array.isArray(output.artifacts)) projected.artifacts = output.artifacts
    .map(projectArtifact)
    .filter(Boolean);
  if (!Object.keys(projected).length) throw new TypeError('candidate output requires messageParts or artifacts');
  return projected;
}

function projectArtifact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const artifact = {};
  if (typeof value.name === 'string') artifact.name = value.name;
  if (typeof value.description === 'string') artifact.description = value.description;
  if (Array.isArray(value.parts)) artifact.parts = projectParts(value.parts);
  return Object.keys(artifact).length ? artifact : null;
}

function projectParts(parts) {
  return parts.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
    const allowed = part.type === 'text' ? ['type', 'text', 'mediaType', 'filename']
      : part.type === 'data' ? ['type', 'data', 'mediaType', 'filename']
        : part.type === 'raw' ? ['type', 'raw', 'mediaType', 'filename']
          : part.type === 'url' ? ['type', 'url', 'mediaType', 'filename', 'snapshot'] : [];
    if (!allowed.length) return null;
    const required = part.type === 'text' ? 'text'
      : part.type === 'data' ? 'data'
        : part.type === 'raw' ? 'raw' : 'url';
    if (part[required] === undefined) return null;
    return Object.fromEntries(allowed
      .filter((key) => part[key] !== undefined)
      .map((key) => [key, structuredClone(part[key])]));
  }).filter(Boolean);
}

function indexOutputs(outputs, field) {
  const indexed = new Map();
  for (const output of outputs) {
    const testId = requiredText(output?.testId, `${field}.testId`);
    const repeatIndex = requiredNonNegativeInteger(output?.repeatIndex, `${field}.repeatIndex`);
    const key = cellKey(testId, repeatIndex);
    if (indexed.has(key)) throw new TypeError(`${field} has duplicate output for ${key}`);
    indexed.set(key, output);
  }
  return indexed;
}

function requiredOutput(outputs, key, sourceId) {
  const output = outputs.get(key);
  if (!output) throw new TypeError(`missing ${sourceId} output for ${key}`);
  return output;
}

function revealMapFor(cell, reviewerId, seed) {
  const map = {};
  for (const candidate of cell.candidates) {
    const candidateId = opaqueCandidateId(seed, reviewerId, candidate.sourceId);
    if (Object.hasOwn(map, candidateId)) throw new Error('opaque candidate label collision');
    map[candidateId] = candidate.sourceId;
  }
  return map;
}

async function persistRevealMap({ evidenceVault, cell, reviewerId, revealMap, now }) {
  const record = createEvidenceRecord({
    evidenceId: `ev_${hash({ testId: cell.testId, repeatIndex: cell.repeatIndex, reviewerId, revealMap })}`,
    runId: `run_${hash({ testId: cell.testId, repeatIndex: cell.repeatIndex, reviewerId }).slice(0, 32)}`,
    grade: 'C',
    kind: 'agent-output',
    testId: 'arena_reveal',
    repeatIndex: cell.repeatIndex,
    capturedAt: typeof now === 'function' ? now() : new Date().toISOString(),
    payload: {
      phase: 'anonymous-arena-reveal-map',
      testId: cell.testId,
      judgeId: reviewerId,
      revealMap: structuredClone(revealMap)
    }
  });
  return evidenceVault.put(record);
}

function weightedTotal(dimensions) {
  return Number(DIMENSION_KEYS.reduce(
    (total, key) => total + dimensions[key] * SCORE_WEIGHTS[key],
    0
  ).toFixed(6));
}

function opaqueCandidateId(seed, reviewerId, sourceId) {
  return `candidate-${hash({ seed, reviewerId, sourceId }).slice(0, 8)}`;
}

function deterministicShuffle(values, seed) {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const next = state % (index + 1);
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

function uniqueReplicaIds(cells) {
  return [...new Set(cells.flatMap((cell) => cell.candidates)
    .map((candidate) => candidate.sourceId)
    .filter((sourceId) => sourceId.startsWith('replica:'))
    .map((sourceId) => sourceId.slice('replica:'.length)))];
}

function cellKey(testId, repeatIndex) {
  return `${testId}:${repeatIndex}`;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

function requiredPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
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

function assertExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`${field} has unknown or missing fields`);
  }
}

function assertDistinct(values, field) {
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must be distinct`);
}
