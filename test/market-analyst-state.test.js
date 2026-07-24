import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createRunTrace,
  sanitizeTraceValue,
  TRACE_SANITIZATION_LIMITS,
  TRACE_LIMITS
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

function findDeadPid() {
  for (const pid of [2_147_483_647, 999_999_999, 99_999_999]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not identify an unused PID for stale-lock test');
}

async function createStaleOwner(stateDir, reportDate, overrides = {}) {
  const lockPath = path.join(stateDir, 'locks', `${reportDate}.lock`);
  await mkdir(lockPath, { recursive: true });
  const owner = {
    schemaVersion: '1.0',
    reportDate,
    pid: findDeadPid(),
    hostname: os.hostname(),
    token: '00000000-0000-4000-8000-000000000001',
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides
  };
  await writeFile(path.join(lockPath, `owner-${owner.token}.json`), JSON.stringify(owner));
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  return lockPath;
}

function stubbornSpawn(capture, { closeOnSigkill = true, errorOnSigterm = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    capture.child = child;
    capture.signals = [];
    child.kill = (signal) => {
      capture.signals.push(signal);
      if (signal === 'SIGTERM' && errorOnSigterm) {
        queueMicrotask(() => child.emit('error', new Error('kill still pending')));
      }
      if (signal === 'SIGKILL' && closeOnSigkill) {
        queueMicrotask(() => child.emit('close', null, signal));
      }
      return true;
    };
    return child;
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
      state: 'TASK_STATE_WORKING',
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

test('MarketTaskStore publishes create and update only after durable persistence succeeds', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const store = new MarketTaskStore(stateDir);
  await store.create({
    id: 'task-base',
    owner: 'owner-a',
    state: 'TASK_STATE_SUBMITTED'
  });
  const tempPath = path.join(stateDir, 'state.json.tmp');
  await mkdir(tempPath);

  await assert.rejects(store.create({
    id: 'task-retry',
    owner: 'owner-a',
    state: 'TASK_STATE_SUBMITTED'
  }));
  assert.equal(await store.get('task-retry'), null);
  await assert.rejects(store.update('task-base', (task) => ({
    ...task,
    state: 'TASK_STATE_WORKING',
    status: { ...task.status, state: 'TASK_STATE_WORKING' }
  })));
  assert.equal((await store.get('task-base')).state, 'TASK_STATE_SUBMITTED');

  await rm(tempPath, { recursive: true, force: true });
  assert.equal((await store.create({
    id: 'task-retry',
    owner: 'owner-a',
    state: 'TASK_STATE_SUBMITTED'
  })).id, 'task-retry');
});

test('MarketTaskStore rejects conflicting aliases and synchronizes accepted task states', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const store = new MarketTaskStore(stateDir);
  await assert.rejects(
    store.create({
      id: 'task-conflict',
      state: 'TASK_STATE_SUBMITTED',
      status: { state: 'TASK_STATE_WORKING' }
    }),
    (error) => error.code === 'TASK_STATE_ALIAS_MISMATCH'
  );

  const created = await store.create({
    id: 'task-alias',
    state: 'TASK_STATE_SUBMITTED'
  });
  assert.equal(created.status.state, 'TASK_STATE_SUBMITTED');
  const { status: _removed, ...withoutStatus } = created;
  const updated = await store.update('task-alias', () => ({
    ...withoutStatus,
    state: 'TASK_STATE_WORKING'
  }));
  assert.equal(updated.state, 'TASK_STATE_WORKING');
  assert.equal(updated.status.state, 'TASK_STATE_WORKING');
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

test('redaction removes quoted keys, spaced secrets, authorization variants, and URL userinfo', async (t) => {
  const secretText = [
    '"api_key": "alpha beta secret"',
    "'access-key' = 'gamma delta secret'",
    '"credentials": "client credential with spaces"',
    '"proxy_authorization": "Basic cHJveHk6c2VjcmV0"',
    'client_secret = words with spaces',
    'https://url-user:url-password@example.com/private'
  ].join('; ');
  const sanitized = JSON.stringify(sanitizeTraceValue({ message: secretText }));
  for (const secret of [
    'alpha beta secret',
    'gamma delta secret',
    'client credential with spaces',
    'cHJveHk6c2VjcmV0',
    'words with spaces',
    'url-user',
    'url-password'
  ]) {
    assert.equal(sanitized.includes(secret), false, `redaction retained ${secret}`);
  }

  const stateDir = await temporaryDirectory(t);
  const store = new MarketTaskStore(stateDir);
  const task = await store.create({
    id: 'task-redacted',
    state: 'TASK_STATE_SUBMITTED',
    detail: secretText
  });
  assert.equal(JSON.stringify(task).includes('alpha beta secret'), false);
  assert.equal((await readFile(path.join(stateDir, 'state.json'), 'utf8')).includes('url-password'), false);
});

test('sanitization bounds oversized object keys in memory and persisted state', async (t) => {
  const oversizedKey = 'oversized-key-'.repeat(80_000);
  const sanitized = sanitizeTraceValue({ [oversizedKey]: 'retained-value' });
  const serialized = JSON.stringify(sanitized);

  assert.ok(Buffer.byteLength(serialized) <= TRACE_SANITIZATION_LIMITS.maxTotalBytes);
  assert.ok(
    Object.keys(sanitized).every(
      (key) => Buffer.byteLength(key) <= TRACE_SANITIZATION_LIMITS.maxObjectKeyBytes
    )
  );
  assert.equal(serialized.includes(oversizedKey), false);
  assert.match(serialized, /object-key-length|TRUNCATED/i);

  const stateDir = await temporaryDirectory(t);
  const store = new MarketTaskStore(stateDir);
  await store.create({
    id: 'task-oversized-key',
    state: 'TASK_STATE_SUBMITTED',
    [oversizedKey]: 'retained-value'
  });
  const persisted = await readFile(path.join(stateDir, 'state.json'), 'utf8');
  assert.ok(Buffer.byteLength(persisted) <= TRACE_SANITIZATION_LIMITS.maxTotalBytes);
  assert.equal(persisted.includes(oversizedKey), false);
  assert.match(persisted, /object-key-length|TRUNCATED/i);
});

test('sanitization redacts object keys and resolves sanitized collisions deterministically', () => {
  const sensitiveKeys = [
    'contact jane.doe@example.com',
    'api_key = first credential value',
    'api_key = second credential value',
    'https://url-user:url-password@example.com/private'
  ];
  const sanitized = sanitizeTraceValue(Object.fromEntries(
    sensitiveKeys.map((key, index) => [key, `value-${index}`])
  ));
  const serialized = JSON.stringify(sanitized);

  for (const sensitive of [
    'jane.doe@example.com',
    'first credential value',
    'second credential value',
    'url-user',
    'url-password'
  ]) {
    assert.equal(serialized.includes(sensitive), false, `object key retained ${sensitive}`);
  }
  const apiKeys = Object.keys(sanitized).filter((key) => key.startsWith('api_key'));
  assert.deepEqual(apiKeys, ['api_key = [REDACTED]', 'api_key = [REDACTED]~001']);
});

test('sanitization bounds BigInt and Error content in memory and persisted state', async (t) => {
  const hugeDigits = `9${'0'.repeat(270_000)}`;
  const hugeBigInt = BigInt(hugeDigits);
  const errors = Array.from({ length: 100 }, (_, index) => {
    const error = new Error(`message-${index}-${'m'.repeat(8_000)}`);
    error.name = `ErrorName-${index}-${'n'.repeat(8_000)}`;
    error.stack = `stack-${index}-${'s'.repeat(8_000)}`;
    return error;
  });

  assert.equal(sanitizeTraceValue(42n), '42');
  const sanitizedError = sanitizeTraceValue(errors[0]);
  assert.equal(Object.hasOwn(sanitizedError, 'stack'), true);
  assert.match(JSON.stringify(sanitizedError), /TRUNCATED|_truncated|sanitization/i);

  const sanitized = sanitizeTraceValue({
    ordinaryBigInt: 42n,
    hugeBigInt,
    errors
  });
  const serialized = JSON.stringify(sanitized);
  assert.equal(sanitized.ordinaryBigInt, '42');
  assert.ok(Buffer.byteLength(sanitized.hugeBigInt) < 5_000);
  assert.ok(sanitized.errors.length < errors.length);
  assert.ok(Buffer.byteLength(serialized) < 400_000);
  assert.match(serialized, /TRUNCATED|_truncated|sanitization/i);

  const budgetProbe = sanitizeTraceValue([
    ...Array.from({ length: 65 }, () => 'x'.repeat(4_000)),
    hugeBigInt
  ]);
  assert.deepEqual(budgetProbe.at(-1), {
    _truncated: true,
    reason: 'byte-budget'
  });

  const stateDir = await temporaryDirectory(t);
  const store = new MarketTaskStore(stateDir);
  await store.create({
    id: 'task-bounded-native-values',
    state: 'TASK_STATE_SUBMITTED',
    hugeBigInt,
    errors
  });
  const persisted = await readFile(path.join(stateDir, 'state.json'), 'utf8');
  assert.ok(Buffer.byteLength(persisted) < 400_000);
  assert.equal(persisted.includes(hugeDigits), false);
  assert.match(persisted, /TRUNCATED|_truncated|sanitization/i);
});

test('sanitization preserves prototype-like keys as safe own data properties', () => {
  const malicious = JSON.parse(`{
    "__proto__": { "attackerInherited": true },
    "constructor": { "kind": "constructor" },
    "prototype": { "kind": "prototype" },
    "__defineGetter__": { "kind": "getter" },
    "hasOwnProperty": { "kind": "shadow" }
  }`);
  const sanitized = sanitizeTraceValue(malicious);

  assert.equal(Object.getPrototypeOf(sanitized), Object.prototype);
  for (const key of [
    '__proto__',
    'constructor',
    'prototype',
    '__defineGetter__',
    'hasOwnProperty'
  ]) {
    assert.equal(Object.hasOwn(sanitized, key), true, `${key} disappeared`);
  }
  assert.equal(sanitized.attackerInherited, undefined);

  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized, JSON.stringify(sanitizeTraceValue(malicious)));
  const parsed = JSON.parse(serialized);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.equal(parsed.__proto__.attackerInherited, true);
  assert.equal(Object.prototype.attackerInherited, undefined);
});

test('sanitization and RunTrace apply global depth, size, count, and lineage bounds', () => {
  const cyclic = { value: 'safe' };
  cyclic.self = cyclic;
  let deep = cyclic;
  for (let index = 0; index < 100; index += 1) deep = { child: deep };
  const sanitized = sanitizeTraceValue({
    deep,
    many: Array.from({ length: 10_000 }, (_, index) => ({ index, text: 'x'.repeat(100) }))
  });
  const serialized = JSON.stringify(sanitized);
  assert.match(serialized, /TRUNCATED|_truncated|sanitization/i);
  assert.ok(Buffer.byteLength(serialized) < 400_000);

  const trace = createRunTrace({
    conclusionLineage: Array.from(
      { length: TRACE_LIMITS.conclusionLineage * 3 },
      (_, index) => ({ conclusionId: `conclusion-${index}` })
    )
  });
  for (let index = 0; index < TRACE_LIMITS.steps * 3; index += 1) {
    const sequence = trace.startStep({ tool: `tool-${index}` });
    trace.finishStep(sequence, { status: 'ok' });
  }
  for (let index = 0; index < TRACE_LIMITS.workerEvents * 3; index += 1) {
    trace.addWorkerEvent({ method: `method-${index}` });
  }
  for (let index = 0; index < TRACE_LIMITS.modelUsage * 3; index += 1) {
    trace.addModelUsage({ totalTokens: index });
  }
  for (let index = 0; index < TRACE_LIMITS.emailAttempts * 3; index += 1) {
    trace.addEmailAttempt({ attempt: index });
  }
  const output = trace.toJSON();
  assert.ok(output.steps.length <= TRACE_LIMITS.steps);
  assert.ok(output.workerEvents.length <= TRACE_LIMITS.workerEvents);
  assert.ok(output.modelUsage.length <= TRACE_LIMITS.modelUsage);
  assert.ok(output.emailAttempts.length <= TRACE_LIMITS.emailAttempts);
  assert.ok(output.conclusionLineage.length <= TRACE_LIMITS.conclusionLineage);
  assert.match(JSON.stringify(output), /trace-truncated|TRUNCATED|_truncated/i);
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

test('acquireRunLock keeps a live same-host owner locked regardless of stale age', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const first = await acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 });
  const lockPath = path.join(stateDir, 'locks', '2026-07-23.lock');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(
    acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 }),
    (error) => error.code === 'RUN_LOCKED'
  );
  await first.release();
});

