import { stableNumber, safeJson } from './utils.js';
import { runtimeBuildSkillPrompt, runtimeRunSkillPrompt } from './prompts.js';
import { applyDeepSeekClaudeEnv } from './claude-env.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RUNTIMES = [
  { id: 'claude-code', name: 'Claude Code', model: 'Claude Sonnet', badge: 'CC' },
  { id: 'cursor', name: 'Cursor Agent', model: 'Auto', badge: 'CU' },
  { id: 'doubao', name: 'Doubao Agent', model: 'Seed', badge: 'DB' }
];

export async function buildSkill(runtime, card, mode) {
  const config = runtimeConfig(runtime.id);
  if (mode === 'live' && config?.kind === 'local-cli') {
    const result = await callLocalCli(runtime.id, runtimeBuildSkillPrompt(card));
    const skill = validateGeneratedSkill(safeJson(result.text));
    return { runtime: runtime.name, runtimeId: runtime.id, model: runtime.model, mode: 'live', adapterKind: 'local-cli', skill, trace: result.trace };
  }
  if (mode === 'live' && config?.kind === 'model-api') {
    const text = await callRuntimeModel(config, runtimeBuildSkillPrompt(card));
    const skill = validateGeneratedSkill(safeJson(text));
    return { runtime: runtime.name, runtimeId: runtime.id, model: config.model, mode: 'live', adapterKind: 'model-api', skill };
  }
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
  if (mode === 'live' && config?.kind === 'local-cli') {
    return (await callLocalCli(build.runtimeId, runtimeRunSkillPrompt(build.skill, testCase.prompt))).text;
  }
  if (mode === 'live' && config?.kind === 'model-api') {
    return callRuntimeModel(config, runtimeRunSkillPrompt(build.skill, testCase.prompt));
  }
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
  try {
    const remote = JSON.parse(process.env.RUNTIME_ADAPTERS_JSON || '{}')[runtimeId];
    if (remote) return remote;
  } catch { return null; }
  if (runtimeId === 'claude-code' && process.env.ENABLE_LOCAL_CLAUDE_CODE === 'true') return { kind: 'local-cli', command: 'claude' };
  if (runtimeId === 'cursor' && process.env.ENABLE_LOCAL_CURSOR_AGENT === 'true') return { kind: 'local-cli', command: 'cursor-agent' };
  if (runtimeId === 'doubao' && process.env.ARK_BASE_URL && process.env.ARK_API_KEY) {
    return { kind: 'model-api', baseUrl: process.env.ARK_BASE_URL, apiKeyEnv: 'ARK_API_KEY', model: process.env.REVIEW_MODEL_DOUBAO || 'ep-20260720110725-5rbml' };
  }
  return null;
}

async function callLocalCli(runtimeId, prompt) {
  const workspace = await mkdtemp(path.join(tmpdir(), `agent-roast-${runtimeId}-`));
  const startedAt = Date.now();
  const timeout = Number(process.env.LOCAL_RUNTIME_TIMEOUT_MS || 180_000);
  const budget = process.env.CLAUDE_MAX_BUDGET_USD || '0.25';
  const command = runtimeId === 'claude-code' ? 'claude' : 'cursor-agent';
  const args = runtimeId === 'claude-code'
    ? ['-p', prompt, '--output-format', 'json', '--tools', '', '--permission-mode', 'plan', '--safe-mode', '--no-session-persistence', '--max-turns', '1', '--max-budget-usd', budget]
    : ['-p', prompt, '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled', '--trust', '--workspace', workspace];
  try {
    const commandEnv = { ...process.env, NO_COLOR: '1' };
    if (runtimeId === 'claude-code') applyDeepSeekClaudeEnv(commandEnv);
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: workspace, timeout, maxBuffer: 5_000_000, env: commandEnv });
    const text = extractCliText(stdout);
    if (!text.trim()) throw new Error(`${command} 没有返回可见结果`);
    return { text, trace: { command, durationMs: Date.now() - startedAt, stdoutBytes: Buffer.byteLength(stdout), stderr: String(stderr || '').trim().slice(0, 500) } };
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
    if (/not logged|login|auth|unauthorized|api key/i.test(detail)) throw new Error(`AUTH_REQUIRED: ${command} 尚未完成账号授权`);
    if (error.killed || error.signal) throw new Error(`${command} 超过 ${timeout}ms 执行时限`);
    throw new Error(`${command} 执行失败：${String(detail).slice(0, 800)}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function callRuntimeModel(config, prompt) {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : baseUrl + '/chat/completions';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[config.apiKeyEnv]}` },
    body: JSON.stringify({ model: config.model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Doubao runtime 返回 HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n') : content;
  if (!text) throw new Error('Doubao runtime 没有返回可见结果');
  return text;
}

function extractCliText(stdout) {
  const raw = String(stdout || '').trim();
  try {
    const payload = JSON.parse(raw);
    if (typeof payload.result === 'string') return payload.result;
    if (typeof payload.text === 'string') return payload.text;
    if (typeof payload.message === 'string') return payload.message;
    const content = payload.message?.content || payload.content;
    if (Array.isArray(content)) return content.map((part) => part.text || '').filter(Boolean).join('\n');
  } catch { /* Some CLI versions return plain text even when json is requested. */ }
  return raw;
}

function inferTools(card) {
  const text = JSON.stringify(card).toLowerCase();
  return [text.includes('file') || text.includes('文件') ? 'filesystem' : null, text.includes('browser') || text.includes('网页') ? 'browser' : null, text.includes('api') ? 'http' : null].filter(Boolean);
}

function validateGeneratedSkill(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) throw new Error('Runtime 返回的 Skill 不是 JSON 对象');
  if (typeof skill.name !== 'string' || !skill.name.trim()) throw new Error('Runtime 返回的 Skill 缺少 name');
  if (typeof skill.description !== 'string' || !skill.description.trim()) throw new Error('Runtime 返回的 Skill 缺少 description');
  if (!Array.isArray(skill.instructions) || !skill.instructions.length || skill.instructions.some((item) => typeof item !== 'string')) throw new Error('Runtime 返回的 Skill instructions 必须是非空字符串数组');
  if (!Array.isArray(skill.tools) || skill.tools.some((item) => typeof item !== 'string')) throw new Error('Runtime 返回的 Skill tools 必须是字符串数组');
  return skill;
}

function slug(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'submitted-agent-skill';
}
