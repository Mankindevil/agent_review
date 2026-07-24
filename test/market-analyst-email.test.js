import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSmtpMailer,
  deliveryKey
} from '../agents/market-analyst/smtp-mailer.js';

const config = {
  email: {
    from: 'reports@example.com',
    to: ['Two@Example.com', 'one@example.com']
  },
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    requireTLS: true,
    username: 'mailer',
    password: 'smtp-secret'
  }
};

test('delivery key, Message-ID, and SMTP transport settings are deterministic', async () => {
  const transportOptions = [];
  const messages = [];
  const createTransport = (options) => {
    transportOptions.push(options);
    return {
      async sendMail(message) {
        messages.push(message);
        return {
          response: '250 2.0.0 queued as provider-123',
          accepted: message.to,
          rejected: [],
          messageId: '<provider-123@example.com>'
        };
      }
    };
  };
  const mailer = createSmtpMailer(config, {
    createTransport,
    wait: async () => assert.fail('successful delivery must not wait'),
    jitter: () => 0,
    clock: () => new Date('2026-07-24T10:30:00.000Z')
  });

  const first = await mailer.send({
    reportDate: '2026-07-23',
    reportVersion: 'sha256:abc',
    subject: '每日市场报告',
    text: 'plain report',
    html: '<p>report</p>'
  });
  const secondKey = deliveryKey(
    '2026-07-23',
    ['one@example.com', 'two@example.com'],
    'sha256:abc'
  );

  assert.equal(first.deliveryKey, secondKey);
  assert.match(first.messageId, /^<market-report\.[a-f0-9]{64}@market-analyst\.local>$/);
  assert.equal(messages[0].messageId, first.messageId);
  assert.deepEqual(transportOptions[0], {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    requireTLS: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    auth: { user: 'mailer', pass: 'smtp-secret' },
    tls: { rejectUnauthorized: true }
  });
  assert.equal(first.attempts.length, 1);
  assert.equal(first.attempts[0].acceptedCount, 2);
  assert.equal(first.attempts[0].rejectedCount, 0);
  assert.equal(first.attempts[0].smtpResponse, '250 2.0.0 queued as provider-123');
  assert.doesNotMatch(JSON.stringify(first), /one@example|two@example|smtp-secret|mailer/);
});

test('transient SMTP failures retry exactly three times with bounded backoff', async () => {
  const waits = [];
  const attempts = [];
  let calls = 0;
  const mailer = createSmtpMailer(config, {
    createTransport: () => ({
      async sendMail() {
        calls += 1;
        if (calls < 3) {
          const error = new Error(`temporary failure for one@example.com password=smtp-secret`);
          error.responseCode = 451;
          error.response = '451 authorization=Bearer secret-token';
          throw error;
        }
        return {
          response: '250 accepted',
          accepted: ['one@example.com', 'two@example.com'],
          rejected: [],
          messageId: 'provider-message'
        };
      }
    }),
    wait: async (milliseconds) => waits.push(milliseconds),
    jitter: () => 0,
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.parse('2026-07-24T10:30:00.000Z') + tick++ * 10);
    })()
  });

  const receipt = await mailer.send({
    reportDate: '2026-07-23',
    reportVersion: 'v1',
    subject: 'report',
    text: 'report'
  }, {
    onAttempt: async (attempt) => attempts.push(attempt)
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1500]);
  assert.deepEqual(attempts.map(({ attempt, status }) => [attempt, status]), [
    [1, 'failed'],
    [2, 'failed'],
    [3, 'sent']
  ]);
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.attemptCount, 3);
  assert.doesNotMatch(JSON.stringify({ attempts, receipt }), /one@example|smtp-secret|secret-token/);
});

