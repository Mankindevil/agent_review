import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  buildA2ARequest,
  buildGetTaskRequest,
  extractAgentText,
  parseA2AResponse,
  selectInterface
} from './a2a.js';
import { safeHttpRequest, validateSafeUrl } from './safe-http.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const POLL_DELAYS = [250, 500, 1000, 2000];
const TERMINAL_STATES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'INTERRUPTED',
  'INPUT_REQUIRED',
  'AUTH_REQUIRED'
]);
const SUCCESS_STATES = new Set(['COMPLETED']);

export async function executeA2ATurn(options) {
  const {
    card,
    input,
    contextId,
    taskId,
    streaming = false,
    timeoutMs = 45_000,
    authorization,
    testId,
    turnIndex,
    repeatIndex,
    signal,
    request = safeHttpRequest,
    clock = () => Date.now(),
    sleep = wait,
    requestId: suppliedRequestId
  } = options || {};
  const startedAt = clock();
  const deadline = startedAt + timeoutMs;
  const runId = `run_${crypto.randomUUID()}`;
  const requestId = suppliedRequestId || crypto.randomUUID();
  const messageId = crypto.randomUUID();
  let target = null;
  let initialRequest = null;
  let headersAt = null;
  let firstByteAt = null;
  let firstEventAt = null;
  let endedAt = null;
  let httpStatus = null;
  let mediaType = null;
  let byteLength = 0;
  const rawObjects = [];
  let normalized = emptyNormalized();

  try {
    if (signal?.aborted) {
      throw Object.assign(new Error('A2A execution cancelled'), { code: 'cancelled' });
    }
    target = selectInterface(card);
    if (!target) throw executorError('No supported A2A interface', 'configuration', 'platform-error');
    initialRequest = buildA2ARequest(target, input, {
      requestId,
      messageId,
      contextId,
      taskId,
      streaming
    });

    if (streaming) {
      const parser = createIncrementalSseParser((object, at) => {
        rawObjects.push(object);
        if (firstEventAt === null && at !== null) firstEventAt = at;
      });
      let sawHookChunk = false;
      const response = await send(initialRequest, {
        request,
        authorization,
        signal,
        timeoutMs: remaining(deadline, clock),
        onHeaders: (event) => {
          if (headersAt === null) headersAt = event.at;
        },
        onChunk: (event) => {
          sawHookChunk = true;
          if (firstByteAt === null) firstByteAt = event.at;
          parser.push(event.bytes, event.at);
        }
      });
      endedAt = clock();
      httpStatus = response.status;
      mediaType = contentType(response.headers);
      byteLength += response.body.length;
      requireHttpSuccess(response);
      requireMediaType(mediaType, 'text/event-stream');
      if (!sawHookChunk) {
        parser.push(response.body, null);
      }
      parser.end(sawHookChunk ? endedAt : null);
      if (parser.error) throw executorError(parser.error.message, 'protocol', 'agent-error');
      if (rawObjects.length === 0) throw executorError('A2A stream returned no events', 'protocol', 'agent-error');
      validateStreamObjects(target, rawObjects, requestId);
      normalized = normalizeA2AResult(target, rawObjects);
      if (normalized.responseKind === 'task' && !isTerminalState(normalized.terminalState)) {
        throw executorError('A2A Task stream ended without a terminal Task state', 'protocol', 'agent-error');
      }
      if (!normalized.terminal) {
        throw executorError('A2A stream ended before a terminal result', 'protocol', 'agent-error');
      }
    } else {
      let response = await send(initialRequest, {
        request,
        authorization,
        signal,
        timeoutMs: remaining(deadline, clock),
        onHeaders: (event) => {
          if (headersAt === null) headersAt = event.at;
        },
        onChunk: (event) => {
          if (firstByteAt === null) firstByteAt = event.at;
        }
      });
      httpStatus = response.status;
      mediaType = contentType(response.headers);
      byteLength += response.body.length;
      let payload = parseJsonResponse(target, response, requestId);
      rawObjects.push(payload);
      normalized = normalizeA2AResult(target, rawObjects);

      let pollIndex = 0;
      while (normalized.responseKind === 'task' && !normalized.terminal) {
        const delay = POLL_DELAYS[Math.min(pollIndex, POLL_DELAYS.length - 1)];
        await sleepWithinDeadline(delay, deadline, clock, signal, sleep);
        const pollRequest = buildGetTaskRequest(target, {
          taskId: normalized.taskId,
          requestId: crypto.randomUUID(),
          historyLength: 50
        });
        response = await send(pollRequest, {
          request,
          authorization,
          signal,
          timeoutMs: remaining(deadline, clock),
          onHeaders: (event) => {
            if (headersAt === null) headersAt = event.at;
          },
          onChunk: (event) => {
            if (firstByteAt === null) firstByteAt = event.at;
          }
        });
        httpStatus = response.status;
        mediaType = contentType(response.headers);
        byteLength += response.body.length;
        payload = parseJsonResponse(target, response, pollRequest.requestId);
        rawObjects.push(payload);
        normalized = normalizeA2AResult(target, rawObjects);
        pollIndex += 1;
      }
      endedAt = clock();
    }

    const outcome = outcomeFor(normalized);
    const error = outcome.status === 'succeeded'
      ? null
      : publicError('Agent returned a non-success terminal state', 'agent', authorization);
    return buildRun({
      runId, testId, turnIndex, repeatIndex, target, initialRequest, requestId, messageId,
      rawObjects, normalized, httpStatus, mediaType, byteLength,
      startedAt, headersAt, firstByteAt, firstEventAt, endedAt: endedAt ?? clock(),
      outcome, error, authorization
    });
  } catch (error) {
    endedAt = endedAt ?? clock();
    const classified = classifyFailure(error);
    return buildRun({
      runId, testId, turnIndex, repeatIndex, target, initialRequest, requestId, messageId,
      rawObjects, normalized: rawObjects.length ? normalizeA2AResult(target, rawObjects) : normalized,
      httpStatus, mediaType, byteLength,
      startedAt, headersAt, firstByteAt, firstEventAt, endedAt,
      outcome: { status: classified.outcome },
      error: publicError(error?.message, classified.category, authorization),
      authorization
    });
  }
}

