import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';

import { sanitizeTraceValue } from './run-trace.js';

const BACKOFF_MS = Object.freeze([500, 1500]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNECTION',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETDOWN',
  'ENETUNREACH',
  'ESOCKET',
  'ETIMEDOUT'
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > 50) {
    throw new TypeError('one to fifty email recipients are required');
  }
  const normalized = recipients.map((recipient) => String(recipient).trim().toLowerCase());
  for (const recipient of normalized) {
    if (
      recipient.length > 254
      || /[\r\n]/.test(recipient)
      || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)
    ) {
      throw new TypeError('email configuration contains an invalid recipient');
    }
  }
  return [...new Set(normalized)].sort();
}

function requireBoundedText(value, name, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || (!optional && !value)) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_BODY_BYTES) {
    throw new RangeError(`${name} exceeds the email payload limit`);
  }
  return value;
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('email message is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(message.reportDate || '')) {
    throw new TypeError('reportDate must be YYYY-MM-DD');
  }
  requireBoundedText(message.reportVersion, 'reportVersion');
  const subject = requireBoundedText(message.subject, 'subject');
  if (/[\r\n]/.test(subject) || subject.length > 998) {
    throw new TypeError('subject contains unsupported characters');
  }
  requireBoundedText(message.text, 'text');
  requireBoundedText(message.html, 'html', { optional: true });
  const maxAttempts = message.maxAttempts === undefined ? 3 : Number(message.maxAttempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new RangeError('maxAttempts must be an integer from one to three');
  }
  return maxAttempts;
}

function isTransient(error) {
  const responseCode = Number(error?.responseCode);
  return (Number.isSafeInteger(responseCode) && responseCode >= 400 && responseCode < 500)
    || TRANSIENT_CODES.has(error?.code);
}

function smtpResponse(info) {
  if (typeof info?.response !== 'string') return null;
  return sanitizeTraceValue(info.response);
}

function safeError(error) {
  return sanitizeTraceValue({
    name: error?.name || 'Error',
    code: error?.code || null,
    responseCode: Number.isSafeInteger(Number(error?.responseCode))
      ? Number(error.responseCode)
      : null,
    message: String(error?.message || error || 'SMTP delivery failed'),
    response: typeof error?.response === 'string' ? error.response : null
  });
}

function abortError(signal) {
  const error = new Error(
    String(signal?.reason?.message || 'SMTP delivery canceled')
  );
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function sendWithSignal(transport, message, signal, {
  reconciliationTimeoutMs,
  setReconciliationTimer,
  clearReconciliationTimer
}) {
  throwIfAborted(signal);
  if (!signal) {
    return Promise.resolve(transport.sendMail(message)).then((info) => ({
      status: 'accepted',
      info,
      canceledAfterAcceptance: false
    }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let canceled = false;
    let reconciliationTimer;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (reconciliationTimer !== undefined) {
        clearReconciliationTimer(reconciliationTimer);
      }
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      if (canceled || settled) return;
      canceled = true;
      try {
        if (typeof transport.abort === 'function') transport.abort();
        else if (typeof transport.close === 'function') transport.close();
      } catch {
        // The bounded reconciliation timer remains authoritative.
      }
      reconciliationTimer = setReconciliationTimer(() => {
        settle(resolve, {
          status: 'delivery-unknown',
          canceledDuringDelivery: true
        });
      }, reconciliationTimeoutMs);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let pending;
    try {
      pending = transport.sendMail(message);
    } catch (error) {
      settle(reject, error);
      return;
    }
    Promise.resolve(pending).then(
      (info) => settle(resolve, {
        status: 'accepted',
        info,
        canceledAfterAcceptance: canceled
      }),
      (error) => settle(reject, canceled ? abortError(signal) : error)
    );
    if (signal.aborted) onAbort();
  });
}

function attemptRecord({
  attempt,
  startedAt,
  endedAt,
  startedMs,
  status,
  deliveryKey,
  messageId,
  canceledAfterAcceptance,
  canceledDuringDelivery,
  info,
  error
}) {
  return sanitizeTraceValue({
    attempt,
    status,
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - startedMs),
    acceptedCount: Array.isArray(info?.accepted) ? info.accepted.length : 0,
    rejectedCount: Array.isArray(info?.rejected) ? info.rejected.length : 0,
    smtpResponse: smtpResponse(info),
    deliveryKey,
    messageId,
    ...(canceledAfterAcceptance ? { canceledAfterAcceptance: true } : {}),
    ...(canceledDuringDelivery ? { canceledDuringDelivery: true } : {}),
    providerMessageId: typeof info?.messageId === 'string'
      ? sanitizeTraceValue(info.messageId)
      : null,
    ...(error ? { error: safeError(error) } : {})
  });
}

export function deliveryKey(reportDate, recipients, reportVersion) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate || '')) {
    throw new TypeError('reportDate must be YYYY-MM-DD');
  }
  if (typeof reportVersion !== 'string' || !reportVersion) {
    throw new TypeError('reportVersion is required');
  }
  const recipientHash = sha256(normalizeRecipients(recipients).join('\n'));
  return `${reportDate}:${recipientHash}:${reportVersion}`;
}

