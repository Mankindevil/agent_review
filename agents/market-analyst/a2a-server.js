import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { readJsonBody } from '../../src/utils.js';
import { buildMarketAgentCard } from './agent-card.js';
import { ownerScope, principalOwnerScope } from './owner-scope.js';
import {
  MarketA2AError,
  MarketTaskService,
  marketA2AError
} from './task-service.js';

const A2A_MEDIA_TYPE = 'application/a2a+json';
const A2A_VERSION = '1.0';
const MAX_BODY_BYTES = 1_000_000;
const MAX_SSE_EVENT_BYTES = 64 * 1024;
const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED'
]);
const TASK_STATES = new Set([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  ...TERMINAL_STATES
]);

const HTTP_STATUS_TEXT = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  413: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL'
};

function contentType(request) {
  return String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

function json(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function a2aJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': `${A2A_MEDIA_TYPE}; charset=utf-8`,
    'cache-control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function errorInfo(reason, metadata = {}) {
  const safeMetadata = Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value).slice(0, 500)])
  );
  return {
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: 'a2a-protocol.org',
    ...(Object.keys(safeMetadata).length ? { metadata: safeMetadata } : {})
  };
}

function sendA2AError(response, error) {
  const statusCode = Number(error?.statusCode) || 500;
  const reason = String(error?.reason || 'INTERNAL');
  const status = String(error?.status || HTTP_STATUS_TEXT[statusCode] || 'INTERNAL');
  if (statusCode === 401) {
    response.setHeader('www-authenticate', 'Bearer realm="panda-market-analyst"');
  }
  return a2aJson(response, statusCode, {
    error: {
      code: statusCode,
      status,
      message: String(error?.message || 'Internal error').slice(0, 1000),
      details: [errorInfo(reason, error?.metadata)]
    }
  });
}

function versionError(value) {
  return marketA2AError(
    'VERSION_NOT_SUPPORTED',
    `A2A version ${value || '(missing)'} is not supported; use 1.0`,
    {
      statusCode: 400,
      status: 'FAILED_PRECONDITION',
      metadata: {
        requestedVersion: value || '',
        supportedVersion: A2A_VERSION
      }
    }
  );
}

function authenticationError() {
  return marketA2AError('UNAUTHENTICATED', 'Valid Bearer authentication is required', {
    statusCode: 401,
    status: 'UNAUTHENTICATED'
  });
}

function contentTypeError() {
  return marketA2AError(
    'CONTENT_TYPE_NOT_SUPPORTED',
    `Content-Type must be ${A2A_MEDIA_TYPE}`,
    { statusCode: 400, status: 'INVALID_ARGUMENT' }
  );
}

function invalidRequestError(message) {
  return marketA2AError('INVALID_REQUEST', message, {
    statusCode: 400,
    status: 'INVALID_ARGUMENT'
  });
}

function requestTooLargeError() {
  return marketA2AError('REQUEST_TOO_LARGE', 'Request body exceeds the 1 MB limit', {
    statusCode: 413,
    status: 'RESOURCE_EXHAUSTED'
  });
}

function unsupportedRoute(pathname) {
  return marketA2AError(
    'UNSUPPORTED_OPERATION',
    `The A2A operation ${pathname} is not supported`,
    { statusCode: 400, status: 'FAILED_PRECONDITION' }
  );
}

function pushNotificationUnsupported() {
  return marketA2AError(
    'PUSH_NOTIFICATION_NOT_SUPPORTED',
    'Push notifications are not supported by this agent',
    { statusCode: 400, status: 'FAILED_PRECONDITION' }
  );
}

function bearerToken(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer ([^\r\n]+)$/i);
  return match?.[1] || '';
}

function constantTimeEqual(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && timingSafeEqual(first, second);
}

function isLoopbackHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isLoopbackAddress(value) {
  const address = String(value || '').toLowerCase();
  return isLoopbackHost(address.replace(/^::ffff:/, ''));
}