test('confirmed delivery is idempotent unless force delivery is explicit', async () => {
  let sends = 0;
  const mailer = createSmtpMailer(config, {
    createTransport: () => ({
      async sendMail(message) {
        sends += 1;
        return { response: '250 ok', accepted: message.to, rejected: [] };
      }
    }),
    wait: async () => {},
    jitter: () => 0
  });
  const message = {
    reportDate: '2026-07-23',
    reportVersion: 'v1',
    subject: 'report',
    text: 'report'
  };
  const delivered = await mailer.send(message);
  const duplicate = await mailer.send(message, { previousReceipt: delivered });
  const forced = await mailer.send(message, {
    previousReceipt: delivered,
    forceDelivery: true
  });

  assert.equal(sends, 2);
  assert.equal(duplicate.status, 'already-sent');
  assert.equal(duplicate.attemptCount, 0);
  assert.equal(forced.status, 'sent');
});

test('failure alert mode makes only one best-effort attempt', async () => {
  let sends = 0;
  const waits = [];
  const mailer = createSmtpMailer(config, {
    createTransport: () => ({
      async sendMail() {
        sends += 1;
        const error = new Error('temporary outage');
        error.responseCode = 451;
        throw error;
      }
    }),
    wait: async (milliseconds) => waits.push(milliseconds),
    jitter: () => 0
  });

  await assert.rejects(
    mailer.send({
      reportDate: '2026-07-23',
      reportVersion: 'failure-alert:run-1',
      subject: '[运行失败] 每日市场报告',
      text: 'run run-1 failed at worker',
      maxAttempts: 1
    }),
    (error) => error.code === 'SMTP_DELIVERY_FAILED'
      && error.receipt?.attemptCount === 1
  );
  assert.equal(sends, 1);
  assert.deepEqual(waits, []);
});

test('a receipt persistence failure after SMTP acceptance never resends', async () => {
  let sends = 0;
  const mailer = createSmtpMailer(config, {
    createTransport: () => ({
      async sendMail(message) {
        sends += 1;
        return { response: '250 accepted', accepted: message.to, rejected: [] };
      }
    }),
    wait: async () => assert.fail('accepted mail must not back off'),
    jitter: () => 0
  });

  await assert.rejects(
    mailer.send({
      reportDate: '2026-07-23',
      reportVersion: 'v1',
      subject: 'report',
      text: 'report'
    }, {
      onAttempt: async () => {
        throw new Error('state store unavailable');
      }
    }),
    (error) => error.code === 'SMTP_RECEIPT_PERSIST_FAILED'
      && error.receipt?.status === 'sent'
  );
  assert.equal(sends, 1);
});

test('SMTP delivery honors caller cancellation before starting a send', async () => {
  let sends = 0;
  const transport = {
    sendMail() {
      sends += 1;
      return new Promise(() => {});
    }
  };
  const mailer = createSmtpMailer(config, {
    createTransport: () => transport,
    wait: async () => {},
    jitter: () => 0
  });
  const message = {
    reportDate: '2026-07-23',
    reportVersion: 'v1',
    subject: 'report',
    text: 'report'
  };
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    mailer.send(message, { signal: preAborted.signal }),
    (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR'
  );
  assert.equal(sends, 0);
});

