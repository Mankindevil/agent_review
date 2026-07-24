import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MarketOrchestrator } from '../agents/market-analyst/orchestrator.js';
import { MarketTaskStore } from '../agents/market-analyst/task-store.js';
import { parseCliArgs, runCli } from '../agents/market-analyst/cli.js';
import { createMarketAgentServer } from '../agents/market-analyst/a2a-server.js';
import { ownerScope } from '../agents/market-analyst/owner-scope.js';
import {
  createSmtpMailer,
  deliveryKey
} from '../agents/market-analyst/smtp-mailer.js';

const date = '2026-07-23';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'market-orchestrator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function evidence(overrides = {}) {
  return {
    schemaVersion: '1.0',
    evidenceModelVersion: '2.0',
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
      const key = deliveryKey(
        message.reportDate,
        config.email.to,
        message.reportVersion
      );
      const messageId = `<market-report.${
        createHash('sha256').update(key).digest('hex')
      }@market-analyst.local>`;
      await options?.onAttempt?.({
        attempt: 1,
        status: 'sent',
        startedAt: '2026-07-24T10:30:00.000Z',
        endedAt: '2026-07-24T10:30:00.010Z',
        durationMs: 10,
        acceptedCount: 1,
        rejectedCount: 0,
        deliveryKey: key,
        messageId
      });
      return {
        status: 'sent',
        deliveryKey: key,
        messageId,
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
  assert.equal(
    fixture.calls.mailer[1].message.text,
    fixture.calls.mailer[0].message.text
  );
  assert.equal(
    fixture.calls.mailer[1].message.html,
    fixture.calls.mailer[0].message.html
  );
  assert.equal(
    fixture.calls.mailer[1].message.reportVersion,
    fixture.calls.mailer[0].message.reportVersion
  );

  const runDirectory = path.join(stateDir, 'runs', '20260723', first.runId);
  for (const file of [
    'market-report.md',
    'market-report.html',
    'market-report.txt',
    'evidence-pack.json',
    'run-trace.json'
  ]) {
    assert.equal((await stat(path.join(runDirectory, file))).isFile(), true);
  }
  const trace = JSON.parse(await readFile(path.join(runDirectory, 'run-trace.json'), 'utf8'));
  assert.equal(trace.emailAttempts.length, 2);
  assert.doesNotMatch(JSON.stringify(trace), /private\.recipient@example\.com/);
});

test('caller abort after narrative resolution cancels before render, persist, or email', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const controller = new AbortController();
  const fixture = dependencies(stateDir, {
    narrator: async () => {
      fixture.calls.narrator += 1;
      controller.abort(new Error('caller canceled during narrative'));
      return { sections: [], fallbackReason: 'provider fallback must not win' };
    }
  });
  const result = await new MarketOrchestrator(fixture.config, fixture.deps).run(request({
    signal: controller.signal
  }));

  assert.equal(result.outcome, 'canceled');
  assert.equal(fixture.calls.renderer, 0);
  assert.equal(fixture.calls.validator, 0);
  assert.equal(fixture.calls.mailer.length, 0);
  const task = (await fixture.deps.store.list())[0];
  assert.equal(task.status.state, 'TASK_STATE_CANCELED');
});

test('caller abort at delivery preserves completed report artifacts', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const controller = new AbortController();
  const fixture = dependencies(stateDir, {
    mailer: {
      async send(_message, { signal }) {
        controller.abort(new Error('caller canceled before SMTP'));
        assert.equal(signal.aborted, true);
        throw signal.reason;
      }
    }
  });
  const result = await new MarketOrchestrator(fixture.config, fixture.deps).run(request({
    signal: controller.signal
  }));

  assert.equal(result.outcome, 'canceled');
  assert.equal(result.emailStatus, 'canceled');
  const task = (await fixture.deps.store.list())[0];
  assert.equal(task.outcome, 'complete');
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.artifactsReady, true);
  assert.equal(task.email.status, 'canceled');
  assert.equal(task.artifacts.some(({ name }) => name === 'market-report.txt'), true);
});

