import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvidencePack, validateOperation } from './schemas.js';
import { sanitizeTraceValue } from './run-trace.js';

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const WORKER_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'tools',
  'panda_market_worker.py'
);

function workerError(message, code, name = 'Error') {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return number;
}

function buildWorkerRequest(request, config) {
  const operation = validateOperation(request);
  if (operation.operation !== 'daily-market-report') {
    throw workerError(
      `Python market worker does not support operation: ${operation.operation}`,
      'WORKER_OPERATION_UNSUPPORTED'
    );
  }
  const result = {
    operation: operation.operation,
    ...(operation.date ? { date: operation.date } : {}),
    topN: operation.topN,
    minLiquidityCny: positiveInteger(config.minLiquidityCny, 'minLiquidityCny'),
    cacheDays: positiveInteger(config.cacheDays, 'cacheDays')
  };
  if (request.runId !== undefined) {
    if (typeof request.runId !== 'string' || !/^[a-z0-9._-]{1,128}$/i.test(request.runId)) {
      throw new TypeError('runId contains unsupported characters');
    }
    result.runId = request.runId;
  }
  return result;
}

export function runMarketWorker({
  request,
  config,
  signal,
  spawnImpl = spawn,
  onTrace = () => {}
}) {
  if (!config || typeof config !== 'object') throw new TypeError('config is required');
  if (typeof config.python !== 'string' || !config.python) {
    throw new TypeError('config.python is required');
  }
  if (typeof config.stateDir !== 'string' || !config.stateDir) {
    throw new TypeError('config.stateDir is required');
  }
  if (!config.panda?.enabled) {
    throw workerError('Panda data source is not enabled', 'PANDA_DISABLED');
  }
  if (!config.panda?.ready) {
    throw workerError('Panda data source is not configured and ready', 'PANDA_NOT_READY');
  }
  const timeoutMs = positiveInteger(config.workerTimeoutMs, 'workerTimeoutMs');
  const terminationGraceMs = positiveInteger(
    config.workerTerminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    'workerTerminationGraceMs'
  );
  const cleanupTimeoutMs = positiveInteger(
    config.workerCleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    'workerCleanupTimeoutMs'
  );
  const payload = buildWorkerRequest(request, config);
  if (signal?.aborted) {
    return Promise.reject(workerError('market worker aborted', 'ABORT_ERR', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let closed = false;
    let pendingFailure = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    let stderrBuffer = '';
    let timeoutTimer;
    let terminationTimer;
    let cleanupTimer;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(terminationTimer);
      clearTimeout(cleanupTimer);
    };
    const destroyPipes = () => {
      for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
        if (stream && !stream.destroyed) stream.destroy();
      }
    };
    const removeListeners = () => {
      signal?.removeEventListener('abort', onAbort);
      child?.removeListener('error', onChildError);
      child?.removeListener('close', onClose);
      child?.stdin?.removeListener('error', onInputError);
      child?.stdout?.removeListener('data', onStdout);
      child?.stderr?.removeListener('data', onStderr);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeListeners();
      destroyPipes();
      callback(value);
    };
    const sendSignal = (name) => {
      try {
        child?.kill(name);
      } catch {
        // The cleanup deadline still guarantees settlement.
      }
    };
    const terminateThenReject = (error) => {
      if (settled || pendingFailure) return;
      pendingFailure = error;
      clearTimeout(timeoutTimer);
      sendSignal('SIGTERM');
      terminationTimer = setTimeout(() => {
        if (settled || closed) return;
        sendSignal('SIGKILL');
        cleanupTimer = setTimeout(() => {
          settle(reject, pendingFailure);
        }, cleanupTimeoutMs);
      }, terminationGraceMs);
    };
    const onAbort = () => {
      terminateThenReject(workerError('market worker aborted', 'ABORT_ERR', 'AbortError'));
    };
    const processTraceLine = (line) => {
      if (pendingFailure || !line.startsWith('TRACE ')) return;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        terminateThenReject(
          workerError('market worker emitted malformed trace JSON', 'WORKER_PROTOCOL_ERROR')
        );
        return;
      }
      try {
        onTrace(sanitizeTraceValue(event));
      } catch {
        terminateThenReject(
          workerError('market worker trace consumer failed', 'WORKER_TRACE_ERROR')
        );
      }
    };
    const onChildError = () => {
      if (pendingFailure) return;
      settle(reject, workerError('market worker process error', 'WORKER_SPAWN_ERROR'));
    };
    const onInputError = () => {
      terminateThenReject(workerError('market worker input failed', 'WORKER_INPUT_ERROR'));
    };
    const onStdout = (chunk) => {
      if (settled || pendingFailure) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        terminateThenReject(
          workerError('market worker stdout exceeded 20 MB', 'WORKER_OUTPUT_LIMIT')
        );
        return;
      }
      stdout.push(buffer);
    };
    const onStderr = (chunk) => {
      if (settled || pendingFailure) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        terminateThenReject(
          workerError('market worker stderr exceeded 20 MB', 'WORKER_OUTPUT_LIMIT')
        );
        return;
      }
      stderrBuffer += buffer.toString('utf8');
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        processTraceLine(line);
        if (pendingFailure) break;
      }
    };
    const onClose = (code, closeSignal) => {
      if (settled) return;
      closed = true;
      if (pendingFailure) {
        settle(reject, pendingFailure);
        return;
      }
      if (stderrBuffer) processTraceLine(stderrBuffer);
      if (pendingFailure) {
        settle(reject, pendingFailure);
        return;
      }
      if (code !== 0) {
        settle(
          reject,
          workerError(
            closeSignal
              ? 'market worker terminated by signal'
              : `market worker exited with code ${code}`,
            'WORKER_EXIT_ERROR'
          )
        );
        return;
      }
      let evidence;
      try {
        evidence = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        validateEvidencePack(evidence);
      } catch {
        settle(
          reject,
          workerError('market worker emitted invalid Evidence Pack JSON', 'WORKER_PROTOCOL_ERROR')
        );
        return;
      }
      settle(resolve, evidence);
    };

    try {
      child = spawnImpl(config.python, [WORKER_FILE], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH || '',
          PYTHONIOENCODING: 'utf-8',
          PANDA_DATA_USERNAME: config.panda.username,
          PANDA_DATA_PASSWORD: config.panda.password,
          ...(String(config.panda.baseUrl || '').trim()
            ? { PANDA_DATA_BASE_URL: String(config.panda.baseUrl).trim() }
            : {}),
          MARKET_REPORT_CACHE_DIR: path.join(path.resolve(config.stateDir), 'cache')
        }
      });
    } catch {
      settle(reject, workerError('market worker could not be started', 'WORKER_SPAWN_ERROR'));
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', onChildError);
    child.stdin.once('error', onInputError);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('close', onClose);
    timeoutTimer = setTimeout(() => {
      terminateThenReject(
        workerError(`market worker timed out after ${timeoutMs}ms`, 'WORKER_TIMEOUT')
      );
    }, timeoutMs);

    child.stdin.end(JSON.stringify(payload));
  });
}
