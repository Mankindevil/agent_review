import { RUBRIC_V1 } from './rubric.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ATTRIBUTIONS = new Set(['agent', 'platform', 'pending']);
const OBSERVATION_STATUSES = new Set(['passed', 'failed', 'unavailable']);
const CLAIM_STATUSES = new Set([
  'passed', 'failed', 'unavailable', 'not-applicable'
]);
const CONTEXT_KINDS = new Set(['retention', 'correction', 'isolation']);
const ACCEPTANCE_TYPES = new Set([
  'model', 'contains', 'exact', 'json-schema', 'numeric'
]);
const METRIC_IDS = Object.freeze(
  Object.keys(RUBRIC_V1.dimensions.agentCapability)
);
const METRIC_FIELDS = Object.freeze([
  'id',
  'weight',
  'applicable',
  'coverage',
  'score',
  'numerator',
  'denominator',
  'evidenceIds',
  'gaps'
]);
const METRIC_FIELD_SET = new Set(METRIC_FIELDS);

export function durationScore(durationMs, targetMs, timeoutMs) {
  requireNonNegativeFinite(durationMs, 'durationMs');
  requireNonNegativeFinite(targetMs, 'targetMs');
  requireNonNegativeFinite(timeoutMs, 'timeoutMs');
  if (targetMs >= timeoutMs) {
    throw new RangeError('targetMs must be less than timeoutMs');
  }
  if (durationMs <= targetMs) return 100;
  if (durationMs >= timeoutMs) return 0;
  return 100 * (timeoutMs - durationMs) / (timeoutMs - targetMs);
}

export function buildObjectiveMetrics(input = {}) {
  assertClosedObject(input, new Set([
    'plannedTests',
    'contextChecks',
    'a2aChecks',
    'claimChecks',
    'errorHandlingChecks'
  ]), 'objective input');

  const plannedTests = normalizePlannedTests(input.plannedTests ?? []);
  const checkIds = new Set();
  const contextChecks = normalizeChecks(
    input.contextChecks ?? [],
    'contextChecks',
    OBSERVATION_STATUSES,
    checkIds,
    { context: true }
  );
  const a2aChecks = normalizeChecks(
    input.a2aChecks ?? [],
    'a2aChecks',
    OBSERVATION_STATUSES,
    checkIds
  );
  const claimChecks = normalizeChecks(
    input.claimChecks ?? [],
    'claimChecks',
    CLAIM_STATUSES,
    checkIds
  );
  const errorHandlingChecks = normalizeChecks(
    input.errorHandlingChecks ?? [],
    'errorHandlingChecks',
    OBSERVATION_STATUSES,
    checkIds
  );

  return [
    buildTestSuccess(plannedTests),
    buildRobustness(plannedTests),
    buildObservedMetric('contextContinuity', contextChecks, {
      applicable: contextChecks.length > 0
    }),
    buildObservedMetric('a2aCompliance', a2aChecks, { applicable: true }),
    buildEfficiency(plannedTests),
    buildClaimErrorHandling(claimChecks, errorHandlingChecks)
  ];
}

export function aggregateObjectiveCapability(metrics, rubric = RUBRIC_V1) {
  if (!Array.isArray(metrics)) throw new TypeError('metrics must be an array');
  if (!isPlainObject(rubric) || rubric.version !== RUBRIC_V1.version) {
    throw new TypeError('rubric must use a2a-black-box-v1');
  }
  if (metrics.length !== METRIC_IDS.length) {
    throw new TypeError('objective capability requires exactly six metrics');
  }

  const byId = new Map();
  for (const item of metrics) {
    assertClosedObject(item, METRIC_FIELD_SET, 'metric');
    assertRequiredFields(item, METRIC_FIELDS, 'metric');
    assertSafeId(item.id, 'metric id');
    if (!METRIC_IDS.includes(item.id)) {
      throw new TypeError(`unknown objective metric: ${item.id}`);
    }
    if (byId.has(item.id)) throw new TypeError(`duplicate objective metric: ${item.id}`);
    if (item.weight !== metricWeight(item.id)) {
      throw new TypeError(`metric ${item.id} must use its canonical weight`);
    }
    validateMetric(item);
    byId.set(item.id, item);
  }
  for (const id of METRIC_IDS) {
    if (!byId.has(id)) throw new TypeError(`missing objective metric: ${id}`);
  }

  const canonicalMetrics = METRIC_IDS.map((id) => {
    const item = byId.get(id);
    return {
      id: item.id,
      weight: metricWeight(id),
      applicable: item.applicable,
      coverage: item.coverage,
      score: item.score,
      numerator: item.numerator,
      denominator: item.denominator,
      evidenceIds: stableEvidenceIds(item.evidenceIds),
      gaps: [...item.gaps]
    };
  });
  const scorable = canonicalMetrics.filter(
    (item) => item.applicable && Number.isFinite(item.score)
  );
  const hasApplicableUnscored = canonicalMetrics.some(
    (item) => item.applicable && item.score === null
  );
  const applicableWeight = scorable.reduce((sum, item) => sum + item.weight, 0);
  const score = applicableWeight === 0
    ? null
    : scorable.reduce((sum, item) => sum + item.score * item.weight, 0) /
      applicableWeight;
  const coverage = canonicalMetrics.reduce(
    (sum, item) => sum + item.weight * item.coverage,
    0
  ) / 100;
  const status = scorable.length === 0
    ? 'unavailable'
    : hasApplicableUnscored
      ? 'incomplete'
      : 'complete';

  return {
    status,
    score,
    coverage,
    provisional: coverage < 0.70,
    metrics: canonicalMetrics
  };
}