test('accepted SMTP settlement after cancellation is persisted and suppresses automatic resend', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const controller = new AbortController();
  const fixture = dependencies(stateDir);
  let sends = 0;
  let resolveSend;
  fixture.deps.mailer = createSmtpMailer(fixture.config, {
    createTransport: () => ({
      sendMail(message) {
        sends += 1;
        queueMicrotask(() => controller.abort(new Error('scheduler stopped')));
        return new Promise((resolve) => {
          resolveSend = () => resolve({
            response: '250 accepted after close',
            accepted: message.to,
            rejected: []
          });
        });
      },
      close() {
        resolveSend();
      }
    }),
    setReconciliationTimer: () => 1,
    clearReconciliationTimer: () => {},
    wait: async () => {},
    jitter: () => 0
  });
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);

  const first = await orchestrator.run(request({ signal: controller.signal }));
  assert.equal(first.outcome, 'complete');
  assert.equal(first.emailStatus, 'reconciliation-needed');
  const persisted = (await fixture.deps.store.list())[0];
  assert.equal(persisted.email.receipt.status, 'reconciliation-needed');
  assert.equal(persisted.email.attempts[0].status, 'sent');
  assert.equal(persisted.email.attempts[0].canceledAfterAcceptance, true);

  const duplicate = await orchestrator.run(request());
  assert.equal(duplicate.emailStatus, 'reconciliation-needed');
  assert.equal(sends, 1);
});

test('unknown SMTP settlement after cancellation is persisted and suppresses automatic resend', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const controller = new AbortController();
  const fixture = dependencies(stateDir);
  let sends = 0;
  fixture.deps.mailer = createSmtpMailer(fixture.config, {
    createTransport: () => ({
      sendMail() {
        sends += 1;
        queueMicrotask(() => controller.abort(new Error('scheduler stopped')));
        return new Promise(() => {});
      },
      close() {}
    }),
    setReconciliationTimer: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearReconciliationTimer: () => {},
    wait: async () => {},
    jitter: () => 0
  });
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);

  const first = await orchestrator.run(request({ signal: controller.signal }));
  assert.equal(first.outcome, 'canceled');
  assert.equal(first.emailStatus, 'reconciliation-needed');
  const persisted = (await fixture.deps.store.list())[0];
  assert.equal(persisted.email.receipt.status, 'reconciliation-needed');
  assert.equal(persisted.email.attempts[0].status, 'delivery-unknown');

  const duplicate = await orchestrator.run(request());
  assert.equal(duplicate.emailStatus, 'reconciliation-needed');
  assert.equal(sends, 1);
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

test('report reuse requires an exact persisted owner scope', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir);
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);

  const ownerA = await orchestrator.run(request({
    owner: 'tenant-owner-a',
    trigger: 'a2a',
    deliverEmail: false
  }));
  const ownerB = await orchestrator.run(request({
    owner: 'tenant-owner-b',
    trigger: 'a2a',
    deliverEmail: false
  }));

  assert.notEqual(ownerA.runId, ownerB.runId);
  assert.equal(fixture.calls.worker, 2);
  const persisted = await fixture.deps.store.list();
  assert.equal(persisted.length, 2);
  assert.match(persisted[0].ownerScope, /^owner-sha256:[a-f0-9]{64}$/);
  assert.match(persisted[1].ownerScope, /^owner-sha256:[a-f0-9]{64}$/);
  assert.notEqual(persisted[0].ownerScope, persisted[1].ownerScope);
});

