import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { normalizeOwnerScope } from './owner-scope.js';
import { readVerifiedArtifact } from './orchestrator.js';
import { sanitizeTraceValue } from './run-trace.js';
import { validateEvidencePack, validateOperation } from './schemas.js';

const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED'
]);
const MAX_HISTORY = 32;
const MAX_ARTIFACTS = 16;
const MAX_SUBSCRIBERS = 64;
const MAX_STREAM_ARTIFACT_BYTES = 48 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TASKS = 128;
const DEFAULT_MAX_ACTIVE_TASKS = 32;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_ID_PATTERN = /^[a-z0-9._-]{1,128}$/i;
const A2A_ARTIFACT_MEDIA_TYPES = Object.freeze({
  'market-report.md': 'text/markdown',
  'evidence-pack.json': 'application/json',
  'run-trace.json': 'application/json'
});
const SUPPORTED_OUTPUT_MODES = Object.freeze([
  'text/markdown',
  'application/json'
]);
const UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const ANALYTICAL_PROJECTIONS = Object.freeze({
  'hot-topic-analysis': {
    sectionId: 'hot-topics',
    leaderboardKeys: ['hotIndustries', 'hotConcepts']
  },
  'sell-pressure-scan': {
    sectionId: 'sell-pressure',
    leaderboardKeys: ['sellPressure']
  },
  'potential-watchlist': {
    sectionId: 'potential-watchlist',
    leaderboardKeys: ['potentialWatchlist']
  }
});

const KEYWORD_ROUTES = [
  ['inspect-run-trace', /(?:运行溯源|运行追踪|调用链|run[\s_-]*trace|trace)/i],
  ['sell-pressure-scan', /(?:卖压|抛压|sell[\s_-]*pressure)/i],
  ['potential-watchlist', /(?:潜力|研究候选|潜力观察|potential|watchlist)/i],
  ['hot-topic-analysis', /(?:热点|热门|热度|行业|概念|hot[\s_-]*topic)/i],
  ['daily-market-report', /(?:每日市场报告|市场报告|收盘报告|收盘复盘|日报|daily[\s_-]*(?:market[\s_-]*)?report|生成报告)/i]
];

export class MarketA2AError extends Error {
  constructor(reason, message, options = {}) {
    super(message);
    this.name = 'MarketA2AError';
    this.reason = reason;
    this.statusCode = options.statusCode || 400;
    this.status = options.status || 'INVALID_ARGUMENT';
    this.metadata = options.metadata || {};
  }
}

export function marketA2AError(reason, message, options) {
  return new MarketA2AError(reason, message, options);
}

function invalidRequest(message, metadata = {}) {
  return marketA2AError('INVALID_REQUEST', message, {
    statusCode: 400,
    status: 'INVALID_ARGUMENT',
    metadata
  });
}

function unsupportedOperation(message = 'The requested operation is not supported') {
  return marketA2AError('UNSUPPORTED_OPERATION', message, {
    statusCode: 400,
    status: 'FAILED_PRECONDITION'
  });
}

function parseHistoryLength(value, field = 'historyLength') {
  if (value === undefined) return MAX_HISTORY;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_HISTORY) {
    throw invalidRequest(`${field} must be an integer from 0 to ${MAX_HISTORY}`, { field });
  }
  return value;
}

function parseAcceptedOutputModes(value) {
  if (value === undefined) return [...SUPPORTED_OUTPUT_MODES];
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > SUPPORTED_OUTPUT_MODES.length
    || value.some((mode) => !SUPPORTED_OUTPUT_MODES.includes(mode))
  ) {
    throw invalidRequest(
      'configuration.acceptedOutputModes must contain only text/markdown or application/json',
      { field: 'configuration.acceptedOutputModes' }
    );
  }
  return [...new Set(value)];
}

