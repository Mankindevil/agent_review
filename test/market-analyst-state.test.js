import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createRunTrace,
  sanitizeTraceValue
} from '../agents/market-analyst/run-trace.js';
import {
  MarketTaskStore,
  TASK_STATES
} from '../agents/market-analyst/task-store.js';
import { acquireRunLock } from '../agents/market-analyst/run-lock.js';
import { runMarketWorker } from '../agents/market-analyst/worker-runner.js';

const MAX_WORKER_OUTPUT_BYTES = 20 * 1024 * 1024;

const evidencePack = {
  schemaVersion: '1.0',
  runId: 'run-20260723',
  reportDate: '2026-07-23',
  status: 'complete',
  markets: {},
  conclusions: [],
  leaderboards: {},
  sources: []
};

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'market-agent-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeSpawn(scenario, capture = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal = 'SIGTERM') => {
      if (child.killed) return false;
      child.killed = true;
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    capture.command = command;
    capture.args = args;
    capture.options = options;
    capture.stdin = '';
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => {
      capture.stdin += chunk;
    });
    queueMicrotask(() => scenario(child));
    return child;
  };
}

function completeChild(child, { stdout = '', stderr = '', code = 0 } = {}) {
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code, null);
}

function workerConfig(stateDir, overrides = {}) {
  return {
    python: 'python-test',
    stateDir,
    workerTimeoutMs: 1_000,
    minLiquidityCny: 20_000_000,
    cacheDays: 30,
    ...overrides
  };
}

test('MarketTaskStore persists queued atomic writes and reloads them', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const store = new MarketTaskStore({ stateDir });
  await Promise.all([
    store.create({
      id: 'task-1',
      owner: 'owner-a',
      messageId: 'message-1',
      status: { state: 'TASK_STATE_SUBMITTED' }
    }),
    store.create({
      id: 'task-2',
      owner: 'owner-b',
      messageId: 'message-2',
      status: { state: 'TASK_STATE_WORKING' }
    })
  ]);

  const persisted = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8'));
  assert.deepEqual(persisted.tasks.map((task) => task.id).sort(), ['task-1', 'task-2']);
  await assert.rejects(stat(path.join(stateDir, 'state.json.tmp')), { code: 'ENOENT' });

  const reloaded = new MarketTaskStore(stateDir);
  await reloaded.load();
  assert.equal((await reloaded.get('task-1')).messageId, 'message-1');
  assert.deepEqual((await reloaded.list({ owner: 'owner-b' })).map(({ id }) => id), ['task-2']);
  assert.equal((await reloaded.findByMessageId('owner-a', 'message-1')).id, 'task-1');
});

test('MarketTaskStore rejects terminal-to-working transitions without changing state', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const store = new MarketTaskStore(stateDir);
  await store.create({
    id: 'task-terminal',
    owner: 'owner-a',
    status: { state: 'TASK_STATE_COMPLETED' }
  });

  await assert.rejects(
    store.update('task-terminal', (task) => ({
      ...task,
      status: { state: 'TASK_STATE_WORKING' }
    })),
    (error) => error.code === 'INVALID_TASK_TRANSITION'
  );
  assert.equal((await store.get('task-terminal')).status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual([...TASK_STATES], [
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_REJECTED'
  ]);
});

test('sanitizeTraceValue removes credentials, authorization, JWTs, and full email addresses', () => {
  const value = sanitizeTraceValue({
    username: 'panda-user',
    smtp: { user: 'smtp-user' },
    password: 'panda-password',
    smtpSecret: 'smtp-secret',
    accessToken: 'access-token',
    authorization: 'Bearer access-token',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
    recipients: ['jane.doe@example.com'],
    message: 'mail jane.doe@example.com; Authorization: Bearer abc.def.ghi; password=hunter2'
  });

  const serialized = JSON.stringify(value);
  for (const secret of [
    'panda-user',
    'smtp-user',
    'panda-password',
    'smtp-secret',
    'access-token',
    'eyJhbGciOiJIUzI1NiJ9.payload.signature',
    'jane.doe@example.com',
    'abc.def.ghi',
    'hunter2'
  ]) {
    assert.equal(serialized.includes(secret), false, `trace retained ${secret}`);
  }
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /j\*+@example\.com/);
});