test('acquireRunLock keeps old metadata locked when its same-host PID is live', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const first = await acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 });
  const lockPath = path.join(stateDir, 'locks', '2026-07-23.lock');
  const [ownerFile] = (await readdir(lockPath)).filter((name) => name.startsWith('owner-'));
  const ownerPath = path.join(lockPath, ownerFile);
  const lock = JSON.parse(await readFile(ownerPath, 'utf8'));
  lock.acquiredAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(ownerPath, JSON.stringify(lock));

  await assert.rejects(
    acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 }),
    (error) => error.code === 'RUN_LOCKED'
  );
  await first.release();
});

test('acquireRunLock recovers only a stale, provably dead same-host owner', async (t) => {
  const stateDir = await temporaryDirectory(t);
  await createStaleOwner(stateDir, '2026-07-23');
  const lock = await acquireRunLock({
    stateDir,
    reportDate: '2026-07-23',
    staleMs: 1_000
  });
  await lock.release();
});

test('concurrent stale recovery never grants two owners', async (t) => {
  const stateDir = await temporaryDirectory(t);
  await createStaleOwner(stateDir, '2026-07-23');
  const results = await Promise.allSettled([
    acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 }),
    acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 })
  ]);
  const acquired = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(
    acquired.length,
    1,
    rejected.map((result) => `${result.reason.code}: ${result.reason.message}`).join('\n')
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'RUN_LOCKED');
  await acquired[0].value.release();
});

