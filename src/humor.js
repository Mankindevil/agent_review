import { humorRewritePrompt } from './prompts.js';
import { requestLockedHumor } from './providers.js';

const SCORE_CHANGE = /\b(?:score|scores|rating|points?)\b|分数|评分|加分|减分|提[高升].{0,8}分|降[低].{0,8}分/iu;
const INTERNAL_CAPABILITY = /\b(?:tool|tools|model|browser|internet|memory|subagent|prompt)\b|工具|模型|浏览器|联网|记忆|子代理|提示词/giu;
const PROPER_NOUN = /\b[A-Z][A-Za-z0-9_-]*\b/gu;
const NUMBER = /\d+(?:\.\d+)?%?/gu;

export async function generateLockedHumor(evaluation, services = {}) {
  const absolute = assertLockedAbsoluteResult(evaluation);
  const lockedFindings = collectLockedFindings(evaluation, absolute);
  const fallback = deterministicFallback(lockedFindings);
  const now = services.now || (() => new Date().toISOString());
  const generatedAt = now();
  assertIso(generatedAt);

  let generated = fallback;
  try {
    const response = await requestHumor(lockedFindings, services);
    const items = validateHumorItems(response?.items, lockedFindings);
    generated = {
      modelIdentity: requiredText(response?.modelIdentity, 'model identity'),
      items
    };
  } catch {
    // The fallback intentionally uses only a captured source finding.
  }

  const humor = Object.freeze({
    generatedAt,
    modelIdentity: generated.modelIdentity,
    sourceResultHash: absolute.resultHash,
    items: Object.freeze(generated.items.map((item) => Object.freeze({ ...item })))
  });
  evaluation.resultV2 = { ...(evaluation.resultV2 || {}), humor };
  return humor;
}

export function validateHumorItems(items, lockedFindings) {
  const sources = normalizeLockedFindings(lockedFindings);
  if (!Array.isArray(items)) throw new TypeError('humor items must be an array');
  const seen = new Set();
  const normalized = items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('humor item must be an object');
    }
    const subcriterionId = requiredText(item.subcriterionId, 'subcriterion ID');
    const source = sources.get(subcriterionId);
    if (!source) throw new TypeError('unknown humor subcriterion');
    if (seen.has(subcriterionId)) throw new TypeError('duplicate humor subcriterion');
    seen.add(subcriterionId);

    const findingIds = uniqueStrings(item.findingIds, 'finding IDs');
    const findings = new Map(source.sourceFindings.map((finding) => [
      finding.findingId, finding.text
    ]));
    if (findingIds.some((findingId) => !findings.has(findingId))) {
      throw new TypeError('unknown humor finding');
    }
    const line = requiredText(item.line, 'humor line');
    if (line.length > 280 || /[\r\n]/u.test(line)) {
      throw new TypeError('humor line must be one concise line');
    }
    validateRewrite(line, findingIds.map((id) => findings.get(id)));
    return { subcriterionId, findingIds, line };
  });
  if (normalized.length !== sources.size || seen.size !== sources.size) {
    throw new TypeError('humor must contain exactly one item per applicable subcriterion');
  }
  return normalized;
}

async function requestHumor(lockedFindings, services) {
  const prompt = humorRewritePrompt(lockedFindings);
  if (typeof services.generateHumor === 'function') {
    return services.generateHumor({ prompt, lockedFindings: structuredClone(lockedFindings) });
  }
  if (services.humorReviewer) {
    const invoke = services.requestLockedHumor || requestLockedHumor;
    return invoke(services.humorReviewer, prompt, services.signal, services.humorSampling);
  }
  throw new Error('no humor model configured');
}

function assertLockedAbsoluteResult(evaluation) {
  const absolute = evaluation?.resultV2?.absolute;
  if (absolute?.status !== 'locked' ||
      typeof absolute.resultHash !== 'string' ||
      !evaluation?.governance?.absoluteLockedAt) {
    throw new Error('absolute result must be locked before humor generation');
  }
  return absolute;
}

