import { mockProfessionalReview } from './scoring.js';
import { PROFESSIONAL_REVIEW_SYSTEM_PROMPT, professionalReviewPrompt } from './prompts.js';
import { safeJson } from './utils.js';

export const DEFAULT_REVIEWERS = [
  { id: 'gpt', name: 'OpenAI 评审', model: 'GPT-5', kind: 'mock' },
  { id: 'claude', name: 'Anthropic 评审', model: 'Claude Sonnet', kind: 'mock' },
  { id: 'doubao', name: '字节评审', model: 'Doubao Seed', kind: 'mock' }
];

export function configuredReviewers() {
  if (process.env.MODEL_REVIEWERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.MODEL_REVIEWERS_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* Fall through to gateway or demo reviewers. */ }
  }
  if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY) return DEFAULT_REVIEWERS;
  const common = { kind: 'openai-compatible', baseUrl: process.env.OPENAI_BASE_URL, apiKeyEnv: 'OPENAI_API_KEY' };
  return [
    { ...common, id: 'gpt', name: 'OpenAI 评审', model: process.env.REVIEW_MODEL_OPENAI || 'g5.4' },
    { ...common, id: 'claude', name: 'Anthropic 评审', model: process.env.REVIEW_MODEL_ANTHROPIC || 'cs4.6' },
    { ...common, id: 'deepseek', name: 'DeepSeek 评审', model: process.env.REVIEW_MODEL_DEEPSEEK || 'dkc' }
  ];
}

export async function reviewAgent(reviewer, card, complexity, mode) {
  if (mode !== 'live' || reviewer.kind === 'mock') return mockProfessionalReview(reviewer, card, complexity);
  const system = PROFESSIONAL_REVIEW_SYSTEM_PROMPT;
  const prompt = professionalReviewPrompt(card, complexity);
  const responseText = reviewer.kind === 'anthropic'
    ? await callAnthropic(reviewer, system, prompt)
    : await callOpenAICompatible(reviewer, system, prompt);
  const parsed = safeJson(responseText);
  return { reviewer: reviewer.name, model: reviewer.model, ...parsed, mode: 'live' };
}

async function callOpenAICompatible(config, system, prompt) {
  const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${resolveSecret(config.apiKeyEnv)}` },
    body: JSON.stringify({ model: config.model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`${config.name} 返回 HTTP ${response.status}`);
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');
  return content || '';
}

async function callAnthropic(config, system, prompt) {
  const response = await fetch(config.baseUrl || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': resolveSecret(config.apiKeyEnv), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.model, max_tokens: 1400, temperature: 0.2, system, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`${config.name} 返回 HTTP ${response.status}`);
  const json = await response.json();
  return json.content?.find((part) => part.type === 'text')?.text || '';
}

function resolveSecret(envName) {
  const value = process.env[envName];
  if (!value) throw new Error(`缺少环境变量 ${envName}`);
  return value;
}