function isValidUtcInstant(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(UTC_INSTANT_PATTERN);
  if (!match) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function taskNotFound(id) {
  return marketA2AError('TASK_NOT_FOUND', 'The specified task does not exist or is not accessible', {
    statusCode: 404,
    status: 'NOT_FOUND',
    metadata: { taskId: id }
  });
}

function taskNotCancelable(id) {
  return marketA2AError('TASK_NOT_CANCELABLE', 'The task is not in a cancelable state', {
    statusCode: 400,
    status: 'FAILED_PRECONDITION',
    metadata: { taskId: id }
  });
}

function cleanOwner(value) {
  return normalizeOwnerScope(value);
}

function boundedMessage(message) {
  const serialized = JSON.stringify(message);
  if (Buffer.byteLength(serialized) > MAX_TEXT_BYTES) {
    throw invalidRequest('message exceeds safe bounds', { field: 'message' });
  }
  return sanitizeTraceValue(message);
}

function textOperation(text) {
  const route = KEYWORD_ROUTES.find(([, pattern]) => pattern.test(text));
  if (!route) throw unsupportedOperation('No declared market operation matches the message');
  const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  return validateOperation({ operation: route[0], ...(date ? { date } : {}) });
}

function parseRunId(value, text) {
  const candidate = value ?? text?.match(/\brun-[a-z0-9._-]+\b/i)?.[0];
  if (typeof candidate !== 'string' || !RUN_ID_PATTERN.test(candidate)) {
    throw invalidRequest('inspect-run-trace requires a bounded runId', { field: 'runId' });
  }
  return candidate;
}

function parseOperation(parts) {
  const dataPart = parts.find((part) => Object.hasOwn(part, 'data'));
  if (dataPart) {
    if (!dataPart.data || typeof dataPart.data !== 'object' || Array.isArray(dataPart.data)) {
      throw invalidRequest('structured operation data must be an object', {
        field: 'message.parts.data'
      });
    }
    let operation;
    try {
      operation = validateOperation(dataPart.data);
    } catch (error) {
      if (error instanceof RangeError && /operation/i.test(error.message)) {
        throw unsupportedOperation(error.message);
      }
      throw invalidRequest(error.message, { field: 'message.parts.data' });
    }
    return {
      operation,
      ...(operation.operation === 'inspect-run-trace'
        ? { runId: parseRunId(dataPart.data.runId) }
        : {})
    };
  }
  const text = parts.map((part) => part.text || '').join('\n').trim();
  if (!text) throw invalidRequest('message must contain a text or data part');
  let operation;
  try {
    operation = textOperation(text);
  } catch (error) {
    if (error instanceof MarketA2AError) throw error;
    throw invalidRequest(error.message);
  }
  return {
    operation,
    ...(operation.operation === 'inspect-run-trace'
      ? { runId: parseRunId(undefined, text) }
      : {})
  };
}

function parseSendRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('request payload must be an object');
  }
  if (
    body.configuration?.taskPushNotificationConfig
    || body.configuration?.pushNotificationConfig
    || body.taskPushNotificationConfig
    || body.pushNotificationConfig
  ) {
    throw marketA2AError(
      'PUSH_NOTIFICATION_NOT_SUPPORTED',
      'Push notifications are not supported',
      { statusCode: 400, status: 'FAILED_PRECONDITION' }
    );
  }
  const configuration = body.configuration === undefined ? {} : body.configuration;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw invalidRequest('configuration must be an object', { field: 'configuration' });
  }
  const message = body.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw invalidRequest('message is required', { field: 'message' });
  }
  if (
    typeof message.messageId !== 'string'
    || !message.messageId
    || message.messageId.length > 200
  ) {
    throw invalidRequest('message.messageId is required and must be bounded', {
      field: 'message.messageId'
    });
  }
  if (message.role !== 'ROLE_USER') {
    throw invalidRequest('message.role must be ROLE_USER', { field: 'message.role' });
  }
  if (
    message.taskId !== undefined
    && (
      typeof message.taskId !== 'string'
      || !message.taskId
      || message.taskId.length > 200
    )
  ) {
    throw invalidRequest('message.taskId must be a nonempty bounded string', {
      field: 'message.taskId'
    });
  }
  if (
    message.contextId !== undefined
    && (
      typeof message.contextId !== 'string'
      || !message.contextId
      || message.contextId.length > 200
    )
  ) {
    throw invalidRequest('message.contextId must be a nonempty bounded string', {
      field: 'message.contextId'
    });
  }
  if (
    !Array.isArray(message.parts)
    || message.parts.length < 1
    || message.parts.length > 32
  ) {
    throw invalidRequest('message.parts must contain 1 to 32 parts', {
      field: 'message.parts'
    });
  }
  for (const [index, part] of message.parts.entries()) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw invalidRequest('each message part must be an object', {
        field: `message.parts[${index}]`
      });
    }
    const contentKeys = ['text', 'data', 'raw', 'url'].filter((key) =>
      Object.hasOwn(part, key)
    );
    if (contentKeys.length !== 1) {
      throw invalidRequest('each message part must contain exactly one content field', {
        field: `message.parts[${index}]`
      });
    }
    if (!['text', 'data'].includes(contentKeys[0])) {
      throw marketA2AError(
        'CONTENT_TYPE_NOT_SUPPORTED',
        'Only text and structured data message parts are supported',
        { statusCode: 400, status: 'INVALID_ARGUMENT' }
      );
    }
    if (contentKeys[0] === 'text' && typeof part.text !== 'string') {
      throw invalidRequest('text parts must contain strings', {
        field: `message.parts[${index}].text`
      });
    }
    const expectedMediaType = contentKeys[0] === 'text'
      ? 'text/plain'
      : 'application/json';
    if (part.mediaType !== undefined && part.mediaType !== expectedMediaType) {
      throw marketA2AError(
        'CONTENT_TYPE_NOT_SUPPORTED',
        `${contentKeys[0]} parts must use ${expectedMediaType}`,
        {
          statusCode: 400,
          status: 'INVALID_ARGUMENT',
          metadata: { field: `message.parts[${index}].mediaType` }
        }
      );
    }
  }
  const parsed = message.taskId ? {} : parseOperation(message.parts);
  return {
    message: boundedMessage(message),
    taskId: message.taskId,
    operation: parsed.operation,
    runId: parsed.runId,
    contextId: message.contextId !== undefined
      ? message.contextId
      : message.taskId
        ? undefined
        : randomUUID(),
    returnImmediately: configuration.returnImmediately === true,
    responseOptions: {
      historyLength: parseHistoryLength(
        configuration.historyLength,
        'configuration.historyLength'
      ),
      acceptedOutputModes: parseAcceptedOutputModes(configuration.acceptedOutputModes)
    }
  };
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('clock returned an invalid date');
  return date.toISOString();
}

