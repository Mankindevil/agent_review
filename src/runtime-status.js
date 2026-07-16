import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function getRuntimeStatus() {
  const [claude, cursorAgent, cursorDesktop, doubao] = await Promise.all([
    probe('claude'), probe('cursor-agent'), probe('cursor'), probe('doubao')
  ]);
  return [
    {
      id: 'claude-code', name: 'Claude Code', installed: claude.installed,
      version: claude.version, runtimeReady: Boolean(process.env.RUNTIME_ADAPTERS_JSON?.includes('claude-code')),
      note: claude.installed ? '已安装；需配置隔离 adapter 才会被平台调用' : '未安装'
    },
    {
      id: 'cursor', name: 'Cursor Agent', installed: cursorAgent.installed,
      version: cursorAgent.version || cursorDesktop.version,
      runtimeReady: Boolean(process.env.RUNTIME_ADAPTERS_JSON?.includes('cursor')),
      note: cursorAgent.installed ? 'Agent CLI 已安装；仍需配置 adapter' : cursorDesktop.installed ? '只有 Cursor Desktop CLI，缺少 cursor-agent' : '未安装'
    },
    {
      id: 'doubao', name: 'Doubao Agent', installed: doubao.installed,
      version: doubao.version, runtimeReady: Boolean(process.env.RUNTIME_ADAPTERS_JSON?.includes('doubao')),
      note: doubao.installed ? '已安装；需配置 adapter' : '未检测到本地 CLI'
    }
  ];
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
