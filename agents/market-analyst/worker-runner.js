import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvidencePack, validateOperation } from './schemas.js';
import { sanitizeTraceValue } from './run-trace.js';

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
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
  if (typeof config.python !== 'string' || !config.python) throw new TypeError('config.python is required');
  if (typeof config.stateDir !== 'string' || !config.stateDir) {
    throw new TypeError('config.stateDir is required');
  }
  const timeoutMs = positiveInteger(config.workerTimeoutMs, 'workerTimeoutMs');
  const payload = buildWorkerRequest(request, config);
  if (signal?.aborted) {
    return Promise.reject(workerError('market worker aborted', 'ABORT_ERR', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    let stderrBuffer = '';
    let timer;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error, terminate = true) => {
      if (settled) return;
      if (terminate && child && !child.killed) child.kill('SIGTERM');
      finish(reject, error);
    };
    const abort = () => {
      fail(workerError('market worker aborted', 'ABORT_ERR', 'AbortError'));
    };
    const processTraceLine = (line) => {
      if (!line.startsWith('TRACE ')) return;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        fail(workerError('market worker emitted malformed trace JSON', 'WORKER_PROTOCOL_ERROR'));
        return;
      }
      try {
        onTrace(sanitizeTraceValue(event));
      } catch {
        fail(workerError('market worker trace consumer failed', 'WORKER_TRACE_ERROR'));
      }
    };

    try {
      child = spawnImpl(config.python, [WORKER_FILE], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH || '',
          PYTHONIOENCODING: 'utf-8',
          PANDA_DATA_USERNAME: process.env.PANDA_DATA_USERNAME || '',
          PANDA_DATA_PASSWORD: process.env.PANDA_DATA_PASSWORD || '',
          PANDA_DATA_BASE_URL: process.env.PANDA_DATA_BASE_URL || '',
          MARKET_REPORT_CACHE_DIR: path.join(path.resolve(config.stateDir), 'cache')
        }
      });
    } catch {
      finish(reject, workerError('market worker could not be started', 'WORKER_SPAWN_ERROR'));
      return;
    }

    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      fail(workerError(`market worker timed out after ${timeoutMs}ms`, 'WORKER_TIMEOUT'));
    }, timeoutMs);

    child.once('error', () => {
      fail(workerError('market worker process error', 'WORKER_SPAWN_ERROR'), false);
    });
    child.stdin.once('error', () => {
      fail(workerError('market worker input failed', 'WORKER_INPUT_ERROR'));
    });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        fail(workerError('market worker stdout exceeded 20 MB', 'WORKER_OUTPUT_LIMIT'));
        return;
      }
      stdout.push(buffer);
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        fail(workerError('market worker stderr exceeded 20 MB', 'WORKER_OUTPUT_LIMIT'));
        return;
      }
      stderrBuffer += buffer.toString('utf8');
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) processTraceLine(line);
    });
    child.once('close', (code, closeSignal) => {
      if (settled) return;
      if (stderrBuffer) processTraceLine(stderrBuffer);
      if (settled) return;
      if (code !== 0) {
        fail(
          workerError(
            closeSignal
              ? 'market worker terminated by signal'
              : `market worker exited with code ${code}`,
            'WORKER_EXIT_ERROR'
          ),
          false
        );
        return;
      }
      let evidence;
      try {
        evidence = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        validateEvidencePack(evidence);
      } catch {
        fail(
          workerError('market worker emitted invalid Evidence Pack JSON', 'WORKER_PROTOCOL_ERROR'),
          false
        );
        return;
      }
      finish(resolve, evidence);
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
