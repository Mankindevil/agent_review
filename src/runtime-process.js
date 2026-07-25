import { spawn } from 'node:child_process';

const DEFAULT_MAX_BUFFER = 5_000_000;
const DEFAULT_GRACE_MS = 1_000;

export function runLocalCliProcess(command, args, {
  cwd,
  env,
  timeoutMs,
  maxBuffer = DEFAULT_MAX_BUFFER,
  signal,
  graceMs = DEFAULT_GRACE_MS,
  spawnImpl = spawn,
  killImpl = process.kill,
  platform = process.platform
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
    // Windows Agent/CLI shims are usually `.cmd`; spawn without a shell cannot
    // resolve PATHEXT and fails with ENOENT / EINVAL on the bare command name.
    const shell = platform === 'win32';
    const child = spawnImpl(command, args, {
      cwd,
      env,
      detached,
      shell,
      windowsHide: true,
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