test('advertised analytical operations map only the trusted worker boundary to daily collection', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const workerRequests = [];
  const fixture = dependencies(stateDir, {
    async worker({ request: workerRequest }) {
      fixture.calls.worker += 1;
      workerRequests.push(workerRequest);
      return evidence({
        runId: workerRequest.runId,
        reportDate: workerRequest.date,
        leaderboards: {
          hotIndustries: [],
          hotConcepts: [],
          sellPressure: [],
          potentialWatchlist: []
        }
      });
    }
  });
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);
  const operations = [
    'hot-topic-analysis',
    'sell-pressure-scan',
    'potential-watchlist'
  ];

  for (const operation of operations) {
    const result = await orchestrator.run(request({
      operation: { operation, date },
      trigger: 'a2a',
      owner: `owner-${operation}`,
      deliverEmail: false
    }));
    assert.equal(result.outcome, 'complete', operation);
  }

  assert.deepEqual(
    workerRequests.map(({ operation }) => operation),
    ['daily-market-report', 'daily-market-report', 'daily-market-report']
  );
  const persisted = await fixture.deps.store.list();
  assert.deepEqual(
    persisted.map(({ operation }) => operation),
    operations
  );
  assert.deepEqual(
    persisted.map(({ requestedOperation }) => requestedOperation),
    operations
  );
});

test('accepted attempt without a final receipt suppresses automatic crash-window resend', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir);
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);
  await orchestrator.run(request());
  const [delivered] = await fixture.deps.store.list();
  const expectedKey = deliveryKey(
    delivered.reportDate,
    fixture.config.email.to,
    delivered.reportVersion
  );
  const expectedMessageId = `<market-report.${
    createHash('sha256').update(expectedKey).digest('hex')
  }@market-analyst.local>`;
  await fixture.deps.store.update(delivered.id, (current) => {
    const email = {
      ...current.email,
      status: 'sent',
      attempts: current.email.attempts.map((attempt) => ({
        ...attempt,
        deliveryKey: expectedKey,
        messageId: expectedMessageId
      }))
    };
    delete email.receipt;
    return { ...current, email };
  });

  const byStatus = await orchestrator.run(request());
  assert.equal(byStatus.emailStatus, 'reconciliation-needed');
  assert.equal(fixture.calls.mailer.length, 1);
  assert.equal(fixture.calls.worker, 1);

  await fixture.deps.store.update(delivered.id, (current) => ({
    ...current,
    email: { ...current.email, status: 'failed' }
  }));
  const byAcceptedAttempt = await orchestrator.run(request());
  assert.equal(byAcceptedAttempt.emailStatus, 'reconciliation-needed');
  assert.equal(fixture.calls.mailer.length, 1);
  assert.equal(fixture.calls.worker, 1);
});

test('recipient identity change sends once to the new recipient and then deduplicates', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir);
  const deliveries = [];
  const mailerFor = (config) => createSmtpMailer(config, {
    createTransport: () => ({
      async sendMail(message) {
        deliveries.push(message);
        return {
          accepted: [message.to[0]],
          rejected: [],
          messageId: message.messageId,
          response: '250 queued'
        };
      }
    }),
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 6, 24, 10, 30, tick++));
    })()
  });
  const firstConfig = {
    ...fixture.config,
    email: {
      ...fixture.config.email,
      to: ['recipient-a@example.test']
    },
    smtp: {
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      username: '',
      password: ''
    }
  };
  const first = new MarketOrchestrator(firstConfig, {
    ...fixture.deps,
    mailer: mailerFor(firstConfig)
  });
  const sentA = await first.run(request());
  assert.equal(sentA.emailStatus, 'sent');

  const secondConfig = {
    ...firstConfig,
    email: {
      ...firstConfig.email,
      to: ['recipient-b@example.test']
    }
  };
  const freshDependencies = {
    ...fixture.deps,
    store: new MarketTaskStore({ stateDir }),
    mailer: mailerFor(secondConfig)
  };
  const second = new MarketOrchestrator(secondConfig, freshDependencies);
  const sentB = await second.run(request());
  assert.equal(sentB.runId, sentA.runId);
  assert.equal(sentB.emailStatus, 'sent');
  const replayB = await new MarketOrchestrator(secondConfig, {
    ...freshDependencies,
    store: new MarketTaskStore({ stateDir })
  }).run(request());
  assert.equal(replayB.emailStatus, 'already-sent');
  assert.deepEqual(deliveries.map(({ to }) => to), [
    ['recipient-a@example.test'],
    ['recipient-b@example.test']
  ]);
  assert.notEqual(deliveries[0].messageId, deliveries[1].messageId);
});