export async function executeA2AExample({
  card,
  example,
  repeatIndex,
  policy = {},
  authorization,
  signal,
  executeTurn = executeA2ATurn
}) {
  let returnedContextId;
  let returnedTaskId;
  const runs = [];
  let contextObserved = false;
  let contextConsistent = true;
  for (let turnIndex = 0; turnIndex < example.turns.length; turnIndex += 1) {
    const run = await executeTurn({
      card,
      input: example.turns[turnIndex].input,
      ...(returnedContextId ? { contextId: returnedContextId } : {}),
      ...(returnedTaskId ? { taskId: returnedTaskId } : {}),
      streaming: policy.streaming === true,
      timeoutMs: policy.timeoutMs,
      authorization,
      testId: example.id,
      turnIndex,
      repeatIndex,
      signal
    });
    runs.push(run);
    const nextContextId = run.response?.normalized?.contextId;
    const nextTaskId = run.response?.normalized?.taskId;
    if (nextContextId) {
      if (returnedContextId && returnedContextId !== nextContextId) contextConsistent = false;
      returnedContextId = nextContextId;
      contextObserved = true;
    }
    if (nextTaskId) returnedTaskId = nextTaskId;
    if (run.outcome?.status !== 'succeeded') break;
  }
  return {
    testId: example.id,
    repeatIndex,
    runs,
    contextCheck: contextObserved
      ? { status: contextConsistent ? 'passed' : 'failed', contextId: returnedContextId }
      : { status: 'unavailable', contextId: null }
  };
}

