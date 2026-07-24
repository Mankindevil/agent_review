import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MarketOrchestrator } from '../agents/market-analyst/orchestrator.js';
import { createSmtpMailer } from '../agents/market-analyst/smtp-mailer.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'market-smoke-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function configuredEnv(overrides = {}) {
  return {
    PANDA_DATA_ENABLED: 'true',
    PANDA_DATA_USERNAME: 'configured-user',
    PANDA_DATA_PASSWORD: 'configured-password',
    PANDA_DATA_PYTHON: 'python-test',
    MARKET_SMOKE_REPORT_DATE: '2026-07-23',
    ...overrides
  };
}

test('live smoke fails closed until Panda is explicitly enabled with credentials', async () => {
  const {
    validateSmokeEnvironment
  } = await import('../scripts/market-agent-live-smoke.js');
  assert.throws(
    () => validateSmokeEnvironment({}),
    (error) => error?.code === 'SMOKE_NOT_CONFIGURED'
  );
  assert.throws(
    () => validateSmokeEnvironment({
      PANDA_DATA_ENABLED: 'true',
      PANDA_DATA_USERNAME: 'configured'
    }),
    (error) => error?.code === 'SMOKE_NOT_CONFIGURED'
  );
  assert.throws(
    () => validateSmokeEnvironment(configuredEnv({
      MARKET_SMOKE_EMAIL_TO: 'smoke@example.test',
      MARKET_REPORT_EMAIL_FROM: 'sender@example.test',
      MARKET_REPORT_SMTP_HOST: 'smtp.example.test'
    })),
    (error) => error?.code === 'SMOKE_STATE_NOT_CONFIGURED'
  );
  assert.throws(
    () => validateSmokeEnvironment(configuredEnv({
      MARKET_SMOKE_EMAIL_TO: 'smoke@example.test',
      MARKET_SMOKE_STATE_DIR: 'relative-state',
      MARKET_REPORT_EMAIL_FROM: 'sender@example.test',
      MARKET_REPORT_SMTP_HOST: 'smtp.example.test'
    })),
    (error) => error?.code === 'SMOKE_STATE_NOT_CONFIGURED'
  );
});

test('live smoke summary is bounded and redacts credential-shaped data', async () => {
  const {
    sanitizeSmokeSummary
  } = await import('../scripts/market-agent-live-smoke.js');
  const secret = 'never-print-this-credential';
  const summary = sanitizeSmokeSummary({
    status: 'COMPLETE',
    authorization: `Bearer ${secret}`,
    password: secret,
    error: new Error(secret),
    huge: 'x'.repeat(50_000),
    nested: { token: secret }
  });
  const output = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(output) <= 16 * 1024);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /Bearer/i);
});