function collectLockedFindings(evaluation, absolute) {
  const reviews = evaluation.absoluteReview?.modelPanel?.primary?.flatMap((run) =>
    Array.isArray(run?.reviews) ? run.reviews : []
  ) || [];
  const reviewByLeaf = new Map();
  for (const review of reviews) {
    const current = reviewByLeaf.get(review.subcriterionId) || [];
    reviewByLeaf.set(review.subcriterionId, [...current, review]);
  }
  const leaves = Object.values(absolute.dimensions || {}).flatMap((dimension) =>
    Object.entries(dimension?.leaves || {}).map(([subcriterionId, leaf]) => ({
      subcriterionId,
      applicable: leaf?.applicable !== false
    }))
  ).filter((leaf) => leaf.applicable);
  return leaves.map(({ subcriterionId }) => {
    const sourceReviews = reviewByLeaf.get(subcriterionId) || [];
    const sourceFindings = sourceReviews.flatMap((review) => review.findings || [])
      .filter((finding) => typeof finding?.findingId === 'string' &&
        typeof finding?.text === 'string' && finding.text.trim())
      .filter((finding, index, findings) =>
        findings.findIndex((candidate) => candidate.findingId === finding.findingId) === index)
      .map((finding) => ({ findingId: finding.findingId, text: finding.text.trim() }));
    if (!sourceFindings.length) {
      throw new TypeError(`locked leaf has no source findings: ${subcriterionId}`);
    }
    const repairSuggestion = sourceReviews.map((review) => review.repairSuggestion)
      .find((value) => typeof value === 'string' && value.trim());
    return {
      subcriterionId,
      sourceFindings,
      repairSuggestion: repairSuggestion?.trim() || 'Clarify the supported finding.'
    };
  });
}

function normalizeLockedFindings(lockedFindings) {
  if (!Array.isArray(lockedFindings) || !lockedFindings.length) {
    throw new TypeError('locked findings are required');
  }
  const result = new Map();
  for (const item of lockedFindings) {
    const subcriterionId = requiredText(item?.subcriterionId, 'subcriterion ID');
    if (result.has(subcriterionId)) throw new TypeError('duplicate locked subcriterion');
    const sourceFindings = Array.isArray(item?.sourceFindings)
      ? item.sourceFindings.map((finding) => ({
        findingId: requiredText(finding?.findingId, 'finding ID'),
        text: requiredText(finding?.text, 'finding text')
      }))
      : [];
    if (!sourceFindings.length || new Set(sourceFindings.map((item) => item.findingId)).size !== sourceFindings.length) {
      throw new TypeError('locked findings must have unique source findings');
    }
    result.set(subcriterionId, { subcriterionId, sourceFindings });
  }
  return result;
}

function validateRewrite(line, findingTexts) {
  const source = findingTexts.join(' ').toLowerCase();
  if (SCORE_CHANGE.test(line)) throw new TypeError('humor must not contain a score or score change');
  for (const number of line.match(NUMBER) || []) {
    if (!source.includes(number.toLowerCase())) {
      throw new TypeError('humor contains an unsupported number');
    }
  }
  for (const noun of line.match(PROPER_NOUN) || []) {
    if (!source.includes(noun.toLowerCase())) {
      throw new TypeError('humor contains an unsupported proper noun');
    }
  }
  for (const claim of line.match(INTERNAL_CAPABILITY) || []) {
    if (!source.includes(claim.toLowerCase())) {
      throw new TypeError('humor contains an unsupported capability claim');
    }
  }
  if (!hasSourceOverlap(line.toLowerCase(), source)) {
    throw new TypeError('humor must rewrite a cited source finding');
  }
}

function hasSourceOverlap(line, source) {
  const words = source.match(/[a-z][a-z-]{3,}/gu) || [];
  if (words.some((word) => line.includes(word))) return true;
  const chinesePairs = source.match(/[\p{Script=Han}]{2}/gu) || [];
  return chinesePairs.some((pair) => line.includes(pair));
}

function deterministicFallback(lockedFindings) {
  return {
    modelIdentity: 'fallback',
    items: lockedFindings.map((item) => ({
      subcriterionId: item.subcriterionId,
      findingIds: [item.sourceFindings[0].findingId],
      line: `${shorten(item.sourceFindings[0].text)}——有思路，但证据还没把工牌戴好。`
    }))
  };
}

function shorten(text) {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 160);
}

function uniqueStrings(value, name) {
  if (!Array.isArray(value) || !value.length) throw new TypeError(`${name} are required`);
  const values = value.map((item) => requiredText(item, name));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} must be unique`);
  return values;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function assertIso(value) {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) {
    throw new TypeError('humor timestamp must be an ISO timestamp');
  }
}