export function normalizeA2AResult(target, rawObjects) {
  const messages = [];
  const history = [];
  const artifacts = [];
  const parts = [];
  const statusSequence = [];
  const textValues = [];
  let responseKind = 'unknown';
  let taskId = null;
  let contextId = null;
  let terminal = false;
  let terminalState = null;

  for (const raw of rawObjects || []) {
    const root = protocolRoot(target, raw);
    if (!root || typeof root !== 'object') continue;
    const message = root.message || (isMessage(root) ? root : null);
    const task = root.task || (isTask(root) ? root : null);
    const statusUpdate = root.statusUpdate || (isStatusUpdate(root) ? root : null);
    const artifactUpdate = root.artifactUpdate || (isArtifactUpdate(root) ? root : null);

    if (message) {
      responseKind = responseKind === 'task' ? responseKind : 'message';
      messages.push(message);
      collectParts(message.parts, parts);
      contextId = message.contextId || contextId;
      textValues.push(extractAgentText(message));
      if (!task && !statusUpdate) terminal = true;
    }
    if (task) {
      responseKind = 'task';
      taskId = task.id || task.taskId || taskId;
      contextId = task.contextId || contextId;
      if (Array.isArray(task.history)) {
        history.push(...task.history);
        for (const item of task.history) collectParts(item.parts, parts);
      }
      if (Array.isArray(task.artifacts)) {
        artifacts.push(...task.artifacts);
        for (const artifact of task.artifacts) collectParts(artifact.parts, parts);
      }
      collectParts(task.status?.message?.parts, parts);
      const state = task.status?.state;
      if (state) statusSequence.push(state);
      if (isTerminalState(state)) {
        terminal = true;
        terminalState = state;
      }
      textValues.push(extractAgentText({ task }));
    }
    if (statusUpdate) {
      responseKind = 'task';
      taskId = statusUpdate.taskId || taskId;
      contextId = statusUpdate.contextId || contextId;
      const status = statusUpdate.status || {};
      collectParts(status.message?.parts, parts);
      if (status.state) statusSequence.push(status.state);
      if (statusUpdate.final === true || isTerminalState(status.state)) {
        terminal = true;
        terminalState = status.state || terminalState;
      }
      textValues.push(extractAgentText({ statusUpdate }));
    }
    if (artifactUpdate) {
      responseKind = 'task';
      taskId = artifactUpdate.taskId || taskId;
      if (artifactUpdate.artifact) {
        artifacts.push(artifactUpdate.artifact);
        collectParts(artifactUpdate.artifact.parts, parts);
      }
      textValues.push(extractAgentText({ artifactUpdate }));
    }
  }

  return {
    responseKind,
    terminal,
    terminalState,
    taskId,
    contextId,
    statusSequence,
    messages,
    history,
    artifacts,
    parts,
    text: textValues.filter(Boolean).join('\n')
  };
}

export async function snapshotUrlParts(parts, options = {}) {
  const request = options.request || safeHttpRequest;
  const seen = new Set();
  const snapshots = [];
  for (const part of parts || []) {
    const declaredSource = directPartUrl(part);
    if (!declaredSource) continue;
    const source = validateSafeUrl(declaredSource, {
      allowPrivate: process.env.ALLOW_PRIVATE_AGENT_URLS === 'true'
    }).toString();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    const response = await request(source, {
      method: 'GET',
      headers: { accept: '*/*' },
      signal: options.signal,
      timeoutMs: 10_000,
      maxBytes: SNAPSHOT_MAX_BYTES
    });
    if (!response || response.status < 200 || response.status >= 300) {
      throw executorError(`URL Part snapshot returned HTTP ${response?.status || 0}`, 'protocol', 'agent-error');
    }
    const body = Buffer.from(response.body);
    if (body.length > SNAPSHOT_MAX_BYTES) {
      throw executorError('URL Part snapshot exceeds 1 MiB', 'response-too-large', 'platform-error');
    }
    snapshots.push({
      sourceUrl: redactUrlQuery(source),
      bytes: body.toString('base64'),
      mediaType: contentType(response.headers) || part.mediaType || part.file?.mimeType || null,
      size: body.length,
      sha256: sha256(body)
    });
  }
  return snapshots;
}

function buildRun(input) {
  const {
    runId, testId, turnIndex, repeatIndex, target, initialRequest, requestId, messageId,
    rawObjects, normalized, httpStatus, mediaType, byteLength,
    startedAt, headersAt, firstByteAt, firstEventAt, endedAt, outcome, error, authorization
  } = input;
  const body = redactValue(initialRequest?.body ?? null, authorization);
  const safeRawObjects = redactValue(rawObjects, authorization);
  const safeNormalized = redactValue(normalized, authorization);
  return {
    runId,
    testId,
    turnIndex,
    repeatIndex,
    protocol: {
      binding: target?.binding || null,
      version: target?.version || null,
      endpointHash: target?.url ? sha256(target.url) : null
    },
    request: {
      requestId,
      messageId,
      body,
      bodyHash: body === null ? null : hashJson(body)
    },
    response: {
      httpStatus,
      mediaType,
      byteLength,
      rawObjects: safeRawObjects,
      rawHash: hashJson(safeRawObjects),
      normalized: safeNormalized
    },
    timing: {
      startedAt,
      headersAt,
      firstByteAt,
      firstEventAt,
      endedAt,
      firstByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
      firstEventMs: firstEventAt === null ? null : firstEventAt - startedAt,
      durationMs: endedAt - startedAt
    },
    outcome,
    error
  };
}

