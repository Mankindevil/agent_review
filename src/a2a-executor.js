import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  buildA2ARequest,
  buildGetTaskRequest,
  extractAgentText,
  negotiateAcceptedOutputModes,
  parseA2AResponse,
  selectInterface,
  validateStreamResult
} from './a2a.js';
import { safeHttpRequest, validateSafeUrl } from './safe-http.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const SNAPSHOT_AGGREGATE_MAX_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_URLS = 16;
const SNAPSHOT_BATCH_TIMEOUT_MS = 30_000;
const MIN_AUTHORIZATION_TOKEN_LENGTH = 3;
const MAX_AUTHORIZATION_BYTES = 4_096;
const MAX_SECRET_PATTERNS = 24;
const MAX_SECRET_PATTERN_LENGTH = 64 * 1_024;
const MAX_SECRET_DECODE_DEPTH = 3;
const MAX_SECRET_DECODE_VIEWS = 8;
const MAX_SECRET_DECODE_INPUT_LENGTH = 2 * 1_024 * 1_024;
const MAX_SECRET_DECODE_WORK = 16 * 1_024 * 1_024;
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
    snapshotRequest = safeHttpRequest,
    persistSnapshot,
    clock = () => Date.now(),
    sleep = wait,
    requestId: suppliedRequestId,
    messageId: suppliedMessageId,
    runId: suppliedRunId,
    acceptedOutputModes: suppliedAcceptedOutputModes
  } = options || {};
  const startedAt = clock();
  const deadline = startedAt + timeoutMs;
  const runId = suppliedRunId || `run_${crypto.randomUUID()}`;
  const requestId = suppliedRequestId || crypto.randomUUID();
  const messageId = suppliedMessageId || crypto.randomUUID();
  let target = null;
  let initialRequest = null;
  let headersAt = null;
  let firstByteAt = null;
  let firstEventAt = null;
  let endedAt = null;
  let httpStatus = null;
  let mediaType = null;
  let byteLength = 0;
  let snapshots = [];
  let protocolValidated = false;
  const rawObjects = [];
  let normalized = emptyNormalized();

  try {
    validateAuthorization(authorization);
    if (signal?.aborted) {
      throw Object.assign(new Error('A2A execution cancelled'), { code: 'cancelled' });
    }
    target = selectInterface(card);
    if (!target) throw executorError('No supported A2A interface', 'configuration', 'platform-error');
    const acceptedOutputModes = suppliedAcceptedOutputModes === undefined
      ? negotiateAcceptedOutputModes(card)
      : suppliedAcceptedOutputModes;
    initialRequest = buildA2ARequest(target, input, {
      requestId,
      messageId,
      contextId,
      taskId,
      streaming,
      acceptedOutputModes
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
      protocolValidated = true;
      let lockedTaskId = normalized.responseKind === 'task' ? normalized.taskId : null;
      let lockedContextId = normalized.responseKind === 'task' ? normalized.contextId : null;

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
        payload = parseJsonResponse(target, response, pollRequest.requestId, 'get-task');
        const polledTask = protocolRoot(target, payload);
        if (polledTask.id !== lockedTaskId) {
          throw executorError('GetTask returned a different Task id', 'protocol', 'agent-error');
        }
        if (lockedContextId && polledTask.contextId !== lockedContextId) {
          throw executorError('GetTask returned a different Task contextId', 'protocol', 'agent-error');
        }
        if (!lockedContextId && polledTask.contextId) lockedContextId = polledTask.contextId;
        rawObjects.push(payload);
        normalized = normalizeA2AResult(target, rawObjects);
        pollIndex += 1;
      }
      endedAt = clock();
    }

    protocolValidated = true;
    const snapshotParts = collectAgentSnapshotParts(target, rawObjects);
    if (snapshotParts.some((part) => directPartUrl(part))) {
      snapshots = await snapshotUrlParts(snapshotParts, {
        request: snapshotRequest,
        persistSnapshot,
        authorization,
        signal,
        clock,
        batchTimeoutMs: remaining(deadline, clock),
        runId,
        testId,
        turnIndex,
        repeatIndex
      });
    }
    const outcome = outcomeFor(normalized);
    const error = outcome.status === 'succeeded'
      ? null
      : publicError('Agent returned a non-success terminal state', 'agent', authorization, {
        code: 'terminal-state'
      });
    return buildRun({
      runId, testId, turnIndex, repeatIndex, target, initialRequest, requestId, messageId,
      rawObjects, normalized, httpStatus, mediaType, byteLength,
      snapshots,
      startedAt, headersAt, firstByteAt, firstEventAt, endedAt: endedAt ?? clock(),
      outcome, error, authorization, protocolValidated
    });
  } catch (error) {
    endedAt = endedAt ?? clock();
    const classified = classifyFailure(error);
    return buildRun({
      runId, testId, turnIndex, repeatIndex, target, initialRequest, requestId, messageId,
      rawObjects, normalized: rawObjects.length ? normalizeA2AResult(target, rawObjects) : normalized,
      httpStatus, mediaType, byteLength,
      snapshots,
      startedAt, headersAt, firstByteAt, firstEventAt, endedAt,
      outcome: { status: classified.outcome },
      error: publicError(error?.message, classified.category, authorization, error),
      authorization, protocolValidated
    });
  }
}

