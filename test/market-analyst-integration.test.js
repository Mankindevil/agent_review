import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MarketOrchestrator } from '../agents/market-analyst/orchestrator.js';
import { MarketTaskStore } from '../agents/market-analyst/task-store.js';
import { parseCliArgs, runCli } from '../agents/market-analyst/cli.js';

const date = '2026-07-23';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'market-orchestrator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function evidence(overrides = {}) {
  return {
    schemaVersion: '1.0',
    runId: 'injected-by-worker',
    reportDate: date,
    status: 'complete',
    markets: {},
    conclusions: [],
    leaderboards: {},
    sources: [],
    missingData: [],
    ...overrides
  };
}

function dependencies(stateDir, overrides = {}) {
  const calls = {
    worker: 0,
    narrator: 0,
    renderer: 0,
    validator: 0,
    mailer: []
  };
  const worker = async ({ request }) => {
    calls.worker += 1;
    return evidence({ runId: request.runId, reportDate: request.date });
  };
  const narrator = async () => {
    calls.narrator += 1;
    return { sections: [], fallbackReason: 'model disabled', usage: { totalTokens: 0 } };
  };
  const renderer = () => {
    calls.renderer += 1;
    return {
      markdown: '# deterministic report',
      html: '<h1>deterministic report</h1>',
      text: 'deterministic report'
    };
  };
  const validator = () => {
    calls.validator += 1;
    return { valid: true };
  };
  const mailer = {
    async send(message, options) {
      calls.mailer.push({ message, options });
      await options?.onAttempt?.({
        attempt: 1,
        status: 'sent',
        startedAt: '2026-07-24T10:30:00.000Z',
        endedAt: '2026-07-24T10:30:00.010Z',
        durationMs: 10,
        acceptedCount: 1,
        rejectedCount: 0,
        messageId: '<stable@market-analyst.local>'
      });
      return {
        status: 'sent',
        deliveryKey: 'delivery-hash',
        messageId: '<stable@market-analyst.local>',
        attemptCount: 1
      };
    }
  };
  const config = {
    stateDir,
    timezone: 'Asia/Shanghai',
    publicBaseUrl: 'https://reports.example.test',
    model: { enabled: false },
    email: {
      from: 'reports@example.com',
      to: ['private.recipient@example.com'],
      sendFailureAlerts: true
    },
    smtp: { host: 'smtp.example.com' },
    python: 'python-test',
    workerTimeoutMs: 1_000,
    minLiquidityCny: 20_000_000,
    cacheDays: 30
  };
  return {
    calls,
    config,
    deps: {
      store: new MarketTaskStore({ stateDir }),
      worker,
      narrator,
      renderer,
      validator,
      mailer,
      clock: () => new Date('2026-07-24T10:30:00.000Z'),
      createId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })(),
      ...overrides
    }
  };
}

function request(overrides = {}) {
  return {
    operation: { operation: 'daily-market-report', date },
    trigger: 'scheduled',
    owner: 'scheduler',
    deliverEmail: true,
    forceDelivery: false,
    ...overrides
  };
}

