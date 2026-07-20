import { mockProfessionalReview } from './scoring.js';
import { PROFESSIONAL_REVIEW_SYSTEM_PROMPT, professionalReviewPrompt } from './prompts.js';
import { safeJson, withTimeout } from './utils.js';

export const DEFAULT_REVIEWERS = [
  { id: 'gpt', name: 'OpenAI 评审', model: 'GPT-5', kind: 'mock' },
  { id: 'claude', name: 'Anthropic 评审', model: 'Claude Sonnet', kind: 'mock' },
  { id: 'doubao', name: '豆包评审', model: 'Doubao Seed', kind: 'mock' },
  { id: 'deepseek', name: 'DeepSeek 评审', model: 'DeepSeek', kind: 'mock' }
];

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
  if (mode !== 'live' || reviewer.kind === 'mock') return mockProfessionalReview(reviewer, card, complexity, sampling.seed);
  const system = PROFESSIONAL_REVIEW_SYSTEM_PROMPT;
  const prompt = professionalReviewPrompt(card, complexity);
  const responseText = reviewer.kind === 'anthropic'
    ? await callAnthropic(reviewer, system, prompt, signal, sampling)
    : await callOpenAICompatible(reviewer, system, prompt, signal, sampling);
  const parsed = normalizeProfessionalReview(safeJson(responseText));
  return { reviewer: reviewer.name, model: reviewer.model, ...parsed, mode: 'live', seed: sampling.seed };
}

export function normalizeProfessionalReview(value) {
  const dimensionKeys = ['domainDepth', 'workflowQuality', 'failureHandling', 'outputContract', 'evaluability'];
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
  let response;
  try {
    response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resolveSecret(config.apiKeyEnv)}` },
      body: JSON.stringify({
        model: config.model,
        temperature: sampling.temperature ?? 0,
        ...(Number.isInteger(sampling.seed) ? { seed: sampling.seed } : {}),
        max_tokens: Number(process.env.MODEL_REVIEW_MAX_TOKENS || 1200),
        ...(config.id === 'doubao' ? { thinking: { type: 'disabled' } } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
      }),
      signal: withTimeout(signal, timeoutMs)
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    if (error.name === 'TimeoutError') throw new Error(`${config.name}（${config.model}）超过 ${Math.round(timeoutMs / 1000)} 秒未返回；可调整 MODEL_REVIEW_TIMEOUT_MS`);
    throw error;
  }
  if (!response.ok) throw new Error(`${config.name} 返回 HTTP ${response.status}`);
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');
  return content || '';
}

async function callAnthropic(config, system, prompt, signal, sampling) {
  const timeoutMs = Number(process.env.MODEL_REVIEW_TIMEOUT_MS || 120_000);
  let response;
  try {
    response = await fetch(config.baseUrl || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': resolveSecret(config.apiKeyEnv), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.model, max_tokens: Number(process.env.MODEL_REVIEW_MAX_TOKENS || 1200), temperature: sampling.temperature ?? 0, system, messages: [{ role: 'user', content: prompt }] }),
      signal: withTimeout(signal, timeoutMs)
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    if (error.name === 'TimeoutError') throw new Error(`${config.name}（${config.model}）超过 ${Math.round(timeoutMs / 1000)} 秒未返回；可调整 MODEL_REVIEW_TIMEOUT_MS`);
    throw error;
  }
  if (!response.ok) throw new Error(`${config.name} 返回 HTTP ${response.status}`);
  const json = await response.json();
  return json.content?.find((part) => part.type === 'text')?.text || '';
}

function resolveSecret(envName) {
  const value = process.env[envName];
  if (!value) throw new Error(`缺少环境变量 ${envName}`);
  return value;
}