function buildTestSuccess(tests) {
  const totalPlannedWeight = tests.reduce((sum, item) => sum + item.weight, 0);
  const applicableTests = tests.filter((item) => item.requiredExecutable > 0);
  const applicable = applicableTests.length > 0;
  let numerator = 0;
  let denominator = 0;
  let observedWeight = 0;
  const gaps = [];

  for (const item of applicableTests) {
    const cellWeight = item.weight / item.repeatCount;
    const runs = runIndex(item);
    for (let repeatIndex = 0; repeatIndex < item.repeatCount; repeatIndex += 1) {
      const current = runs.get(repeatIndex);
      if (!current) {
        gaps.push(`missing:${item.testId}:${repeatIndex}`);
        continue;
      }
      if (current.attribution !== 'agent') {
        gaps.push(`${current.attribution}:${item.testId}:${repeatIndex}`);
        continue;
      }
      denominator += cellWeight;
      observedWeight += cellWeight;
      if (
        current.terminalSuccess === true &&
        current.acceptance.semanticSuccess === true
      ) {
        numerator += cellWeight;
      }
    }
  }

  return metricResult('testSuccess', {
    applicable,
    coverage: totalPlannedWeight === 0 ? 0 : observedWeight / totalPlannedWeight,
    score: denominator === 0 ? null : numerator * 100 / denominator,
    numerator,
    denominator,
    evidenceIds: evidenceFromTests(tests),
    gaps
  });
}

function buildRobustness(tests) {
  const repeated = tests.filter((item) => item.repeatCount >= 2);
  const applicable = repeated.length > 0;
  const totalPlannedWeight = repeated.reduce((sum, item) => sum + item.weight, 0);
  let numerator = 0;
  let denominator = 0;
  const gaps = [];

  for (const item of repeated) {
    const pairs = item.repeatCount * (item.repeatCount - 1) / 2;
    const componentWeight = item.weight / pairs / 2;
    const runs = runIndex(item);
    for (let left = 0; left < item.repeatCount; left += 1) {
      for (let right = left + 1; right < item.repeatCount; right += 1) {
        const first = runs.get(left);
        const second = runs.get(right);
        const pair = `${item.testId}:${left}-${right}`;
        if (!isAgentObservation(first) || !isAgentObservation(second)) {
          const reason = unavailablePairReason(first, second);
          gaps.push(`${reason}:${pair}:terminal`);
          gaps.push(`${reason}:${pair}:result`);
          continue;
        }

        denominator += componentWeight;
        if (first.terminalSuccess === second.terminalSuccess) {
          numerator += componentWeight;
        }

        const resultAgreement = compareRunResults(first, second);
        if (resultAgreement.available) {
          denominator += componentWeight;
          if (resultAgreement.agrees) numerator += componentWeight;
        } else {
          gaps.push(`unavailable:${pair}:result`);
        }
      }
    }
  }

  return metricResult('robustness', {
    applicable,
    coverage: totalPlannedWeight === 0 ? 0 : denominator / totalPlannedWeight,
    score: denominator === 0 ? null : numerator / denominator * 100,
    numerator,
    denominator,
    evidenceIds: evidenceFromTests(repeated),
    gaps
  });
}

