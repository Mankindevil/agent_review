import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MarketOrchestrator } from '../agents/market-analyst/orchestrator.js';
import { MarketTaskStore } from '../agents/market-analyst/task-store.js';
import { parseCliArgs, runCli } from '../agents/market-analyst/cli.js';
import { deliveryKey } from '../agents/market-analyst/smtp-mailer.js';

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
      readFile: async () => Buffer.from('safe'),
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
      readFile: async () => Buffer.from('safe'),
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
      readFile: async () => Buffer.from('safe'),
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