function statusMessage(record, state, text, at) {
  return {
    state,
    message: {
      messageId: randomUUID(),
      taskId: record.id,
      contextId: record.contextId,
      role: 'ROLE_AGENT',
      parts: [{ text, mediaType: 'text/plain' }]
    },
    timestamp: at
  };
}

function clone(value) {
  return structuredClone(value);
}

function boundedText(value) {
  const text = String(value || '');
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text;
  return `${Buffer.from(text).subarray(0, MAX_TEXT_BYTES).toString('utf8')}\n[TRUNCATED]`;
}

function outputState(summary) {
  if (TERMINAL_STATES.has(summary?.taskState)) return summary.taskState;
  if (summary?.outcome === 'canceled') return 'TASK_STATE_CANCELED';
  if (summary?.outcome === 'rejected') return 'TASK_STATE_REJECTED';
  if (summary?.outcome === 'failed') return 'TASK_STATE_FAILED';
  return 'TASK_STATE_COMPLETED';
}

function terminalText(state) {
  return {
    TASK_STATE_COMPLETED: 'Market analysis completed',
    TASK_STATE_FAILED: 'Market analysis failed',
    TASK_STATE_CANCELED: 'Market analysis canceled',
    TASK_STATE_REJECTED: 'Market analysis rejected'
  }[state] || 'Market analysis stopped';
}

function mediaTypeFor(name, fallback) {
  if (fallback) return fallback;
  if (name?.endsWith('.md')) return 'text/markdown';
  if (name?.endsWith('.json')) return 'application/json';
  if (name?.endsWith('.html')) return 'text/html';
  return 'text/plain';
}

function artifactId(taskId, name, index) {
  return `${taskId}-${index + 1}-${String(name || 'artifact')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 80)}`;
}

function protectedArtifactUrl(runId, name) {
  if (!runId) return null;
  const suffix = {
    'market-report.md': 'report',
    'evidence-pack.json': 'evidence',
    'run-trace.json': 'trace'
  }[name];
  return suffix ? `/runs/${encodeURIComponent(runId)}/${suffix}` : null;
}

function streamArtifact(artifact, runId, taskId) {
  if (Buffer.byteLength(JSON.stringify(artifact)) <= MAX_STREAM_ARTIFACT_BYTES) {
    return artifact;
  }
  const url = protectedArtifactUrl(runId, artifact.name);
  const mediaType = artifact.parts?.[0]?.mediaType || mediaTypeFor(artifact.name);
  if (artifact.metadata?.projected === true) {
    const message = `Fetch /a2a/v1/tasks/${encodeURIComponent(taskId)} for the complete projected artifact`;
    return {
      ...artifact,
      parts: mediaType === 'text/markdown'
        ? [{ text: `# Projected artifact truncated for stream\n\n${message}`, mediaType }]
        : [{
            data: { truncated: true, name: artifact.name, message },
            mediaType
          }],
      metadata: {
        ...(artifact.metadata || {}),
        truncatedForStream: true
      }
    };
  }
  return {
    ...artifact,
    parts: url
      ? [{ url, mediaType }]
      : [{
          data: {
            truncated: true,
            name: artifact.name,
            message: 'Fetch the protected run detail for the complete artifact'
          },
          mediaType: 'application/json'
        }],
    metadata: {
      ...(artifact.metadata || {}),
      truncatedForStream: true
    }
  };
}

function partData(artifact) {
  return artifact?.parts?.find((part) => part && typeof part === 'object')?.data;
}

function projectedMarkdown(operation, evidence, keys) {
  const lines = [
    `# ${operation}`,
    '',
    `Report date: ${String(evidence?.reportDate || 'unavailable')}`
  ];
  for (const key of keys) {
    lines.push(
      '',
      `## ${key}`,
      '',
      '```json',
      JSON.stringify(evidence?.leaderboards?.[key] || [], null, 2),
      '```'
    );
  }
  return lines.join('\n');
}

function projectedMetadata(artifact) {
  const {
    size: _sourceSize,
    sha256: _sourceSha256,
    ...metadata
  } = artifact.metadata || {};
  return { ...metadata, projected: true };
}

