#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { createMarketAgentServer } from '../agents/market-analyst/a2a-server.js';
import { marketAgentConfig } from '../agents/market-analyst/config.js';
import { MarketOrchestrator } from '../agents/market-analyst/orchestrator.js';
import { validateEvidencePack } from '../agents/market-analyst/schemas.js';
import { createSmtpMailer } from '../agents/market-analyst/smtp-mailer.js';

const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED'
]);
const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|credential|api.?key)/i;

function smokeError(code) {
  const error = new Error('Production live smoke could not complete');
  error.code = code;
  return error;
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function emailRecipients(value) {
  const recipients = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (recipients.some((item) => item.length > 320 || /[\r\n]/.test(item))) {
    throw smokeError('SMOKE_EMAIL_INVALID');
  }
  return recipients;
}

export function validateSmokeEnvironment(env = process.env) {
  if (
    String(env.PANDA_DATA_ENABLED || '').toLowerCase() !== 'true'
    || !String(env.PANDA_DATA_USERNAME || '').trim()
    || !String(env.PANDA_DATA_PASSWORD || '')
  ) {
    throw smokeError('SMOKE_NOT_CONFIGURED');
  }
  const reportDate = String(env.MARKET_SMOKE_REPORT_DATE || '').trim();
  if (reportDate && !realDate(reportDate)) {
    throw smokeError('SMOKE_DATE_INVALID');
  }
  const recipients = emailRecipients(env.MARKET_SMOKE_EMAIL_TO);
  if (recipients.length && (
    !String(env.MARKET_REPORT_EMAIL_FROM || '').trim()
    || !String(env.MARKET_REPORT_SMTP_HOST || '').trim()
  )) {
    throw smokeError('SMOKE_SMTP_NOT_CONFIGURED');
  }
  return Object.freeze({
    reportDate: reportDate || null,
    emailEnabled: recipients.length > 0,
    recipients
  });
}

function safeValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > 5) return '[truncated]';
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  if (typeof value === 'string') {
    return /Bearer\s+\S+/i.test(value)
      ? '[redacted]'
      : value.slice(0, 1000);
  }
  if (value instanceof Error) {
    return {
      name: String(value.name || 'Error').slice(0, 100),
      code: String(value.code || 'SMOKE_FAILED').slice(0, 100)
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => safeValue(item, depth + 1, seen));
  }
  if (typeof value !== 'object') return String(value).slice(0, 1000);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    const safeKey = String(key).slice(0, 100);
    result[safeKey] = SENSITIVE_KEY.test(safeKey)
      ? '[redacted]'
      : safeValue(item, depth + 1, seen);
  }
  return result;
}

export function sanitizeSmokeSummary(value) {
  const safe = safeValue(value);
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded) <= MAX_SUMMARY_BYTES) return safe;
  return {
    status: typeof safe?.status === 'string' ? safe.status.slice(0, 100) : 'FAILED',
    error: safe?.error && typeof safe.error === 'object'
      ? safe.error
      : { code: 'SMOKE_SUMMARY_TRUNCATED' },
    truncated: true
  };
}

function dateCandidates(explicitDate, now = new Date()) {
  if (explicitDate) return [explicitDate];
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now).map(({ type, value }) => [type, value])
  );
  const start = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day)
  ));
  if (Number(parts.hour) < 15) start.setUTCDate(start.getUTCDate() - 1);
  const dates = [];
  for (let offset = 0; offset < 14 && dates.length < 10; offset += 1) {
    const candidate = new Date(start);
    candidate.setUTCDate(start.getUTCDate() - offset);
    if (![0, 6].includes(candidate.getUTCDay())) {
      dates.push(candidate.toISOString().slice(0, 10));
    }
  }
  return dates;
}

function artifactPath(config, summary, name) {
  return path.join(
    path.resolve(config.stateDir),
    'artifacts',
    summary.reportDate,
    summary.runId,
    name
  );
}

