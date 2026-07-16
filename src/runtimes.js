import { stableNumber } from './utils.js';

export const RUNTIMES = [
  { id: 'claude-code', name: 'Claude Code', model: 'Claude Sonnet', badge: 'CC' },
  { id: 'cursor', name: 'Cursor Agent', model: 'Auto', badge: 'CU' },
  { id: 'doubao', name: 'Doubao Agent', model: 'Seed', badge: 'DB' }
];

export async function buildSkill(runtime, card, mode) {
  const config = runtimeConfig(runtime.id);
  if (mode === 'live' && config?.url) {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.apiKeyEnv ? { authorization: `Bearer ${process.env[config.apiKeyEnv]}` } : {}) },
      body: JSON.stringify({ action: 'build_skill', agentCard: card }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`${runtime.name} runtime 返回 HTTP ${response.status}`);
    return { runtime: runtime.name, mode: 'live', ...(await response.json()) };
  }
  const tools = inferTools(card);
  return {
    runtime: runtime.name,
    runtimeId: runtime.id,
    model: runtime.model,
    mode: 'demo',
    skill: {
      name: slug(card.name),
      description: card.description,
      instructions: [
        `先确认任务是否属于：${(card.skills || []).map((skill) => skill.name).join('、')}`,
        '拆解输入、执行核心步骤，并在缺少关键条件时明确请求补充。',
        '输出结果、依据与未解决风险，不虚构已完成的外部操作。'
      ],
      tools,
      fingerprint: stableNumber(`${runtime.id}:${card.name}`, 100000, 999999).toString()
    }
  };
}

export async function runSkill(build, testCase, mode) {
  const config = runtimeConfig(build.runtimeId);
  if (mode === 'live' && config?.url) {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.apiKeyEnv ? { authorization: `Bearer ${process.env[config.apiKeyEnv]}` } : {}) },
      body: JSON.stringify({ action: 'run_skill', skill: build.skill, prompt: testCase.prompt }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`${build.runtime} 执行返回 HTTP ${response.status}`);
    return (await response.json()).output;
  }
  const lead = build.runtimeId === 'claude-code' ? '我先检查约束并给出可复核结果。' : build.runtimeId === 'cursor' ? '已按任务流程执行并整理产物。' : '任务已完成，下面是处理结果。';
  return `${lead}\n\n1. 任务理解：${testCase.prompt}\n2. 执行依据：使用 ${build.skill.tools.join('、') || '文本推理'}，按技能边界逐项处理。\n3. 结果：已形成结构化交付，并标出需要人工确认的假设。\n4. 风险：真实文件或外部系统未提供时，不声称已经修改。`;
}

function runtimeConfig(runtimeId) {
  try { return JSON.parse(process.env.RUNTIME_ADAPTERS_JSON || '{}')[runtimeId]; } catch { return null; }
}

function inferTools(card) {
  const text = JSON.stringify(card).toLowerCase();
  return [text.includes('file') || text.includes('文件') ? 'filesystem' : null, text.includes('browser') || text.includes('网页') ? 'browser' : null, text.includes('api') ? 'http' : null].filter(Boolean);
}

function slug(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'submitted-agent-skill';
}
