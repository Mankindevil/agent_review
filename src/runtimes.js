import { stableNumber, safeJson, withTimeout } from './utils.js';
import { runtimeBuildSkillPrompt, runtimeRunSkillPrompt } from './prompts.js';
import {
  applyArkClaudeEnv,
  applyDeepSeekClaudeEnv,
  hasClaudeCredential,
  resolveClaudeBackend,
  shouldUseArkClaude
} from './claude-env.js';
import { startArkAnthropicProxy } from './ark-anthropic-proxy.js';
import { prepareRuntimeWorkspace } from './runtime-sandbox.js';
import { resolveRuntimeConfig } from './runtime-config.js';
import { localCliEnv } from './runtime-environment.js';
import { runLocalCliProcess } from './runtime-process.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLAUDE_RUNTIME_SYSTEM_PROMPT = '你是 Agent 盲测平台中的隔离执行器。严格完成用户给出的单一任务，只输出最终内容。当前会话没有任何工具，不得浏览文件、探索代码库、启动子代理，也不得输出或模拟 tool_call、Bash、Explore 等工具调用。';
const RUNTIME_READINESS_PROMPT =
  'Output exactly the five ASCII letters READY with no punctuation or other text.';
const DEFAULT_LOCAL_RUNTIME_TIMEOUT_MS = 180_000;
const MAX_LOCAL_RUNTIME_TIMEOUT_MS = 1_200_000;

export const RUNTIMES = [
  { id: 'claude-code', name: 'Claude Code', model: 'Claude Sonnet', badge: 'CC' },
  { id: 'cursor', name: 'Cursor Agent', model: 'Auto', badge: 'CU' },
  { id: 'doubao', name: 'Doubao Agent', model: 'Seed', badge: 'DB' }
];

export function createSkillBundle(build, description) {
  if (!build?.skill || build.error) throw new Error('该 Runtime 没有可查看的 Skill 产物');
  const skill = validateGeneratedSkill(build.skill);
  const root = slug(skill.name);
  const sourceDescription = normalizeSourceDescription(description);
  const descriptionOnly = build.baselineInput === 'description-only';
  const inputPolicy = descriptionOnly ? 'description-only' : 'legacy-full-card-possible';
  const metadata = {
    schemaVersion: 2,
    source: 'normalized-runtime-output',
    inputPolicy,
    runtimeId: build.runtimeId,
    runtime: build.runtime,
    model: build.model || null,
    mode: build.mode,
    adapterKind: build.adapterKind || (build.mode === 'demo' ? 'demo' : null),
    seed: Number.isInteger(build.seed) ? build.seed : null,
    fingerprint: skill.fingerprint || null
  };
  const files = [
    { path: 'SKILL.md', language: 'markdown', content: skillMarkdown(skill) },
    { path: 'skill.json', language: 'json', content: JSON.stringify(skill, null, 2) },
    { path: 'references/source-description.txt', language: 'text', content: sourceDescription }
  ];
  if (!descriptionOnly) {
    files.push({
      path: 'references/legacy-input-warning.txt',
      language: 'text',
      content: '这条 Skill 生成于 description-only 信息防火墙上线前，构建 Runtime 当时可能接收过完整 Agent Card。该产物不能作为公平基线；请点击“重建并对测”后重新评估。'
    });
  }
  files.push({ path: '.agent-roast/manifest.json', language: 'json', content: JSON.stringify(metadata, null, 2) });
  return {
    root,
    source: metadata.source,
    inputPolicy,
    legacyBaseline: !descriptionOnly,
    files
  };
}