test('stale recovery never removes a live replacement owner record', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const lockPath = await createStaleOwner(stateDir, '2026-07-23');
  const liveToken = '00000000-0000-4000-8000-000000000002';
  const liveOwnerPath = path.join(lockPath, `owner-${liveToken}.json`);
  await writeFile(liveOwnerPath, JSON.stringify({
    schemaVersion: '1.0',
    reportDate: '2026-07-23',
    pid: process.pid,
    hostname: os.hostname(),
    token: liveToken,
    acquiredAt: new Date(Date.now() - 60_000).toISOString()
  }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(
    acquireRunLock({ stateDir, reportDate: '2026-07-23', staleMs: 1_000 }),
    (error) => error.code === 'RUN_LOCKED'
  );
  assert.equal((await stat(liveOwnerPath)).isFile(), true);
});

test('acquireRunLock rejects impossible calendar dates', async (t) => {
  const stateDir = await temporaryDirectory(t);
  await assert.rejects(
    acquireRunLock({ stateDir, reportDate: '2026-02-30', staleMs: 1_000 }),
    /real calendar date/
  );
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
      spawnImpl: fakeSpawn((child) => completeChild(child, {
        stdout: JSON.stringify({ ...evidencePack, schemaVersion: 1 })
      }))
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

test('runMarketWorker rejects non-worker operations before spawning Python', async (t) => {
  const stateDir = await temporaryDirectory(t);
  for (const operation of [
    'hot-topic-analysis',
    'sell-pressure-scan',
    'potential-watchlist',
    'inspect-run-trace'
  ]) {
    let spawnCount = 0;
    assert.throws(
      () => runMarketWorker({
        request: { operation },
        config: workerConfig(stateDir),
        spawnImpl: () => {
          spawnCount += 1;
        }
      }),
      (error) => error.code === 'WORKER_OPERATION_UNSUPPORTED'
    );
    assert.equal(spawnCount, 0);
  }
});

test('runMarketWorker stops a stderr chunk after malformed TRACE JSON', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const traces = [];
  await assert.rejects(
    runMarketWorker({
      request: { operation: 'daily-market-report' },
      config: workerConfig(stateDir),
      spawnImpl: fakeSpawn((child) => completeChild(child, {
        stderr: 'TRACE {bad-json}\nTRACE {"type":"must-not-run"}\n'
      })),
      onTrace: (event) => traces.push(event)
    }),
    (error) => error.code === 'WORKER_PROTOCOL_ERROR'
  );
  assert.deepEqual(traces, []);
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

test('runMarketWorker escalates ignored SIGTERM and cleans listeners before rejecting', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const capture = {};
  await assert.rejects(
    runMarketWorker({
      request: { operation: 'daily-market-report' },
      config: workerConfig(stateDir, {
        workerTimeoutMs: 5,
        workerTerminationGraceMs: 5,
        workerCleanupTimeoutMs: 10
      }),
      spawnImpl: stubbornSpawn(capture, { errorOnSigterm: true })
    }),
    (error) => error.code === 'WORKER_TIMEOUT'
  );
  assert.deepEqual(capture.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(capture.child.listenerCount('close'), 0);
  assert.equal(capture.child.stdout.listenerCount('data'), 0);
  assert.equal(capture.child.stdout.destroyed, true);
  assert.equal(capture.child.stderr.destroyed, true);
  assert.equal(capture.child.stdin.destroyed, true);
});

test('runMarketWorker has a final cleanup deadline when both signals are ignored', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const capture = {};
  await assert.rejects(
    runMarketWorker({
      request: { operation: 'daily-market-report' },
      config: workerConfig(stateDir, {
        workerTimeoutMs: 5,
        workerTerminationGraceMs: 5,
        workerCleanupTimeoutMs: 10
      }),
      spawnImpl: stubbornSpawn(capture, { closeOnSigkill: false })
    }),
    (error) => error.code === 'WORKER_TIMEOUT'
  );
  assert.deepEqual(capture.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(capture.child.listenerCount('close'), 0);
});
