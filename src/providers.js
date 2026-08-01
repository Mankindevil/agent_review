import { mockLegacyProfessionalReview, mockProfessionalReview } from './scoring.js';
import {
  LEGACY_PROFESSIONAL_REVIEW_SYSTEM_PROMPT,
  PROFESSIONAL_REVIEW_SYSTEM_PROMPT,
  legacyProfessionalReviewPrompt,
  professionalReviewPrompt
} from './prompts.js';
import { normalizeV1CardReview } from './v1-card-review.js';
import {
  networkFailureMessage,
  safeJson,
  withTimeout,
  withTransientNetworkRetry
} from './utils.js';

export const DEFAULT_REVIEWERS = [
  { id: 'gpt', name: 'OpenAI 评审', model: 'GPT-5', kind: 'mock' },
  { id: 'claude', name: 'Anthropic 评审', model: 'Claude Sonnet', kind: 'mock' },
  { id: 'doubao', name: '豆包评审', model: 'Doubao Seed', kind: 'mock' },
  { id: 'deepseek', name: 'DeepSeek 评审', model: 'DeepSeek', kind: 'mock' }
];

export const LOCKED_HUMOR_SYSTEM_PROMPT = `You rewrite supplied locked findings into concise,
non-abusive Chinese humor.
Return ONE JSON object only: {"items":[{"subcriterionId":"","findingIds":[""],"line":""}]}.
Copy subcriterionId and findingIds verbatim from the user packet; never invent IDs.
You may not add facts, scores, score changes, numbers, named entities, tools, models,
or capability claims. No Markdown or prose outside the JSON.`;

export function configuredReviewPanel(env = process.env) {
  if (env.MODEL_REVIEW_PANEL_JSON) {
    return panelFromJson(env);
  }
  const panelMode = String(env.MODEL_REVIEW_PANEL_MODE || '').trim().toLowerCase();
  // Explicit demo escape must win so tests can inject MODE=demo without
  // clearing ambient gateway keys from process.env.
  if (panelMode === 'demo') {
    return demoReviewPanel();
  }
  const gateway = gatewayLiveStatus(env);
  if (gateway.ready) {
    return gatewayLivePanel(env);
  }
  const nodeEnv = String(env.NODE_ENV || process.env.NODE_ENV || '').trim().toLowerCase();
  // Test harnesses import the server without full gateway secrets; keep demo
  // unless MODE=live was requested (which still requires credentials above).
  if (nodeEnv === 'test') {
    return demoReviewPanel();
  }
  const missing = gateway.missing.length
    ? gateway.missing.join(', ')
    : 'OPENAI_*, ARK_*, REVIEW_MODEL_*';
  throw new TypeError(
    'model review panel requires MODEL_REVIEW_PANEL_JSON or complete gateway credentials (missing: '
      + missing
      + '). Set MODEL_REVIEW_PANEL_MODE=demo only for explicit local/test mock panels.'
  );
}

function demoReviewPanel() {
  const primary = DEFAULT_REVIEWERS.map((reviewer) =>
    withIdentity({ ...reviewer, baseUrl: 'mock://' + reviewer.id })
  );
  return deepFreeze({
    version: 'panel-v1',
    mode: 'demo',
    primary,
    arbitrator: withIdentity({
      id: 'arbitrator',
      name: 'Deterministic arbitration reviewer',
      model: 'Arbitrator Mock',
      kind: 'mock',
      baseUrl: 'mock://arbitrator'
    }),
    fallbacks: []
  });
}

function gatewayLivePanel(env) {
  const llmx = {
    kind: 'openai-compatible',
    baseUrl: env.OPENAI_BASE_URL,
    apiKeyEnv: 'OPENAI_API_KEY'
  };
  const ark = {
    kind: 'openai-compatible',
    baseUrl: env.ARK_BASE_URL,
    apiKeyEnv: 'ARK_API_KEY'
  };
  const primary = [
    withIdentity({
      ...llmx,
      id: 'gpt',
      name: 'OpenAI 评审',
      model: env.REVIEW_MODEL_OPENAI
    }),
    withIdentity({
      ...llmx,
      id: 'claude',
      name: 'Anthropic 评审',
      model: env.REVIEW_MODEL_ANTHROPIC
    }),
    withIdentity({
      ...ark,
      id: 'doubao',
      name: '豆包评审',
      model: env.REVIEW_MODEL_DOUBAO
    }),
    withIdentity({
      ...ark,
      id: 'deepseek',
      name: 'DeepSeek 评审',
      model: env.REVIEW_MODEL_DEEPSEEK
    })
  ];
  const arbitrator = withIdentity({
    ...ark,
    id: 'arbitrator',
    name: 'Arbitration reviewer',
    model: env.REVIEW_MODEL_DEEPSEEK
  }, { seatSalt: 'arbitrator' });
  const identities = [...primary, arbitrator].map((reviewer) => reviewer.identityKey);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError('model review panel requires distinct reviewer identities');
  }
  return deepFreeze({
    version: 'panel-v1',
    mode: 'live',
    primary,
    arbitrator,
    fallbacks: []
  });
}

