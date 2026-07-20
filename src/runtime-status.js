import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasClaudeCredential, shouldUseArkClaude } from './claude-env.js';

const execFileAsync = promisify(execFile);

export async function getRuntimeStatus() {
  const [claude, cursorAgent, cursorDesktop, doubao, claudeAuth, cursorAuth] = await Promise.all([
    probe('claude'), probe('cursor-agent'), probe('cursor'), probe('doubao'), probeClaudeAuth(), probeCursorAuth()
  ]);
  const remoteConfig = process.env.RUNTIME_ADAPTERS_JSON || '';
  const claudeEnabled = remoteConfig.includes('claude-code') || process.env.ENABLE_LOCAL_CLAUDE_CODE === 'true';
  const cursorEnabled = remoteConfig.includes('cursor') || process.env.ENABLE_LOCAL_CURSOR_AGENT === 'true';
  const doubaoApiReady = Boolean(process.env.ARK_BASE_URL && process.env.ARK_API_KEY && process.env.REVIEW_MODEL_DOUBAO);
  const claudeBackend = shouldUseArkClaude() ? '火山方舟 DeepSeek' : process.env.DEEPSEEK_API_KEY ? 'DeepSeek 直连' : 'Claude';
  return [
    {
      id: 'claude-code', name: 'Claude Code', installed: claude.installed,
      version: claude.version, authenticated: claudeAuth, runtimeReady: Boolean(claude.installed && claudeEnabled && (claudeAuth || remoteConfig.includes('claude-code'))),
      note: !claude.installed ? '未安装' : !claudeAuth ? '已安装但未登录' : claudeEnabled ? `本地 CLI adapter 已就绪 · ${claudeBackend}` : `凭据已就绪（${claudeBackend}）；需显式启用本地 adapter`
    },
    {
      id: 'cursor', name: 'Cursor Agent', installed: cursorAgent.installed,
      version: cursorAgent.version || cursorDesktop.version,
      authenticated: cursorAuth, runtimeReady: Boolean(cursorAgent.installed && cursorEnabled && (cursorAuth || remoteConfig.includes('cursor'))),
      note: !cursorAgent.installed ? (cursorDesktop.installed ? '只有 Cursor Desktop CLI，缺少 cursor-agent' : '未安装') : !cursorAuth ? 'Agent CLI 已安装但未登录' : cursorEnabled ? '本地 CLI adapter 已就绪' : '已登录；需显式启用本地 adapter'
    },
    {
      id: 'doubao', name: 'Doubao Agent', installed: doubao.installed,
      version: doubao.version, authenticated: doubaoApiReady,
      runtimeReady: Boolean(process.env.RUNTIME_ADAPTERS_JSON?.includes('doubao') || doubaoApiReady),
      note: doubaoApiReady ? '火山方舟 API adapter 已就绪' : doubao.installed ? '已安装；需配置 adapter' : '未检测到本地 CLI，也未配置方舟 API'
    }
  ];
}

async function probeClaudeAuth() {
  if (hasClaudeCredential()) return true;
  try { const { stdout } = await execFileAsync('claude', ['auth', 'status'], { timeout: 3_000, maxBuffer: 64_000 }); return JSON.parse(stdout).loggedIn === true; } catch { return false; }
}

async function probeCursorAuth() {
  try { const { stdout } = await execFileAsync('cursor-agent', ['status'], { timeout: 5_000, maxBuffer: 64_000 }); return !/not logged/i.test(stdout); } catch { return false; }
}

async function probe(command) {
  const executable = await findExecutable(command);
  if (!executable) return { installed: false, version: null };
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 3_000, maxBuffer: 64_000 });
    return { installed: true, version: stdout.trim().split('\n')[0] || 'unknown' };
  } catch {
    return { installed: true, version: 'unknown' };
  }
}

async function findExecutable(command) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return null;
}
