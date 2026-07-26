import { constants as fsConstants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const DEFAULT_MAX_BUFFER = 5_000_000;
const DEFAULT_GRACE_MS = 1_000;

/** Extra install locations when a long-lived Node process has a stale PATH. */
export function wellKnownCliDirectories(command, {
  env = process.env,
  platform = process.platform
} = {}) {
  if (command !== 'cursor-agent' || platform !== 'win32') return [];
  const directories = [];
  if (typeof env.CURSOR_AGENT_HOME === 'string' && env.CURSOR_AGENT_HOME.trim()) {
    directories.push(env.CURSOR_AGENT_HOME.trim());
  }
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()) {
    directories.push(path.join(env.LOCALAPPDATA.trim(), 'cursor-agent'));
  }
  return directories;
}

/** Resolve a bare CLI name to an absolute PATHEXT candidate when possible. */
export async function resolveCliExecutable(command, {
  env = process.env,
  accessImpl = access,
  platform = process.platform
} = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return command;
  }
  const directories = [
    ...String(env.PATH || env.Path || '').split(path.delimiter),
    ...wellKnownCliDirectories(command, { env, platform })
  ];
  for (const directory of directories) {
    if (!directory) continue;
    for (const name of executableNames(command, env, platform)) {
      const candidate = path.join(directory, name);
      try {
        await accessImpl(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH / PATHEXT candidates.
      }
    }
  }
  return null;
}

function executableNames(command, env, platform) {
  if (platform !== 'win32' || path.extname(command)) return [command];
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  // Prefer PowerShell shims when PATHEXT omits .PS1 (common for Agent CLIs).
  return [command, ...extensions.map((ext) => `${command}${ext}`), `${command}.ps1`];
}

/**
 * Prefer shell-less spawns on Windows so multiline `-p` prompts and flag
 * tokens are not mangled by `cmd.exe /s /c`.
 */
export function normalizeCliSpawn(command, args, {
  platform = process.platform,
  env = process.env,
  existsSyncImpl = existsSync
} = {}) {
  const argv = Array.isArray(args) ? [...args] : [];
  if (platform !== 'win32') {
    return { command, args: argv, shell: false, windowsHide: true };
  }

  let target = typeof command === 'string' ? command : '';
  const lower = target.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const sibling = target.replace(/\.(cmd|bat)$/iu, '.ps1');
    if (existsSyncImpl(sibling)) target = sibling;
  }

  if (target.toLowerCase().endsWith('.exe')) {
    return { command: target, args: argv, shell: false, windowsHide: true };
  }

  if (target.toLowerCase().endsWith('.ps1')) {
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    return {
      command: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target, ...argv],
      shell: false,
      windowsHide: true
    };
  }

  // Bare command names still need cmd.exe PATHEXT resolution.
  return { command: target, args: argv, shell: true, windowsHide: true };
}

export function runLocalCliProcess(command, args, {
  cwd,
  env,
  timeoutMs,
  maxBuffer = DEFAULT_MAX_BUFFER,
  signal,
  graceMs = DEFAULT_GRACE_MS,
  spawnImpl = spawn,
  killImpl = process.kill,
  platform = process.platform,
  existsSyncImpl = existsSync
} = {}) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationError = null;
    let timeoutTimer;
    let killTimer;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const detached = platform !== 'win32';
    const normalized = normalizeCliSpawn(command, args, {
      platform,
      env: env || process.env,
      existsSyncImpl
    });
    const child = spawnImpl(normalized.command, normalized.args, {
      cwd,
      env,
      detached,
      shell: normalized.shell,
      windowsHide: normalized.windowsHide,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(attachOutput(error));
      else resolve(result);
    };

    const attachOutput = (error) => {
      error.stdout = Buffer.concat(stdout).toString();
      error.stderr = Buffer.concat(stderr).toString();
      return error;
    };

    const signalTree = (treeSignal) => {
      try {
        if (detached && Number.isInteger(child.pid) && child.pid > 0) {
          killImpl(-child.pid, treeSignal);
        } else {
          child.kill(treeSignal);
        }
      } catch {
        try { child.kill(treeSignal); } catch { /* close/error will settle */ }
      }
    };

    const terminate = (error) => {
      if (terminationError || settled) return;
      terminationError = error;
      signalTree('SIGTERM');
      killTimer = setTimeout(() => {
        signalTree('SIGKILL');
      }, graceMs);
    };

    const onAbort = () => terminate(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (chunks, chunk, stream) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === 'stdout') stdoutBytes += value.length;
      else stderrBytes += value.length;
      if ((stream === 'stdout' ? stdoutBytes : stderrBytes) > maxBuffer) {
        const error = new Error(`${stream} exceeded maxBuffer`);
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        terminate(error);
        return;
      }
      chunks.push(value);
    };

    child.stdout?.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.once('error', (error) => finish(error));
    child.once('close', (code, closeSignal) => {
      const output = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString()
      };
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code === 0) {
        finish(null, output);
        return;
      }
      const error = new Error(`${command} exited with ${closeSignal || code}`);
      error.code = code;
      error.signal = closeSignal;
      finish(error);
    });

    timeoutTimer = setTimeout(() => {
      const error = new Error(`${command} exceeded ${timeoutMs}ms`);
      error.code = 'LOCAL_RUNTIME_TIMEOUT';
      error.killed = true;
      terminate(error);
    }, timeoutMs);
  });
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}