export function createSmtpMailer(config, {
  createTransport = nodemailer.createTransport,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  jitter = (maximum) => Math.floor(Math.random() * Math.min(maximum, 250)),
  clock = () => new Date(),
  reconciliationTimeoutMs = 1_000,
  setReconciliationTimer = setTimeout,
  clearReconciliationTimer = clearTimeout
} = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('config is required');
  const recipients = normalizeRecipients(config.email?.to);
  const from = String(config.email?.from || '').trim();
  if (!from || /[\r\n]/.test(from)) throw new TypeError('email.from is required');
  if (!config.smtp?.host) throw new TypeError('smtp.host is required');
  const keyFor = (message) =>
    deliveryKey(message.reportDate, recipients, message.reportVersion);
  const transport = createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: config.smtp.requireTLS,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    auth: config.smtp.username
      ? { user: config.smtp.username, pass: config.smtp.password }
      : undefined,
    tls: { rejectUnauthorized: true }
  });

  return Object.freeze({
    async send(message, {
      previousReceipt,
      forceDelivery = false,
      onAttempt = async () => {},
      signal
    } = {}) {
      throwIfAborted(signal);
      const maxAttempts = validateMessage(message);
      const key = keyFor(message);
      const messageId = `<market-report.${sha256(key)}@market-analyst.local>`;
      if (
        !forceDelivery
        && previousReceipt?.deliveryKey === key
        && previousReceipt?.messageId === messageId
        && ['sent', 'already-sent', 'reconciliation-needed'].includes(
          previousReceipt.status
        )
      ) {
        return sanitizeTraceValue({
          status: previousReceipt.status === 'reconciliation-needed'
            ? 'reconciliation-needed'
            : 'already-sent',
          deliveryKey: key,
          messageId,
          ...(previousReceipt.reconciliationReason
            ? { reconciliationReason: previousReceipt.reconciliationReason }
            : {}),
          attemptCount: 0,
          attempts: []
        });
      }

      const attempts = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(signal);
        const started = clock();
        const startedAt = started.toISOString();
        const startedMs = started.getTime();
        try {
          const settlement = await sendWithSignal(transport, {
            from,
            to: recipients,
            subject: message.subject,
            text: message.text,
            ...(message.html === undefined ? {} : { html: message.html }),
            messageId
          }, signal, {
            reconciliationTimeoutMs,
            setReconciliationTimer,
            clearReconciliationTimer
          });
          const endedAt = clock().toISOString();
          if (settlement.status === 'delivery-unknown') {
            const record = attemptRecord({
              attempt,
              startedAt,
              endedAt,
              startedMs,
              status: 'delivery-unknown',
              deliveryKey: key,
              messageId,
              canceledDuringDelivery: true
            });
            attempts.push(record);
            const receipt = sanitizeTraceValue({
              status: 'reconciliation-needed',
              reconciliationReason: 'delivery-unknown',
              deliveryKey: key,
              recipientHash: sha256(recipients.join('\n')),
              recipientCount: recipients.length,
              messageId,
              attemptCount: attempts.length,
              attempts
            });
            try {
              await onAttempt(record);
            } catch (cause) {
              const persistenceFailure = new Error('SMTP receipt persistence failed');
              persistenceFailure.code = 'SMTP_RECEIPT_PERSIST_FAILED';
              persistenceFailure.receipt = receipt;
              persistenceFailure.cause = cause;
              throw persistenceFailure;
            }
            const canceled = abortError(signal);
            canceled.receipt = receipt;
            throw canceled;
          }
          const info = settlement.info;
          const record = attemptRecord({
            attempt,
            startedAt,
            endedAt,
            startedMs,
            status: 'sent',
            deliveryKey: key,
            messageId,
            canceledAfterAcceptance: settlement.canceledAfterAcceptance,
            info
          });
          attempts.push(record);
          const receipt = sanitizeTraceValue({
            status: settlement.canceledAfterAcceptance
              ? 'reconciliation-needed'
              : 'sent',
            ...(settlement.canceledAfterAcceptance
              ? {
                  canceledAfterAcceptance: true,
                  reconciliationReason: 'canceled-after-acceptance'
                }
              : {}),
            deliveryKey: key,
            recipientHash: sha256(recipients.join('\n')),
            recipientCount: recipients.length,
            messageId,
            providerMessageId: record.providerMessageId,
            attemptCount: attempts.length,
            attempts
          });
          try {
            await onAttempt(record);
          } catch (cause) {
            const persistenceFailure = new Error('SMTP receipt persistence failed');
            persistenceFailure.code = 'SMTP_RECEIPT_PERSIST_FAILED';
            persistenceFailure.receipt = receipt;
            persistenceFailure.cause = cause;
            throw persistenceFailure;
          }
          return receipt;
        } catch (error) {
          if (error?.code === 'SMTP_RECEIPT_PERSIST_FAILED') throw error;
          if (signal?.aborted) {
            if (error?.receipt) throw error;
            throw abortError(signal);
          }
          const endedAt = clock().toISOString();
          const record = attemptRecord({
            attempt,
            startedAt,
            endedAt,
            startedMs,
            status: 'failed',
            deliveryKey: key,
            messageId,
            error
          });
          attempts.push(record);
          await onAttempt(record);
          if (attempt >= maxAttempts || !isTransient(error)) {
            const failure = new Error('SMTP delivery failed');
            failure.code = 'SMTP_DELIVERY_FAILED';
            failure.receipt = sanitizeTraceValue({
              status: 'failed',
              deliveryKey: key,
              recipientHash: sha256(recipients.join('\n')),
              recipientCount: recipients.length,
              messageId,
              attemptCount: attempts.length,
              attempts,
              error: safeError(error)
            });
            throw failure;
          }
          const baseDelay = BACKOFF_MS[attempt - 1];
          const extraDelay = Number(jitter(baseDelay));
          await wait(baseDelay + (
            Number.isFinite(extraDelay) && extraDelay >= 0
              ? Math.min(Math.floor(extraDelay), baseDelay)
              : 0
          ));
          throwIfAborted(signal);
        }
      }
      throw new Error('unreachable SMTP delivery state');
    }
  });
}