test('RunTrace records sanitized step, worker, model, email, and lineage detail', () => {
  const trace = createRunTrace({
    runId: 'run-1',
    reportDate: '2026-07-23',
    conclusionLineage: {
      conclusionId: 'market-hot-industries',
      authorization: 'Bearer should-not-persist'
    }
  });
  const sequence = trace.startStep({
    skillId: 'daily-market-report',
    tool: 'panda-market-worker',
    detail: { username: 'panda-user' }
  });
  trace.finishStep(sequence, {
    status: 'ok',
    detail: { rowCount: 4000, fields: ['symbol', 'close'], responseHash: 'sha256' }
  });
  trace.addWorkerEvent({
    type: 'panda-call',
    method: 'get_stock_daily',
    durationMs: 20,
    rowCount: 4000,
    fields: ['symbol', 'close'],
    cacheStatus: 'hit',
    retryCount: 1,
    responseHash: 'worker-hash'
  });
  trace.addModelUsage({ model: 'g5.4', totalTokens: 42, cost: 0.01 });
  trace.addEmailAttempt({ attempt: 1, recipient: 'jane.doe@example.com', status: 'sent' });

  const output = trace.toJSON();
  assert.equal(output.steps[0].sequence, 1);
  assert.equal(output.workerEvents[0].sequence, 2);
  assert.equal(output.modelUsage[0].sequence, 3);
  assert.equal(output.emailAttempts[0].sequence, 4);
  assert.equal(output.steps[0].status, 'ok');
  assert.equal(typeof output.steps[0].durationMs, 'number');
  assert.equal(output.workerEvents[0].rowCount, 4000);
  assert.equal(output.modelUsage[0].totalTokens, 42);
  assert.equal(JSON.stringify(output).includes('jane.doe@example.com'), false);
  assert.equal(JSON.stringify(output).includes('should-not-persist'), false);
});

test('acquireRunLock rejects a second live lock for the same report date', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const first = await acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 60_000 });
  t.after(() => first.release());

  await assert.rejects(
    acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 60_000 }),
    (error) => error.code === 'RUN_LOCKED'
  );
});

test('acquireRunLock recovers stale locks without letting an old owner release the replacement', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const first = await acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 });
  const lockPath = path.join(stateDir, 'locks', '2026-07-23.lock');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  const replacement = await acquireRunLock({
    stateDir,
    reportDate: '2026-07-23',
    staleMs: 1_000
  });
  t.after(() => replacement.release());
  await first.release();

  await assert.rejects(
    acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 60_000 }),
    (error) => error.code === 'RUN_LOCKED'
  );
});

test('acquireRunLock recognizes stale acquisition metadata after a crash', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const first = await acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 });
  const lockPath = path.join(stateDir, 'locks', '2026-07-23.lock');
  const [ownerFile] = (await readdir(lockPath)).filter((name) => name.startsWith('owner-'));
  const ownerPath = path.join(lockPath, ownerFile);
  const lock = JSON.parse(await readFile(ownerPath, 'utf8'));
  lock.acquiredAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(ownerPath, JSON.stringify(lock));

  const replacement = await acquireRunLock({
    stateDir,
    reportDate: '2026-07-23',
    staleMs: 1_000
  });
  t.after(() => replacement.release());
  await first.release();
});