function projectAnalyticalArtifacts(operation, artifacts, expectedRunId) {
  const projection = ANALYTICAL_PROJECTIONS[operation];
  if (!projection) return artifacts;
  const evidenceArtifact = artifacts.find(({ name }) => name === 'evidence-pack.json');
  const sourceEvidence = partData(evidenceArtifact) || {};
  if (expectedRunId && sourceEvidence.runId !== expectedRunId) {
    throw new TypeError('Projected Evidence Pack identity does not match the authorized run');
  }
  const conclusions = Array.isArray(sourceEvidence.conclusions)
    ? sourceEvidence.conclusions.filter((item) => {
        const leaderboards = String(item?.leaderboard || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        return item?.sectionId === projection.sectionId
          || item?.skillId === operation
          || projection.leaderboardKeys.some((key) => leaderboards.includes(key));
      })
    : [];
  const sourceIds = new Set(conclusions.flatMap((item) =>
    Array.isArray(item?.sourceIds) ? item.sourceIds : []
  ));
  const evidence = {
    schemaVersion: sourceEvidence.schemaVersion,
    runId: sourceEvidence.runId,
    reportDate: sourceEvidence.reportDate,
    status: sourceEvidence.status,
    markets: {},
    ...(sourceEvidence.skipReason === undefined
      ? {}
      : { skipReason: clone(sourceEvidence.skipReason) }),
    ...(sourceEvidence.metricVersion === undefined
      ? {}
      : { metricVersion: clone(sourceEvidence.metricVersion) }),
    requestedOperation: operation,
    conclusions: clone(conclusions),
    leaderboards: Object.fromEntries(projection.leaderboardKeys.map((key) => [
      key,
      clone(sourceEvidence.leaderboards?.[key] || [])
    ])),
    excluded: Object.fromEntries(projection.leaderboardKeys
      .filter((key) => sourceEvidence.excluded?.[key] !== undefined)
      .map((key) => [key, clone(sourceEvidence.excluded[key])])),
    sources: Array.isArray(sourceEvidence.sources)
      ? clone(sourceEvidence.sources.filter(({ id }) => sourceIds.has(id)))
      : [],
    missingData: Array.isArray(sourceEvidence.missingData)
      ? clone(sourceEvidence.missingData.filter(({ section }) =>
          projection.leaderboardKeys.includes(section)
        ))
      : []
  };
  validateEvidencePack(evidence);
  return artifacts.map((artifact) => {
    if (artifact.name === 'market-report.md') {
      return {
        ...artifact,
        parts: [{
          text: projectedMarkdown(operation, evidence, projection.leaderboardKeys),
          mediaType: 'text/markdown'
        }],
        metadata: projectedMetadata(artifact)
      };
    }
    if (artifact.name === 'evidence-pack.json') {
      return {
        ...artifact,
        parts: [{ data: evidence, mediaType: 'application/json' }],
        metadata: projectedMetadata(artifact)
      };
    }
    if (artifact.name === 'run-trace.json') {
      const sourceTrace = partData(artifact) || {};
      const trace = {
        schemaVersion: sourceTrace.schemaVersion,
        runId: sourceTrace.runId,
        startedAt: sourceTrace.startedAt,
        endedAt: sourceTrace.endedAt,
        durationMs: sourceTrace.durationMs,
        requestedOperation: operation,
        steps: Array.isArray(sourceTrace.steps)
          ? clone(sourceTrace.steps.filter((step) => step?.skillId === operation))
          : []
      };
      return {
        ...artifact,
        parts: [{ data: trace, mediaType: 'application/json' }],
        metadata: projectedMetadata(artifact)
      };
    }
    return artifact;
  });
}

function encodePageToken(record) {
  return Buffer.from(JSON.stringify({
    statusTimestamp: record.status.timestamp,
    id: record.id
  }), 'utf8').toString('base64url');
}

function decodePageToken(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (
      !parsed
      || typeof parsed.statusTimestamp !== 'string'
      || new Date(parsed.statusTimestamp).toISOString() !== parsed.statusTimestamp
      || typeof parsed.id !== 'string'
      || parsed.id.length < 1
      || parsed.id.length > 250
    ) {
      throw new Error('invalid cursor');
    }
    return {
      statusTimestamp: parsed.statusTimestamp,
      id: parsed.id
    };
  } catch {
    throw invalidRequest('pageToken is invalid', { field: 'pageToken' });
  }
}

function boundedPositiveInteger(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return number;
}