test('email-only retry rejects tampered report artifacts before calling SMTP', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir, {
    mailer: {
      async send(message, options) {
        fixture.calls.mailer.push({ message, options });
        const attempt = {
          attempt: 1,
          status: 'failed',
          startedAt: '2026-07-24T10:30:00.000Z',
          endedAt: '2026-07-24T10:30:00.010Z',
          durationMs: 10,
          acceptedCount: 0,
          rejectedCount: 0,
          messageId: '<stable@market-analyst.local>'
        };
        await options.onAttempt(attempt);
        const error = new Error('SMTP unavailable');
        error.code = 'SMTP_DELIVERY_FAILED';
        error.receipt = { status: 'failed', attemptCount: 1, attempts: [attempt] };
        throw error;
      }
    }
  });
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);
  const first = await orchestrator.run(request());
  const htmlPath = path.join(
    stateDir, 'runs', '20260723', first.runId, 'market-report.html'
  );
  await writeFile(htmlPath, '<h1>tampered report</h1>', 'utf8');

  await assert.rejects(
    orchestrator.run(request()),
    (error) => error.code === 'ARTIFACT_INTEGRITY_FAILED'
  );
  assert.equal(fixture.calls.mailer.length, 1);
  assert.equal(fixture.calls.worker, 1);
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

test('model-internal AbortError is fallback unless the caller signal is aborted', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const fixture = dependencies(stateDir, {
    narrator: async () => {
      fixture.calls.narrator += 1;
      const error = new Error('model request deadline');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      throw error;
    }
  });
  const result = await new MarketOrchestrator(fixture.config, fixture.deps).run(request());

  assert.equal(result.outcome, 'complete');
  assert.equal(result.modelFallback, true);
  assert.equal(fixture.calls.renderer, 1);
  assert.equal(fixture.calls.mailer.length, 1);
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
    env: {
      MARKET_AGENT_ACCESS_TOKEN: 'scheduled-access',
      MARKET_AGENT_PRINCIPAL_ID: 'stable-scheduled-principal',
      MARKET_REPORT_SMTP_PASSWORD: 'must-not-print'
    },
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
  assert.equal(
    orchestratorRequest.ownerScope,
    ownerScope('market-agent-principal:stable-scheduled-principal')
  );
  assert.equal('owner' in orchestratorRequest, false);
  assert.equal(orchestratorRequest.deliverEmail, true);
  assert.equal(orchestratorRequest.forceDelivery, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].endsWith('\n'), true);
  assert.equal(JSON.parse(lines[0]).runId, 'run-cli');
  assert.doesNotMatch(lines[0], /must-not-print/);
  assert.doesNotMatch(lines[0], /scheduled-access/);

  const canceled = await runCli(['--no-email'], {
    stdout: { write() {} },
    orchestratorFactory: () => ({
      run: async () => ({ outcome: 'canceled' })
    })
  });
  assert.equal(canceled, 130);

  const emailFailureLines = [];
  const emailFailure = await runCli([], {
    stdout: { write: (value) => emailFailureLines.push(value) },
    orchestratorFactory: () => ({
      run: async () => ({
        outcome: 'complete',
        runId: 'run-email-failed',
        reportDate: date,
        emailStatus: 'failed',
        error: { message: 'recipient private.recipient@example.com rejected' }
      })
    })
  });
  assert.equal(emailFailure, 1);
  assert.equal(JSON.parse(emailFailureLines[0]).outcome, 'complete');
  assert.doesNotMatch(emailFailureLines[0], /private\.recipient@example\.com/);
});