function buildObservedMetric(id, checks, { applicable }) {
  const included = checks;
  const totalWeight = included.reduce((sum, check) => sum + check.weight, 0);
  const available = included.filter((check) => check.status !== 'unavailable');
  const denominator = available.reduce((sum, check) => sum + check.weight, 0);
  const numerator = available
    .filter((check) => check.status === 'passed')
    .reduce((sum, check) => sum + check.weight, 0);
  return metricResult(id, {
    applicable,
    coverage: totalWeight === 0 ? 0 : denominator / totalWeight,
    score: !applicable || denominator === 0
      ? null
      : numerator / denominator * 100,
    numerator,
    denominator,
    evidenceIds: evidenceFromChecks(checks),
    gaps: included
      .filter((check) => check.status === 'unavailable')
      .map((check) => `unavailable:${check.id}`)
  });
}

function buildEfficiency(tests) {
  const totalPlannedWeight = tests.reduce((sum, item) => sum + item.weight, 0);
  let numerator = 0;
  let denominator = 0;
  const gaps = [];

  for (const item of tests) {
    const cellWeight = item.weight / item.repeatCount;
    const runs = runIndex(item);
    for (let repeatIndex = 0; repeatIndex < item.repeatCount; repeatIndex += 1) {
      const current = runs.get(repeatIndex);
      if (!current) {
        gaps.push(`missing:${item.testId}:${repeatIndex}`);
        continue;
      }
      if (current.attribution !== 'agent') {
        gaps.push(`${current.attribution}:${item.testId}:${repeatIndex}`);
        continue;
      }
      if (current.timing.timedOut) {
        denominator += cellWeight;
        continue;
      }
      if (
        item.timingPolicy.streaming &&
        current.timing.firstEventMs === null
      ) {
        gaps.push(`missing-first-event:${item.testId}:${repeatIndex}`);
        continue;
      }
      const completion = durationScore(
        current.timing.durationMs,
        item.timingPolicy.targetMs,
        item.timingPolicy.timeoutMs
      );
      const score = item.timingPolicy.streaming
        ? 0.3 * durationScore(
          current.timing.firstEventMs,
          item.timingPolicy.targetMs,
          item.timingPolicy.timeoutMs
        ) + 0.7 * completion
        : completion;
      numerator += score * cellWeight;
      denominator += cellWeight;
    }
  }

  return metricResult('efficiency', {
    applicable: true,
    coverage: totalPlannedWeight === 0 ? 0 : denominator / totalPlannedWeight,
    score: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
    evidenceIds: evidenceFromTests(tests),
    gaps
  });
}

function buildClaimErrorHandling(claimChecks, errorChecks) {
  const applicableClaims = claimChecks.filter(
    (check) => check.status !== 'not-applicable'
  );
  return buildObservedMetric(
    'claimErrorHandling',
    [...applicableClaims, ...errorChecks],
    { applicable: true }
  );
}

function metricResult(id, values) {
  return {
    id,
    weight: metricWeight(id),
    applicable: values.applicable,
    coverage: normalizeUnit(values.coverage),
    score: values.score,
    numerator: values.numerator,
    denominator: values.denominator,
    evidenceIds: stableEvidenceIds(values.evidenceIds),
    gaps: [...new Set(values.gaps)]
  };
}

function normalizePlannedTests(value) {
  if (!Array.isArray(value)) throw new TypeError('plannedTests must be an array');
  const testIds = new Set();
  return value.map((item, index) => {
    const path = `plannedTests[${index}]`;
    assertClosedObject(item, new Set([
      'testId', 'weight', 'repeatCount', 'requiredExecutable', 'requiresState',
      'timingPolicy', 'runs'
    ]), path);
    assertRequiredFields(item, [
      'testId', 'weight', 'repeatCount', 'requiredExecutable', 'requiresState',
      'timingPolicy', 'runs'
    ], path);
    assertSafeId(item.testId, `${path}.testId`);
    if (testIds.has(item.testId)) throw new TypeError(`duplicate planned test id: ${item.testId}`);
    testIds.add(item.testId);
    requireNonNegativeFinite(item.weight, `${path}.weight`);
    if (!Number.isSafeInteger(item.repeatCount) || item.repeatCount <= 0) {
      throw new TypeError(`${path}.repeatCount must be a positive safe integer`);
    }
    if (
      !Number.isSafeInteger(item.requiredExecutable) ||
      item.requiredExecutable < 0
    ) {
      throw new TypeError(`${path}.requiredExecutable must be a non-negative safe integer`);
    }
    if (typeof item.requiresState !== 'boolean') {
      throw new TypeError(`${path}.requiresState must be a boolean`);
    }
    const timingPolicy = normalizeTimingPolicy(item.timingPolicy, `${path}.timingPolicy`);
    const runs = normalizeRuns(item.runs, item, path);
    return {
      testId: item.testId,
      weight: item.weight,
      repeatCount: item.repeatCount,
      requiredExecutable: item.requiredExecutable,
      requiresState: item.requiresState,
      timingPolicy,
      runs
    };
  });
}