export async function executeA2AProtocolRecoveryProbe(options = {}) {
  const {
    card,
    input,
    timeoutMs = 45_000,
    authorization,
    signal,
    request = safeHttpRequest,
    clock = () => Date.now()
  } = options;
  validateAuthorization(authorization);
  const startedAt = clock();
  const deadline = startedAt + timeoutMs;
  const target = selectInterface(card);
  if (!target) {
    return executeA2ATurn({
      ...options,
      contextId: undefined,
      taskId: undefined
    });
  }
  const acceptedOutputModes = options.acceptedOutputModes === undefined
    ? negotiateAcceptedOutputModes(card)
    : options.acceptedOutputModes;
  const malformedRequestId = options.requestId
    ? `${options.requestId}_malformed`
    : crypto.randomUUID();
  const template = buildA2ARequest(target, input, {
    requestId: malformedRequestId,
    messageId: options.messageId
      ? `${options.messageId}_malformed`
      : crypto.randomUUID(),
    streaming: false,
    acceptedOutputModes
  });
  const malformedBody = target.binding === 'JSONRPC'
    ? {
        jsonrpc: '2.0',
        id: malformedRequestId,
        method: template.body.method,
        params: {}
      }
    : { configuration: template.body.configuration || {} };
  let malformedRejected = false;
  let malformedHttpStatus = null;
  let malformedResponseHash = null;
  let malformedErrorCategory = null;
  try {
    const malformedResponse = await send({
      ...template,
      body: malformedBody
    }, {
      request,
      authorization,
      signal,
      timeoutMs: Math.min(
        10_000,
        Math.max(1, Math.floor(timeoutMs / 3))
      )
    });
    malformedHttpStatus = malformedResponse.status;
    malformedResponseHash = sha256(malformedResponse.body || Buffer.alloc(0));
    malformedRejected = isMalformedRequestRejection(
      target,
      malformedResponse,
      malformedRequestId
    );
  } catch (error) {
    malformedErrorCategory = classifyFailure(error).category;
  }
  const validRun = await executeA2ATurn({
    ...options,
    contextId: undefined,
    taskId: undefined,
    streaming: false,
    timeoutMs: Math.max(1, deadline - clock()),
    request
  });
  return {
    ...validRun,
    protocolRecovery: {
      malformedRejected,
      malformedRequestBodyHash: hashJson(malformedBody),
      malformedHttpStatus,
      malformedResponseHash,
      malformedErrorCategory,
      validRequestUsedFreshContext: true
    }
  };
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
  let contextStatus = 'unavailable';
  let contextUnavailable = false;
  let checkedTransitions = 0;
  for (let turnIndex = 0; turnIndex < example.turns.length; turnIndex += 1) {
    const sentContextId = returnedContextId;
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
    if (turnIndex > 0) {
      checkedTransitions += 1;
      if (!sentContextId || !nextContextId) {
        contextUnavailable = true;
      } else if (sentContextId !== nextContextId) {
        contextStatus = 'failed';
      }
    }
    returnedContextId = nextContextId || undefined;
    returnedTaskId = isInterruptedOutcome(run) && nextTaskId ? nextTaskId : undefined;
    if (contextStatus !== 'failed') {
      contextStatus = checkedTransitions > 0 && !contextUnavailable ? 'passed' : 'unavailable';
    }
    if (run.outcome?.status !== 'succeeded') break;
  }
  return {
    testId: example.id,
    repeatIndex,
    runs,
    contextCheck: { status: contextStatus, contextId: returnedContextId || null }
  };
}