test('runMarketWorker sends only whitelisted JSON, controls cache by environment, and parses traces', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const capture = {};
  const traces = [];
  const spawnImpl = fakeSpawn((child) => {
    completeChild(child, {
      stdout: JSON.stringify(evidencePack),
      stderr: [
        'worker diagnostic without protocol meaning',
        `TRACE ${JSON.stringify({
          type: 'panda-call',
          method: 'get_stock_daily',
          rowCount: 4000,
          password: 'should-not-escape'
        })}`,
        ''
      ].join('\n')
    });
  }, capture);

  const result = await runMarketWorker({
    request: {
      operation: 'daily-market-report',
      date: '2026-07-23',
      topN: 10,
      runId: 'run-20260723',
      cacheDir: 'C:\\attacker-cache',
      outputPath: 'C:\\attacker-output',
      pandaMethod: 'get_arbitrary_method'
    },
    config: workerConfig(stateDir),
    spawnImpl,
    onTrace: (event) => traces.push(event)
  });

  assert.deepEqual(result, evidencePack);
  assert.equal(capture.command, 'python-test');
  assert.match(capture.args[0], /panda_market_worker\.py$/);
  assert.equal(capture.options.stdio.join(','), 'pipe,pipe,pipe');
  assert.equal(capture.options.env.MARKET_REPORT_CACHE_DIR, path.join(stateDir, 'cache'));
  assert.deepEqual(Object.keys(capture.options.env).sort(), [
    'MARKET_REPORT_CACHE_DIR',
    'PANDA_DATA_BASE_URL',
    'PANDA_DATA_PASSWORD',
    'PANDA_DATA_USERNAME',
    'PATH',
    'PYTHONIOENCODING'
  ]);
  assert.deepEqual(JSON.parse(capture.stdin), {
    operation: 'daily-market-report',
    date: '2026-07-23',
    topN: 10,
    minLiquidityCny: 20_000_000,
    cacheDays: 30,
    runId: 'run-20260723'
  });
  assert.equal(traces.length, 1);
  assert.equal(traces[0].method, 'get_stock_daily');
  assert.equal(JSON.stringify(traces[0]).includes('should-not-escape'), false);
});

test('runMarketWorker rejects malformed evidence and nonzero exits', async (t) => {
  const stateDir = await temporaryDirectory(t);
  await assert.rejects(
    runMarketWorker({
      request: { operation: 'daily-market-report' },
      config: workerConfig(stateDir),
      spawnImpl: fakeSpawn((child) => completeChild(child, { stdout: '{not-json' }))
    }),
    (error) => error.code === 'WORKER_PROTOCOL_ERROR'
  );
  await assert.rejects(
    runMarketWorker({
      request: { operation: 'daily-market-report' },
      config: workerConfig(stateDir),
      spawnImpl: fakeSpawn((child) => completeChild(child, { code: 2 }))
    }),
    (error) => error.code === 'WORKER_EXIT_ERROR' && !error.message.includes('PANDA_DATA_PASSWORD')
  );
});

test('runMarketWorker enforces its 20 MB output bound', async (t) => {
  const stateDir = await temporaryDirectory(t);
  await assert.rejects(
    runMarketWorker({
      request: { operation: 'daily-market-report' },
      config: workerConfig(stateDir),
      spawnImpl: fakeSpawn((child) => {
        child.stdout.write(Buffer.alloc(MAX_WORKER_OUTPUT_BYTES + 1, 0x61));
      })
    }),
    (error) => error.code === 'WORKER_OUTPUT_LIMIT'
  );
});

test('runMarketWorker terminates on timeout and propagates abort', async (t) => {
  const stateDir = await temporaryDirectory(t);
  await assert.rejects(
    runMarketWorker({
      request: { operation: 'daily-market-report' },
      config: workerConfig(stateDir, { workerTimeoutMs: 5 }),
      spawnImpl: fakeSpawn(() => {})
    }),
    (error) => error.code === 'WORKER_TIMEOUT'
  );

  const controller = new AbortController();
  const running = runMarketWorker({
    request: { operation: 'daily-market-report' },
    config: workerConfig(stateDir),
    signal: controller.signal,
    spawnImpl: fakeSpawn(() => {})
  });
  controller.abort(new Error('caller canceled'));
  await assert.rejects(
    running,
    (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR'
  );
});