test('successful report plus email failure retries email only from persisted artifacts', async (t) => {
  const stateDir = await temporaryDirectory(t);
  let failDelivery = true;
  const fixture = dependencies(stateDir, {
    mailer: {
      async send(message, options) {
        fixture.calls.mailer.push({ message, options });
        const attempt = {
          attempt: 1,
          status: failDelivery ? 'failed' : 'sent',
          startedAt: '2026-07-24T10:30:00.000Z',
          endedAt: '2026-07-24T10:30:00.010Z',
          durationMs: 10,
          acceptedCount: failDelivery ? 0 : 1,
          rejectedCount: 0,
          messageId: '<stable@market-analyst.local>'
        };
        await options.onAttempt(attempt);
        if (failDelivery) {
          const error = new Error('SMTP unavailable');
          error.code = 'SMTP_DELIVERY_FAILED';
          error.receipt = { status: 'failed', attemptCount: 1, attempts: [attempt] };
          throw error;
        }
        return {
          status: 'sent',
          deliveryKey: 'delivery-hash',
          messageId: '<stable@market-analyst.local>',
          attemptCount: 1
        };
      }
    }
  });
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);

  const first = await orchestrator.run(request());
  assert.equal(first.outcome, 'complete');
  assert.equal(first.emailStatus, 'failed');
  assert.equal(fixture.calls.worker, 1);
  failDelivery = false;
  const retry = await orchestrator.run(request());
  assert.equal(retry.outcome, 'complete');
  assert.equal(retry.emailStatus, 'sent');
  assert.equal(retry.runId, first.runId);
  assert.equal(fixture.calls.worker, 1);
  assert.equal(fixture.calls.mailer.length, 2);

  const runDirectory = path.join(stateDir, 'runs', '20260723', first.runId);
  for (const file of [
    'market-report.md',
    'market-report.html',
    'evidence-pack.json',
    'run-trace.json'
  ]) {
    assert.equal((await stat(path.join(runDirectory, file))).isFile(), true);
  }
  const trace = JSON.parse(await readFile(path.join(runDirectory, 'run-trace.json'), 'utf8'));
  assert.equal(trace.emailAttempts.length, 2);
  assert.doesNotMatch(JSON.stringify(trace), /private\.recipient@example\.com/);
});

test('confirmed scheduled delivery is not duplicated and force delivery reuses artifacts', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir);
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);

  const first = await orchestrator.run(request());
  const duplicate = await orchestrator.run(request());
  const forced = await orchestrator.run(request({ forceDelivery: true }));

  assert.equal(first.emailStatus, 'sent');
  assert.equal(duplicate.emailStatus, 'already-sent');
  assert.equal(forced.emailStatus, 'sent');
  assert.equal(fixture.calls.worker, 1);
  assert.equal(fixture.calls.mailer.length, 2);
});

test('worker-reported non-trading day is skipped without rendering or email', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir, {
    worker: async ({ request: workerRequest }) => {
      fixture.calls.worker += 1;
      return evidence({
        runId: workerRequest.runId,
        reportDate: workerRequest.date,
        status: 'skipped',
        skipReason: 'Panda SH calendar reports a non-trading day'
      });
    }
  });
  const result = await new MarketOrchestrator(fixture.config, fixture.deps).run(request());

  assert.equal(result.outcome, 'skipped');
  assert.equal(result.emailStatus, 'not-requested');
  assert.equal(fixture.calls.renderer, 0);
  assert.equal(fixture.calls.mailer.length, 0);
});

test('optional-source degradation is delivered with an explicit subject prefix', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir, {
    worker: async ({ request: workerRequest }) => {
      fixture.calls.worker += 1;
      return evidence({
        runId: workerRequest.runId,
        reportDate: workerRequest.date,
        status: 'degraded',
        missingData: [{
          section: 'us',
          method: 'get_us_daily',
          reason: 'OPTIONAL_SOURCE_FAILED'
        }]
      });
    }
  });
  const result = await new MarketOrchestrator(fixture.config, fixture.deps).run(request());

  assert.equal(result.outcome, 'degraded');
  assert.match(fixture.calls.mailer[0].message.subject, /^\[数据降级\]/);
});

test('core failure sends no conclusions and makes one best-effort alert attempt', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir, {
    worker: async () => {
      fixture.calls.worker += 1;
      const error = new Error('A-share core unavailable for private.recipient@example.com');
      error.code = 'CORE_DATA_FAILED';
      throw error;
    }
  });
  const result = await new MarketOrchestrator(fixture.config, fixture.deps).run(request());

  assert.equal(result.outcome, 'failed');
  assert.equal(fixture.calls.renderer, 0);
  assert.equal(fixture.calls.mailer.length, 1);
  assert.equal(fixture.calls.mailer[0].message.maxAttempts, 1);
  assert.match(fixture.calls.mailer[0].message.subject, /运行失败/);
  assert.doesNotMatch(fixture.calls.mailer[0].message.text, /market conclusion|deterministic report/i);
  assert.doesNotMatch(JSON.stringify(result), /private\.recipient@example\.com/);
});

