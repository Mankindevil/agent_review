import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import path from 'node:path';

import { acquireRunLock } from './run-lock.js';
import { createRunTrace, sanitizeTraceValue, TRACE_LIMITS } from './run-trace.js';
import { MarketTaskStore } from './task-store.js';
import { runMarketWorker } from './worker-runner.js';
import { generateNarrative } from './narrative-adapter.js';
import { renderReport } from './report-renderer.js';
import { validateReport } from './report-validator.js';
import { validateEvidencePack, validateOperation } from './schemas.js';
import { deliveryKey } from './smtp-mailer.js';

const REPORT_VERSION = 'market-report-v1';
const ALLOWED_TRIGGERS = new Set(['scheduled', 'manual', 'a2a']);
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const FORBIDDEN_CALLER_KEY =
  /(?:recipient|smtp|artifact.*(?:path|dir)|state.*dir|cache.*dir|file.*path|^path$|^to$|^from$|^email$)/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error) {
  return sanitizeTraceValue({
    name: error?.name || 'Error',
    code: error?.code || null,
    message: String(error?.message || error || 'market report failed')
  });
}

function cancellationError(signal) {
  const error = new Error(String(signal?.reason?.message || 'market report canceled'));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancellationError(signal);
}

function dateInTimezone(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function containsForbiddenOverride(value, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_CALLER_KEY.test(key)) return true;
    if (containsForbiddenOverride(value[key], depth + 1, seen)) return true;
  }
  return false;
}

function boundedString(value, name, maximum = MAX_REPORT_BYTES) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  if (Buffer.byteLength(value, 'utf8') > maximum) {
    throw new RangeError(`${name} exceeds safe artifact bounds`);
  }
  return value;
}

function artifactDirectory(stateDir, reportDate, runId) {
  return path.join(
    path.resolve(stateDir),
    'runs',
    reportDate.replaceAll('-', ''),
    runId
  );
}

async function atomicWrite(file, value, maximum) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  if (data.length > maximum) throw new RangeError('artifact exceeds safe bounds');
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  return {
    size: data.length,
    sha256: sha256(data)
  };
}

function artifactIntegrityError() {
  const error = new Error('persisted report artifact failed integrity verification');
  error.code = 'ARTIFACT_INTEGRITY_FAILED';
  return error;
}