function gatewayLiveStatus(env) {
  const required = [
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'ARK_BASE_URL',
    'ARK_API_KEY',
    'REVIEW_MODEL_OPENAI',
    'REVIEW_MODEL_ANTHROPIC',
    'REVIEW_MODEL_DOUBAO',
    'REVIEW_MODEL_DEEPSEEK'
  ];
  const missing = required.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || !value.trim();
  });
  return { ready: missing.length === 0, missing };
}

function panelFromJson(env) {
  let parsed;
  try {
    parsed = JSON.parse(env.MODEL_REVIEW_PANEL_JSON);
  } catch {
    throw new TypeError('MODEL_REVIEW_PANEL_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('model review panel must be an object');
  }
  if (parsed.version !== 'panel-v1') throw new TypeError('unsupported model review panel version');
  if (!Array.isArray(parsed.primary) || parsed.primary.length !== 4) {
    throw new TypeError('model review panel requires exactly four primary reviewers');
  }
  const primary = parsed.primary.map((reviewer, index) =>
    normalizePanelReviewer(reviewer, env, 'primary[' + index + ']')
  );
  const arbitrator = normalizePanelReviewer(parsed.arbitrator, env, 'arbitrator');
  const fallbacks = (parsed.fallbacks || []).map((reviewer, index) =>
    normalizePanelReviewer(reviewer, env, 'fallbacks[' + index + ']')
  );
  const identities = [...primary, arbitrator, ...fallbacks].map(
    (reviewer) => reviewer.identityKey
  );
  if (new Set(identities).size !== identities.length) {
    throw new TypeError('model review panel requires distinct reviewer identities');
  }
  return deepFreeze({
    version: 'panel-v1',
    mode: 'live',
    primary,
    arbitrator,
    fallbacks
  });
}

/**
 * Returns the frozen primary panel for independent anonymous arena sessions.
 * Arbitration and fallback identities are deliberately excluded.
 */
export function configuredArenaReviewers(env = process.env) {
  return configuredReviewPanel(env).primary;
}

export function configuredReviewers() {
  if (process.env.MODEL_REVIEWERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.MODEL_REVIEWERS_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* Fall through to gateway or demo reviewers. */ }
  }
  const llmxReady = Boolean(process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY);
  const arkReady = Boolean(process.env.ARK_BASE_URL && process.env.ARK_API_KEY);
  if (!llmxReady && !arkReady) return DEFAULT_REVIEWERS;
  const llmx = { kind: 'openai-compatible', baseUrl: process.env.OPENAI_BASE_URL, apiKeyEnv: 'OPENAI_API_KEY' };
  const ark = { kind: 'openai-compatible', baseUrl: process.env.ARK_BASE_URL, apiKeyEnv: 'ARK_API_KEY' };
  return DEFAULT_REVIEWERS.map((reviewer) => {
    if (reviewer.id === 'gpt' && llmxReady) return { ...llmx, id: reviewer.id, name: reviewer.name, model: process.env.REVIEW_MODEL_OPENAI || 'g5.4' };
    if (reviewer.id === 'claude' && llmxReady) return { ...llmx, id: reviewer.id, name: reviewer.name, model: process.env.REVIEW_MODEL_ANTHROPIC || 'cs4.6' };
    if (reviewer.id === 'doubao' && arkReady) return { ...ark, id: reviewer.id, name: reviewer.name, model: process.env.REVIEW_MODEL_DOUBAO || 'ep-20260720110725-5rbml' };
    if (reviewer.id === 'deepseek' && arkReady) return { ...ark, id: reviewer.id, name: reviewer.name, model: process.env.REVIEW_MODEL_DEEPSEEK || 'ep-20260708162855-pcf9x' };
    return reviewer;
  });
}