test('live smoke contract uses bounded Panda, ephemeral loopback A2A, and opt-in email', async () => {
  const source = await readFile(
    new URL('../scripts/market-agent-live-smoke.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /topN:\s*3/);
  assert.match(source, /host:\s*'127\.0\.0\.1'/);
  assert.match(source, /port:\s*0/);
  assert.match(source, /MARKET_SMOKE_EMAIL_TO/);
  assert.match(source, /daily-market-report/);
  assert.match(source, /validateEvidencePack/);
  assert.match(source, /version\(['"]panda-data['"]\)/);
  assert.match(source, /['"]0\.0\.12['"]/);
  assert.doesNotMatch(source, /console\.(?:log|error)\(\s*process\.env/);
});

test('live smoke validates artifacts from the orchestrator runs directory', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const runId = 'run-smoke-artifacts';
  const reportDate = '2026-07-23';
  const directory = path.join(stateDir, 'runs', '20260723', runId);
  await mkdir(directory, { recursive: true });
  const values = {
    'market-report.md': '# report\n',
    'market-report.html': '<h1>report</h1>',
    'market-report.txt': 'report',
    'evidence-pack.json': `${JSON.stringify({
      schemaVersion: '1.0',
      runId,
      reportDate,
      status: 'complete',
      markets: {},
      conclusions: [],
      leaderboards: {},
      sources: []
    })}\n`,
    'run-trace.json': `${JSON.stringify({ runId })}\n`
  };
  const artifacts = [];
  for (const [name, value] of Object.entries(values)) {
    const content = Buffer.from(value);
    await writeFile(path.join(directory, name), content);
    artifacts.push({
      name,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex')
    });
  }
  const { validateSmokeArtifacts } = await import(
    '../scripts/market-agent-live-smoke.js'
  );
  const result = await validateSmokeArtifacts(
    { stateDir },
    { runId, reportDate, artifacts }
  );
  assert.equal(result.artifactCount, 5);
  assert.equal(result.evidenceStatus, 'complete');
});

test('email smoke validates no-email core before delivery and preserves durable state', async () => {
  const stateDir = path.resolve(os.tmpdir(), 'market-smoke-durable-test');
  const order = [];
  const requests = [];
  let runCount = 0;
  let cleanupCalls = 0;
  const orchestrator = {
    async run(request) {
      requests.push(request);
      runCount += 1;
      order.push(request.deliverEmail ? `email-${runCount}` : 'core');
      return {
        runId: 'run-stable',
        reportDate: '2026-07-23',
        outcome: 'complete',
        emailStatus: runCount === 1
          ? 'not-requested'
          : runCount === 2
            ? 'sent'
            : 'already-sent',
        artifacts: []
      };
    }
  };
  const { runLiveSmoke } = await import('../scripts/market-agent-live-smoke.js');
  const result = await runLiveSmoke(configuredEnv({
    MARKET_SMOKE_EMAIL_TO: 'smoke@example.test',
    MARKET_SMOKE_STATE_DIR: stateDir,
    MARKET_REPORT_EMAIL_FROM: 'sender@example.test',
    MARKET_REPORT_SMTP_HOST: 'smtp.example.test'
  }), process.cwd(), {
    verifyPandaSdk: async () => order.push('sdk'),
    createOrchestrator: () => orchestrator,
    validateArtifacts: async (config, report) => {
      order.push('validate');
      assert.equal(config.stateDir, stateDir);
      assert.equal(report.runId, 'run-stable');
      return {
        artifactCount: 5,
        evidenceStatus: 'complete',
        conclusionCount: 1,
        sourceCount: 1
      };
    },
    verifyA2A: async () => {
      order.push('a2a');
      return {
        cardVersion: '1.0',
        taskState: 'TASK_STATE_COMPLETED',
        artifactCount: 3
      };
    },
    removeTemporaryStateDir: async () => {
      cleanupCalls += 1;
    }
  });

  assert.deepEqual(order, ['sdk', 'core', 'validate', 'email-2', 'email-3', 'a2a']);
  assert.deepEqual(requests.map(({ deliverEmail }) => deliverEmail), [false, true, true]);
  assert.ok(requests.every(({ owner }) => owner === 'production-live-smoke'));
  assert.equal(result.email, 'sent');
  assert.equal(result.emailReplay, 'already-sent');
  assert.equal(cleanupCalls, 0);
});

test('repeated same-date email smoke reuses the durable delivery receipt', async () => {
  const stateDir = path.resolve(os.tmpdir(), 'market-smoke-repeat-durable-test');
  let emailRuns = 0;
  const orchestrator = {
    async run(request) {
      if (request.deliverEmail) emailRuns += 1;
      return {
        runId: 'run-repeat',
        reportDate: '2026-07-23',
        outcome: 'complete',
        emailStatus: request.deliverEmail
          ? (emailRuns === 1 ? 'sent' : 'already-sent')
          : 'not-requested',
        artifacts: []
      };
    }
  };
  const dependencies = {
    verifyPandaSdk: async () => {},
    createOrchestrator: () => orchestrator,
    validateArtifacts: async () => ({
      artifactCount: 5,
      evidenceStatus: 'complete',
      conclusionCount: 1,
      sourceCount: 1
    }),
    verifyA2A: async () => ({
      cardVersion: '1.0',
      taskState: 'TASK_STATE_COMPLETED',
      artifactCount: 3
    }),
    removeTemporaryStateDir: async () => {
      throw new Error('durable state must not be removed');
    }
  };
  const env = configuredEnv({
    MARKET_SMOKE_EMAIL_TO: 'smoke@example.test',
    MARKET_SMOKE_STATE_DIR: stateDir,
    MARKET_REPORT_EMAIL_FROM: 'sender@example.test',
    MARKET_REPORT_SMTP_HOST: 'smtp.example.test'
  });
  const { runLiveSmoke } = await import('../scripts/market-agent-live-smoke.js');
  assert.equal((await runLiveSmoke(env, process.cwd(), dependencies)).email, 'sent');
  const repeated = await runLiveSmoke(env, process.cwd(), dependencies);
  assert.equal(repeated.email, 'already-sent');
  assert.equal(repeated.emailReplay, 'already-sent');
  assert.equal(emailRuns, 4);
});

test('fresh orchestrator processes reuse the durable same-date smoke receipt', async (t) => {
  const stateDir = await temporaryDirectory(t);
  const deliveries = [];
  let nextRunId = 0;
  const createOrchestrator = (config) => {
    const mailer = createSmtpMailer(config, {
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
      clock: () => new Date('2026-07-24T10:30:00.000Z')
    });
    return new MarketOrchestrator(config, {
      mailer,
      worker: async ({ request }) => ({
        schemaVersion: '1.0',
        runId: request.runId,
        reportDate: request.date,
        status: 'complete',
        markets: {},
        conclusions: [],
        leaderboards: {},
        sources: [],
        missingData: []
      }),
      narrator: async () => ({
        sections: [],
        fallbackReason: 'model disabled',
        usage: { totalTokens: 0 }
      }),
      renderer: () => ({
        markdown: '# durable smoke report',
        html: '<h1>durable smoke report</h1>',
        text: 'durable smoke report'
      }),
      validator: () => ({ valid: true }),
      clock: () => new Date('2026-07-24T10:30:00.000Z'),
      createId: () => `run-durable-smoke-${++nextRunId}`
    });
  };
  const dependencies = {
    verifyPandaSdk: async () => {},
    createOrchestrator,
    verifyA2A: async () => ({
      cardVersion: '1.0',
      taskState: 'TASK_STATE_COMPLETED',
      artifactCount: 3
    })
  };
  const env = configuredEnv({
    MARKET_SMOKE_EMAIL_TO: 'smoke@example.test',
    MARKET_SMOKE_STATE_DIR: stateDir,
    MARKET_REPORT_EMAIL_FROM: 'sender@example.test',
    MARKET_REPORT_SMTP_HOST: 'smtp.example.test'
  });
  const { runLiveSmoke } = await import('../scripts/market-agent-live-smoke.js');
  const first = await runLiveSmoke(env, process.cwd(), dependencies);
  const second = await runLiveSmoke(env, process.cwd(), dependencies);
  assert.equal(first.email, 'sent');
  assert.equal(second.email, 'already-sent');
  assert.equal(second.emailReplay, 'already-sent');
  assert.equal(deliveries.length, 1);
  assert.equal(nextRunId, 6);
});

test('no-email smoke uses and removes disposable state after validation', async () => {
  const stateDir = path.resolve(os.tmpdir(), 'market-smoke-disposable-test');
  const order = [];
  const { runLiveSmoke } = await import('../scripts/market-agent-live-smoke.js');
  await runLiveSmoke(configuredEnv(), process.cwd(), {
    makeTemporaryStateDir: async () => {
      order.push('make');
      return stateDir;
    },
    removeTemporaryStateDir: async (value) => {
      order.push(`remove:${value}`);
    },
    verifyPandaSdk: async () => order.push('sdk'),
    createOrchestrator: () => ({
      async run(request) {
        assert.equal(request.deliverEmail, false);
        order.push('core');
        return {
          runId: 'run-disposable',
          reportDate: '2026-07-23',
          outcome: 'complete',
          emailStatus: 'not-requested',
          artifacts: []
        };
      }
    }),
    validateArtifacts: async () => {
      order.push('validate');
      return {
        artifactCount: 5,
        evidenceStatus: 'complete',
        conclusionCount: 0,
        sourceCount: 1
      };
    },
    verifyA2A: async () => {
      order.push('a2a');
      return {
        cardVersion: '1.0',
        taskState: 'TASK_STATE_COMPLETED',
        artifactCount: 3
      };
    }
  });
  assert.deepEqual(order, [
    'make',
    'sdk',
    'core',
    'validate',
    'a2a',
    `remove:${stateDir}`
  ]);
});