function normalizeTimingPolicy(value, path) {
  assertClosedObject(value, new Set([
    'targetMs', 'timeoutMs', 'streaming'
  ]), path);
  assertRequiredFields(value, ['targetMs', 'timeoutMs', 'streaming'], path);
  requireNonNegativeFinite(value.targetMs, `${path}.targetMs`);
  requireNonNegativeFinite(value.timeoutMs, `${path}.timeoutMs`);
  if (value.targetMs >= value.timeoutMs) {
    throw new RangeError(`${path}.targetMs must be less than timeoutMs`);
  }
  if (typeof value.streaming !== 'boolean') {
    throw new TypeError(`${path}.streaming must be a boolean`);
  }
  return {
    targetMs: value.targetMs,
    timeoutMs: value.timeoutMs,
    streaming: value.streaming
  };
}

function normalizeRuns(value, plannedTest, path) {
  if (!Array.isArray(value)) throw new TypeError(`${path}.runs must be an array`);
  const repeatIndexes = new Set();
  return value.map((item, index) => {
    const runPath = `${path}.runs[${index}]`;
    assertClosedObject(item, new Set([
      'runId', 'repeatIndex', 'attribution', 'terminalSuccess', 'acceptance',
      'schemaFingerprint', 'timing', 'evidenceIds'
    ]), runPath);
    assertRequiredFields(item, [
      'runId', 'repeatIndex', 'attribution', 'terminalSuccess', 'acceptance',
      'schemaFingerprint', 'timing', 'evidenceIds'
    ], runPath);
    assertSafeId(item.runId, `${runPath}.runId`);
    if (
      !Number.isSafeInteger(item.repeatIndex) ||
      item.repeatIndex < 0 ||
      item.repeatIndex >= plannedTest.repeatCount
    ) {
      throw new TypeError(`${runPath}.repeatIndex is outside the planned cells`);
    }
    if (repeatIndexes.has(item.repeatIndex)) {
      throw new TypeError(`duplicate planned cell ${plannedTest.testId}:${item.repeatIndex}`);
    }
    repeatIndexes.add(item.repeatIndex);
    if (!ATTRIBUTIONS.has(item.attribution)) {
      throw new TypeError(`${runPath}.attribution is invalid`);
    }
    if (typeof item.terminalSuccess !== 'boolean') {
      throw new TypeError(`${runPath}.terminalSuccess must be a boolean`);
    }
    const normalizedAcceptance = normalizeAcceptance(item.acceptance, `${runPath}.acceptance`);
    if (normalizedAcceptance.requiredExecutable !== plannedTest.requiredExecutable) {
      throw new TypeError(
        `${runPath}.acceptance.requiredExecutable does not match the planned value`
      );
    }
    if (
      item.schemaFingerprint !== null &&
      (typeof item.schemaFingerprint !== 'string' || item.schemaFingerprint.length === 0)
    ) {
      throw new TypeError(`${runPath}.schemaFingerprint must be a string or null`);
    }
    const timing = normalizeTiming(item.timing, item.attribution, `${runPath}.timing`);
    return {
      runId: item.runId,
      repeatIndex: item.repeatIndex,
      attribution: item.attribution,
      terminalSuccess: item.terminalSuccess,
      acceptance: normalizedAcceptance,
      schemaFingerprint: item.schemaFingerprint,
      timing,
      evidenceIds: stableEvidenceIds(item.evidenceIds)
    };
  });
}