test('SMTP cancellation reconciles acceptance after transport close and suppresses resend', async () => {
  const controller = new AbortController();
  let sends = 0;
  let resolveSend;
  let timers = 0;
  let clearedTimers = 0;
  const attempts = [];
  const mailer = createSmtpMailer(config, {
    createTransport: () => ({
      sendMail(message) {
        sends += 1;
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
    setReconciliationTimer: () => {
      timers += 1;
      return 1;
    },
    clearReconciliationTimer: () => {
      clearedTimers += 1;
    },
    wait: async () => {},
    jitter: () => 0
  });
  const message = {
    reportDate: '2026-07-23',
    reportVersion: 'v1',
    subject: 'report',
    text: 'report'
  };
  const pending = mailer.send(message, {
    signal: controller.signal,
    onAttempt: async (attempt) => attempts.push(attempt)
  });
  await Promise.resolve();
  controller.abort();
  const receipt = await pending;
  assert.equal(receipt.status, 'reconciliation-needed');
  assert.equal(receipt.canceledAfterAcceptance, true);
  assert.equal(attempts[0].status, 'sent');
  assert.equal(attempts[0].canceledAfterAcceptance, true);
  const duplicate = await mailer.send(message, { previousReceipt: receipt });
  assert.equal(duplicate.status, 'reconciliation-needed');
  assert.equal(sends, 1);
  assert.equal(timers, 1);
  assert.equal(clearedTimers, 1);
});

test('SMTP cancellation propagates AbortError after confirmed rejection and permits retry', async () => {
  const controller = new AbortController();
  let sends = 0;
  let rejectSend;
  let reconciliationTimeout;
  const mailer = createSmtpMailer(config, {
    createTransport: () => ({
      sendMail(message) {
        sends += 1;
        if (sends > 1) {
          return Promise.resolve({
            response: '250 accepted on retry',
            accepted: message.to,
            rejected: []
          });
        }
        return new Promise((_resolve, reject) => {
          rejectSend = reject;
        });
      },
      close() {}
    }),
    setReconciliationTimer: (callback) => {
      reconciliationTimeout = callback;
      return 1;
    },
    clearReconciliationTimer: () => {},
    wait: async () => {},
    jitter: () => 0
  });
  const message = {
    reportDate: '2026-07-23',
    reportVersion: 'v1',
    subject: 'report',
    text: 'report'
  };
  const pending = mailer.send(message, { signal: controller.signal });
  let settled = false;
  pending.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await Promise.resolve();
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(typeof reconciliationTimeout, 'function');
  rejectSend(new Error('socket closed before acceptance'));
  await assert.rejects(
    pending,
    (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR'
  );
  const retry = await mailer.send(message);
  assert.equal(retry.status, 'sent');
  assert.equal(sends, 2);
});

test('SMTP cancellation persists delivery-unknown after bounded reconciliation and suppresses resend', async () => {
  const controller = new AbortController();
  let sends = 0;
  let closes = 0;
  const attempts = [];
  const mailer = createSmtpMailer(config, {
    createTransport: () => ({
      sendMail() {
        sends += 1;
        return new Promise(() => {});
      },
      close() {
        closes += 1;
      }
    }),
    setReconciliationTimer: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearReconciliationTimer: () => {},
    wait: async () => {},
    jitter: () => 0
  });
  const message = {
    reportDate: '2026-07-23',
    reportVersion: 'v1',
    subject: 'report',
    text: 'report'
  };
  const pending = mailer.send(message, {
    signal: controller.signal,
    onAttempt: async (attempt) => attempts.push(attempt)
  });
  await Promise.resolve();
  controller.abort();
  let ambiguousReceipt;
  await assert.rejects(pending, (error) => {
    ambiguousReceipt = error.receipt;
    return error.name === 'AbortError'
      && error.code === 'ABORT_ERR'
      && error.receipt?.status === 'reconciliation-needed';
  });
  assert.equal(attempts[0].status, 'delivery-unknown');
  assert.equal(attempts[0].canceledDuringDelivery, true);
  assert.equal(attempts[0].canceledAfterAcceptance, undefined);
  const duplicate = await mailer.send(message, {
    previousReceipt: ambiguousReceipt
  });
  assert.equal(duplicate.status, 'reconciliation-needed');
  assert.equal(sends, 1);
  assert.equal(closes, 1);
});

test('SMTP acceptance after a same-turn abort requires reconciliation', async () => {
  const controller = new AbortController();
  const mailer = createSmtpMailer(config, {
    createTransport: () => ({
      async sendMail(message) {
        controller.abort();
        return { response: '250 accepted', accepted: message.to, rejected: [] };
      }
    }),
    wait: async () => {},
    jitter: () => 0
  });
  const receipt = await mailer.send({
    reportDate: '2026-07-23',
    reportVersion: 'v1',
    subject: 'report',
    text: 'report'
  }, { signal: controller.signal });
  assert.equal(receipt.status, 'reconciliation-needed');
  assert.equal(receipt.canceledAfterAcceptance, true);
  assert.equal(receipt.attemptCount, 1);
});