async function boundedRead(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ARTIFACT_BYTES) throw smokeError('SMOKE_ARTIFACT_TOO_LARGE');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function verifyPandaSdk(python) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      python,
      [
        '-c',
        "from importlib.metadata import version; print(version('panda-data'))"
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024,
        env: { PATH: process.env.PATH || '' }
      }
    ));
  } catch {
    throw smokeError('SMOKE_PANDA_SDK_UNAVAILABLE');
  }
  if (String(stdout).trim() !== '0.0.12') {
    throw smokeError('SMOKE_PANDA_SDK_VERSION');
  }
}

async function validateArtifacts(config, summary) {
  const required = new Map([
    ['market-report.md', null],
    ['market-report.html', null],
    ['market-report.txt', null],
    ['evidence-pack.json', null],
    ['run-trace.json', null]
  ]);
  for (const artifact of summary.artifacts || []) {
    if (required.has(artifact.name)) required.set(artifact.name, artifact);
  }
  if ([...required.values()].some((value) => !value)) {
    throw smokeError('SMOKE_ARTIFACT_MISSING');
  }
  const loaded = {};
  for (const [name, metadata] of required) {
    const content = await boundedRead(artifactPath(config, summary, name));
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== metadata.sha256 || content.length !== metadata.size) {
      throw smokeError('SMOKE_ARTIFACT_INTEGRITY');
    }
    loaded[name] = content;
  }
  if (
    !loaded['market-report.md'].length
    || !loaded['market-report.html'].length
    || !loaded['market-report.txt'].length
  ) {
    throw smokeError('SMOKE_REPORT_EMPTY');
  }
  let evidence;
  let trace;
  try {
    evidence = JSON.parse(loaded['evidence-pack.json'].toString('utf8'));
    trace = JSON.parse(loaded['run-trace.json'].toString('utf8'));
  } catch {
    throw smokeError('SMOKE_ARTIFACT_INVALID');
  }
  validateEvidencePack(evidence);
  if (
    evidence.runId !== summary.runId
    || evidence.reportDate !== summary.reportDate
    || trace.runId !== summary.runId
  ) {
    throw smokeError('SMOKE_ARTIFACT_IDENTITY');
  }
  return {
    evidenceStatus: evidence.status,
    conclusionCount: evidence.conclusions.length,
    sourceCount: evidence.sources.length,
    artifactCount: required.size
  };
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw smokeError('SMOKE_HTTP_FAILED');
  }
  if (!response.ok) throw smokeError('SMOKE_HTTP_STATUS');
  try {
    return await response.json();
  } catch {
    throw smokeError('SMOKE_HTTP_INVALID_JSON');
  }
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function findCompletedReport(orchestrator, smoke) {
  for (const date of dateCandidates(smoke.reportDate)) {
    const summary = await orchestrator.run({
      operation: { operation: 'daily-market-report', date, topN: 3 },
      trigger: 'manual',
      owner: 'production-live-smoke',
      deliverEmail: smoke.emailEnabled
    });
    if (summary.outcome === 'skipped' && !smoke.reportDate) continue;
    if (!['complete', 'degraded'].includes(summary.outcome)) {
      throw smokeError('SMOKE_PANDA_RUN_FAILED');
    }
    if (
      smoke.emailEnabled
      && !['sent', 'already-sent'].includes(summary.emailStatus)
    ) {
      throw smokeError('SMOKE_EMAIL_FAILED');
    }
    return summary;
  }
  throw smokeError('SMOKE_COMPLETED_DATE_NOT_FOUND');
}

async function verifyEmailIdempotency(orchestrator, smoke, report) {
  if (!smoke.emailEnabled) return 'not-requested';
  const replay = await orchestrator.run({
    operation: {
      operation: 'daily-market-report',
      date: report.reportDate,
      topN: 3
    },
    trigger: 'manual',
    owner: 'production-live-smoke',
    deliverEmail: true
  });
  if (
    replay.runId !== report.runId
    || replay.emailStatus !== 'already-sent'
  ) {
    throw smokeError('SMOKE_EMAIL_IDEMPOTENCY_FAILED');
  }
  return replay.emailStatus;
}

