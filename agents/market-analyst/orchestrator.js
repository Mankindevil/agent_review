import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { acquireRunLock } from './run-lock.js';
import { createRunTrace, sanitizeTraceValue, TRACE_LIMITS } from './run-trace.js';
import { MarketTaskStore } from './task-store.js';
import { runMarketWorker } from './worker-runner.js';
import { generateNarrative } from './narrative-adapter.js';
import { renderReport } from './report-renderer.js';
import { validateReport } from './report-validator.js';
import { validateEvidencePack, validateOperation } from './schemas.js';

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

async function boundedRead(file, maximum) {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximum) {
    throw new RangeError('persisted artifact exceeds safe bounds');
  }
  return readFile(file, 'utf8');
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
    emailStatus: emailStatus || task.email?.status || 'not-requested',
    modelFallback: Boolean(task.modelFallback),
    artifacts: task.artifacts || []
  });
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

    const lock = await this.acquireLock({
      stateDir: this.config.stateDir,
      reportDate
    });
    try {
      const prior = await this.#findReusableReport(operation.operation, reportDate);
      if (prior) {
        if (prior.outcome === 'skipped' || !deliverEmail) {
          return taskSummary(prior, 'not-requested');
        }
        if (
          !forceDelivery
          && ['sent', 'already-sent'].includes(prior.email?.receipt?.status)
        ) {
          return taskSummary(prior, 'already-sent');
        }
        return this.#deliverPersisted(prior, { forceDelivery });
      }

      const task = await this.store.create({
        id: taskId,
        runId,
        owner,
        reportDate,
        operation: operation.operation,
        trigger,
        outcome: 'working',
        status: {
          state: 'TASK_STATE_WORKING',
          message: 'market report is running'
        },
        email: { status: deliverEmail ? 'pending' : 'not-requested', attempts: [] }
      });
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
          const artifacts = await this.#writeSkippedArtifacts({
            reportDate,
            runId,
            evidence,
            trace
          });
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
          narrative = {
            sections: [],
            fallbackReason: `model request failed: ${String(error?.message || error).slice(0, 300)}`
          };
        }
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

        stage = 'artifacts';
        const artifacts = await this.#writeReportArtifacts({
          reportDate,
          runId,
          evidence,
          report,
          trace
        });
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
          modelFallback,
          email: {
            status: deliverEmail ? 'pending' : 'not-requested',
            attempts: current.email?.attempts || []
          }
        }));
        if (!deliverEmail) return taskSummary(completed);
        completed = await this.#deliverNew(completed, report, trace, { forceDelivery });
        return taskSummary(completed);
      } catch (error) {
        if (activeStep !== undefined) {
          trace.finishStep(activeStep, {
            status: 'failed',
            error: safeError(error)
          });
        }
        const canceled = input.signal?.aborted
          || error?.name === 'AbortError'
          || error?.code === 'ABORT_ERR';
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
      artifactMetadata('evidence-pack.json', 'application/json', evidenceResult),
      artifactMetadata('run-trace.json', 'application/json', traceResult)
    ];
  }

  async #deliverNew(task, report, trace, { forceDelivery }) {
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
    const reportVersion = task.artifacts.find(
      ({ name }) => name === 'market-report.html'
    )?.sha256;
    const message = this.#reportMessage(task, report, reportVersion);
    try {
      const receipt = await this.mailer.send(message, {
        previousReceipt: task.email?.receipt,
        forceDelivery,
        onAttempt: async (attempt) => {
          trace.addEmailAttempt(attempt);
          await this.#persistTraceAttempt(task, trace.toJSON(), attempt);
        }
      });
      return this.#persistReceipt(task.id, receipt);
    } catch (error) {
      return this.#persistReceipt(task.id, error?.receipt || {
        status: 'failed',
        error: safeError(error)
      });
    }
  }

  async #deliverPersisted(task, { forceDelivery }) {
    if (!this.mailer) return taskSummary(task, 'failed');
    const directory = artifactDirectory(this.config.stateDir, task.reportDate, task.runId);
    const markdown = await boundedRead(
      path.join(directory, 'market-report.md'),
      MAX_REPORT_BYTES
    );
    const html = await boundedRead(
      path.join(directory, 'market-report.html'),
      MAX_REPORT_BYTES
    );
    const trace = JSON.parse(await boundedRead(
      path.join(directory, 'run-trace.json'),
      MAX_JSON_BYTES
    ));
    const reportVersion = task.artifacts.find(
      ({ name }) => name === 'market-report.html'
    )?.sha256 || sha256(html);
    const message = this.#reportMessage(
      task,
      { markdown, html, text: markdown },
      reportVersion
    );
    try {
      const receipt = await this.mailer.send(message, {
        previousReceipt: task.email?.receipt,
        forceDelivery,
        onAttempt: async (attempt) => {
          appendPlainAttempt(trace, attempt);
          await this.#persistTraceAttempt(task, trace, attempt);
        }
      });
      const updated = await this.#persistReceipt(task.id, receipt);
      return taskSummary(updated);
    } catch (error) {
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