function isContained(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function readVerifiedArtifact(file, {
  root,
  maximum,
  expectedSize,
  expectedSha256
}, fsOps = { lstat, realpath, open }) {
  let handle;
  try {
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(file);
    if (!isContained(resolvedRoot, resolvedFile)) throw artifactIntegrityError();
    const beforePath = await fsOps.lstat(resolvedFile);
    if (
      beforePath.isSymbolicLink()
      || !beforePath.isFile()
      || beforePath.size > maximum
      || beforePath.size !== expectedSize
    ) {
      throw artifactIntegrityError();
    }
    const canonical = path.resolve(await fsOps.realpath(resolvedFile));
    if (canonical !== resolvedFile || !isContained(resolvedRoot, canonical)) {
      throw artifactIntegrityError();
    }
    const noFollow = fsConstants.O_NOFOLLOW || 0;
    handle = await fsOps.open(resolvedFile, fsConstants.O_RDONLY | noFollow);
    const beforeHandle = await handle.stat();
    if (
      !beforeHandle.isFile()
      || !sameFile(beforePath, beforeHandle)
      || beforeHandle.size > maximum
      || beforeHandle.size !== expectedSize
    ) {
      throw artifactIntegrityError();
    }
    const data = await handle.readFile();
    if (data.length > maximum || data.length !== expectedSize) {
      throw artifactIntegrityError();
    }
    const afterHandle = await handle.stat();
    const afterPath = await fsOps.lstat(resolvedFile);
    if (
      !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || !sameFile(beforeHandle, afterHandle)
      || !sameFile(beforeHandle, afterPath)
      || afterHandle.size !== beforeHandle.size
      || afterPath.size !== beforeHandle.size
    ) {
      throw artifactIntegrityError();
    }
    if (
      typeof expectedSha256 !== 'string'
      || sha256(data) !== expectedSha256
    ) {
      throw artifactIntegrityError();
    }
    return data.toString('utf8');
  } catch (error) {
    if (error?.code === 'ARTIFACT_INTEGRITY_FAILED') throw error;
    throw artifactIntegrityError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function artifactMetadata(name, mediaType, result) {
  return {
    name,
    mediaType,
    size: result.size,
    sha256: result.sha256
  };
}

function appendPlainAttempt(trace, attempt) {
  const values = Array.isArray(trace.emailAttempts) ? trace.emailAttempts : [];
  if (values.length < TRACE_LIMITS.emailAttempts - 1) {
    values.push(sanitizeTraceValue(attempt));
  } else if (!values.some((item) => item?.type === 'trace-truncated')) {
    values.push({
      type: 'trace-truncated',
      category: 'emailAttempts',
      status: 'truncated'
    });
  }
  trace.emailAttempts = values;
}

function publicDetailUrl(config, runId) {
  return config.publicBaseUrl
    ? `${String(config.publicBaseUrl).replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}`
    : null;
}

function taskSummary(task, emailStatus) {
  return sanitizeTraceValue({
    taskId: task.id,
    runId: task.runId,
    reportDate: task.reportDate,
    outcome: task.outcome,
    taskState: task.status?.state || task.state,
    trigger: task.trigger,
    deliveryRequested: task.deliveryRequested === true,
    emailStatus: emailStatus || task.email?.status || 'not-requested',
    modelFallback: Boolean(task.modelFallback),
    artifacts: task.artifacts || []
  });
}

function reportVersionFromArtifacts(artifacts) {
  const html = artifacts.find(({ name }) => name === 'market-report.html');
  const text = artifacts.find(({ name }) => name === 'market-report.txt');
  if (!html?.sha256 || !text?.sha256) return null;
  return sha256(`html:${html.sha256}\ntext:${text.sha256}`);
}

function expectedDeliveryIdentity(task, config) {
  if (!task.reportVersion) return null;
  const key = deliveryKey(task.reportDate, config.email?.to, task.reportVersion);
  return {
    deliveryKey: key,
    messageId: `<market-report.${sha256(key)}@market-analyst.local>`
  };
}

function persistedDeliveryState(task, config) {
  const receiptStatus = task.email?.receipt?.status;
  if (['sent', 'already-sent'].includes(receiptStatus)) return 'already-sent';
  if (task.email?.status === 'sent') return 'reconciliation-needed';
  const expected = expectedDeliveryIdentity(task, config);
  if (!expected) return null;
  const accepted = (task.email?.attempts || []).some((attempt) =>
    attempt?.status === 'sent'
    && attempt?.deliveryKey === expected.deliveryKey
    && attempt?.messageId === expected.messageId
    && Number(attempt?.acceptedCount) > 0
  );
  return accepted ? 'reconciliation-needed' : null;
}

export class MarketOrchestrator {
  constructor(config, dependencies = {}) {
    if (!config || typeof config !== 'object') throw new TypeError('config is required');
    if (typeof config.stateDir !== 'string' || !config.stateDir) {
      throw new TypeError('config.stateDir is required');
    }
    this.config = config;
    this.store = dependencies.store || new MarketTaskStore({ stateDir: config.stateDir });
    this.worker = dependencies.worker || runMarketWorker;
    this.narrator = dependencies.narrator || generateNarrative;
    this.renderer = dependencies.renderer || renderReport;
    this.validator = dependencies.validator || validateReport;
    this.mailer = dependencies.mailer;
    this.acquireLock = dependencies.acquireLock || acquireRunLock;
    this.clock = dependencies.clock || (() => new Date());
    this.createId = dependencies.createId || randomUUID;
  }

  async run(input = {}) {
    const runId = String(this.createId());
    const taskId = `task-${runId}`;
    const fallbackDate = dateInTimezone(this.clock(), this.config.timezone || 'Asia/Shanghai');
    let owner = typeof input.owner === 'string' && input.owner ? input.owner : 'system';
    if (owner.length > 200) owner = owner.slice(0, 200);
    let operation;
    let reportDate = fallbackDate;
    let trigger;
    let deliverEmail;
    let forceDelivery;

    try {
      if (containsForbiddenOverride(input)) {
        throw new TypeError('caller-controlled delivery or path overrides are not allowed');
      }
      const operationInput = typeof input.operation === 'string'
        ? { operation: input.operation }
        : input.operation;
      operation = validateOperation(operationInput);
      reportDate = operation.date || fallbackDate;
      if (!isRealDate(reportDate)) throw new TypeError('date must be a real YYYY-MM-DD date');
      trigger = input.trigger || 'manual';
      if (!ALLOWED_TRIGGERS.has(trigger)) throw new TypeError('trigger is unsupported');
      if (input.deliverEmail !== undefined && typeof input.deliverEmail !== 'boolean') {
        throw new TypeError('deliverEmail must be boolean');
      }
      if (input.forceDelivery !== undefined && typeof input.forceDelivery !== 'boolean') {
        throw new TypeError('forceDelivery must be boolean');
      }
      deliverEmail = input.deliverEmail === true && trigger !== 'a2a';
      forceDelivery = input.forceDelivery === true;
    } catch (error) {
      const rejected = {
        id: taskId,
        runId,
        owner,
        reportDate,
        trigger: typeof input.trigger === 'string' ? input.trigger : 'unknown',
        outcome: 'rejected',
        status: {
          state: 'TASK_STATE_REJECTED',
          message: 'invalid market report request'
        },
        error: safeError(error),
        email: { status: 'not-requested' }
      };
      await this.store.create(rejected);
      return taskSummary(rejected);
    }

    throwIfAborted(input.signal);
    const lock = await this.acquireLock({
      stateDir: this.config.stateDir,
      reportDate
    });
    try {
      throwIfAborted(input.signal);
      const prior = await this.#findReusableReport(operation.operation, reportDate);
      throwIfAborted(input.signal);
      if (prior) {
        if (prior.outcome === 'skipped' || !deliverEmail) {
          return taskSummary(prior, 'not-requested');
        }
        const deliveryState = persistedDeliveryState(prior, this.config);
        if (!forceDelivery && deliveryState) {
          return taskSummary(prior, deliveryState);
        }
        throwIfAborted(input.signal);
        return await this.#deliverPersisted(prior, {
          forceDelivery,
          signal: input.signal
        });
      }

      throwIfAborted(input.signal);
      let task = await this.store.create({
        id: taskId,
        runId,
        owner,
        reportDate,
        operation: operation.operation,
        trigger,
        deliveryRequested: deliverEmail,
        outcome: 'working',
        status: {
          state: 'TASK_STATE_WORKING',
          message: 'market report is running'
        },
        email: { status: deliverEmail ? 'pending' : 'not-requested', attempts: [] }
      });
      throwIfAborted(input.signal);
      const trace = createRunTrace({
        runId,
        taskId,
        trigger,
        reportDate,
        timezone: this.config.timezone || 'Asia/Shanghai',
        reportVersion: REPORT_VERSION
      });
      let stage = 'worker';
      let activeStep;
      try {
        activeStep = trace.startStep({
          skillId: operation.operation,
          tool: 'panda-market-worker',
          detail: { reportDate }
        });
        let evidence = await this.worker({
          request: { ...operation, date: reportDate, runId },
          config: this.config,
          signal: input.signal,
          onTrace: (event) => trace.addWorkerEvent(event)
        });
        throwIfAborted(input.signal);
        validateEvidencePack(evidence);
        if (evidence.runId !== runId || evidence.reportDate !== reportDate) {
          const error = new Error('worker Evidence Pack identity does not match the run');
          error.code = 'EVIDENCE_IDENTITY_MISMATCH';
          throw error;
        }
        trace.finishStep(activeStep, { status: evidence.status });
        activeStep = undefined;
        if (evidence.status === 'failed') {
          const error = new Error('worker reported a core-data failure');
          error.code = 'CORE_DATA_FAILED';
          throw error;
        }
        const detailUrl = publicDetailUrl(this.config, runId);
        evidence = {
          ...evidence,
          ...(detailUrl ? { detailUrl } : {})
        };

        if (evidence.status === 'skipped') {
          throwIfAborted(input.signal);
          const artifacts = await this.#writeSkippedArtifacts({
            reportDate,
            runId,
            evidence,
            trace
          });
          throwIfAborted(input.signal);
          const completed = await this.store.update(taskId, (current) => ({
            ...current,
            outcome: 'skipped',
            state: 'TASK_STATE_COMPLETED',
            status: {
              state: 'TASK_STATE_COMPLETED',
              message: 'report date is not a Panda trading day'
            },
            artifacts,
            artifactsReady: true,
            email: { status: 'not-requested', attempts: [] }
          }));
          task = completed;
          return taskSummary(completed);
        }

        stage = 'narrative';
        activeStep = trace.startStep({
          skillId: operation.operation,
          tool: 'narrative-adapter'
        });
        let narrative;
        try {
          narrative = await this.narrator(evidence, this.config.model || {}, {
            signal: input.signal
          });
        } catch (error) {
          if (input.signal?.aborted) {
            throw cancellationError(input.signal);
          }
          narrative = {
            sections: [],
            fallbackReason: `model request failed: ${String(error?.message || error).slice(0, 300)}`
          };
        }
        throwIfAborted(input.signal);
        if (narrative?.usage) {
          trace.addModelUsage({
            ...narrative.usage,
            ...(narrative.fallbackReason ? { fallbackReason: narrative.fallbackReason } : {})
          });
        } else if (narrative?.fallbackReason) {
          trace.addModelUsage({ fallbackReason: narrative.fallbackReason });
        }
        const modelFallback = Boolean(narrative?.fallbackReason);
        trace.finishStep(activeStep, {
          status: modelFallback ? 'fallback' : 'ok',
          detail: modelFallback ? { reason: narrative.fallbackReason } : undefined
        });
        activeStep = undefined;

        throwIfAborted(input.signal);
        stage = 'render';
        activeStep = trace.startStep({
          skillId: operation.operation,
          tool: 'report-renderer'
        });
        const report = this.renderer(evidence, narrative);
        boundedString(report?.markdown, 'report markdown');
        boundedString(report?.html, 'report HTML');
        boundedString(report?.text, 'report text');
        this.validator({
          evidence,
          markdown: report.markdown,
          narrative
        });
        trace.finishStep(activeStep, { status: 'ok' });
        activeStep = undefined;

        throwIfAborted(input.signal);
        stage = 'artifacts';
        const artifacts = await this.#writeReportArtifacts({
          reportDate,
          runId,
          evidence,
          report,
          trace
        });
        throwIfAborted(input.signal);
        const reportVersion = reportVersionFromArtifacts(artifacts);
        if (!reportVersion) throw artifactIntegrityError();
        let completed = await this.store.update(taskId, (current) => ({
          ...current,
          outcome: evidence.status === 'degraded' ? 'degraded' : 'complete',
          state: 'TASK_STATE_COMPLETED',
          status: {
            state: 'TASK_STATE_COMPLETED',
            message: evidence.status === 'degraded'
              ? 'market report completed with optional data degradation'
              : 'market report completed'
          },
          artifacts,
          artifactsReady: true,
          reportVersion,
          modelFallback,
          email: {
            status: deliverEmail ? 'pending' : 'not-requested',
            attempts: current.email?.attempts || []
          }
        }));
        task = completed;
        throwIfAborted(input.signal);
        if (!deliverEmail) return taskSummary(completed);
        throwIfAborted(input.signal);
        completed = await this.#deliverNew(completed, report, trace, {
          forceDelivery,
          signal: input.signal
        });
        return taskSummary(completed);
      } catch (error) {
        if (activeStep !== undefined) {
          trace.finishStep(activeStep, {
            status: 'failed',
            error: safeError(error)
          });
        }
        const canceled = input.signal?.aborted;
        return this.#finishFailure({
          task,
          trace,
          stage,
          error,
          canceled,
          deliverEmail,
          trigger
        });
      }
    } finally {
      await lock.release();
    }
  }

  async #findReusableReport(operation, reportDate) {
    const tasks = await this.store.list();
    return tasks
      .filter((task) =>
        task.operation === operation
        && task.reportDate === reportDate
        && task.artifactsReady === true
        && ['complete', 'degraded', 'skipped'].includes(task.outcome)
      )
      .sort((left, right) =>
        String(right.lastModified || right.createdAt || '')
          .localeCompare(String(left.lastModified || left.createdAt || ''))
      )[0] || null;
  }

  async #writeSkippedArtifacts({ reportDate, runId, evidence, trace }) {
    const directory = artifactDirectory(this.config.stateDir, reportDate, runId);
    const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`;
    const evidenceResult = await atomicWrite(
      path.join(directory, 'evidence-pack.json'),
      evidenceJson,
      MAX_JSON_BYTES
    );
    const traceResult = await atomicWrite(
      path.join(directory, 'run-trace.json'),
      `${JSON.stringify(trace.toJSON(), null, 2)}\n`,
      MAX_JSON_BYTES
    );
    return [
      artifactMetadata('evidence-pack.json', 'application/json', evidenceResult),
      artifactMetadata('run-trace.json', 'application/json', traceResult)
    ];
  }

  async #writeReportArtifacts({ reportDate, runId, evidence, report, trace }) {
    const directory = artifactDirectory(this.config.stateDir, reportDate, runId);
    const markdown = await atomicWrite(
      path.join(directory, 'market-report.md'),
      report.markdown,
      MAX_REPORT_BYTES
    );
    const html = await atomicWrite(
      path.join(directory, 'market-report.html'),
      report.html,
      MAX_REPORT_BYTES
    );
    const text = await atomicWrite(
      path.join(directory, 'market-report.txt'),
      report.text,
      MAX_REPORT_BYTES
    );
    const evidenceResult = await atomicWrite(
      path.join(directory, 'evidence-pack.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      MAX_JSON_BYTES
    );
    const traceResult = await atomicWrite(
      path.join(directory, 'run-trace.json'),
      `${JSON.stringify(trace.toJSON(), null, 2)}\n`,
      MAX_JSON_BYTES
    );
    return [
      artifactMetadata('market-report.md', 'text/markdown', markdown),
      artifactMetadata('market-report.html', 'text/html', html),
      artifactMetadata('market-report.txt', 'text/plain', text),
      artifactMetadata('evidence-pack.json', 'application/json', evidenceResult),
      artifactMetadata('run-trace.json', 'application/json', traceResult)
    ];
  }

  async #deliverNew(task, report, trace, { forceDelivery, signal }) {
    throwIfAborted(signal);
    if (!this.mailer) {
      return this.store.update(task.id, (current) => ({
        ...current,
        email: {
          ...current.email,
          status: 'failed',
          error: { code: 'EMAIL_NOT_CONFIGURED', message: 'email delivery is not configured' }
        }
      }));
    }
    const message = this.#reportMessage(task, report, task.reportVersion);
    try {
      throwIfAborted(signal);
      const receipt = await this.mailer.send(message, {
        previousReceipt: task.email?.receipt,
        forceDelivery,
        signal,
        onAttempt: async (attempt) => {
          trace.addEmailAttempt(attempt);
          await this.#persistTraceAttempt(task, trace.toJSON(), attempt);
        }
      });
      return this.#persistReceipt(task.id, receipt);
    } catch (error) {
      if (signal?.aborted) {
        throw cancellationError(signal);
      }
      return this.#persistReceipt(task.id, error?.receipt || {
        status: 'failed',
        error: safeError(error)
      });
    }
  }

  async #deliverPersisted(task, { forceDelivery, signal }) {
    throwIfAborted(signal);
    if (!this.mailer) return taskSummary(task, 'failed');
    const directory = artifactDirectory(this.config.stateDir, task.reportDate, task.runId);
    const artifact = (name) => {
      const metadata = task.artifacts?.find((item) => item.name === name);
      if (!metadata) throw artifactIntegrityError();
      return metadata;
    };
    const read = async (name, maximum) => {
      const metadata = artifact(name);
      const value = await readVerifiedArtifact(path.join(directory, name), {
        root: directory,
        maximum,
        expectedSize: metadata.size,
        expectedSha256: metadata.sha256
      });
      throwIfAborted(signal);
      return value;
    };
    const html = await read('market-report.html', MAX_REPORT_BYTES);
    const text = await read('market-report.txt', MAX_REPORT_BYTES);
    const trace = JSON.parse(await read('run-trace.json', MAX_JSON_BYTES));
    const reportVersion = reportVersionFromArtifacts(task.artifacts);
    if (!reportVersion || reportVersion !== task.reportVersion) {
      throw artifactIntegrityError();
    }
    throwIfAborted(signal);
    const message = this.#reportMessage(
      task,
      { html, text },
      reportVersion
    );
    try {
      throwIfAborted(signal);
      const receipt = await this.mailer.send(message, {
        previousReceipt: task.email?.receipt,
        forceDelivery,
        signal,
        onAttempt: async (attempt) => {
          appendPlainAttempt(trace, attempt);
          await this.#persistTraceAttempt(task, trace, attempt);
        }
      });
      const updated = await this.#persistReceipt(task.id, receipt);
      return taskSummary(updated);
    } catch (error) {
      if (signal?.aborted) {
        throw cancellationError(signal);
      }
      const updated = await this.#persistReceipt(task.id, error?.receipt || {
        status: 'failed',
        error: safeError(error)
      });
      return taskSummary(updated);
    }
  }

  #reportMessage(task, report, reportVersion) {
    const prefix = task.outcome === 'degraded' ? '[数据降级] ' : '';
    return {
      reportDate: task.reportDate,
      reportVersion: reportVersion || REPORT_VERSION,
      subject: `${prefix}${task.reportDate} 每日市场报告`,
      text: report.text || report.markdown,
      html: report.html
    };
  }

  async #persistTraceAttempt(task, traceValue, attempt) {
    const directory = artifactDirectory(
      this.config.stateDir,
      task.reportDate,
      task.runId
    );
    const traceResult = await atomicWrite(
      path.join(directory, 'run-trace.json'),
      `${JSON.stringify(traceValue, null, 2)}\n`,
      MAX_JSON_BYTES
    );
    await this.store.update(task.id, (current) => ({
      ...current,
      artifacts: (current.artifacts || []).map((artifact) =>
        artifact.name === 'run-trace.json'
          ? artifactMetadata('run-trace.json', 'application/json', traceResult)
          : artifact
      ),
      email: {
        ...current.email,
        status: attempt.status === 'sent' ? 'sent' : 'failed',
        attempts: [
          ...(current.email?.attempts || []).slice(-(TRACE_LIMITS.emailAttempts - 2)),
          sanitizeTraceValue(attempt)
        ]
      }
    }));
  }

  async #persistReceipt(taskId, receipt) {
    return this.store.update(taskId, (current) => ({
      ...current,
      email: {
        ...current.email,
        status: receipt?.status || 'failed',
        receipt: sanitizeTraceValue(receipt)
      }
    }));
  }

  async #finishFailure({
    task,
    trace,
    stage,
    error,
    canceled,
    deliverEmail,
    trigger
  }) {
    if (canceled) {
      const current = await this.store.get(task.id);
      if (current?.status?.state === 'TASK_STATE_COMPLETED') {
        if (current.email?.status === 'sent') {
          return taskSummary(
            current,
            persistedDeliveryState(current, this.config) || 'reconciliation-needed'
          );
        }
        const preserved = await this.store.update(task.id, (record) => ({
          ...record,
          cancellationRequested: true,
          email: {
            ...record.email,
            status: 'canceled'
          }
        }));
        return sanitizeTraceValue({
          ...taskSummary(preserved, 'canceled'),
          outcome: 'canceled'
        });
      }
    }
    const directory = artifactDirectory(
      this.config.stateDir,
      task.reportDate,
      task.runId
    );
    let traceValue = trace.toJSON();
    const traceResult = await atomicWrite(
      path.join(directory, 'run-trace.json'),
      `${JSON.stringify(traceValue, null, 2)}\n`,
      MAX_JSON_BYTES
    );
    let failed = await this.store.update(task.id, (current) => ({
      ...current,
      outcome: canceled ? 'canceled' : 'failed',
      failureStage: stage,
      error: safeError(error),
      state: canceled ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED',
      status: {
        state: canceled ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED',
        message: canceled ? 'market report canceled' : 'market report failed'
      },
      artifacts: [
        artifactMetadata('run-trace.json', 'application/json', traceResult)
      ],
      artifactsReady: false,
      email: {
        status: 'not-requested',
        attempts: current.email?.attempts || []
      }
    }));
    if (
      canceled
      || !deliverEmail
      || trigger === 'a2a'
      || !this.config.email?.sendFailureAlerts
      || !this.mailer
    ) {
      return taskSummary(failed);
    }

    const detailUrl = publicDetailUrl(this.config, task.runId);
    const alert = {
      reportDate: task.reportDate,
      reportVersion: `failure-alert:${task.runId}`,
      subject: `[运行失败] ${task.reportDate} 每日市场报告`,
      text: [
        `运行 ${task.runId} 在 ${stage} 阶段失败。`,
        detailUrl ? `受保护详情：${detailUrl}` : ''
      ].filter(Boolean).join('\n'),
      maxAttempts: 1
    };
    try {
      const receipt = await this.mailer.send(alert, {
        onAttempt: async (attempt) => {
          appendPlainAttempt(traceValue, attempt);
          await this.#persistTraceAttempt(failed, traceValue, attempt);
        }
      });
      failed = await this.#persistReceipt(task.id, receipt);
    } catch (alertError) {
      failed = await this.#persistReceipt(task.id, alertError?.receipt || {
        status: 'failed',
        error: safeError(alertError)
      });
    }
    return taskSummary(failed);
  }
}