test('scheduled CLI run is visible to its configured Bearer owner with linked detail', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const originalToken = 'scheduled-detail-token';
  const rotatedToken = 'rotated-detail-token';
  const principalId = 'stable-report-owner';
  let detailUrl;
  const fixture = dependencies(stateDir, {
    renderer: (evidenceValue) => {
      detailUrl = evidenceValue.detailUrl;
      return {
        markdown: `# report\n\n${detailUrl}`,
        html: `<a href="${detailUrl}">detail</a>`,
        text: `detail: ${detailUrl}`
      };
    }
  });
  fixture.config.accessToken = originalToken;
  fixture.config.principalId = principalId;
  fixture.config.publicBaseUrl = 'https://reports.example.test';
  const orchestrator = new MarketOrchestrator(fixture.config, fixture.deps);
  const lines = [];
  const code = await runCli(['--date', date], {
    env: {
      MARKET_AGENT_ACCESS_TOKEN: originalToken,
      MARKET_AGENT_PRINCIPAL_ID: principalId
    },
    stdout: { write: (value) => lines.push(value) },
    orchestratorFactory: () => orchestrator
  });
  assert.equal(code, 0);
  const summary = JSON.parse(lines[0]);
  assert.equal(detailUrl, `https://reports.example.test/runs/${summary.runId}`);
  assert.equal(fixture.calls.mailer[0].message.html.includes(detailUrl), true);
  const persistedState = await readFile(path.join(stateDir, 'state.json'), 'utf8');
  assert.doesNotMatch(persistedState, new RegExp(originalToken));
  assert.doesNotMatch(persistedState, new RegExp(rotatedToken));

  const server = createMarketAgentServer({
    config: { ...fixture.config, accessToken: rotatedToken },
    orchestrator
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const own = await fetch(`http://127.0.0.1:${port}/runs/${summary.runId}`, {
    headers: { Authorization: `Bearer ${rotatedToken}` }
  });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).runId, summary.runId);
  const wrong = await fetch(`http://127.0.0.1:${port}/runs/${summary.runId}`, {
    headers: { Authorization: `Bearer ${originalToken}` }
  });
  assert.equal(wrong.status, 401);
  await new Promise((resolve) => server.close(resolve));

  const isolated = createMarketAgentServer({
    config: {
      ...fixture.config,
      accessToken: rotatedToken,
      principalId: 'intentionally-isolated-owner'
    },
    orchestrator
  });
  await new Promise((resolve) => isolated.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => isolated.close(resolve)));
  const isolatedResponse = await fetch(
    `http://127.0.0.1:${isolated.address().port}/runs/${summary.runId}`,
    { headers: { Authorization: `Bearer ${rotatedToken}` } }
  );
  assert.equal(isolatedResponse.status, 404);
});

test('one-shot CLI maps SIGTERM cancellation to 130 and removes both handlers', async () => {
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  const codePromise = runCli([], {
    stdout: { write() {} },
    orchestratorFactory: () => ({
      run: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ outcome: 'canceled' }), {
          once: true
        });
        queueMicrotask(() => process.emit('SIGTERM'));
      })
    })
  });
  assert.equal(await codePromise, 130);
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
});