export async function reviewAgent(reviewer, card, complexity, mode, signal, sampling = {}) {
  const isLegacyRetry = sampling.reviewVersion === 'legacy';
  if (mode !== 'live' || reviewer.kind === 'mock') {
    return isLegacyRetry
      ? mockLegacyProfessionalReview(reviewer, card, complexity, sampling.seed)
      : mockProfessionalReview(reviewer, card, complexity, sampling.seed);
  }
  const system = isLegacyRetry ? LEGACY_PROFESSIONAL_REVIEW_SYSTEM_PROMPT : PROFESSIONAL_REVIEW_SYSTEM_PROMPT;
  const prompt = isLegacyRetry ? legacyProfessionalReviewPrompt(card, complexity) : professionalReviewPrompt(card, complexity);
  const responseText = reviewer.kind === 'anthropic'
    ? await callAnthropic(reviewer, system, prompt, signal, sampling)
    : await callOpenAICompatible(reviewer, system, prompt, signal, sampling);
  const parsed = isLegacyRetry
    ? normalizeProfessionalReview(safeJson(responseText))
    : normalizeV1CardReview(safeJson(responseText));
  return { reviewer: reviewer.name, model: reviewer.model, ...parsed, mode: 'live', seed: sampling.seed };
}

export async function requestJson(
  reviewer,
  system,
  prompt,
  signal,
  { seed, temperature = 0, maxTokens = 24000, requiredKeys } = {}
) {
  if (reviewer.kind === 'mock') {
    throw new TypeError('mock reviewers require an injected deterministic evaluator');
  }
  const sampling = { seed, temperature, maxTokens };
  const text = reviewer.kind === 'anthropic'
    ? await callAnthropic(reviewer, system, prompt, signal, sampling)
    : await callOpenAICompatible(reviewer, system, prompt, signal, sampling);
  return safeJson(text, { requiredKeys });
}

export async function requestLockedHumor(reviewer, prompt, signal, sampling = {}) {
  return requestJson(
    reviewer,
    LOCKED_HUMOR_SYSTEM_PROMPT,
    prompt,
    signal,
    { temperature: 0, maxTokens: 1200, ...sampling }
  );
}