async function authenticateRequest(request, options) {
  const token = bearerToken(request);
  if (typeof options.authenticate === 'function') {
    if (!token) throw authenticationError();
    const identity = await options.authenticate({ token, request });
    if (!identity || typeof identity.owner !== 'string' || !identity.owner) {
      throw authenticationError();
    }
    try {
      return { owner: ownerScope(identity.owner) };
    } catch {
      throw authenticationError();
    }
  }
  const expected = String(options.config?.accessToken || '');
  if (!expected) {
    if (!isLoopbackAddress(request.socket?.remoteAddress)) throw authenticationError();
    return { owner: ownerScope('loopback:anonymous') };
  }
  if (!token || !constantTimeEqual(token, expected)) throw authenticationError();
  return { owner: principalOwnerScope(options.config?.principalId) };
}

function requestOrigin(request, options) {
  const configured = String(
    options.origin || options.config?.publicBaseUrl || ''
  ).replace(/\/+$/, '');
  if (configured) {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new TypeError('public origin must use HTTP(S)');
    }
    return url.origin;
  }
  const host = String(request.headers.host || '');
  if (!/^[a-z0-9.[\]:_-]+$/i.test(host)) {
    throw invalidRequestError('Host header is invalid');
  }
  return `http://${host}`;
}

function parseIdentifier(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 200 || decoded.includes('/')) {
      throw new Error('invalid identifier');
    }
    return decoded;
  } catch {
    throw invalidRequestError('Resource identifier is invalid');
  }
}

async function body(request) {
  if (contentType(request) !== A2A_MEDIA_TYPE) throw contentTypeError();
  try {
    return await readJsonBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error?.statusCode === 413) throw requestTooLargeError();
    throw invalidRequestError('Invalid JSON payload');
  }
}

function requireVersion(request) {
  const version = String(request.headers['a2a-version'] || '');
  if (version !== A2A_VERSION) throw versionError(version);
}

function terminalTask(task) {
  return TERMINAL_STATES.has(task?.status?.state);
}

function writeSse(response, event) {
  response.write(sseFrame(event));
}

function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function streamTaskSnapshot(task) {
  const snapshot = structuredClone(task);
  const fits = (value) =>
    Buffer.byteLength(sseFrame({ task: value })) <= MAX_SSE_EVENT_BYTES;
  if (fits(snapshot)) {
    return snapshot;
  }
  if (Array.isArray(snapshot.artifacts) && snapshot.artifacts.length) {
    snapshot.artifacts = snapshot.artifacts.map((artifact) => {
      const projected = artifact.metadata?.projected === true;
      return {
        artifactId: artifact.artifactId,
        name: artifact.name,
        parts: [{
          data: {
            truncated: true,
            message: projected
              ? `Fetch /a2a/v1/tasks/${encodeURIComponent(snapshot.id)} for the complete projected artifact`
              : 'Fetch the protected task or run detail for the complete artifact'
          },
          mediaType: 'application/json'
        }],
        metadata: {
          ...(projected ? { projected: true } : {}),
          truncatedForStream: true
        }
      };
    });
  }
  if (fits(snapshot)) return snapshot;
  snapshot.artifacts = [];
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    artifactsTruncatedForStream: true
  };
  if (fits(snapshot)) return snapshot;
  if (Array.isArray(snapshot.history) && snapshot.history.length) {
    snapshot.history = [];
    snapshot.metadata = {
      ...(snapshot.metadata || {}),
      historyTruncatedForStream: true
    };
  }
  if (fits(snapshot)) return snapshot;
  return {
    id: snapshot.id,
    contextId: snapshot.contextId,
    status: {
      state: snapshot.status?.state,
      timestamp: snapshot.status?.timestamp
    },
    metadata: { truncatedForStream: true }
  };
}