test('verified artifact reader rejects containment, symlink, replacement, growth, and hash violations', async () => {
  const { readVerifiedArtifact } = await import(
    '../agents/market-analyst/orchestrator.js'
  );
  assert.equal(typeof readVerifiedArtifact, 'function');
  const regular = {
    isFile: () => true,
    isSymbolicLink: () => false,
    dev: 1,
    ino: 2,
    size: 4
  };
  const readBytes = (value) => {
    const source = Buffer.from(value);
    let position = 0;
    return async (buffer, offset, length) => {
      const bytesRead = Math.min(length, source.length - position);
      if (bytesRead > 0) {
        source.copy(buffer, offset, position, position + bytesRead);
        position += bytesRead;
      }
      return { bytesRead, buffer };
    };
  };
  const calls = { open: 0 };
  const symlinkFs = {
    lstat: async () => ({ ...regular, isSymbolicLink: () => true }),
    realpath: async (value) => value,
    open: async () => {
      calls.open += 1;
      throw new Error('must not open');
    }
  };
  await assert.rejects(
    readVerifiedArtifact('C:\\safe\\report.txt', {
      root: 'C:\\safe',
      maximum: 100,
      expectedSize: 4,
      expectedSha256: 'unused'
    }, symlinkFs),
    (error) => error.code === 'ARTIFACT_INTEGRITY_FAILED'
  );
  assert.equal(calls.open, 0);

  await assert.rejects(
    readVerifiedArtifact('C:\\outside\\report.txt', {
      root: 'C:\\safe',
      maximum: 100,
      expectedSize: 4,
      expectedSha256: 'unused'
    }, symlinkFs),
    (error) => error.code === 'ARTIFACT_INTEGRITY_FAILED'
  );

  let handleStat = 0;
  const replacementFs = {
    lstat: async () => regular,
    realpath: async (value) => value,
    open: async () => ({
      stat: async () => {
        handleStat += 1;
        return handleStat === 1 ? regular : { ...regular, size: 5 };
      },
      read: readBytes('safe'),
      close: async () => {}
    })
  };
  await assert.rejects(
    readVerifiedArtifact('C:\\safe\\report.txt', {
      root: 'C:\\safe',
      maximum: 100,
      expectedSize: 4,
      expectedSha256: 'unused'
    }, replacementFs),
    (error) => error.code === 'ARTIFACT_INTEGRITY_FAILED'
  );

  const replacedPathFs = {
    ...replacementFs,
    lstat: (() => {
      let count = 0;
      return async () => ({ ...regular, ino: count++ === 0 ? 2 : 3 });
    })(),
    open: async () => ({
      stat: async () => regular,
      read: readBytes('safe'),
      close: async () => {}
    })
  };
  await assert.rejects(
    readVerifiedArtifact('C:\\safe\\report.txt', {
      root: 'C:\\safe',
      maximum: 100,
      expectedSize: 4,
      expectedSha256: 'unused'
    }, replacedPathFs),
    (error) => error.code === 'ARTIFACT_INTEGRITY_FAILED'
  );

  const stableFs = {
    lstat: async () => regular,
    realpath: async (value) => value,
    open: async () => ({
      stat: async () => regular,
      read: readBytes('safe'),
      close: async () => {}
    })
  };
  await assert.rejects(
    readVerifiedArtifact('C:\\safe\\report.txt', {
      root: 'C:\\safe',
      maximum: 100,
      expectedSize: 4,
      expectedSha256: createHash('sha256').update('different').digest('hex')
    }, stableFs),
    (error) => error.code === 'ARTIFACT_INTEGRITY_FAILED'
  );
});

test('verified artifact reader caps every growth-race allocation at maximum plus one', async () => {
  const { readVerifiedArtifact } = await import(
    '../agents/market-analyst/orchestrator.js'
  );
  const maximum = 8;
  const regular = {
    isFile: () => true,
    isSymbolicLink: () => false,
    dev: 1,
    ino: 2,
    size: 4
  };
  let readFileCalls = 0;
  let readCalls = 0;
  let requestedBytes = 0;
  let largestBuffer = 0;
  let pathStats = 0;
  let handleStats = 0;
  const growingFs = {
    lstat: async () => {
      pathStats += 1;
      return regular;
    },
    realpath: async (value) => value,
    open: async () => ({
      stat: async () => {
        handleStats += 1;
        return regular;
      },
      readFile: async () => {
        readFileCalls += 1;
        throw new Error('unbounded readFile must not be called');
      },
      read: async (buffer, offset, length) => {
        readCalls += 1;
        requestedBytes += length;
        largestBuffer = Math.max(largestBuffer, buffer.length);
        assert.ok(length <= maximum + 1);
        assert.ok(requestedBytes <= maximum + 1);
        buffer.fill(0x78, offset, offset + length);
        return { bytesRead: length, buffer };
      },
      close: async () => {}
    })
  };

  await assert.rejects(
    readVerifiedArtifact('C:\\safe\\report.txt', {
      root: 'C:\\safe',
      maximum,
      expectedSize: 4,
      expectedSha256: 'unused'
    }, growingFs),
    (error) => error.code === 'ARTIFACT_INTEGRITY_FAILED'
  );
  assert.equal(readFileCalls, 0);
  assert.ok(readCalls > 0);
  assert.ok(requestedBytes <= maximum + 1);
  assert.ok(largestBuffer <= maximum + 1);
  assert.equal(pathStats, 2);
  assert.equal(handleStats, 2);
});
