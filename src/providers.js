import { mockProfessionalReview } from './scoring.js';
import { safeJson } from './utils.js';

export const DEFAULT_REVIEWERS = [
  { id: 'gpt', name: 'OpenAI 评审', model: 'GPT-5', kind: 'mock' },
  { id: 'claude', name: 'Anthropic 评审', model: 'Claude Sonnet', kind: 'mock' },
  { id: 'doubao', name: '字节评审', model: 'Doubao Seed', kind: 'mock' }
];

export function configuredReviewers() {
  if (!process.env.MODEL_REVIEWERS_JSON) return DEFAULT_REVIEWERS;
  try {
    const parsed = JSON.parse(process.env.MODEL_REVIEWERS_JSON);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_REVIEWERS;
  } catch {
    return DEFAULT_REVIEWERS;
  }
}

export async function reviewAgent(reviewer, card, complexity, mode) {
  if (mode !== 'live' || reviewer.kind === 'mock') return mockProfessionalReview(reviewer, card, complexity);
  const system = '你是苛刻的 Agent 架构评审。只返回 JSON，字段 score(0-100), dimensions(domainDepth,workflowQuality,failureHandling,outputContract,evaluability), comment, risk。不要输出 markdown。';
  const prompt = `评审以下 A2A Agent Card。复杂度初评为 ${complexity.score}/100。\n${JSON.stringify(card, null, 2)}`;
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
    body: JSON.stringify({ model: config.model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`${config.name} 返回 HTTP ${response.status}`);
  const json = await response.json();
  return json.choices?.[0]?.message?.content || '';
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