async function send(requestDefinition, options) {
  const headers = {
    ...requestDefinition.headers,
    ...(options.authorization ? { authorization: bearer(options.authorization) } : {})
  };
  return options.request(requestDefinition.url, {
    method: requestDefinition.method || 'POST',
    headers,
    ...(requestDefinition.body === null ? {} : { body: JSON.stringify(requestDefinition.body) }),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_RESPONSE_BYTES,
    onHeaders: options.onHeaders,
    onChunk: options.onChunk
  });
}

function parseJsonResponse(target, response, requestId) {
  requireHttpSuccess(response);
  requireMediaType(contentType(response.headers), ['application/json', 'application/a2a+json']);
  let payload;
  try {
    payload = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw executorError('A2A response is not valid JSON', 'protocol', 'agent-error');
  }
  try {
    parseA2AResponse(target, payload, requestId);
  } catch (error) {
    throw executorError(error.message, 'protocol', 'agent-error');
  }
  return payload;
}

function requireHttpSuccess(response) {
  if (!response || response.status < 200 || response.status >= 300) {
    throw executorError(`A2A returned HTTP ${response?.status || 0}`, 'protocol', 'agent-error');
  }
}

function requireMediaType(actual, expected) {
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.some((item) => actual.includes(item))) {
    throw executorError('A2A response Content-Type does not match the protocol', 'protocol', 'agent-error');
  }
}

function validateStreamObjects(target, objects, requestId) {
  for (const object of objects) {
    let value = object;
    if (target.binding === 'JSONRPC') {
      if (object?.jsonrpc !== '2.0' || String(object.id) !== String(requestId)) {
        throw executorError('A2A stream JSON-RPC envelope is invalid', 'protocol', 'agent-error');
      }
      if (object.error) {
        throw executorError(`A2A stream protocol error: ${object.error.message || object.error.code}`, 'protocol', 'agent-error');
      }
      value = object.result;
    }
    if (!value || typeof value !== 'object') {
      throw executorError('A2A stream event is missing a protocol object', 'protocol', 'agent-error');
    }
    const message = value.message || (isMessage(value) ? value : null);
    const task = value.task || (isTask(value) ? value : null);
    const statusUpdate = value.statusUpdate || (isStatusUpdate(value) ? value : null);
    const artifactUpdate = value.artifactUpdate || (isArtifactUpdate(value) ? value : null);
    if (
      (value.message && !isMessage(value.message)) ||
      (value.task && !isTask(value.task)) ||
      (value.statusUpdate && !isStatusUpdate(value.statusUpdate)) ||
      (value.artifactUpdate && !isArtifactUpdate(value.artifactUpdate)) ||
      (!message && !task && !statusUpdate && !artifactUpdate)
    ) {
      throw executorError('A2A stream event contains an invalid protocol object', 'protocol', 'agent-error');
    }
  }
}

function createIncrementalSseParser(onObject) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dataLines = [];
  let eventCount = 0;
  let error = null;
  const flush = (at) => {
    if (error || dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (Buffer.byteLength(data) > 64 * 1024) {
      error = new Error('SSE event exceeds the size limit');
      return;
    }
    try {
      onObject(JSON.parse(data), at);
      eventCount += 1;
      if (eventCount > 256) error = new Error('SSE event count exceeds the limit');
    } catch (caught) {
      error = caught;
    }
  };
  const processLine = (rawLine, at) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return flush(at);
    if (line.startsWith(':')) return;
    if (line === 'data') dataLines.push('');
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''));
  };
  return {
    push(bytes, at) {
      if (error) return;
      pending += decoder.write(Buffer.from(bytes));
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        processLine(line, at);
      }
    },
    end(at) {
      if (error) return;
      pending += decoder.end();
      if (pending) processLine(pending, at);
      flush(at);
    },
    get error() {
      return error;
    }
  };
}

function protocolRoot(target, raw) {
  return target?.binding === 'JSONRPC' ? raw?.result : raw;
}

function isMessage(value) {
  return typeof value?.messageId === 'string' &&
    typeof value?.role === 'string' &&
    Array.isArray(value?.parts) &&
    (value.kind === undefined || value.kind === 'message');
}

