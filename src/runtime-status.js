import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasClaudeCredential, resolveClaudeBackend } from './claude-env.js';
import { hasOwnEnvValue, resolveRuntimeConfig, runtimeConfigAuthenticated } from './runtime-config.js';
import { cursorAuthConfigHome, localCliEnv } from './runtime-environment.js';
import { resolveCliExecutable, runLocalCliProcess } from './runtime-process.js';
import { probeRuntimeReadiness } from './runtimes.js';

const readinessCache = new Map();
const DEFAULT_READINESS_CACHE_TTL_MS = 60_000;

export async function getRuntimeStatus(options = {}) {
  const env = options.env || process.env;
  const probeExecutableImpl = options.probeExecutableImpl
    || ((command) => probeExecutable(command, { env }));
  const probeCursorAuthImpl = options.probeCursorAuthImpl
    || ((executable) => probeCursorAuthentication(executable, { env }));
  const liveProbe = options.liveProbe
    || ((runtimeId, config) => cachedRuntimeReadiness(runtimeId, config, { env }));
  const [claude, cursorAgent, cursorDesktop, doubao] = await Promise.all([
    probeExecutableImpl('claude'),
    probeExecutableImpl('cursor-agent'),
    probeExecutableImpl('cursor'),
    probeExecutableImpl('doubao')
  ]);
  const configs = {
    'claude-code': resolveRuntimeConfig('claude-code', env),
    cursor: resolveRuntimeConfig('cursor', env),
    doubao: resolveRuntimeConfig('doubao', env)
  };
  const claudeAuth = await adapterOrLocalAuthentication(
    configs['claude-code'],
    env,
    () => hasClaudeCredential(env)
  );
  const cursorAuth = await adapterOrLocalAuthentication(
    configs.cursor,
    env,
    () => cursorAgent.installed
      ? probeCursorAuthImpl(cursorAgent.executable)
      : false
  );
  const doubaoAuth = configs.doubao
    ? runtimeConfigAuthenticated(configs.doubao, env)
    : hasOwnEnvValue(env, 'ARK_API_KEY');
  const [claudeLive, cursorLive, doubaoLive] = await Promise.all([
    readinessProbe('claude-code', configs['claude-code'], claude.installed, claudeAuth, liveProbe),
    readinessProbe('cursor', configs.cursor, cursorAgent.installed, cursorAuth, liveProbe),
    readinessProbe('doubao', configs.doubao, doubao.installed, doubaoAuth, liveProbe)
  ]);
  const selectedClaudeBackend = resolveClaudeBackend(env);
  const claudeBackend = selectedClaudeBackend === 'ark'
    ? '火山方舟 DeepSeek'
    : selectedClaudeBackend === 'deepseek'
      ? 'DeepSeek 直连'
      : '未配置';

  return [
    statusEntry({
      id: 'claude-code',
      name: 'Claude Code',
      probe: claude,
      config: configs['claude-code'],
      authenticated: claudeAuth,
      live: claudeLive,
      localReadyNote: `本地 CLI adapter 已就绪 · ${claudeBackend}`
    }),
    statusEntry({
      id: 'cursor',
      name: 'Cursor Agent',
      probe: cursorAgent,
      version: cursorAgent.version || cursorDesktop.version,
      config: configs.cursor,
      authenticated: cursorAuth,
      live: cursorLive,
      localReadyNote: '本地 CLI adapter 已就绪 · 持久账户登录',
      missingNote: cursorDesktop.installed
        ? '只有 Cursor Desktop CLI，缺少 cursor-agent'
        : '未安装'
    }),
    statusEntry({
      id: 'doubao',
      name: 'Doubao Agent',
      probe: doubao,
      config: configs.doubao,
      authenticated: doubaoAuth,
      live: doubaoLive,
      localReadyNote: '本地 CLI adapter 已就绪'
    })
  ];
}

export async function cachedRuntimeReadiness(runtimeId, config, {
  env = process.env,
  probe = probeRuntimeReadiness,
  ttlMs = DEFAULT_READINESS_CACHE_TTL_MS,
  now = Date.now
} = {}) {
  const key = readinessCacheKey(runtimeId, config, env);
  const timestamp = now();
  const cached = readinessCache.get(key);
  if (cached && cached.expiresAt > timestamp) return cached.promise;

  const promise = Promise.resolve()
    .then(() => probe(runtimeId, config, { env }))
    .then((ready) => ready === true)
    .catch(() => false);
  readinessCache.set(key, {
    expiresAt: timestamp + Math.max(0, ttlMs),
    promise
  });
  return promise;
}

export function clearRuntimeReadinessCache() {
  readinessCache.clear();
}

export async function probeExecutable(command, {
  env = process.env,
  accessImpl = access,
  execFileImpl = runProbeProcess,
  createWorkspace = mkdtemp,
  removeWorkspace = rm
} = {}) {
  const executable = await findExecutable(command, env, accessImpl);
  if (!executable) return { installed: false, version: null, executable: null };

  const workspace = await createWorkspace(path.join(tmpdir(), `agent-roast-probe-${command}-`));
  try {
    const { stdout } = await execFileImpl(executable, ['--version'], {
      cwd: workspace,
      timeout: 3_000,
      maxBuffer: 64_000,
      env: localCliEnv(null, workspace, env)
    });
    const version = String(stdout || '').trim().split(/\r?\n/)[0];
    if (!version) return { installed: false, version: null, executable: null };
    return { installed: true, version, executable };
  } catch {
    return { installed: false, version: null, executable: null };
  } finally {
    await removeWorkspace(workspace, { recursive: true, force: true });
  }
}