function streamTask(request, response, service, task, owner, options = {}) {
  let unsubscribe = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (!response.writableEnded) response.end();
  };
  const listener = (event) => {
    if (closed || response.writableEnded) return;
    writeSse(response, event);
    if (terminalTask({ status: event.statusUpdate?.status })) close();
  };
  unsubscribe = service.subscribe(task.id, owner, listener, options);
  try {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff'
    });
    response.flushHeaders?.();
    writeSse(response, { task: streamTaskSnapshot(task) });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  if (terminalTask(task)) {
    close();
    return;
  }
  const detach = () => {
    closed = true;
    unsubscribe();
  };
  request.once('aborted', detach);
  response.once('close', detach);
}

function queryOptions(url) {
  const pageSize = url.searchParams.get('pageSize');
  const historyValue = url.searchParams.get('historyLength');
  const status = url.searchParams.get('status');
  const includeArtifactsValue = url.searchParams.get('includeArtifacts');
  const statusTimestampAfter = url.searchParams.get('statusTimestampAfter');
  let historyLength;
  if (historyValue !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(historyValue)) {
      throw invalidRequestError('historyLength must be an integer from 0 to 32');
    }
    historyLength = Number(historyValue);
    if (historyLength > 32) {
      throw invalidRequestError('historyLength must be an integer from 0 to 32');
    }
  }
  if (status !== null && !TASK_STATES.has(status)) {
    throw invalidRequestError('status must be a supported task state');
  }
  if (
    includeArtifactsValue !== null
    && includeArtifactsValue !== 'true'
    && includeArtifactsValue !== 'false'
  ) {
    throw invalidRequestError('includeArtifacts must be true or false');
  }
  return {
    contextId: url.searchParams.get('contextId') || undefined,
    status: status || undefined,
    statusTimestampAfter: statusTimestampAfter === null
      ? undefined
      : statusTimestampAfter,
    pageToken: url.searchParams.get('pageToken') || undefined,
    pageSize: pageSize === null ? undefined : pageSize,
    historyLength,
    includeArtifacts: includeArtifactsValue === 'true'
  };
}

function standardError(response, error) {
  const statusCode = Number(error?.statusCode) || 500;
  if (statusCode === 401) {
    response.setHeader('www-authenticate', 'Bearer realm="panda-market-analyst"');
  }
  return json(response, statusCode, {
    error: {
      code: statusCode,
      status: error?.status || HTTP_STATUS_TEXT[statusCode] || 'INTERNAL',
      message: String(error?.message || 'Internal error').slice(0, 1000)
    }
  });
}

function artifactPart(artifact) {
  return artifact?.parts?.[0];
}

async function handleRunRoute(request, response, url, identity, service) {
  const match = url.pathname.match(/^\/runs\/([^/]+)(?:\/(report|evidence|trace))?$/);
  if (!match || request.method !== 'GET') return false;
  const runId = parseIdentifier(match[1]);
  const type = match[2];
  if (!type) {
    json(response, 200, await service.loadRun(runId, identity.owner));
    return true;
  }
  const artifacts = await service.loadRunArtifacts(runId, identity.owner);
  const names = {
    report: 'market-report.md',
    evidence: 'evidence-pack.json',
    trace: 'run-trace.json'
  };
  const artifact = artifacts.find((candidate) => candidate.name === names[type]);
  if (!artifact) {
    throw marketA2AError('TASK_NOT_FOUND', 'The requested run artifact was not found', {
      statusCode: 404,
      status: 'NOT_FOUND',
      metadata: { runId, artifact: names[type] }
    });
  }
  const part = artifactPart(artifact);
  if (type === 'report') {
    json(response, 200, { runId, report: part?.text || '' });
  } else {
    json(response, 200, part?.data ?? {});
  }
  return true;
}