function isMalformedRequestRejection(target, response, requestId) {
  if (response?.status >= 400 && response.status < 500) return true;
  if (target.binding !== 'JSONRPC') return false;
  try {
    const payload = JSON.parse(response.body.toString('utf8'));
    return payload?.jsonrpc === '2.0' &&
      payload?.id === requestId &&
      payload?.error &&
      Number.isInteger(payload.error.code);
  } catch {
    return false;
  }
}

export function normalizeA2AResult(target, rawObjects) {
  const messages = [];
  let history = [];
  let taskArtifacts = [];
  let taskArtifactsIndex = -1;
  const streamedArtifactUpdates = [];
  const statusMessages = [];
  const statusSequence = [];
  let responseKind = 'unknown';
  let taskId = null;
  let contextId = null;
  let terminal = false;
  let terminalState = null;

  for (const [eventIndex, raw] of (rawObjects || []).entries()) {
    const root = protocolRoot(target, raw);
    if (!root || typeof root !== 'object') continue;
    const message = root.message || (isMessage(root) ? root : null);
    const task = root.task || (isTask(root) ? root : null);
    const statusUpdate = root.statusUpdate || (isStatusUpdate(root) ? root : null);
    const artifactUpdate = root.artifactUpdate || (isArtifactUpdate(root) ? root : null);
    if (message) {
      if (responseKind !== 'task') responseKind = 'message';
      messages.push(message);
      contextId = message.contextId || contextId;
      if (!task && !statusUpdate && !artifactUpdate) terminal = true;
    }
    if (task) {
      responseKind = 'task';
      taskId = task.id || task.taskId || taskId;
      contextId = task.contextId || contextId;
      if (Array.isArray(task.history)) history = dedupeByIdentity(task.history, 'messageId');
      if (Array.isArray(task.artifacts)) {
        taskArtifacts = dedupeByIdentity(task.artifacts, 'artifactId', 'id');
        taskArtifactsIndex = eventIndex;
      }
      if (task.status?.message) statusMessages.push(task.status.message);
      const state = task.status?.state;
      appendStateTransition(statusSequence, state);
      if (isTerminalState(state)) {
        terminal = true;
        terminalState = state;
      }
    }
    if (statusUpdate) {
      responseKind = 'task';
      taskId = statusUpdate.taskId || taskId;
      contextId = statusUpdate.contextId || contextId;
      if (statusUpdate.status?.message) statusMessages.push(statusUpdate.status.message);
      const state = statusUpdate.status?.state;
      appendStateTransition(statusSequence, state);
      if (statusUpdate.final === true || isTerminalState(state)) {
        terminal = true;
        terminalState = state || terminalState;
      }
    }
    if (artifactUpdate) {
      responseKind = 'task';
      taskId = artifactUpdate.taskId || taskId;
      contextId = artifactUpdate.contextId || contextId;
      if (artifactUpdate.artifact) streamedArtifactUpdates.push({
        eventIndex,
        update: artifactUpdate
      });
    }
  }

  const uniqueMessages = dedupeByIdentity(messages, 'messageId');
  history = dedupeByIdentity(history, 'messageId');
  const artifactMap = new Map();
  for (const artifact of taskArtifacts) {
    artifactMap.set(identityFor(artifact, 'artifactId', 'id'), artifact);
  }
  for (const { eventIndex, update } of streamedArtifactUpdates) {
    if (eventIndex <= taskArtifactsIndex) continue;
    const artifact = update.artifact;
    const key = identityFor(artifact, 'artifactId', 'id');
    const previous = artifactMap.get(key);
    if (update.append === true && previous) {
      artifactMap.set(key, {
        ...previous,
        ...artifact,
        parts: [...(previous.parts || []), ...(artifact.parts || [])]
      });
    } else {
      artifactMap.set(key, artifact);
    }
  }
  const artifacts = [...artifactMap.values()];
  const artifactTimeline = streamedArtifactUpdates.map(({ update }) => ({
    artifactId: update.artifact.artifactId,
    append: update.append === true,
    lastChunk: update.lastChunk === true,
    partCount: update.artifact.parts?.length || 0
  }));
  const parts = [];
  const seenMessageIds = new Set();
  for (const message of [
    ...uniqueMessages,
    ...history,
    ...dedupeByIdentity(statusMessages, 'messageId')
  ]) {
    const identity = identityFor(message, 'messageId');
    if (seenMessageIds.has(identity)) continue;
    seenMessageIds.add(identity);
    parts.push(...(message.parts || []));
  }
  for (const artifact of artifacts) parts.push(...(artifact.parts || []));
  return {
    responseKind,
    terminal,
    terminalState,
    taskId,
    contextId,
    statusSequence,
    messages: uniqueMessages,
    history,
    artifacts,
    artifactTimeline,
    parts,
    text: parts.map(partText).filter(Boolean).join('\n')
  };
}

