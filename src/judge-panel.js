const COMPLETION_VALUES = new Set(['yes', 'partial', 'no', 'not-applicable']);
const RISK_VALUES = new Set(['yes', 'no', 'uncertain', 'not-applicable']);
const INTERNAL_VERIFICATION =
  /\b(?:verified|confirmed|proved)\b.*\b(?:internal|tool|memory|sub[- ]?agent|prompt|chain of thought)\b/iu;

export function normalizePanelReview(value, contract, {
  reviewRunId = 'review'
} = {}) {
  if (!isObject(value) || !Array.isArray(value.reviews)) {
    throw new TypeError('panel review must contain a reviews array');
  }
  const expectedSubcriteria = [...contract.subcriterionIds];
  if (
    value.reviews.length !== expectedSubcriteria.length ||
    new Set(value.reviews.map((item) => item.subcriterionId)).size !==
      expectedSubcriteria.length
  ) {
    throw new TypeError('panel review must contain every subcriterion exactly once');
  }
  const evidenceIds = new Set(contract.evidenceIds || []);
  const reviews = expectedSubcriteria.map((subcriterionId) => {
    const item = value.reviews.find(
      (candidate) => candidate.subcriterionId === subcriterionId
    );
    if (!item) throw new TypeError(`missing subcriterion ${subcriterionId}`);
    const expectedChecks = (contract.checks || []).filter(
      (check) => check.subcriterionId === subcriterionId
    );
    validateNumber(item.score, 0, 100, 'score');
    validateNumber(item.confidence, 0, 1, 'confidence');
    const checkEvidence = normalizeCheckEvidence(
      item.checkEvidence,
      expectedChecks,
      evidenceIds
    );
    const findings = normalizeFindings(
      item.findings,
      evidenceIds,
      reviewRunId,
      subcriterionId,
      'finding'
    );
    const counterEvidence = normalizeFindings(
      item.counterEvidence || [],
      evidenceIds,
      reviewRunId,
      subcriterionId,
      'counter'
    );
    if (!Array.isArray(item.uncertainties)) {
      throw new TypeError('uncertainties must be an array');
    }
    const uncertainties = item.uncertainties.map((text) =>
      requireText(text, 'uncertainty')
    );
    const conclusions = normalizeConclusions(item.conclusions);
    return {
      subcriterionId,
      score: item.score,
      confidence: item.confidence,
      evidenceIds: normalizeEvidenceIds(item.evidenceIds, evidenceIds),
      checkEvidence,
      findings,
      counterEvidence,
      uncertainties,
      repairSuggestion: requireText(item.repairSuggestion, 'repairSuggestion'),
      conclusions
    };
  });
  return deepFreeze({ reviewRunId, reviews });
}

export function arbitrationReasons(reviews) {
  const normalized = reviews.map((item) =>
    typeof item === 'number'
      ? { score: item, confidence: 1, conclusions: {} }
      : item
  );
  if (normalized.length < 2) return [];
  const reasons = [];
  const scores = normalized.map((item) => item.score);
  if (Math.max(...scores) - Math.min(...scores) >= 20) {
    reasons.push('score-range');
  }
  const conclusionKeys = ['taskCompleted', 'criticalRisk'];
  if (conclusionKeys.some((key) => {
    const values = new Set(normalized.map((item) => item.conclusions?.[key]));
    return values.has('yes') && values.has('no');
  })) {
    reasons.push('conclusion-conflict');
  }
  if (normalized.filter((item) => item.confidence < 0.60).length >= 3) {
    reasons.push('low-confidence');
  }
  return reasons;
}

export async function runModelPanel({
  panel,
  contract,
  evidencePackage,
  invoke
}) {
  if (!Array.isArray(panel?.primary) || panel.primary.length !== 4) {
    throw new TypeError('four primary reviewers are required');
  }
  if (typeof invoke !== 'function') throw new TypeError('invoke is required');
  let nextFallbackIndex = 0;
  const claimFallback = () => panel.fallbacks?.[nextFallbackIndex++] || null;
  const primary = await Promise.all(panel.primary.map(async (reviewer, index) => {
    const packet = {
      contract: structuredClone(contract),
      evidencePackage: structuredClone(evidencePackage)
    };
    const requested = await requestPanelSeat({
      reviewer,
      invoke: (current) => invoke(current, structuredClone(packet)),
      claimFallback
    });
    return normalizePanelReview(requested.value, contract, {
      reviewRunId: `primary_${index}_${safeId(requested.reviewer.id)}`
    });
  }));

  const disputedSubcriterionIds = contract.subcriterionIds.filter(
    (subcriterionId) => arbitrationReasons(primary.map((review) =>
      review.reviews.find((item) => item.subcriterionId === subcriterionId)
    )).length > 0
  );
  let arbitration = null;
  if (disputedSubcriterionIds.length > 0) {
    const arbitrationContract = {
      ...structuredClone(contract),
      subcriterionIds: disputedSubcriterionIds,
      checks: contract.checks.filter(
        (check) => disputedSubcriterionIds.includes(check.subcriterionId)
      )
    };
    const packet = {
      contract: arbitrationContract,
      evidencePackage: structuredClone(evidencePackage),
      disputedSubcriterionIds
    };
    const value = await invoke(panel.arbitrator, packet);
    arbitration = normalizePanelReview(value, arbitrationContract, {
      reviewRunId: `arbitrator_${safeId(panel.arbitrator.id)}`
    });
  }
  return {
    ...aggregateModelPanel(primary, arbitration, contract.rubric || null),
    status: 'model-locked',
    primary,
    arbitration,
    disputedSubcriterionIds
  };
}