async function handleA2A(request, response, url, identity, service) {
  requireVersion(request);
  if (url.pathname.includes('/pushNotificationConfigs')) {
    if (['POST', 'PUT'].includes(request.method)) await body(request);
    throw pushNotificationUnsupported();
  }
  if (request.method === 'POST' && url.pathname === '/a2a/v1/message:send') {
    const submission = service.submit({
      owner: identity.owner,
      request: await body(request)
    });
    const task = submission.returnImmediately
      ? submission.task
      : await service.wait(
          submission.task.id,
          identity.owner,
          submission.responseOptions
        );
    return a2aJson(response, 200, { task });
  }
  if (request.method === 'POST' && url.pathname === '/a2a/v1/message:stream') {
    const submission = service.submit({
      owner: identity.owner,
      request: await body(request)
    });
    return streamTask(
      request,
      response,
      service,
      submission.task,
      identity.owner,
      submission.responseOptions
    );
  }
  if (request.method === 'GET' && url.pathname === '/a2a/v1/tasks') {
    return a2aJson(response, 200, service.list(identity.owner, queryOptions(url)));
  }
  const getMatch = url.pathname.match(/^\/a2a\/v1\/tasks\/([^/:]+)$/);
  if (request.method === 'GET' && getMatch) {
    const id = parseIdentifier(getMatch[1]);
    return a2aJson(response, 200, service.get(id, identity.owner, {
      historyLength: queryOptions(url).historyLength
    }));
  }
  const cancelMatch = url.pathname.match(/^\/a2a\/v1\/tasks\/([^/:]+):cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    await body(request);
    const id = parseIdentifier(cancelMatch[1]);
    return a2aJson(response, 200, service.cancel(id, identity.owner));
  }
  const subscribeMatch = url.pathname.match(/^\/a2a\/v1\/tasks\/([^/:]+):subscribe$/);
  if (request.method === 'POST' && subscribeMatch) {
    await body(request);
    const id = parseIdentifier(subscribeMatch[1]);
    const task = service.get(id, identity.owner);
    if (terminalTask(task)) throw unsupportedRoute(url.pathname);
    return streamTask(request, response, service, task, identity.owner);
  }
  throw unsupportedRoute(url.pathname);
}

export function createMarketAgentServer(options = {}) {
  if (!options.config || typeof options.config !== 'object') {
    throw new TypeError('config is required');
  }
  const accessProtected = Boolean(
    options.config.accessToken || typeof options.authenticate === 'function'
  );
  if (!accessProtected) {
    if (options.config.allowInsecureLoopback !== true) {
      throw new TypeError(
        'MARKET_AGENT_ACCESS_TOKEN is required unless loopback development is explicitly enabled'
      );
    }
    if (!isLoopbackHost(options.config.host)) {
      throw new TypeError('tokenless development mode must bind to a loopback host');
    }
  }
  const cardConfig = {
    ...options.config,
    accessProtected
  };
  const service = options.taskService || new MarketTaskService({
    orchestrator: options.orchestrator,
    config: options.config,
    runLoader: options.runLoader,
    artifactLoader: options.artifactLoader,
    clock: options.clock,
    createId: options.createId,
    maxTasks: options.maxTasks,
    maxActiveTasks: options.maxActiveTasks,
    retentionMs: options.retentionMs
  });
  const server = createServer(async (request, response) => {
    let isA2A = false;
    try {
      const url = new URL(request.url, 'http://localhost');
      isA2A = url.pathname.startsWith('/a2a/v1');
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { ok: true, agent: 'panda-market-analyst' });
      }
      if (request.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
        return a2aJson(
          response,
          200,
          buildMarketAgentCard(requestOrigin(request, options), cardConfig),
          { 'cache-control': 'public, max-age=60' }
        );
      }
      const identity = await authenticateRequest(request, options);
      if (isA2A) return await handleA2A(request, response, url, identity, service);
      if (await handleRunRoute(request, response, url, identity, service)) return;
      return json(response, 404, {
        error: { code: 404, status: 'NOT_FOUND', message: 'Route not found' }
      });
    } catch (error) {
      if (!(error instanceof MarketA2AError) && error?.statusCode !== 404) {
        options.logger?.error?.(error);
      }
      if (isA2A) {
        if (error instanceof MarketA2AError) return sendA2AError(response, error);
        return sendA2AError(response, marketA2AError(
          'INTERNAL',
          'Internal error',
          { statusCode: 500, status: 'INTERNAL' }
        ));
      }
      return standardError(response, error);
    }
  });
  server.marketTaskService = service;
  return server;
}