export async function snapshotUrlParts(parts, options = {}) {
  const request = options.request || safeHttpRequest;
  const persistSnapshot = options.persistSnapshot;
  validateAuthorization(options.authorization);
  const scrubber = createSecretScrubber(options.authorization);
  const seen = new Set();
  const sources = [];
  const snapshots = [];
  for (const part of parts || []) {
    const declaredSource = directPartUrl(part);
    if (!declaredSource) continue;
    if (scrubber.contains(declaredSource)) {
      throw executorError(
        'URL Part contains the submission authorization credential',
        'agent',
        'agent-error',
        { code: 'credential-in-url' }
      );
    }
    let source;
    try {
      source = validateSafeUrl(declaredSource, {
        allowPrivate: process.env.ALLOW_PRIVATE_AGENT_URLS === 'true'
      }).toString();
    } catch {
      throw executorError('Agent returned an unsafe URL Part', 'agent', 'agent-error', {
        code: 'unsafe-part-url'
      });
    }
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push({ source, part });
  }
  if (sources.length === 0) return snapshots;
  if (typeof persistSnapshot !== 'function') {
    throw executorError('URL Part snapshot persistence is unavailable', 'configuration', 'platform-error');
  }
  if (sources.length > SNAPSHOT_MAX_URLS) {
    throw executorError(`URL Part snapshot count exceeds ${SNAPSHOT_MAX_URLS}`, 'agent', 'agent-error', {
      code: 'snapshot-count-limit'
    });
  }

  const clock = options.clock || (() => Date.now());
  const deadline = clock() + (options.batchTimeoutMs || SNAPSHOT_BATCH_TIMEOUT_MS);
  let aggregateBytes = 0;
  for (const { source, part } of sources) {
    let response;
    try {
      response = await runWithinDeadline(
        ({ signal, remainingMs }) => request(source, {
          method: 'GET',
          headers: { accept: '*/*' },
          signal,
          timeoutMs: Math.min(10_000, remainingMs),
          maxBytes: SNAPSHOT_MAX_BYTES
        }),
        { deadline, clock, signal: options.signal }
      );
    } catch (error) {
      throw executorError(
        scrubber.text(error?.message || 'URL Part snapshot transport failed'),
        classifyFailure(error).category,
        'platform-error'
      );
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw executorError(
        `URL Part snapshot returned HTTP ${response?.status || 0}`,
        'http',
        'agent-error',
        { code: 'http-status', status: response?.status || 0 }
      );
    }
    remaining(deadline, clock);
    const body = Buffer.from(response.body);
    if (body.length > SNAPSHOT_MAX_BYTES) {
      throw executorError(
        'URL Part snapshot exceeds 1 MiB',
        'agent',
        'agent-error',
        { code: 'response-too-large' }
      );
    }
    aggregateBytes += body.length;
    if (aggregateBytes > SNAPSHOT_AGGREGATE_MAX_BYTES) {
      throw executorError(
        'URL Part snapshots exceed the aggregate size limit',
        'agent',
        'agent-error',
        { code: 'response-too-large' }
      );
    }
    const sourceUrl = scrubber.text(redactUrlQuery(source));
    const mediaType = contentType(response.headers) || part.mediaType || part.file?.mimeType || null;
    const digest = sha256(body);
    let persisted;
    try {
      persisted = await runWithinDeadline(
        ({ signal, remainingMs }) => persistSnapshot({
          bytes: body,
          mediaType,
          size: body.length,
          sha256: digest,
          sourceUrl,
          runId: options.runId,
          testId: options.testId,
          turnIndex: options.turnIndex,
          repeatIndex: options.repeatIndex,
          signal,
          remainingMs
        }),
        { deadline, clock, signal: options.signal }
      );
    } catch (error) {
      const failure = classifyFailure(error);
      if (['signal', 'timeout'].includes(failure.category)) {
        throw executorError(
          scrubber.text(error?.message || 'URL Part snapshot persistence was interrupted'),
          failure.category,
          failure.outcome,
          { code: error?.code || failure.category }
        );
      }
      throw executorError(
        scrubber.text(error?.message || 'URL Part snapshot persistence failed'),
        'instrumentation',
        'platform-error'
      );
    }
    const evidenceRef = typeof persisted === 'string'
      ? persisted
      : persisted?.evidenceRef || persisted?.evidenceId;
    if (typeof evidenceRef !== 'string' || evidenceRef.trim() === '') {
      throw executorError('URL Part snapshot persistence returned no evidence reference', 'instrumentation', 'platform-error');
    }
    snapshots.push({
      evidenceRef: scrubber.text(evidenceRef),
      sourceUrl,
      mediaType,
      size: body.length,
      sha256: digest
    });
  }
  return snapshots;
}