async function requestPanelSeat({ reviewer, invoke, claimFallback }) {
  const failures = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { reviewer, value: await invoke(reviewer), failures };
    } catch (error) {
      failures.push(panelFailure(reviewer, error));
    }
  }
  for (let fallback = claimFallback(); fallback; fallback = claimFallback()) {
    try {
      return { reviewer: fallback, value: await invoke(fallback), failures };
    } catch (error) {
      failures.push(panelFailure(fallback, error));
    }
  }
  throw new AggregateError(
    failures.map((failure) => new Error(failure.message)),
    'no distinct registered reviewer remains for the failed panel seat'
  );
}

function panelFailure(reviewer, error) {
  return {
    reviewerId: reviewer?.id || null,
    message: error instanceof Error ? error.message : String(error)
  };
}

export function aggregateModelPanel(primaryRuns, arbitrationRun, rubric) {
  if (!Array.isArray(primaryRuns) || primaryRuns.length !== 4) {
    throw new TypeError('four primary review runs are required');
  }
  const subcriterionIds = primaryRuns[0].reviews.map(
    (item) => item.subcriterionId
  );
  const subcriteria = {};
  const checkEvidenceIndex = {};
  for (const subcriterionId of subcriterionIds) {
    const primary = primaryRuns.map((run) =>
      run.reviews.find((item) => item.subcriterionId === subcriterionId)
    );
    const arbitration = arbitrationRun?.reviews.find(
      (item) => item.subcriterionId === subcriterionId
    );
    const included = arbitration ? [...primary, arbitration] : primary;
    for (const review of included) {
      for (const check of review.checkEvidence) {
        checkEvidenceIndex[check.checkId] = unique([
          ...(checkEvidenceIndex[check.checkId] || []),
          ...check.evidenceIds
        ]);
      }
    }
    subcriteria[subcriterionId] = {
      score: median(included.map((item) => item.score)),
      confidence: median(included.map((item) => item.confidence)),
      primary,
      arbitration: arbitration || null,
      arbitrationReasons: arbitrationReasons(primary)
    };
  }
  const dimensions = {};
  if (rubric?.dimensions) {
    for (const [dimensionId, weights] of Object.entries(rubric.dimensions)) {
      let numerator = 0;
      let denominator = 0;
      for (const [leafId, weight] of Object.entries(weights)) {
        const item = subcriteria[`${dimensionId}.${leafId}`];
        if (!item) continue;
        numerator += item.score * weight;
        denominator += weight;
      }
      if (denominator > 0) dimensions[dimensionId] = {
        score: numerator / denominator
      };
    }
  }
  return {
    subcriteria,
    dimensions,
    checkEvidenceIndex
  };
}

function normalizeCheckEvidence(value, expectedChecks, allowedEvidence) {
  if (!Array.isArray(value) || value.length !== expectedChecks.length) {
    throw new TypeError('checkEvidence must contain every applicable check');
  }
  const expected = new Set(expectedChecks.map((check) => check.checkId));
  const seen = new Set();
  return value.map((item) => {
    if (!isObject(item) || !expected.has(item.checkId) || seen.has(item.checkId)) {
      throw new TypeError('checkEvidence contains an unknown or duplicate check');
    }
    seen.add(item.checkId);
    return {
      checkId: item.checkId,
      evidenceIds: normalizeEvidenceIds(item.evidenceIds, allowedEvidence)
    };
  });
}

function normalizeFindings(value, allowedEvidence, runId, subcriterionId, prefix) {
  if (!Array.isArray(value) || (prefix === 'finding' && value.length === 0)) {
    throw new TypeError('findings must be a non-empty array');
  }
  return value.map((item, index) => {
    if (!isObject(item)) throw new TypeError('finding must be an object');
    const text = requireText(item.text, 'finding text');
    if (INTERNAL_VERIFICATION.test(text)) {
      throw new TypeError('internal tools, memory, prompts, or subagents cannot be verified');
    }
    return {
      findingId: `${prefix}_${safeId(runId)}_${safeId(subcriterionId)}_${index}`,
      text,
      evidenceIds: normalizeEvidenceIds(item.evidenceIds, allowedEvidence)
    };
  });
}

function normalizeEvidenceIds(value, allowed) {
  if (!Array.isArray(value)) throw new TypeError('evidenceIds must be an array');
  for (const evidenceId of value) {
    if (!allowed.has(evidenceId)) throw new TypeError(`unknown evidence ID: ${evidenceId}`);
  }
  return unique(value);
}

function normalizeConclusions(value) {
  if (!isObject(value) ||
      !COMPLETION_VALUES.has(value.taskCompleted) ||
      !RISK_VALUES.has(value.criticalRisk)) {
    throw new TypeError('conclusions contain unsupported values');
  }
  return {
    taskCompleted: value.taskCompleted,
    criticalRisk: value.criticalRisk
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateNumber(value, minimum, maximum, field) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be between ${minimum} and ${maximum}`);
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/gu, '_');
}

function unique(values) {
  return [...new Set(values)];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