export async function requestReviewerWithFallback({
  reviewer,
  fallbacks = [],
  invoke,
  maxSameReviewerAttempts = 2
}) {
  if (typeof invoke !== 'function') throw new TypeError('invoke is required');
  if (!Number.isSafeInteger(maxSameReviewerAttempts) || maxSameReviewerAttempts < 1) {
    throw new TypeError('maxSameReviewerAttempts must be a positive integer');
  }
  const failures = [];
  const queue = [
    ...Array.from({ length: maxSameReviewerAttempts }, () => reviewer),
    ...fallbacks
  ];
  for (const current of queue) {
    try {
      return {
        reviewer: current,
        value: await invoke(current),
        failures
      };
    } catch (error) {
      failures.push({
        reviewerId: current?.id || null,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  throw new AggregateError(
    failures.map((failure) => new Error(failure.message)),
    'all registered reviewer attempts failed'
  );
}

export function normalizeProfessionalReview(value) {
  const dimensionKeys = ['researchRigor', 'dataDiscipline', 'backtestIntegrity', 'riskCompliance', 'reproducibility'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('专业度评审必须返回 JSON 对象');
  assertScore(value.score, 'score');
  if (!value.dimensions || typeof value.dimensions !== 'object' || Array.isArray(value.dimensions)) throw new TypeError('专业度评审缺少 dimensions 对象');
  const dimensions = Object.fromEntries(dimensionKeys.map((key) => {
    assertScore(value.dimensions[key], `dimensions.${key}`);
    return [key, Math.round(value.dimensions[key])];
  }));
  if (typeof value.comment !== 'string' || !value.comment.trim()) throw new TypeError('专业度评审缺少 comment');
  if (typeof value.risk !== 'string' || !value.risk.trim()) throw new TypeError('专业度评审缺少 risk');
  return { score: Math.round(value.score), dimensions, comment: value.comment.trim(), risk: value.risk.trim() };
}

function assertScore(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError(`${field} 必须是 0–100 的数字`);
}

async function callOpenAICompatible(config, system, prompt, signal, sampling) {
  const timeoutMs = Number(process.env.MODEL_REVIEW_TIMEOUT_MS || 120_000);
  const response = await withTransientNetworkRetry(async () => {
    try {
      return await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${resolveSecret(config.apiKeyEnv)}` },
        body: JSON.stringify({
          model: config.model,
          temperature: sampling.temperature ?? 0,
          ...(Number.isInteger(sampling.seed) ? { seed: sampling.seed } : {}),
          max_tokens: sampling.maxTokens ?? Number(process.env.MODEL_REVIEW_MAX_TOKENS || 1200),
          ...(config.id === 'doubao' ? { thinking: { type: 'disabled' } } : {}),
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
        }),
        signal: withTimeout(signal, timeoutMs)
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (error.name === 'TimeoutError') {
        throw new Error(`${config.name}（${config.model}）超过 ${Math.round(timeoutMs / 1000)} 秒未返回；可调整 MODEL_REVIEW_TIMEOUT_MS`);
      }
      throw wrapProviderNetworkError(config, error);
    }
  });
  if (!response.ok) throw await httpStatusError(config, response);
  const json = await response.json();
  const choice = json.choices?.[0];
  assertCompletionNotTruncated(config, choice?.finish_reason);
  const content = choice?.message?.content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');
  return content || '';
}

async function callAnthropic(config, system, prompt, signal, sampling) {
  const timeoutMs = Number(process.env.MODEL_REVIEW_TIMEOUT_MS || 120_000);
  const response = await withTransientNetworkRetry(async () => {
    try {
      return await fetch(config.baseUrl || 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': resolveSecret(config.apiKeyEnv), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: config.model, max_tokens: sampling.maxTokens ?? Number(process.env.MODEL_REVIEW_MAX_TOKENS || 1200), temperature: sampling.temperature ?? 0, system, messages: [{ role: 'user', content: prompt }] }),
        signal: withTimeout(signal, timeoutMs)
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (error.name === 'TimeoutError') {
        throw new Error(`${config.name}（${config.model}）超过 ${Math.round(timeoutMs / 1000)} 秒未返回；可调整 MODEL_REVIEW_TIMEOUT_MS`);
      }
      throw wrapProviderNetworkError(config, error);
    }
  });
  if (!response.ok) throw await httpStatusError(config, response);
  const json = await response.json();
  assertCompletionNotTruncated(config, json.stop_reason || json.choices?.[0]?.finish_reason);
  return json.content?.find((part) => part.type === 'text')?.text || '';
}

function wrapProviderNetworkError(config, error) {
  const detail = networkFailureMessage(error);
  const wrapped = new Error(`${config.name}（${config.model}）网络异常: ${detail}`);
  wrapped.cause = error;
  wrapped.code = error?.cause?.code || error?.code;
  return wrapped;
}

function assertCompletionNotTruncated(config, finishReason) {
  const reason = String(finishReason || '').toLowerCase();
  if (reason === 'length' || reason === 'max_tokens') {
    throw new Error(
      `${config.name}（${config.model}）输出被 max_tokens 截断；可提高 MODEL_REVIEW_MAX_TOKENS`
    );
  }
}

async function httpStatusError(config, response) {
  let detail = '';
  try {
    detail = String(await response.text() || '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 400);
  } catch {
    detail = '';
  }
  return new Error(
    detail
      ? `${config.name} 返回 HTTP ${response.status}: ${detail}`
      : `${config.name} 返回 HTTP ${response.status}`
  );
}

function resolveSecret(envName) {
  const value = process.env[envName];
  if (!value) throw new Error(`缺少环境变量 ${envName}`);
  return value;
}

function normalizePanelReviewer(value, env, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} reviewer must be an object`);
  }
  if (Object.hasOwn(value, 'apiKey')) {
    throw new TypeError(`${field} must not contain a literal apiKey`);
  }
  const reviewer = {
    id: requireText(value.id, `${field}.id`),
    name: requireText(value.name, `${field}.name`),
    kind: requireText(value.kind, `${field}.kind`),
    baseUrl: requireText(value.baseUrl, `${field}.baseUrl`),
    model: requireText(value.model, `${field}.model`),
    apiKeyEnv: requireText(value.apiKeyEnv, `${field}.apiKeyEnv`)
  };
  if (!['openai-compatible', 'anthropic'].includes(reviewer.kind)) {
    throw new TypeError(`${field}.kind is unsupported`);
  }
  if (!env[reviewer.apiKeyEnv]) {
    throw new TypeError(`${field} secret environment variable is not configured`);
  }
  return withIdentity(reviewer);
}

function withIdentity(reviewer, { seatSalt } = {}) {
  let host;
  if (reviewer.kind === 'mock') {
    host = reviewer.id;
  } else {
    try {
      host = new URL(reviewer.baseUrl).host.toLowerCase();
    } catch {
      throw new TypeError('reviewer baseUrl must be an absolute URL');
    }
  }
  const salt = typeof seatSalt === 'string' && seatSalt.trim()
    ? `:${seatSalt.trim()}`
    : '';
  return {
    ...reviewer,
    identityKey: `${reviewer.kind}:${host}:${reviewer.model}${salt}`
  };
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