function buildRun(input) {
  const {
    runId, testId, turnIndex, repeatIndex, target, initialRequest, requestId, messageId,
    rawObjects, normalized, httpStatus, mediaType, byteLength,
    snapshots,
    startedAt, headersAt, firstByteAt, firstEventAt, endedAt, outcome, error,
    authorization, protocolValidated
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
      endpointHash: target?.url ? sha256(target.url) : null,
      validated: protocolValidated === true
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
      normalized: safeNormalized,
      currentOutput: deriveCurrentOutput(
        safeNormalized,
        target,
        safeRawObjects
      ),
      snapshots: redactValue(snapshots || [], authorization)
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

function deriveCurrentOutput(normalized, target, rawObjects) {
  if (normalized?.responseKind === 'message') {
    const message = [...(normalized.messages || [])].reverse().find(
      (item) => ['agent', 'ROLE_AGENT'].includes(item?.role)
    );
    const parts = message?.parts || [];
    return {
      text: parts.map(directText).filter(Boolean).join('\n'),
      data: firstData(parts),
      artifacts: []
    };
  }
  if (normalized?.responseKind === 'task') {
    const artifacts = finalTaskArtifacts(target, rawObjects, normalized);
    const parts = artifacts.flatMap((artifact) => artifact.parts || []);
    return {
      text: parts.map(directText).filter(Boolean).join('\n'),
      data: firstData(parts),
      artifacts
    };
  }
  return { text: '', data: null, artifacts: [] };
}

function finalTaskArtifacts(target, rawObjects, normalized) {
  let finalTask = null;
  let hasArtifactUpdate = false;
  for (const raw of rawObjects || []) {
    const root = protocolRoot(target, raw);
    const task = root?.task || (isTask(root) ? root : null);
    if (root?.artifactUpdate || isArtifactUpdate(root)) {
      hasArtifactUpdate = true;
    }
    if (task) finalTask = task;
  }
  if (hasArtifactUpdate) return normalized.artifacts || [];
  if (finalTask && isTerminalState(finalTask.status?.state)) {
    return Array.isArray(finalTask.artifacts) ? finalTask.artifacts : [];
  }
  return normalized.artifacts || [];
}

function directText(part) {
  return typeof part?.text === 'string' ? part.text : '';
}

function firstData(parts) {
  for (const part of parts) {
    if (Object.hasOwn(part || {}, 'data')) return part.data;
  }
  return null;
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

function parseJsonResponse(target, response, requestId, operation = 'send-message') {
  requireHttpSuccess(response);
  requireMediaType(contentType(response.headers), ['application/json', 'application/a2a+json']);
  let payload;
  try {
    payload = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw executorError('A2A response is not valid JSON', 'json', 'agent-error', { code: 'invalid-json' });
  }
  try {
    parseA2AResponse(target, payload, requestId, { operation });
  } catch (error) {
    throw executorError(error.message, 'protocol', 'agent-error', {
      code: error.protocolCode === undefined ? 'protocol' : 'jsonrpc-error',
      protocolCode: error.protocolCode
    });
  }
  return payload;
}

function requireHttpSuccess(response) {
  if (!response || response.status < 200 || response.status >= 300) {
    throw executorError(
      `A2A returned HTTP ${response?.status || 0}`,
      'http',
      'agent-error',
      { code: 'http-status', status: response?.status || 0 }
    );
  }
}

function requireMediaType(actual, expected) {
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(actual)) {
    throw executorError(
      'A2A response Content-Type does not match the protocol',
      'content-type',
      'agent-error',
      { code: 'invalid-content-type' }
    );
  }
}

function validateStreamObjects(target, objects, requestId) {
  try {
    validateStreamResult(target, objects, requestId);
  } catch (error) {
    throw executorError(error.message, 'protocol', 'agent-error');
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

function appendStateTransition(sequence, state) {
  if (state && sequence.at(-1) !== state) sequence.push(state);
}

function dedupeByIdentity(values, ...keys) {
  const map = new Map();
  for (const value of values || []) map.set(identityFor(value, ...keys), value);
  return [...map.values()];
}

function identityFor(value, ...keys) {
  for (const key of keys) {
    if (typeof value?.[key] === 'string' && value[key]) return `${key}:${value[key]}`;
  }
  return `json:${JSON.stringify(value)}`;
}

function partText(part) {
  if (typeof part?.text === 'string') return part.text;
  if (typeof part?.data?.text === 'string') return part.data.text;
  if (Object.hasOwn(part || {}, 'data')) return JSON.stringify(part.data);
  return '';
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
  if (normalized.responseKind === 'message' && normalized.terminal) {
    return { status: 'succeeded', lifecycle: 'completed' };
  }
  if (normalized.terminal && SUCCESS_STATES.has(normalizeState(normalized.terminalState))) {
    return { status: 'succeeded', lifecycle: 'completed' };
  }
  if (
    normalized.terminal &&
    ['INPUT_REQUIRED', 'AUTH_REQUIRED', 'INTERRUPTED'].includes(normalizeState(normalized.terminalState))
  ) {
    return { status: 'succeeded', lifecycle: 'interrupted' };
  }
  if (normalized.terminal) return { status: 'agent-error', lifecycle: 'terminal-failure' };
  return { status: 'unknown', lifecycle: 'incomplete' };
}

function isInterruptedOutcome(run) {
  if (run?.outcome?.lifecycle === 'interrupted') return true;
  return ['INPUT_REQUIRED', 'AUTH_REQUIRED', 'INTERRUPTED'].includes(
    normalizeState(run?.response?.normalized?.terminalState)
  );
}

function classifyFailure(error) {
  if (error?.outcome && error?.category) return { outcome: error.outcome, category: error.category };
  if (error instanceof TypeError) return { outcome: 'platform-error', category: 'configuration' };
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

function executorError(message, category, outcome, details = {}) {
  return Object.assign(new Error(message), {
    category,
    outcome,
    code: details.code || category,
    status: details.status ?? null,
    ...(details.protocolCode === undefined ? {} : { protocolCode: details.protocolCode })
  });
}

function publicError(message, category, authorization, details = {}) {
  const scrubber = createSecretScrubber(authorization);
  return {
    category,
    code: details.code || category,
    status: details.status ?? null,
    message: scrubber.text(String(message || 'A2A execution failed')),
    ...(details.protocolCode === undefined ? {} : { protocolCode: details.protocolCode })
  };
}

function bearer(value) {
  return `Bearer ${authorizationToken(value)}`;
}

function contentType(headers) {
  return String(headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

function remaining(deadline, clock) {
  const value = deadline - clock();
  if (value <= 0) throw Object.assign(new Error('A2A execution timed out'), { code: 'timeout' });
  return value;
}

async function runWithinDeadline(operation, { deadline, clock, signal }) {
  if (signal?.aborted) {
    throw Object.assign(new Error('A2A execution cancelled'), { code: 'cancelled' });
  }
  const remainingMs = remaining(deadline, clock);
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error('A2A execution timed out'), { code: 'timeout' });
  const onExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(Object.assign(new Error('A2A execution cancelled'), {
        code: 'cancelled',
        name: 'AbortError'
      }));
    }
  };
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (signal?.aborted) onExternalAbort();

  let onInternalAbort;
  let timer;
  const aborted = new Promise((_, reject) => {
    onInternalAbort = () => reject(
      controller.signal.reason ||
      Object.assign(new Error('A2A execution cancelled'), { code: 'cancelled' })
    );
    controller.signal.addEventListener('abort', onInternalAbort, { once: true });
  });
  timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(timeoutError);
  }, remainingMs);

  const pending = Promise.resolve().then(() => operation({
    signal: controller.signal,
    remainingMs
  }));
  try {
    const result = await Promise.race([pending, aborted]);
    remaining(deadline, clock);
    return result;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onInternalAbort);
    signal?.removeEventListener('abort', onExternalAbort);
  }
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

function collectAgentSnapshotParts(target, rawObjects) {
  const parts = [];
  const addMessage = (message) => {
    if (['agent', 'ROLE_AGENT'].includes(message?.role)) collectParts(message.parts, parts);
  };
  for (const raw of rawObjects || []) {
    const root = protocolRoot(target, raw);
    if (!root || typeof root !== 'object') continue;
    const message = root.message || (isMessage(root) ? root : null);
    const task = root.task || (isTask(root) ? root : null);
    const statusUpdate = root.statusUpdate || (isStatusUpdate(root) ? root : null);
    const artifactUpdate = root.artifactUpdate || (isArtifactUpdate(root) ? root : null);
    addMessage(message);
    if (task) {
      addMessage(task.status?.message);
      for (const item of task.history || []) addMessage(item);
      for (const artifact of task.artifacts || []) collectParts(artifact.parts, parts);
    }
    if (statusUpdate) addMessage(statusUpdate.status?.message);
    if (artifactUpdate?.artifact) collectParts(artifactUpdate.artifact.parts, parts);
  }
  return dedupeByIdentity(parts);
}

function directPartUrl(part) {
  if (!part || typeof part !== 'object') return null;
  const v1Choices = ['text', 'raw', 'url', 'data'].filter((key) => Object.hasOwn(part, key));
  if (
    part.kind === undefined &&
    part.type === undefined &&
    v1Choices.length === 1 &&
    v1Choices[0] === 'url' &&
    typeof part.url === 'string'
  ) {
    return part.url;
  }
  if (
    part.kind === 'file' &&
    part.file &&
    typeof part.file === 'object' &&
    Object.hasOwn(part.file, 'uri') &&
    !Object.hasOwn(part.file, 'bytes') &&
    typeof part.file.uri === 'string'
  ) {
    return part.file.uri;
  }
  return null;
}

function redactUrlQuery(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function redactValue(value, secret) {
  return createSecretScrubber(secret).value(value);
}

function redactText(value, secret) {
  return createSecretScrubber(secret).text(value);
}

function validateAuthorization(value) {
  if (value === undefined || value === null) return;
  authorizationToken(value);
}

export function validateAgentAuthorization(value) {
  validateAuthorization(value);
  return value ?? undefined;
}

function authorizationToken(value) {
  if (typeof value !== 'string') {
    throw executorError('Authorization must be a string', 'configuration', 'platform-error');
  }
  const bearerMatch = value.match(/^Bearer ([A-Za-z0-9\-._~+/]+=*)$/iu);
  const rawMatch = value.match(/^([A-Za-z0-9\-._~+/]+=*)$/u);
  const token = bearerMatch?.[1] ?? rawMatch?.[1];
  if (
    value.trim() !== value ||
    !token ||
    /^Bearer$/iu.test(value) ||
    token.length < MIN_AUTHORIZATION_TOKEN_LENGTH ||
    Buffer.byteLength(value) > MAX_AUTHORIZATION_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw executorError(
      'Authorization is blank, too short, too long, or contains unsafe characters',
      'configuration',
      'platform-error'
    );
  }
  return token;
}

function createSecretScrubber(authorization) {
  if (typeof authorization !== 'string' || authorization.length === 0) {
    return {
      text: (value) => String(value),
      value: (value) => value,
      contains: () => false
    };
  }
  let token;
  try {
    token = authorizationToken(authorization);
  } catch {
    return literalSecretScrubber(authorization);
  }
  const header = bearer(token);
  const patterns = [];
  const patternKeys = new Set();
  const addPattern = (source, caseInsensitive = false) => {
    if (
      typeof source !== 'string' ||
      source.length < MIN_AUTHORIZATION_TOKEN_LENGTH ||
      source.length > MAX_SECRET_PATTERN_LENGTH
    ) return;
    const key = `${caseInsensitive ? 'i' : ''}:${source}`;
    if (patternKeys.has(key) || patterns.length >= MAX_SECRET_PATTERNS) return;
    patternKeys.add(key);
    patterns.push({
      source,
      regex: new RegExp(source, caseInsensitive ? 'giu' : 'gu')
    });
  };
  const addLiteral = (value, caseInsensitive = false) => {
    if (typeof value !== 'string') return;
    addPattern(escapeRegExp(value), caseInsensitive);
  };

  for (const value of [token, header]) {
    const bytes = Buffer.from(value);
    const base64 = bytes.toString('base64');
    const base64url = bytes.toString('base64url');
    const uriEncoded = encodeURIComponent(value);
    addLiteral(value);
    addLiteral(value.replaceAll('/', '\\/'));
    addLiteral(JSON.stringify(value).slice(1, -1));
    addPattern(percentFlexiblePattern(value), true);
    addLiteral(uriEncoded, true);
    addLiteral(uriEncoded.replaceAll('%20', '+'), true);
    addLiteral(base64);
    addLiteral(base64.replace(/=+$/u, ''));
    addLiteral(base64url);
    addLiteral(base64url.padEnd(Math.ceil(base64url.length / 4) * 4, '='));
    addLiteral(bytes.toString('hex'), true);
  }
  patterns.sort((left, right) => right.source.length - left.source.length);
  const text = (input) => {
    const inspected = inspectDecodedSecretViews(input);
    if (inspected.unsafe) return '[REDACTED]';
    const redacted = patterns.reduce(
      (result, pattern) => {
        pattern.regex.lastIndex = 0;
        return result.replace(pattern.regex, '[REDACTED]');
      },
      inspected.views[0]
    );
    const inspectedRedacted = inspectDecodedSecretViews(redacted);
    if (
      inspectedRedacted.unsafe ||
      inspectedRedacted.views.some((view) => matchesSecretPattern(patterns, view))
    ) {
      return '[REDACTED]';
    }
    return redacted;
  };
  const value = (input) => scrubObjectValue(input, text);
  const contains = (input) => {
    const inspected = inspectDecodedSecretViews(input);
    return inspected.unsafe ||
      inspected.views.some((view) => matchesSecretPattern(patterns, view));
  };
  return { text, value, contains };
}

function matchesSecretPattern(patterns, input) {
  return patterns.some((pattern) => {
    pattern.regex.lastIndex = 0;
    const found = pattern.regex.test(String(input));
    pattern.regex.lastIndex = 0;
    return found;
  });
}

function inspectDecodedSecretViews(input) {
  const source = String(input);
  if (source.length > MAX_SECRET_DECODE_INPUT_LENGTH) {
    return { views: [], unsafe: true };
  }
  const views = [source];
  const seen = new Set(views);
  const queue = [{ value: source, depth: 0 }];
  let work = 0;
  const reserveWork = (amount) => {
    if (amount > MAX_SECRET_DECODE_WORK - work) return false;
    work += amount;
    return true;
  };
  const decode = (value, formEncoded) => {
    const cost = value.length * (formEncoded ? 2 : 1);
    if (!reserveWork(cost)) return { unsafe: true };
    const candidate = formEncoded ? value.replaceAll('+', ' ') : value;
    try {
      return { value: decodeURIComponent(candidate), unsafe: false };
    } catch {
      return { unsafe: true };
    }
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (!reserveWork(current.value.length)) {
      return { views, unsafe: true };
    }
    const modes = current.value.includes('+') ? [false, true] : [false];
    for (const formEncoded of modes) {
      const decoded = decode(current.value, formEncoded);
      if (decoded.unsafe) return { views, unsafe: true };
      if (current.depth >= MAX_SECRET_DECODE_DEPTH) {
        if (decoded.value !== current.value) return { views, unsafe: true };
        continue;
      }
      if (seen.has(decoded.value)) continue;
      if (views.length >= MAX_SECRET_DECODE_VIEWS) {
        return { views, unsafe: true };
      }
      seen.add(decoded.value);
      views.push(decoded.value);
      queue.push({ value: decoded.value, depth: current.depth + 1 });
    }
  }
  return { views, unsafe: false };
}

function literalSecretScrubber(secret) {
  const text = (input) => String(input).split(secret).join('[REDACTED]');
  return {
    text,
    value: (input) => scrubObjectValue(input, text),
    contains: (input) => String(input).includes(secret)
  };
}

function scrubObjectValue(input, text) {
  if (typeof input === 'string') return text(input);
  if (Array.isArray(input)) return input.map((item) => scrubObjectValue(item, text));
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [text(key), scrubObjectValue(item, text)])
    );
  }
  return input;
}

function percentFlexiblePattern(value) {
  return [...value].map((character) => {
    const raw = escapeRegExp(character);
    const percentEncoded = [...Buffer.from(character)]
      .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
      .join('');
    const alternatives = character === ' '
      ? [raw, percentEncoded, '\\+']
      : [raw, percentEncoded];
    return `(?:${alternatives.join('|')})`;
  }).join('');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
    artifactTimeline: [],
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