export class MarketTaskService {
  constructor(options = {}) {
    if (!options.orchestrator || typeof options.orchestrator.run !== 'function') {
      throw new TypeError('orchestrator.run is required');
    }
    this.orchestrator = options.orchestrator;
    this.config = options.config || {};
    this.runLoader = options.runLoader;
    this.artifactLoader = options.artifactLoader;
    this.clock = options.clock || (() => new Date());
    this.createId = options.createId || randomUUID;
    this.maxTasks = boundedPositiveInteger(
      options.maxTasks,
      DEFAULT_MAX_TASKS,
      10_000,
      'maxTasks'
    );
    this.maxActiveTasks = boundedPositiveInteger(
      options.maxActiveTasks,
      Math.min(DEFAULT_MAX_ACTIVE_TASKS, this.maxTasks),
      this.maxTasks,
      'maxActiveTasks'
    );
    this.retentionMs = boundedPositiveInteger(
      options.retentionMs,
      DEFAULT_RETENTION_MS,
      365 * 24 * 60 * 60 * 1000,
      'retentionMs'
    );
    this.tasks = new Map();
    this.idempotency = new Map();
  }

  submit({ owner, request }) {
    const safeOwner = cleanOwner(owner);
    const parsed = parseSendRequest(request);
    const key = `${safeOwner}\u0000${parsed.message.messageId}`;
    const now = timestamp(this.clock);
    this.#prune(Date.parse(now));
    if (parsed.taskId) {
      const record = this.#visibleRecord(parsed.taskId, safeOwner);
      if (
        parsed.contextId !== undefined
        && parsed.contextId !== record.contextId
      ) {
        throw invalidRequest('message.contextId must match the specified task', {
          field: 'message.contextId'
        });
      }
      const duplicateId = this.idempotency.get(key);
      if (duplicateId === record.id) {
        return {
          task: this.#publicTask(record, parsed.responseOptions),
          duplicate: true,
          returnImmediately: parsed.returnImmediately,
          responseOptions: parsed.responseOptions
        };
      }
      if (duplicateId) {
        throw invalidRequest('message.messageId is already associated with another task', {
          field: 'message.messageId'
        });
      }
      throw unsupportedOperation(
        'Deterministic market operations cannot be changed after submission'
      );
    }
    const duplicateId = this.idempotency.get(key);
    if (duplicateId) {
      const duplicate = this.tasks.get(duplicateId);
      return {
        task: this.#publicTask(duplicate, parsed.responseOptions),
        duplicate: true,
        returnImmediately: parsed.returnImmediately,
        responseOptions: parsed.responseOptions
      };
    }
    const activeCount = [...this.tasks.values()].filter(
      (record) => !TERMINAL_STATES.has(record.status.state)
    ).length;
    if (activeCount >= this.maxActiveTasks) {
      throw marketA2AError(
        'RESOURCE_EXHAUSTED',
        'The server has reached its active task limit',
        { statusCode: 429, status: 'RESOURCE_EXHAUSTED' }
      );
    }
    this.#makeRoom();
    const id = `task-${String(this.createId())}`;
    const record = {
      id,
      owner: safeOwner,
      idempotencyKey: key,
      messageId: parsed.message.messageId,
      operation: parsed.operation,
      requestedRunId: parsed.runId,
      contextId: parsed.contextId,
      status: {
        state: 'TASK_STATE_SUBMITTED',
        timestamp: now
      },
      history: [parsed.message].slice(-MAX_HISTORY),
      artifacts: [],
      acceptedOutputModes: parsed.responseOptions.acceptedOutputModes,
      createdAt: now,
      lastModified: now,
      emitter: new EventEmitter(),
      controller: new AbortController(),
      settled: false,
      summary: null
    };
    record.history = [{
      ...parsed.message,
      taskId: record.id,
      contextId: record.contextId
    }];
    record.idempotencyKeys = [key];
    record.emitter.setMaxListeners(100);
    record.done = new Promise((resolve) => {
      record.resolveDone = resolve;
    });
    this.tasks.set(id, record);
    this.idempotency.set(key, id);
    queueMicrotask(() => this.#execute(record));
    return {
      task: this.#publicTask(record, parsed.responseOptions),
      duplicate: false,
      returnImmediately: parsed.returnImmediately,
      responseOptions: parsed.responseOptions
    };
  }

  async wait(id, owner, options = {}) {
    const record = this.#visibleRecord(id, owner);
    if (!TERMINAL_STATES.has(record.status.state)) await record.done;
    return this.#publicTask(record, options);
  }

  get(id, owner, options = {}) {
    return this.#publicTask(this.#visibleRecord(id, owner), options);
  }

  list(owner, filters = {}) {
    const safeOwner = cleanOwner(owner);
    let records = [...this.tasks.values()].filter((record) => record.owner === safeOwner);
    if (filters.contextId) {
      records = records.filter((record) => record.contextId === filters.contextId);
    }
    if (filters.status) {
      records = records.filter((record) => record.status.state === filters.status);
    }
    if (filters.statusTimestampAfter !== undefined) {
      if (!isValidUtcInstant(filters.statusTimestampAfter)) {
        throw invalidRequest('statusTimestampAfter must be a valid UTC instant', {
          field: 'statusTimestampAfter'
        });
      }
      const after = new Date(filters.statusTimestampAfter);
      records = records.filter((record) =>
        new Date(record.status.timestamp).getTime() >= after.getTime()
      );
    }
    records.sort((left, right) =>
      right.status.timestamp.localeCompare(left.status.timestamp)
      || right.id.localeCompare(left.id)
    );
    const totalSize = records.length;
    const requestedPageSize = filters.pageSize === undefined
      ? 50
      : typeof filters.pageSize === 'string'
        && /^[1-9][0-9]*$/.test(filters.pageSize)
        ? Number(filters.pageSize)
        : filters.pageSize;
    if (
      (
        typeof filters.pageSize === 'string'
        && !/^[1-9][0-9]*$/.test(filters.pageSize)
      )
      ||
      !Number.isSafeInteger(requestedPageSize)
      || requestedPageSize < 1
      || requestedPageSize > 100
    ) {
      throw invalidRequest('pageSize must be an integer from 1 to 100', {
        field: 'pageSize'
      });
    }
    const pageSize = requestedPageSize;
    const cursor = decodePageToken(filters.pageToken);
    if (cursor) {
      records = records.filter((record) =>
        record.status.timestamp < cursor.statusTimestamp
        || (
          record.status.timestamp === cursor.statusTimestamp
          && record.id < cursor.id
        )
      );
    }
    const page = records.slice(0, pageSize);
    return {
      tasks: page.map((record) => this.#publicTask(record, {
        historyLength: filters.historyLength,
        includeArtifacts: filters.includeArtifacts === true
      })),
      nextPageToken: records.length > page.length ? encodePageToken(page.at(-1)) : '',
      pageSize,
      totalSize
    };
  }

  cancel(id, owner) {
    const record = this.#visibleRecord(id, owner);
    if (record.status.state === 'TASK_STATE_CANCELED') return this.#publicTask(record);
    if (TERMINAL_STATES.has(record.status.state)) throw taskNotCancelable(id);
    record.controller.abort(new Error('A2A task canceled'));
    this.#finish(record, 'TASK_STATE_CANCELED', 'Market analysis canceled');
    return this.#publicTask(record);
  }

  isTerminal(id, owner) {
    return TERMINAL_STATES.has(this.#visibleRecord(id, owner).status.state);
  }

  subscribe(id, owner, listener, options = {}) {
    const record = this.#visibleRecord(id, owner);
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (record.emitter.listenerCount('event') >= MAX_SUBSCRIBERS) {
      throw marketA2AError(
        'RESOURCE_EXHAUSTED',
        'The task has reached its active subscription limit',
        { statusCode: 429, status: 'RESOURCE_EXHAUSTED', metadata: { taskId: id } }
      );
    }
    const outputModes = options.acceptedOutputModes || record.acceptedOutputModes;
    const filteredListener = (event) => {
      const artifact = event?.artifactUpdate?.artifact;
      if (
        artifact
        && !outputModes.includes(artifact.parts?.[0]?.mediaType)
      ) {
        return;
      }
      listener(event);
    };
    record.emitter.on('event', filteredListener);
    return () => record.emitter.off('event', filteredListener);
  }

  async loadRun(runId, owner) {
    const { run, safeOwner } = await this.#loadOwnedRun(runId, owner);
    const artifacts = await this.#materializeProjectedRunArtifacts(run, safeOwner);
    return this.#publicRun({ ...run, artifacts });
  }

  async loadRunArtifacts(runId, owner) {
    const { run, safeOwner } = await this.#loadOwnedRun(runId, owner);
    return this.#materializeProjectedRunArtifacts(run, safeOwner);
  }

  async #loadOwnedRun(runId, owner) {
    if (!RUN_ID_PATTERN.test(String(runId || ''))) throw taskNotFound(runId);
    const safeOwner = cleanOwner(owner);
    let run;
    let ownerAttested = false;
    if (typeof this.runLoader === 'function') {
      run = await this.runLoader(runId, safeOwner);
      ownerAttested = run?.runId === runId && run?.ownerScope === safeOwner;
    } else {
      if (this.orchestrator.store?.list) {
        const stored = await this.orchestrator.store.list({ ownerScope: safeOwner });
        run = stored.find((candidate) => candidate.runId === runId);
        ownerAttested = run?.ownerScope === safeOwner;
      }
    }
    if (!run || !ownerAttested) {
      throw taskNotFound(runId);
    }
    return { run, safeOwner };
  }

  async #materializeProjectedRunArtifacts(run, safeOwner) {
    const requestedOperation = run.requestedOperation || run.operation;
    const artifacts = await this.#materializeArtifacts(run, {
      id: `run-${run.runId}`,
      contextId: run.runId,
      owner: safeOwner,
      operation: requestedOperation ? { operation: requestedOperation } : undefined
    }, {
      requestedOperation
    });
    return projectAnalyticalArtifacts(
      requestedOperation,
      artifacts,
      run.runId
    ).filter((artifact) =>
      A2A_ARTIFACT_MEDIA_TYPES[artifact.name]
      && artifact.parts?.length
      && artifact.parts.every((part) =>
        part?.mediaType === A2A_ARTIFACT_MEDIA_TYPES[artifact.name]
      )
    );
  }

  #visibleRecord(id, owner) {
    const record = this.tasks.get(id);
    if (!record || record.owner !== cleanOwner(owner)) throw taskNotFound(id);
    return record;
  }

  #deleteRecord(record) {
    record.emitter.removeAllListeners();
    this.tasks.delete(record.id);
    for (const key of record.idempotencyKeys || [record.idempotencyKey]) {
      this.idempotency.delete(key);
    }
  }

  #prune(nowMs) {
    for (const record of this.tasks.values()) {
      if (
        TERMINAL_STATES.has(record.status.state)
        && nowMs - Date.parse(record.lastModified) >= this.retentionMs
      ) {
        this.#deleteRecord(record);
      }
    }
  }

  #makeRoom() {
    if (this.tasks.size < this.maxTasks) return;
    throw marketA2AError(
      'RESOURCE_EXHAUSTED',
      'The server has reached its retained task limit',
      { statusCode: 429, status: 'RESOURCE_EXHAUSTED' }
    );
  }

  #publicTask(record, options = {}) {
    const historyLength = parseHistoryLength(options.historyLength);
    const outputModes = options.acceptedOutputModes || record.acceptedOutputModes;
    const task = {
      id: record.id,
      contextId: record.contextId,
      status: clone(record.status),
      history: clone(historyLength === 0 ? [] : record.history.slice(-historyLength)),
      metadata: sanitizeTraceValue({
        operation: record.operation.operation,
        createdAt: record.createdAt,
        lastModified: record.lastModified,
        ...(record.summary?.runId ? { runId: record.summary.runId } : {})
      })
    };
    if (options.includeArtifacts !== false) {
      task.artifacts = clone(record.artifacts
        .filter((artifact) => outputModes.includes(artifact.parts[0].mediaType))
        .slice(0, MAX_ARTIFACTS));
    }
    return task;
  }

  #publicRun(run) {
    const safe = sanitizeTraceValue(run);
    if (!safe || typeof safe !== 'object') throw taskNotFound(run?.runId);
    const { owner, ownerScope: _ownerScope, email, ...visible } = safe;
    return visible;
  }

  #touch(record) {
    record.lastModified = timestamp(this.clock);
  }

  #emit(record, event) {
    record.emitter.emit('event', clone(event));
  }

  #updateStatus(record, state, text) {
    const at = timestamp(this.clock);
    record.status = statusMessage(record, state, text, at);
    record.lastModified = at;
    const event = {
      statusUpdate: {
        taskId: record.id,
        contextId: record.contextId,
        status: clone(record.status)
      }
    };
    this.#emit(record, event);
  }

  #finish(record, state, text) {
    if (record.settled) return;
    record.settled = true;
    this.#updateStatus(record, state, text);
    record.history = [
      ...record.history,
      record.status.message
    ].slice(-MAX_HISTORY);
    record.resolveDone();
  }

  async #execute(record) {
    if (record.settled) return;
    this.#updateStatus(record, 'TASK_STATE_WORKING', 'Market analysis is running');
    try {
      let summary;
      let requestedOperation = record.operation.operation;
      if (record.operation.operation === 'inspect-run-trace') {
        const loaded = await this.#loadOwnedRun(record.requestedRunId, record.owner);
        summary = this.#publicRun(loaded.run);
        requestedOperation = loaded.run.requestedOperation || loaded.run.operation;
      } else {
        summary = await this.orchestrator.run({
          owner: record.owner,
          ownerScope: record.owner,
          operation: record.operation,
          trigger: 'a2a',
          deliverEmail: false,
          signal: record.controller.signal
        });
      }
      if (record.settled) return;
      record.summary = sanitizeTraceValue(summary);
      let artifacts = await this.#materializeArtifacts(summary, record, {
        requestedOperation
      });
      if (record.settled || record.controller.signal.aborted) return;
      if (record.operation.operation === 'inspect-run-trace') {
        artifacts = artifacts.filter((artifact) => artifact.name === 'run-trace.json');
      } else {
        artifacts = projectAnalyticalArtifacts(
          requestedOperation,
          artifacts,
          summary?.runId
        );
      }
      artifacts = artifacts.filter((artifact) =>
        A2A_ARTIFACT_MEDIA_TYPES[artifact.name]
        && artifact.parts?.length
        && artifact.parts.every((part) =>
          part?.mediaType === A2A_ARTIFACT_MEDIA_TYPES[artifact.name]
        )
      );
      const state = outputState(summary);
      if (
        state === 'TASK_STATE_COMPLETED'
        && record.operation.operation !== 'inspect-run-trace'
        && !artifacts.some((artifact) =>
          artifact.parts.some((part) => typeof part.text === 'string')
        )
      ) {
        artifacts.unshift(this.#buildArtifact(record, {
          name: 'market-report.md',
          mediaType: 'text/markdown',
          content: '# Market report\n\nThe run completed without an embedded text report.'
        }, 0));
      }
      record.artifacts = artifacts.slice(0, MAX_ARTIFACTS);
      this.#touch(record);
      for (const artifact of record.artifacts) {
        if (record.settled || record.controller.signal.aborted) return;
        this.#emit(record, {
          artifactUpdate: {
            taskId: record.id,
            contextId: record.contextId,
            artifact: clone(streamArtifact(
              artifact,
              record.summary?.runId,
              record.id
            )),
            append: false,
            lastChunk: true
          }
        });
      }
      this.#finish(record, state, terminalText(state));
    } catch (error) {
      if (record.settled) return;
      if (record.controller.signal.aborted || error?.name === 'AbortError') {
        this.#finish(record, 'TASK_STATE_CANCELED', 'Market analysis canceled');
        return;
      }
      record.summary = sanitizeTraceValue({
        outcome: 'failed',
        error: {
          name: error?.name || 'Error',
          code: error?.code || null,
          message: error?.message || 'Market analysis failed'
        }
      });
      this.#finish(record, 'TASK_STATE_FAILED', 'Market analysis failed');
    }
  }

  async #materializeArtifacts(summary, record, context = {}) {
    if (typeof this.artifactLoader === 'function') {
      const requestedOperation = context.requestedOperation
        || summary?.requestedOperation
        || record.operation?.operation;
      const loaded = await this.artifactLoader(summary, {
        owner: record.owner,
        ownerScope: record.owner,
        taskId: record.id,
        runId: summary?.runId,
        requestedOperation
      });
      return this.#buildArtifacts(record, loaded);
    }
    const descriptors = Array.isArray(summary?.artifacts) ? summary.artifacts : [];
    const resolved = [];
    for (const descriptor of descriptors.slice(0, MAX_ARTIFACTS)) {
      if (
        descriptor?.content !== undefined
        || descriptor?.data !== undefined
        || Array.isArray(descriptor?.parts)
      ) {
        resolved.push(descriptor);
        continue;
      }
      if (
        !summary?.runId
        || !summary?.reportDate
        || !descriptor?.name
        || !Number.isSafeInteger(descriptor?.size)
        || typeof descriptor?.sha256 !== 'string'
        || !this.config.stateDir
      ) {
        continue;
      }
      const root = path.join(
        path.resolve(this.config.stateDir),
        'runs',
        String(summary.reportDate).replaceAll('-', ''),
        String(summary.runId)
      );
      const maximum = descriptor.mediaType === 'application/json'
        ? MAX_JSON_BYTES
        : MAX_REPORT_BYTES;
      const content = await readVerifiedArtifact(path.join(root, descriptor.name), {
        root,
        maximum,
        expectedSize: descriptor.size,
        expectedSha256: descriptor.sha256
      });
      resolved.push({ ...descriptor, content });
    }
    return this.#buildArtifacts(record, resolved);
  }

  #buildArtifacts(record, descriptors) {
    if (!Array.isArray(descriptors)) return [];
    return descriptors
      .slice(0, MAX_ARTIFACTS)
      .map((descriptor, index) => this.#buildArtifact(record, descriptor, index))
      .filter(Boolean);
  }

  #buildArtifact(record, descriptor, index) {
    if (!descriptor || typeof descriptor !== 'object') return null;
    const name = String(descriptor.name || `artifact-${index + 1}`).slice(0, 200);
    const mediaType = mediaTypeFor(name, descriptor.mediaType);
    let parts;
    if (Array.isArray(descriptor.parts) && descriptor.parts.length) {
      parts = sanitizeTraceValue(descriptor.parts.slice(0, 16));
    } else if (descriptor.data !== undefined) {
      parts = [{
        data: sanitizeTraceValue(descriptor.data),
        mediaType
      }];
    } else {
      const content = descriptor.content ?? '';
      if (mediaType === 'application/json') {
        let data;
        try {
          data = typeof content === 'string' ? JSON.parse(content) : content;
        } catch {
          data = { invalidJson: true };
        }
        parts = [{ data: sanitizeTraceValue(data), mediaType }];
      } else {
        parts = [{ text: boundedText(content), mediaType }];
      }
    }
    if (!Array.isArray(parts) || !parts.length) return null;
    const suppliedArtifactId = typeof descriptor.artifactId === 'string'
      ? descriptor.artifactId.slice(0, 200)
      : '';
    return {
      artifactId: suppliedArtifactId || artifactId(record.id, name, index),
      name,
      parts,
      metadata: sanitizeTraceValue({
        ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
        ...(descriptor.sha256 ? { sha256: descriptor.sha256 } : {}),
        ...(descriptor.description ? { description: descriptor.description } : {})
      })
    };
  }
}