test('model failure falls back to the deterministic report without degrading data status', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir, {
    narrator: async () => {
      fixture.calls.narrator += 1;
      throw new Error('model unavailable');
    }
  });
  const result = await new MarketOrchestrator(fixture.config, fixture.deps).run(request());

  assert.equal(result.outcome, 'complete');
  assert.equal(result.modelFallback, true);
  assert.equal(fixture.calls.renderer, 1);
  assert.equal(fixture.calls.validator, 1);
  assert.equal(fixture.calls.mailer[0].message.text, 'deterministic report');
});

test('A2A and explicit no-email intent cannot be overridden by config or caller injection', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir);
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);
  const a2a = await orchestrator.run(request({
    trigger: 'a2a',
    deliverEmail: true
  }));
  assert.equal(a2a.emailStatus, 'not-requested');
  assert.equal(fixture.calls.mailer.length, 0);

  const noEmail = await orchestrator.run(request({
    operation: { operation: 'daily-market-report', date: '2026-07-22' },
    deliverEmail: false
  }));
  assert.equal(noEmail.emailStatus, 'not-requested');
  assert.equal(fixture.calls.mailer.length, 0);

  const rejected = await orchestrator.run({
    ...request({ operation: { operation: 'daily-market-report', date: '2026-07-21' } }),
    recipients: ['attacker@example.com'],
    smtp: { host: 'attacker.example.com' },
    artifactPath: '../../outside'
  });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(fixture.calls.mailer.length, 0);

  const rejectedAlias = await orchestrator.run({
    ...request({ operation: { operation: 'daily-market-report', date: '2026-07-20' } }),
    smtpHost: 'attacker.example.com'
  });
  assert.equal(rejectedAlias.outcome, 'rejected');
  assert.equal(fixture.calls.mailer.length, 0);
});

test('one-shot CLI parses only the declared date and delivery flags', () => {
  assert.deepEqual(parseCliArgs([]), {
    date: undefined,
    deliverEmail: true,
    forceDelivery: false
  });
  assert.deepEqual(parseCliArgs([
    '--date', '2026-07-23', '--force-delivery', '--no-email'
  ]), {
    date: '2026-07-23',
    deliverEmail: false,
    forceDelivery: true
  });
  assert.throws(() => parseCliArgs(['--smtp-host', 'attacker.example.com']), /unknown/i);
  assert.throws(() => parseCliArgs(['--date', '../../secret']), /YYYY-MM-DD/i);
  assert.throws(
    () => parseCliArgs(['--date', '2026-07-23', '--date', '2026-07-22']),
    /duplicate/i
  );
});

test('one-shot CLI prints one sanitized JSON summary and maps terminal exit codes', async () => {
  const lines = [];
  let orchestratorRequest;
  const code = await runCli(['--date', date, '--force-delivery'], {
    env: { MARKET_REPORT_SMTP_PASSWORD: 'must-not-print' },
    cwd: 'C:\\repo',
    stdout: { write: (value) => lines.push(value) },
    orchestratorFactory: () => ({
      async run(value) {
        orchestratorRequest = value;
        return {
          outcome: 'degraded',
          runId: 'run-cli',
          reportDate: date,
          emailStatus: 'sent'
        };
      }
    })
  });

  assert.equal(code, 0);
  assert.deepEqual(orchestratorRequest.operation, {
    operation: 'daily-market-report',
    date
  });
  assert.equal(orchestratorRequest.trigger, 'scheduled');
  assert.equal(orchestratorRequest.deliverEmail, true);
  assert.equal(orchestratorRequest.forceDelivery, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].endsWith('\n'), true);
  assert.equal(JSON.parse(lines[0]).runId, 'run-cli');
  assert.doesNotMatch(lines[0], /must-not-print/);

  const canceled = await runCli(['--no-email'], {
    stdout: { write() {} },
    orchestratorFactory: () => ({
      run: async () => ({ outcome: 'canceled' })
    })
  });
  assert.equal(canceled, 130);
});