export async function probeCursorAuthentication(executable, {
  env = process.env,
  execFileImpl = runProbeProcess,
  createWorkspace = mkdtemp,
  removeWorkspace = rm
} = {}) {
  if (!executable || !cursorAuthConfigHome(env)) return false;
  const workspace = await createWorkspace(path.join(tmpdir(), 'agent-roast-cursor-status-'));
  try {
    const { stdout, stderr } = await execFileImpl(executable, ['status'], {
      cwd: workspace,
      timeout: 5_000,
      maxBuffer: 64_000,
      env: localCliEnv('cursor', workspace, env, {
        cursorConfigHome: cursorAuthConfigHome(env)
      })
    });
    const output = `${stdout || ''}\n${stderr || ''}`.trim();
    if (!output || /not\s+logged|logged\s+out|unauthenticated|not\s+authenticated/i.test(output)) {
      return false;
    }
    return /\blogged\s+in\b|\bauthenticated\b|\bsigned\s+in\b/i.test(output);
  } catch {
    return false;
  } finally {
    await removeWorkspace(workspace, { recursive: true, force: true });
  }
}

async function readinessProbe(runtimeId, config, installed, authenticated, liveProbe) {
  if (!config || !authenticated) return false;
  if (config.kind === 'local-cli' && !installed) return false;
  try {
    return (await liveProbe(runtimeId, config)) === true;
  } catch {
    return false;
  }
}

async function adapterOrLocalAuthentication(config, env, localProbe) {
  if (config && config.kind !== 'local-cli') {
    return runtimeConfigAuthenticated(config, env);
  }
  try { return (await localProbe()) === true; } catch { return false; }
}

function statusEntry({
  id,
  name,
  probe,
  version = probe.version,
  config,
  authenticated,
  live,
  localReadyNote,
  missingNote = '未安装'
}) {
  const enabled = Boolean(config);
  const runtimeReady = Boolean(enabled
    && authenticated
    && live
    && (config.kind !== 'local-cli' || probe.installed));
  let note;
  if (!config) {
    note = probe.installed ? '已安装；需显式启用 adapter' : missingNote;
  } else if (config.source === 'remote') {
    note = !authenticated
      ? '远程 adapter 已配置但缺少鉴权'
      : runtimeReady
        ? '远程隔离 adapter 最小调用成功'
        : '远程隔离 adapter 最小调用失败';
  } else if (config.kind === 'model-api') {
    note = !authenticated
      ? 'Model API adapter 已配置但缺少鉴权'
      : runtimeReady
        ? 'Model API adapter 最小调用成功'
        : 'Model API adapter 最小调用失败';
  } else if (!probe.installed) {
    note = missingNote;
  } else if (!authenticated) {
    note = id === 'cursor'
      ? 'Agent CLI 已安装但持久账户未登录'
      : '已安装但后端凭据无效';
  } else {
    note = runtimeReady ? localReadyNote : '本地 CLI 最小调用失败';
  }
  return {
    id,
    name,
    installed: probe.installed,
    version,
    authenticated: Boolean(authenticated),
    enabled,
    runtimeReady,
    note
  };
}

async function findExecutable(command, env, accessImpl) {
  return resolveCliExecutable(command, { env, accessImpl });
}

function readinessCacheKey(runtimeId, config, env) {
  const credentialMaterial = [];
  if (Object.hasOwn(config, 'apiKeyEnv') && Object.hasOwn(env, config.apiKeyEnv)) {
    credentialMaterial.push(String(env[config.apiKeyEnv] || ''));
  }
  if (runtimeId === 'claude-code' && config.kind === 'local-cli') {
    const backend = resolveClaudeBackend(env);
    const backendKeys = backend === 'ark'
      ? ['CLAUDE_BACKEND', 'ARK_BASE_URL', 'ARK_API_KEY', 'CLAUDE_ARK_MODEL']
      : backend === 'deepseek'
        ? ['CLAUDE_BACKEND', 'DEEPSEEK_API_KEY', 'DEEPSEEK_CLAUDE_MODEL']
        : ['CLAUDE_BACKEND'];
    for (const name of backendKeys) {
      if (Object.hasOwn(env, name)) credentialMaterial.push(`${name}=${env[name]}`);
    }
  }
  if (runtimeId === 'cursor' && config.kind === 'local-cli') {
    credentialMaterial.push(`CURSOR_AUTH_CONFIG_HOME=${env.CURSOR_AUTH_CONFIG_HOME || ''}`);
  }
  return createHash('sha256')
    .update(JSON.stringify({ runtimeId, config, credentialMaterial }))
    .digest('hex');
}

function runProbeProcess(command, args, options) {
  return runLocalCliProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeout,
    maxBuffer: options.maxBuffer
  });
}