async function verifyA2A(config, orchestrator, token, reportDate) {
  const server = createMarketAgentServer({
    config: { ...config, host: '127.0.0.1', port: 0, accessToken: token },
    orchestrator
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw smokeError('SMOKE_A2A_BIND_FAILED');
    const base = `http://127.0.0.1:${address.port}`;
    const card = await fetchJson(`${base}/.well-known/agent-card.json`);
    if (
      !Array.isArray(card.supportedInterfaces)
      || !card.supportedInterfaces.some((item) =>
        item.protocolBinding === 'HTTP+JSON' && item.protocolVersion === '1.0')
    ) {
      throw smokeError('SMOKE_A2A_CARD_INVALID');
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'A2A-Version': '1.0',
      'Content-Type': 'application/a2a+json'
    };
    const sent = await fetchJson(`${base}/a2a/v1/message:send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: {
          messageId: `live-smoke-${randomUUID()}`,
          role: 'ROLE_USER',
          parts: [{
            mediaType: 'application/json',
            data: {
              operation: 'daily-market-report',
              date: reportDate,
              topN: 3
            }
          }]
        },
        configuration: {
          returnImmediately: true,
          acceptedOutputModes: ['text/markdown', 'application/json']
        }
      })
    });
    const taskId = sent.task?.id;
    if (typeof taskId !== 'string' || !taskId) throw smokeError('SMOKE_A2A_TASK_INVALID');
    const deadline = Date.now() + Math.min(config.workerTimeoutMs + 60_000, 15 * 60_000);
    let task = sent.task;
    while (!TERMINAL_STATES.has(task?.status?.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const value = await fetchJson(
        `${base}/a2a/v1/tasks/${encodeURIComponent(taskId)}?historyLength=0`,
        { headers }
      );
      task = value.task;
    }
    if (task?.status?.state !== 'TASK_STATE_COMPLETED') {
      throw smokeError('SMOKE_A2A_TASK_FAILED');
    }
    const names = new Set((task.artifacts || []).map(({ name }) => name));
    for (const name of ['market-report.md', 'evidence-pack.json', 'run-trace.json']) {
      if (!names.has(name)) throw smokeError('SMOKE_A2A_ARTIFACT_MISSING');
    }
    return {
      cardVersion: card.supportedInterfaces[0].protocolVersion,
      taskState: task.status.state,
      artifactCount: task.artifacts.length
    };
  } finally {
    await closeServer(server);
  }
}

export async function runLiveSmoke(env = process.env, cwd = process.cwd()) {
  const smoke = validateSmokeEnvironment(env);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'panda-market-live-smoke-'));
  const token = randomBytes(32).toString('hex');
  try {
    const configEnv = {
      ...env,
      MARKET_AGENT_HOST: '127.0.0.1',
      MARKET_AGENT_PORT: '4190',
      MARKET_AGENT_PUBLIC_BASE_URL: '',
      MARKET_AGENT_ACCESS_TOKEN: token,
      MARKET_AGENT_ALLOW_INSECURE_LOOPBACK: 'false',
      MARKET_REPORT_STATE_DIR: stateDir,
      MARKET_REPORT_EMAIL_TO: smoke.recipients.join(','),
      MARKET_REPORT_MODEL_ENABLED: 'false'
    };
    const config = marketAgentConfig(configEnv, cwd);
    await verifyPandaSdk(config.python);
    const mailer = smoke.emailEnabled ? createSmtpMailer(config) : undefined;
    const orchestrator = new MarketOrchestrator(config, { mailer });
    const report = await findCompletedReport(orchestrator, smoke);
    const artifacts = await validateArtifacts(config, report);
    const emailReplay = await verifyEmailIdempotency(orchestrator, smoke, report);
    const a2a = await verifyA2A(config, orchestrator, token, report.reportDate);
    return sanitizeSmokeSummary({
      status: report.outcome === 'degraded' ? 'DEGRADED' : 'COMPLETE',
      reportDate: report.reportDate,
      artifactCount: artifacts.artifactCount,
      conclusionCount: artifacts.conclusionCount,
      sourceCount: artifacts.sourceCount,
      evidenceStatus: artifacts.evidenceStatus,
      email: smoke.emailEnabled ? report.emailStatus : 'not-requested',
      emailReplay,
      a2a
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = await runLiveSmoke();
    process.stdout.write(`${JSON.stringify(sanitizeSmokeSummary(result))}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify(sanitizeSmokeSummary({
      status: 'FAILED',
      error
    }))}\n`);
  }
}