export async function buildSkill(runtime, description, mode, { signal, seed, temperature = 0 } = {}) {
  const sourceDescription = normalizeSourceDescription(description);
  const config = resolveRuntimeConfig(runtime.id);
  if (mode === 'live' && config?.kind === 'local-cli') {
    const { skill, result } = await generateValidatedSkill(
      (prompt) => callLocalCli(runtime.id, prompt, signal, { seed, temperature }),
      runtimeBuildSkillPrompt(sourceDescription)
    );
    return { runtime: runtime.name, runtimeId: runtime.id, model: localRuntimeModel(runtime), mode: 'live', adapterKind: 'local-cli', baselineInput: 'description-only', skill, trace: result.trace, seed };
  }
  if (mode === 'live' && config?.kind === 'model-api') {
    const { skill } = await generateValidatedSkill(
      async (prompt) => ({ text: await callRuntimeModel(config, prompt, signal, { seed, temperature }) }),
      runtimeBuildSkillPrompt(sourceDescription)
    );
    return { runtime: runtime.name, runtimeId: runtime.id, model: config.model, mode: 'live', adapterKind: 'model-api', baselineInput: 'description-only', skill, seed };
  }
  if (mode === 'live' && config?.kind === 'remote-http') {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: runtimeAdapterHeaders(config),
      body: JSON.stringify({ action: 'build_skill', description: sourceDescription, inputPolicy: 'description-only', seed, temperature }),
      signal: withTimeout(signal, 120_000)
    });
    if (!response.ok) throw new Error(`${runtime.name} runtime 返回 HTTP ${response.status}`);
    const payload = await response.json();
    return {
      runtime: runtime.name,
      runtimeId: runtime.id,
      model: typeof payload.model === 'string' ? payload.model : runtime.model,
      mode: 'live',
      adapterKind: 'remote-http',
      baselineInput: 'description-only',
      skill: validateGeneratedSkill(payload.skill),
      trace: payload.trace,
      seed
    };
  }
  const tools = inferTools(sourceDescription);
  const generatedName = slug(sourceDescription).slice(0, 64).replace(/-$/g, '') || 'description-baseline-skill';
  return {
    runtime: runtime.name,
    runtimeId: runtime.id,
    model: runtime.model,
    mode: 'demo',
    adapterKind: 'demo',
    baselineInput: 'description-only',
    seed,
    skill: {
      name: generatedName,
      description: sourceDescription,
      instructions: [
        `仅根据任务描述确认范围：${sourceDescription}`,
        '拆解输入、执行核心步骤，并在缺少关键条件时明确请求补充。',
        '输出结果、依据与未解决风险，不虚构已完成的外部操作。'
      ],
      tools,
      fingerprint: stableNumber(`${runtime.id}:${sourceDescription}`, 100000, 999999).toString()
    }
  };
}

