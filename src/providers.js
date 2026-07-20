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

export async function reviewAgent(reviewer, card, complexity, mode, signal) {
  if (mode !== 'live' || reviewer.kind === 'mock') return mockProfessionalReview(reviewer, card, complexity);
  const system = PROFESSIONAL_REVIEW_SYSTEM_PROMPT;
  const prompt = professionalReviewPrompt(card, complexity);
  const responseText = reviewer.kind === 'anthropic'
    ? await callAnthropic(reviewer, system, prompt, signal)
    : await callOpenAICompatible(reviewer, system, prompt, signal);
  const parsed = safeJson(responseText);
  return { reviewer: reviewer.name, model: reviewer.model, ...parsed, mode: 'live' };
}

async function callOpenAICompatible(config, system, prompt, signal) {
  const timeoutMs = Number(process.env.MODEL_REVIEW_TIMEOUT_MS || 120_000);
  let response;
  try {
    response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resolveSecret(config.apiKeyEnv)}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
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

async function callAnthropic(config, system, prompt, signal) {
  const timeoutMs = Number(process.env.MODEL_REVIEW_TIMEOUT_MS || 120_000);
  let response;
  try {
    response = await fetch(config.baseUrl || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': resolveSecret(config.apiKeyEnv), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.model, max_tokens: Number(process.env.MODEL_REVIEW_MAX_TOKENS || 1200), temperature: 0.2, system, messages: [{ role: 'user', content: prompt }] }),
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