function isTask(value) {
  return typeof value?.id === 'string' &&
    value?.status &&
    typeof value.status === 'object' &&
    (value.kind === undefined || value.kind === 'task');
}

function isStatusUpdate(value) {
  return typeof value?.taskId === 'string' &&
    value?.status &&
    typeof value.status === 'object' &&
    !value?.artifact &&
    (value.kind === undefined || value.kind === 'status-update');
}

function isArtifactUpdate(value) {
  return typeof value?.taskId === 'string' &&
    value?.artifact &&
    typeof value.artifact === 'object' &&
    (value.kind === undefined || value.kind === 'artifact-update');
}

function collectParts(value, target) {
  if (Array.isArray(value)) target.push(...value);
}

function isTerminalState(state) {
  return TERMINAL_STATES.has(normalizeState(state));
}

function normalizeState(state) {
  return String(state || '')
    .toUpperCase()
    .replace(/^TASK_STATE_/u, '')
    .replace(/-/gu, '_');
}

function outcomeFor(normalized) {
  if (normalized.responseKind === 'message' && normalized.terminal) return { status: 'succeeded' };
  if (normalized.terminal && SUCCESS_STATES.has(normalizeState(normalized.terminalState))) {
    return { status: 'succeeded' };
  }
  if (normalized.terminal) return { status: 'agent-error' };
  return { status: 'unknown' };
}

function classifyFailure(error) {
  if (error?.outcome && error?.category) return { outcome: error.outcome, category: error.category };
  if (error?.code === 'cancelled' || error?.name === 'AbortError') {
    return { outcome: 'platform-error', category: 'signal' };
  }
  if (error?.code === 'timeout') return { outcome: 'platform-error', category: 'timeout' };
  if (error?.code === 'instrumentation') return { outcome: 'platform-error', category: 'instrumentation' };
  if (['security', 'dns', 'connection', 'tls', 'response-too-large'].includes(error?.code)) {
    return { outcome: 'platform-error', category: 'transport' };
  }
  return { outcome: 'platform-error', category: 'transport' };
}

function executorError(message, category, outcome) {
  return Object.assign(new Error(message), { category, outcome });
}

function publicError(message, category, authorization) {
  return {
    category,
    message: redactText(String(message || 'A2A execution failed'), authorization)
  };
}

function bearer(value) {
  const text = String(value);
  return /^Bearer\s/iu.test(text) ? text : `Bearer ${text}`;
}

function contentType(headers) {
  return String(headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

function remaining(deadline, clock) {
  const value = deadline - clock();
  if (value <= 0) throw Object.assign(new Error('A2A execution timed out'), { code: 'timeout' });
  return value;
}

async function sleepWithinDeadline(delay, deadline, clock, signal, sleep) {
  if (signal?.aborted) throw Object.assign(new Error('A2A execution cancelled'), { code: 'cancelled' });
  if (clock() + delay >= deadline) {
    throw Object.assign(new Error('A2A execution timed out'), { code: 'timeout' });
  }
  await sleep(delay, signal);
  if (signal?.aborted) throw Object.assign(new Error('A2A execution cancelled'), { code: 'cancelled' });
}

function wait(delay, signal) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('A2A execution cancelled'), { code: 'cancelled' }));
  }
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('A2A execution cancelled'), { code: 'cancelled' }));
    };
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    timer = setTimeout(finish, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function directPartUrl(part) {
  if (!part || typeof part !== 'object') return null;
  if (typeof part.url === 'string') return part.url;
  if (part.type === 'url' && typeof part.url === 'string') return part.url;
  if (part.kind === 'file' && typeof part.file?.uri === 'string') return part.file.uri;
  return null;
}

function redactUrlQuery(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function redactValue(value, secret) {
  if (!secret) return value;
  if (typeof value === 'string') return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, secret)])
    );
  }
  return value;
}

function redactText(value, secret) {
  if (!secret) return value;
  const text = String(secret);
  const rawToken = text.match(/^Bearer\s+(.+)$/iu)?.[1];
  const variants = [...new Set([bearer(text), text, rawToken].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  return variants.reduce(
    (result, variant) => result.split(variant).join('[REDACTED]'),
    value
  );
}

function emptyNormalized() {
  return {
    responseKind: 'unknown',
    terminal: false,
    terminalState: null,
    taskId: null,
    contextId: null,
    statusSequence: [],
    messages: [],
    history: [],
    artifacts: [],
    parts: [],
    text: ''
  };
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