export async function generateValidatedSkill(generate, prompt, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const retryHint = attempt
      ? '\n\n上一次返回的内容不是完整、合法的 Skill JSON。请重新生成；只输出结构完整的单个 JSON 对象，尤其不要提前停止，也不要调用或模拟任何工具。'
      : '';
    const result = await generate(`${prompt}${retryHint}`);
    try {
      return { skill: validateGeneratedSkill(safeJson(result.text)), result, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Runtime 连续 ${attempts} 次未返回有效 Skill：${lastError?.message || '未知格式错误'}`);
}

export async function runSkill(build, testCase, mode, { signal, seed, temperature = 0 } = {}) {
  const config = resolveRuntimeConfig(build.runtimeId);
  if (mode === 'live' && config?.kind === 'local-cli') {
    return (await callLocalCli(build.runtimeId, runtimeRunSkillPrompt(build.skill, testCase.prompt), signal, { seed, temperature })).text;
  }
  if (mode === 'live' && config?.kind === 'model-api') {
    return callRuntimeModel(config, runtimeRunSkillPrompt(build.skill, testCase.prompt), signal, { seed, temperature });
  }
  if (mode === 'live' && config?.kind === 'remote-http') {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: runtimeAdapterHeaders(config),
      body: JSON.stringify({ action: 'run_skill', skill: build.skill, prompt: testCase.prompt, seed, temperature }),
      signal: withTimeout(signal, 120_000)
    });
    if (!response.ok) throw new Error(`${build.runtime} 执行返回 HTTP ${response.status}`);
    const output = (await response.json()).output;
    if (typeof output !== 'string' || !output.trim()) throw new Error(`${build.runtime} adapter 没有返回非空 output`);
    return output;
  }
  const lead = build.runtimeId === 'claude-code' ? '我先检查约束并给出可复核结果。' : build.runtimeId === 'cursor' ? '已按任务流程执行并整理产物。' : '任务已完成，下面是处理结果。';
  return `${lead}\n\n1. 任务理解：${testCase.prompt}\n2. 执行依据：使用 ${build.skill.tools.join('、') || '文本推理'}，按技能边界逐项处理。\n3. 结果：已形成结构化交付，并标出需要人工确认的假设。\n4. 风险：真实文件或外部系统未提供时，不声称已经修改。`;
}

function runtimeAdapterHeaders(config, env = process.env) {
  if (!Object.hasOwn(config, 'apiKeyEnv')) return { 'content-type': 'application/json' };
  const apiKey = Object.hasOwn(env, config.apiKeyEnv) ? env[config.apiKeyEnv] : null;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error(`Runtime adapter 缺少环境变量 ${config.apiKeyEnv}`);
  }
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

function localRuntimeModel(runtime) {
  if (runtime.id !== 'claude-code') return runtime.model;
  const backend = resolveClaudeBackend(process.env);
  if (backend === 'ark' && shouldUseArkClaude(process.env)) return process.env.CLAUDE_ARK_MODEL;
  if (backend === 'deepseek' && hasClaudeCredential(process.env)) {
    return process.env.DEEPSEEK_CLAUDE_MODEL || 'deepseek-v4-pro[1m]';
  }
  return runtime.model;
}

export function localCliArgs(runtimeId, prompt, { budget = '0.25' } = {}) {
  if (runtimeId === 'claude-code') {
    return [
      '-p', prompt,
      '--system-prompt', CLAUDE_RUNTIME_SYSTEM_PROMPT,
      '--output-format', 'json',
      '--tools', '',
      '--permission-mode', 'plan',
      '--safe-mode',
      '--no-session-persistence',
      '--max-turns', '1',
      '--max-budget-usd', budget
    ];
  }
  if (runtimeId === 'cursor') {
    return ['-p', prompt, '--output-format', 'json', '--trust'];
  }
  throw new Error(`Unsupported local Runtime: ${runtimeId}`);
}

export { localCliEnv } from './runtime-environment.js';

export function localRuntimeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    return DEFAULT_LOCAL_RUNTIME_TIMEOUT_MS;
  }
  return Math.min(timeout, MAX_LOCAL_RUNTIME_TIMEOUT_MS);
}

export async function withRuntimeWorkspace(runtimeId, run, {
  createWorkspace = mkdtemp,
  prepareWorkspace = prepareRuntimeWorkspace,
  removeWorkspace = rm,
  parentEnv = process.env
} = {}) {
  const workspace = await createWorkspace(path.join(tmpdir(), `agent-roast-${runtimeId}-`));
  try {
    await prepareWorkspace(runtimeId, workspace, {
      cursorAuthConfigHome: parentEnv.CURSOR_AUTH_CONFIG_HOME
    });
    return await run(workspace);
  } finally {
    await removeWorkspace(workspace, { recursive: true, force: true });
  }
}

async function callLocalCli(runtimeId, prompt, signal, sampling = {}, parentEnv = process.env) {
  let arkProxy;
  const startedAt = Date.now();
  const timeout = localRuntimeTimeout(parentEnv.LOCAL_RUNTIME_TIMEOUT_MS);
  const budget = parentEnv.CLAUDE_MAX_BUDGET_USD || '0.25';
  const command = runtimeId === 'claude-code' ? 'claude' : 'cursor-agent';
  const args = localCliArgs(runtimeId, prompt, { budget });
  return withRuntimeWorkspace(runtimeId, async (workspace) => {
    try {
    const claudeBackend = runtimeId === 'claude-code'
      ? resolveClaudeBackend(parentEnv)
      : null;
    if (runtimeId === 'claude-code' && (!claudeBackend || !hasClaudeCredential(parentEnv))) {
      throw new Error('AUTH_REQUIRED: selected Claude backend is unsupported or incomplete');
    }
    const commandEnv = localCliEnv(runtimeId, workspace, parentEnv);
    if (runtimeId === 'claude-code' && claudeBackend === 'ark') {
      const model = parentEnv.CLAUDE_ARK_MODEL;
      arkProxy = await startArkAnthropicProxy({ baseUrl: parentEnv.ARK_BASE_URL, apiKey: parentEnv.ARK_API_KEY, model, signal, ...sampling });
      applyArkClaudeEnv(commandEnv, arkProxy.baseUrl, model);
    } else if (
      runtimeId === 'claude-code'
      && claudeBackend === 'deepseek'
      && !applyDeepSeekClaudeEnv(commandEnv, parentEnv)
    ) {
      throw new Error('AUTH_REQUIRED: selected DeepSeek backend is incomplete');
    }
    const { stdout, stderr } = await runLocalCliProcess(command, args, {
      cwd: workspace,
      timeoutMs: timeout,
      maxBuffer: 5_000_000,
      env: commandEnv,
      signal
    });
    const text = extractCliText(stdout);
    if (!text.trim()) throw new Error(`${command} 没有返回可见结果`);
    return { text, trace: { command, durationMs: Date.now() - startedAt, stdoutBytes: Buffer.byteLength(stdout), stderr: String(stderr || '').trim().slice(0, 500), seed: sampling.seed } };
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('评测已停止');
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
    if (/not logged|login|auth|unauthorized|api key/i.test(detail)) throw new Error(`AUTH_REQUIRED: ${command} 尚未完成账号授权`);
    if (error.killed || error.signal) throw new Error(`${command} 超过 ${timeout}ms 执行时限`);
    throw new Error(`${command} 执行失败：${String(detail).slice(0, 800)}`);
    } finally {
      await arkProxy?.close();
    }
  }, { parentEnv });
}

async function callRuntimeModel(
  config,
  prompt,
  signal,
  sampling = {},
  env = process.env,
  maxTokens = 2400,
  fetchImpl = globalThis.fetch
) {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : baseUrl + '/chat/completions';
  const timeout = localRuntimeTimeout(env.LOCAL_RUNTIME_TIMEOUT_MS);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: runtimeAdapterHeaders(config, env),
    body: JSON.stringify({ model: config.model, temperature: sampling.temperature ?? 0, ...(Number.isInteger(sampling.seed) ? { seed: sampling.seed } : {}), max_tokens: maxTokens, ...(config.thinking ? { thinking: config.thinking } : {}), messages: [{ role: 'user', content: prompt }] }),
    signal: withTimeout(signal, timeout)
  });
  if (!response.ok) throw new Error(`Model API runtime 返回 HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n') : content;
  if (!text) throw new Error('Model API runtime 没有返回可见结果');
  return text;
}

export async function probeRuntimeReadiness(runtimeId, config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  localCall = callLocalCli,
  signal
} = {}) {
  const probeTimeout = Math.min(
    localRuntimeTimeout(env.RUNTIME_PROBE_TIMEOUT_MS || '30000'),
    60_000
  );
  const probeSignal = withTimeout(signal, probeTimeout);
  try {
    if (config.kind === 'local-cli') {
      const probeEnv = { ...env, LOCAL_RUNTIME_TIMEOUT_MS: String(probeTimeout) };
      const result = await localCall(runtimeId, RUNTIME_READINESS_PROMPT, probeSignal, {}, probeEnv);
      return isReadinessSentinel(result.text);
    }
    if (config.kind === 'model-api') {
      return isReadinessSentinel(
        await callRuntimeModel(
          config,
          RUNTIME_READINESS_PROMPT,
          probeSignal,
          {},
          env,
          8,
          fetchImpl
        )
      );
    }
    if (config.kind === 'remote-http') {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: runtimeAdapterHeaders(config, env),
        body: JSON.stringify({
          action: 'build_skill',
          description: 'Runtime readiness probe',
          inputPolicy: 'description-only',
          probe: true,
          seed: 0,
          temperature: 0
        }),
        signal: probeSignal
      });
      if (!response.ok) return false;
      const payload = await response.json();
      validateGeneratedSkill(payload.skill);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isReadinessSentinel(value) {
  return typeof value === 'string' && value.trim().toUpperCase() === 'READY';
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

function inferTools(description) {
  const text = String(description).toLowerCase();
  return [text.includes('file') || text.includes('文件') ? 'filesystem' : null, text.includes('browser') || text.includes('网页') ? 'browser' : null, text.includes('api') ? 'http' : null].filter(Boolean);
}

function normalizeSourceDescription(description) {
  if (typeof description !== 'string' || !description.trim()) throw new Error('Runtime description-only 基线缺少非空 description');
  return description;
}

function validateGeneratedSkill(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) throw new Error('Runtime 返回的 Skill 不是 JSON 对象');
  if (typeof skill.name !== 'string' || !skill.name.trim()) throw new Error('Runtime 返回的 Skill 缺少 name');
  if (typeof skill.description !== 'string' || !skill.description.trim()) throw new Error('Runtime 返回的 Skill 缺少 description');
  if (!Array.isArray(skill.instructions) || !skill.instructions.length || skill.instructions.some((item) => typeof item !== 'string')) throw new Error('Runtime 返回的 Skill instructions 必须是非空字符串数组');
  if (!Array.isArray(skill.tools) || skill.tools.some((item) => typeof item !== 'string')) throw new Error('Runtime 返回的 Skill tools 必须是字符串数组');
  return skill;
}

function skillMarkdown(skill) {
  const quotedName = JSON.stringify(skill.name);
  const quotedDescription = JSON.stringify(skill.description);
  const instructions = skill.instructions.map((instruction, index) => `${index + 1}. ${instruction}`).join('\n');
  const tools = skill.tools.length ? skill.tools.map((tool) => `- \`${tool}\``).join('\n') : '- 无；仅使用文本推理';
  return `---\nname: ${quotedName}\ndescription: ${quotedDescription}\n---\n\n# ${skill.name}\n\n${skill.description}\n\n## 执行流程\n\n${instructions}\n\n## 工具\n\n${tools}\n`;
}

function slug(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'submitted-agent-skill';
}