function normalizeAcceptance(value, path) {
  assertClosedObject(value, new Set([
    'requiredExecutable',
    'passedRequiredExecutable',
    'semanticSuccess',
    'checks'
  ]), path);
  for (const field of [
    'requiredExecutable', 'passedRequiredExecutable', 'semanticSuccess', 'checks'
  ]) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${path} requires ${field}`);
  }
  if (!Number.isSafeInteger(value.requiredExecutable) || value.requiredExecutable < 0) {
    throw new TypeError(`${path}.requiredExecutable must be non-negative`);
  }
  if (
    !Number.isSafeInteger(value.passedRequiredExecutable) ||
    value.passedRequiredExecutable < 0 ||
    value.passedRequiredExecutable > value.requiredExecutable
  ) {
    throw new TypeError(`${path}.passedRequiredExecutable is invalid`);
  }
  if (![true, false, null].includes(value.semanticSuccess)) {
    throw new TypeError(`${path}.semanticSuccess is invalid`);
  }
  if (!Array.isArray(value.checks)) throw new TypeError(`${path}.checks must be an array`);
  const checkIds = new Set();
  const checks = value.checks.map((check, index) => {
    const checkPath = `${path}.checks[${index}]`;
    assertClosedObject(check, new Set([
      'id', 'type', 'required', 'status'
    ]), checkPath);
    assertRequiredFields(check, ['id', 'type', 'required', 'status'], checkPath);
    assertSafeId(check.id, `${checkPath}.id`);
    if (checkIds.has(check.id)) throw new TypeError(`${path} has duplicate check id: ${check.id}`);
    checkIds.add(check.id);
    if (!ACCEPTANCE_TYPES.has(check.type) || typeof check.required !== 'boolean') {
      throw new TypeError(`${checkPath} is invalid`);
    }
    if (!['passed', 'failed', 'not-executable'].includes(check.status)) {
      throw new TypeError(`${checkPath}.status is invalid`);
    }
    if (
      (check.type === 'model' && check.status !== 'not-executable') ||
      (check.type !== 'model' && check.status === 'not-executable')
    ) {
      throw new TypeError(`${checkPath} has an inconsistent executable status`);
    }
    return {
      id: check.id,
      type: check.type,
      required: check.required,
      status: check.status
    };
  });
  const requiredChecks = checks.filter((check) =>
    check.required && check.type !== 'model'
  );
  const passedChecks = requiredChecks.filter((check) => check.status === 'passed');
  if (requiredChecks.length !== value.requiredExecutable) {
    throw new TypeError(`${path}.requiredExecutable does not match required checks`);
  }
  if (passedChecks.length !== value.passedRequiredExecutable) {
    throw new TypeError(`${path}.passedRequiredExecutable does not match passed checks`);
  }
  const expectedSemantic = requiredChecks.length === 0
    ? null
    : passedChecks.length === requiredChecks.length;
  if (value.semanticSuccess !== expectedSemantic) {
    throw new TypeError(`${path}.semanticSuccess is inconsistent with required checks`);
  }
  return {
    requiredExecutable: value.requiredExecutable,
    passedRequiredExecutable: value.passedRequiredExecutable,
    semanticSuccess: value.semanticSuccess,
    checks
  };
}

function normalizeTiming(value, attribution, path) {
  assertClosedObject(value, new Set([
    'durationMs', 'firstEventMs', 'timedOut'
  ]), path);
  assertRequiredFields(value, ['durationMs', 'firstEventMs', 'timedOut'], path);
  if (typeof value.timedOut !== 'boolean') throw new TypeError(`${path}.timedOut must be boolean`);
  for (const field of ['durationMs', 'firstEventMs']) {
    if (value[field] !== null) requireNonNegativeFinite(value[field], `${path}.${field}`);
  }
  if (attribution === 'agent' && !value.timedOut && value.durationMs === null) {
    throw new TypeError(`${path}.durationMs is required for an Agent observation`);
  }
  return {
    durationMs: value.durationMs,
    firstEventMs: value.firstEventMs,
    timedOut: value.timedOut
  };
}

function normalizeChecks(value, path, statuses, ids, options = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((item, index) => {
    const checkPath = `${path}[${index}]`;
    const fields = ['id', 'status', 'weight', 'evidenceIds'];
    if (options.context) fields.push('kind');
    assertClosedObject(item, new Set(fields), checkPath);
    assertRequiredFields(item, fields, checkPath);
    assertSafeId(item.id, `${checkPath}.id`);
    if (ids.has(item.id)) throw new TypeError(`duplicate check id: ${item.id}`);
    ids.add(item.id);
    if (!statuses.has(item.status)) throw new TypeError(`${checkPath}.status is invalid`);
    requireNonNegativeFinite(item.weight, `${checkPath}.weight`);
    if (options.context && !CONTEXT_KINDS.has(item.kind)) {
      throw new TypeError(`${checkPath}.kind is invalid`);
    }
    return {
      id: item.id,
      ...(options.context ? { kind: item.kind } : {}),
      status: item.status,
      weight: item.weight,
      evidenceIds: stableEvidenceIds(item.evidenceIds)
    };
  });
}

function validateMetric(item) {
  if (typeof item.applicable !== 'boolean') throw new TypeError('metric applicable must be boolean');
  requireRange(item.coverage, 0, 1, 'metric coverage');
  if (item.score !== null) requireRange(item.score, 0, 100, 'metric score');
  requireNonNegativeFinite(item.numerator, 'metric numerator');
  requireNonNegativeFinite(item.denominator, 'metric denominator');
  if (
    !item.applicable &&
    (
      item.score !== null ||
      item.coverage !== 0 ||
      item.numerator !== 0 ||
      item.denominator !== 0
    )
  ) {
    throw new TypeError('non-applicable metric values must be null or zero');
  }
  if (item.denominator === 0) {
    if (item.numerator !== 0 || item.score !== null) {
      throw new TypeError('zero-denominator metric must have zero numerator and null score');
    }
  } else {
    if (item.score === null) {
      throw new TypeError('scorable metric must have a finite score');
    }
    const expectedScore = item.id === 'efficiency'
      ? item.numerator / item.denominator
      : item.numerator / item.denominator * 100;
    const tolerance = 1e-12 * Math.max(1, Math.abs(expectedScore));
    if (Math.abs(item.score - expectedScore) > tolerance) {
      throw new TypeError('metric score is incoherent with its numerator and denominator');
    }
  }
  if (!Array.isArray(item.gaps)) throw new TypeError('metric gaps must be an array');
  for (const gap of item.gaps) {
    if (typeof gap !== 'string') throw new TypeError('metric gap must be a string');
  }
  stableEvidenceIds(item.evidenceIds);
}

function compareRunResults(first, second) {
  const firstRequired = first.acceptance.requiredExecutable;
  const secondRequired = second.acceptance.requiredExecutable;
  if (firstRequired > 0 || secondRequired > 0) {
    if (firstRequired === 0 || secondRequired === 0) {
      return { available: true, agrees: false };
    }
    return {
      available: true,
      agrees: arraysEqual(requiredStatusVector(first), requiredStatusVector(second))
    };
  }
  if (
    first.schemaFingerprint === null ||
    second.schemaFingerprint === null
  ) {
    return { available: false, agrees: false };
  }
  return {
    available: true,
    agrees: first.schemaFingerprint === second.schemaFingerprint
  };
}

function requiredStatusVector(run) {
  return run.acceptance.checks
    .filter((check) =>
      check.required &&
      check.type !== 'model' &&
      check.status !== 'not-executable'
    )
    .map((check) => check.status);
}

function unavailablePairReason(first, second) {
  for (const run of [first, second]) {
    if (!run) return 'missing';
    if (run.attribution !== 'agent') return run.attribution;
  }
  return 'unavailable';
}

function isAgentObservation(run) {
  return run?.attribution === 'agent';
}

function runIndex(item) {
  return new Map(item.runs.map((run) => [run.repeatIndex, run]));
}

function evidenceFromTests(tests) {
  return stableEvidenceIds(
    tests.flatMap((item) => item.runs.flatMap((run) => run.evidenceIds))
  );
}

function evidenceFromChecks(checks) {
  return stableEvidenceIds(checks.flatMap((check) => check.evidenceIds));
}

function stableEvidenceIds(value) {
  if (!Array.isArray(value)) throw new TypeError('evidenceIds must be an array');
  const seen = new Set();
  const result = [];
  for (const id of value) {
    assertSafeId(id, 'evidence identifier');
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function metricWeight(id) {
  return RUBRIC_V1.dimensions.agentCapability[id];
}

function normalizeUnit(value) {
  if (Math.abs(value) < Number.EPSILON) return 0;
  if (Math.abs(1 - value) < Number.EPSILON) return 1;
  return value;
}

function requireRange(value, minimum, maximum, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite`);
  }
  if (value < minimum || value > maximum) {
    throw new RangeError(`${field} is outside ${minimum}..${maximum}`);
  }
}

function requireNonNegativeFinite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  if (value < 0) throw new RangeError(`${field} cannot be negative`);
}

function assertClosedObject(value, allowed, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${field} field: ${key}`);
  }
}

function assertRequiredFields(value, fields, path) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${path} requires ${field}`);
  }
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
}

function arraysEqual(first, second) {
  return first.length === second.length &&
    first.every((value, index) => value === second[index]);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
