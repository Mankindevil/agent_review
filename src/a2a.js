import { safeHttpRequest, validateSafeUrl } from './safe-http.js';

const LEGACY_BINDINGS = { JSONRPC: 'JSONRPC', 'JSON-RPC': 'JSONRPC', HTTP_JSON: 'HTTP+JSON', 'HTTP+JSON': 'HTTP+JSON' };
const HYBRID_1X_WARNING =
  '检测到 A2A 0.3/1.x 混合格式；平台已根据顶层 url、protocolVersion 和 preferredTransport 生成兼容接口。建议提交前修正原始 Agent Card。';
const LEGACY_02_WARNING =
  '检测到 A2A 0.2.x；平台已按 0.3 兼容接口执行。建议将 protocolVersion 升级为 0.3 或改为 supportedInterfaces 1.x。';
const PLATFORM_OUTPUT_MODES = new Set([
  'text/plain',
  'text/markdown',
  'application/json'
]);
const DEFAULT_ACCEPTED_OUTPUT_MODES = Object.freeze(['text/plain', 'application/json']);

export function negotiateAcceptedOutputModes(card) {
  if (!Object.hasOwn(card || {}, 'defaultOutputModes')) {
    return [...DEFAULT_ACCEPTED_OUTPUT_MODES];
  }
  const modes = [];
  for (const mode of card.defaultOutputModes || []) {
    if (PLATFORM_OUTPUT_MODES.has(mode) && !modes.includes(mode)) {
      modes.push(mode);
    }
  }
  if (modes.length === 0) {
    throw new TypeError(
      'Agent Card defaultOutputModes are incompatible with platform-supported output modes'
    );
  }
  return modes;
}

export function validateAgentCard(card, options = {}) {
  const errors = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) errors.push('Agent Card 必须是 JSON 对象');
  if (!isNonEmptyString(card?.name)) errors.push('name 必须是非空字符串');
  if (!isNonEmptyString(card?.description)) errors.push('description 必须是非空字符串');
  validateOptionalString(card, 'version', 'version', errors);
  validateOptionalStringArray(card, 'defaultInputModes', 'defaultInputModes', errors);
  validateOptionalStringArray(card, 'defaultOutputModes', 'defaultOutputModes', errors);
  validateCapabilities(card?.capabilities, errors);
  if (!Array.isArray(card?.skills) || card.skills.length === 0) {
    errors.push('至少声明一个 skill');
  } else {
    card.skills.forEach((skill, index) => {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
        errors.push(`skills[${index}] 必须是对象`);
        return;
      }
      if (!isNonEmptyString(skill.id)) errors.push(`skills[${index}].id 必须是非空字符串`);
      if (!isNonEmptyString(skill.name)) errors.push(`skills[${index}].name 必须是非空字符串`);
      if (!isNonEmptyString(skill.description)) errors.push(`skills[${index}].description 必须是非空字符串`);
      validateOptionalStringArray(skill, 'tags', `skills[${index}].tags`, errors);
      validateOptionalStringArray(skill, 'examples', `skills[${index}].examples`, errors);
      validateOptionalStringArray(skill, 'inputModes', `skills[${index}].inputModes`, errors);
      validateOptionalStringArray(skill, 'outputModes', `skills[${index}].outputModes`, errors);
    });
  }
  validateOptionalContainer(card, 'provider', 'object', errors);
  validateOptionalContainer(card, 'securitySchemes', 'object', errors);
  validateOptionalContainer(card, 'security', 'array', errors);
  validateOptionalContainer(card, 'signatures', 'array', errors);
  validateOptionalContainer(card, 'extensions', 'array', errors);

  const resolved = resolveDeclaredInterfaces(card, options);
  errors.push(...resolved.errors);
  const selectedInterface = resolved.interfaces.find(isSupportedInterface) || null;
  if (!selectedInterface) errors.push('Agent Card must declare at least one supported interface');
  return {
    valid: errors.length === 0,
    errors,
    warnings: resolved.warnings,
    version: inferVersion(card),
    schemaVersion: resolved.schemaVersion,
    interfaces: resolved.interfaces,
    selectedInterface
  };
}

export function inferVersion(card) {
  return card?.protocolVersion || card?.supportedInterfaces?.[0]?.protocolVersion || (card?.url ? '0.3-compatible' : '1.0');
}

export function getInterfaces(card, options = {}) {
  return resolveDeclaredInterfaces(card, options).interfaces;
}

export function selectInterface(card, options = {}) {
  return getInterfaces(card, options).find(isSupportedInterface) || null;
}

export function resolveDeclaredInterfaces(card, options = {}) {
  const errors = [];
  const warnings = [];
  const hasSupportedInterfaces = Array.isArray(card?.supportedInterfaces) ||
    Object.hasOwn(card || {}, 'supportedInterfaces');
  if (hasSupportedInterfaces) {
    return {
      schemaVersion: '1.x',
      interfaces: validateV1Interfaces(card?.supportedInterfaces, errors, options),
      warnings,
      errors
    };
  }
  return resolveTopLevelInterface(card, errors, warnings, options);
}

function isNonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }

function validateV1Interfaces(value, errors, options) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('supportedInterfaces 必须是非空数组');
    return [];
  }
  const interfaces = [];
  value.forEach((item, index) => {
    const path = `supportedInterfaces[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${path} 必须是对象`);
      return;
    }
    const url = validateDeclaredUrl(item.url, `${path}.url`, errors, options);
    const binding = validateRequiredString(item.protocolBinding, `${path}.protocolBinding`, errors);
    let version = validateRequiredString(item.protocolVersion, `${path}.protocolVersion`, errors);
    if (version && !/^1\./u.test(version)) {
      errors.push(`${path}.protocolVersion 必须是 1.x 版本`);
      version = null;
    }
    if (item.tenant !== undefined && !isNonEmptyString(item.tenant)) {
      errors.push(`${path}.tenant 必须是非空字符串`);
    }
    if (url && binding && version) {
      const normalized = {
        url,
        binding: LEGACY_BINDINGS[binding] || binding,
        version
      };
      if (isNonEmptyString(item.tenant)) normalized.tenant = item.tenant;
      interfaces.push(normalized);
    }
  });
  return interfaces;
}

function resolveTopLevelInterface(card, errors, warnings, options) {
  const url = validateDeclaredUrl(card?.url, 'url', errors, options);
  const declaredVersion = card?.protocolVersion === undefined
    ? '0.3'
    : validateRequiredString(card.protocolVersion, 'protocolVersion', errors);
  if (!url || !declaredVersion) {
    return { schemaVersion: '0.3', interfaces: [], warnings, errors };
  }

  if (/^0\.3(?:\.|$)/u.test(declaredVersion)) {
    const transport = resolveLegacyTransport(card, errors, { required: false });
    if (!transport) return { schemaVersion: '0.3', interfaces: [], warnings, errors };
    return {
      schemaVersion: '0.3',
      interfaces: [{ url, binding: transport, version: declaredVersion }],
      warnings,
      errors
    };
  }

  if (/^0\.2(?:\.|$)/u.test(declaredVersion)) {
    const transport = resolveLegacyTransport(card, errors, { required: false });
    if (!transport) return { schemaVersion: '0.3', interfaces: [], warnings, errors };
    warnings.push(LEGACY_02_WARNING);
    return {
      schemaVersion: '0.3',
      interfaces: [{ url, binding: transport, version: '0.3' }],
      warnings,
      errors
    };
  }

  if (/^1\./u.test(declaredVersion)) {
    const transport = resolveLegacyTransport(card, errors, { required: true });
    if (!transport) return { schemaVersion: '0.3', interfaces: [], warnings, errors };
    warnings.push(HYBRID_1X_WARNING);
    return {
      schemaVersion: '0.3',
      interfaces: [{ url, binding: transport, version: declaredVersion }],
      warnings,
      errors
    };
  }

  errors.push('protocolVersion 必须是 0.2.x、0.3 兼容版本或 1.x 混合格式');
  return { schemaVersion: '0.3', interfaces: [], warnings, errors };
}

function resolveLegacyTransport(card, errors, { required }) {
  if (card?.preferredTransport === undefined) {
    if (required) {
      errors.push('hybrid 1.x Agent Card 必须声明 preferredTransport');
      return null;
    }
    return 'JSONRPC';
  }
  const transport = validateRequiredString(card.preferredTransport, 'preferredTransport', errors);
  if (!transport) return null;
  const binding = LEGACY_BINDINGS[transport];
  if (!binding) {
    errors.push('preferredTransport 必须是 JSONRPC 或 HTTP+JSON');
    return null;
  }
  return binding;
}

function validateDeclaredUrl(value, path, errors, options = {}) {
  if (!isNonEmptyString(value)) {
    errors.push(`${path} 必须是非空 URL 字符串`);
    return null;
  }
  try {
    return validateSafeUrl(value, {
      allowPrivate: options.allowPrivate ??
        process.env.ALLOW_PRIVATE_AGENT_URLS === 'true'
    }).toString();
  } catch {
    errors.push(`${path} 必须是安全的 HTTP(S) URL`);
    return null;
  }
}

function validateRequiredString(value, path, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${path} 必须是非空字符串`);
    return null;
  }
  return value;
}

function validateOptionalString(source, key, path, errors) {
  if (source?.[key] !== undefined && !isNonEmptyString(source[key])) {
    errors.push(`${path} 必须是非空字符串`);
  }
}

function validateOptionalStringArray(source, key, path, errors) {
  if (source?.[key] === undefined) return;
  if (!Array.isArray(source[key])) {
    errors.push(`${path} 必须是字符串数组`);
    return;
  }
  source[key].forEach((value, index) => {
    if (!isNonEmptyString(value)) errors.push(`${path}[${index}] 必须是非空字符串`);
  });
}

function validateCapabilities(value, errors) {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    errors.push('capabilities 必须是对象');
    return;
  }
  for (const key of ['streaming', 'pushNotifications', 'stateTransitionHistory', 'extendedAgentCard']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      errors.push(`capabilities.${key} 必须是布尔值`);
    }
  }
  if (value.extensions !== undefined && !Array.isArray(value.extensions)) {
    errors.push('capabilities.extensions 必须是数组');
  }
}

function validateOptionalContainer(source, key, type, errors) {
  if (source?.[key] === undefined) return;
  const valid = type === 'array' ? Array.isArray(source[key]) : isPlainObject(source[key]);
  if (!valid) errors.push(`${key} 必须是${type === 'array' ? '数组' : '对象'}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSupportedInterface(item) {
  return ['HTTP+JSON', 'JSONRPC'].includes(item?.binding) &&
    (/^1\./u.test(String(item?.version)) || /^0\.3(?:\.|$)/u.test(String(item?.version)));
}

export function assertSafeAgentUrl(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ??
    process.env.ALLOW_PRIVATE_AGENT_URLS === 'true';
  return validateSafeUrl(rawUrl, { allowPrivate });
}

export async function resolveAgentCard(sourceType, rawUrl, timeoutMs = 30_000, options = {}) {
  if (!['card-url', 'service-url'].includes(sourceType)) throw new Error('不支持的 Agent Card 发现方式');
  const allowPrivate = options.allowPrivate ??
    process.env.ALLOW_PRIVATE_AGENT_URLS === 'true';
  const input = assertSafeAgentUrl(rawUrl, { allowPrivate });
  const target = sourceType === 'service-url'
    ? new URL('/.well-known/agent-card.json', input.origin)
    : input;
  const response = await safeHttpRequest(target.toString(), {
    allowPrivate,
    headers: { accept: 'application/json, application/a2a+json' },
    timeoutMs,
    connectTimeoutMs: 8_000,
    maxAttempts: 3,
    maxBytes: 1_000_000
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`Agent Card 获取失败：HTTP ${response.status}`);
  const text = response.body.toString('utf8');
  let card;
  try { card = JSON.parse(text); } catch { throw new Error('远程地址没有返回合法 JSON'); }
  const validation = validateAgentCard(card);
  if (!validation.valid) throw new Error(`远程 Agent Card 校验失败：${validation.errors.join('；')}`);
  return { card, resolvedUrl: target.toString(), validation };
}

export async function callA2AAgent(card, prompt, timeoutMs = 90_000, signal, options = {}) {
  const { executeA2ATurn } = await import('./a2a-executor.js');
  const run = await executeA2ATurn({
    card,
    input: { parts: [{ type: 'text', text: String(prompt) }] },
    timeoutMs,
    signal,
    ...(options.authorization !== undefined ? { authorization: options.authorization } : {})
  });
  if (run.outcome.status !== 'succeeded') throw new Error(run.error?.message || 'A2A execution failed');
  return {
    raw: run.response.rawObjects.at(-1),
    text: run.response.normalized.text,
    run
  };
}

/** Run one Agent Example with true multi-turn context reuse. */
export async function callA2AAgentExample(card, example, options = {}) {
  const { executeA2AExample } = await import('./a2a-executor.js');
  const timeoutMs = options.timeoutMs ?? 90_000;
  const result = await executeA2AExample({
    card,
    example,
    policy: { timeoutMs, totalTimeoutMs: timeoutMs },
    authorization: options.authorization,
    signal: options.signal
  });
  const failed = result.runs.find((run) => run.outcome?.status !== 'succeeded');
  if (failed) throw new Error(failed.error?.message || 'A2A execution failed');
  const text = result.runs
    .map((run) => run.response?.normalized?.text)
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n\n');
  return { text, result };
}

export function buildA2ARequest(target, input, options = {}) {
  const requestId = options.requestId || crypto.randomUUID();
  const messageId = options.messageId || crypto.randomUUID();
  const streaming = options.streaming === true;
  const isJsonRpc = target.binding === 'JSONRPC';
  const isV1 = !String(target.version).startsWith('0.');
  if (!['JSONRPC', 'HTTP+JSON'].includes(target.binding)) throw new Error(`不支持的 A2A binding：${target.binding}`);
  const message = {
    role: isV1 ? 'ROLE_USER' : 'user',
    messageId,
    parts: normalizedInputParts(input).map((part) => serializePart(part, isV1))
  };
  if (options.contextId) message.contextId = options.contextId;
  if (options.taskId) message.taskId = options.taskId;
  const params = { message };
  if (target.tenant) params.tenant = target.tenant;
  if (options.acceptedOutputModes !== undefined) {
    params.configuration = {
      acceptedOutputModes: normalizedAcceptedOutputModes(
        options.acceptedOutputModes
      )
    };
  }
  if (isJsonRpc) {
    return {
      url: assertSafeAgentUrl(target.url, { allowPrivate: options.allowPrivate }).toString(),
      headers: { 'content-type': 'application/json', 'a2a-version': protocolHeaderVersion(target.version) },
      body: {
        jsonrpc: '2.0',
        id: requestId,
        method: streaming ? (isV1 ? 'SendStreamingMessage' : 'message/stream') : (isV1 ? 'SendMessage' : 'message/send'),
        params
      },
      requestId
    };
  }
  const endpoint = appendOperation(
    target.url,
    streaming ? 'message:stream' : 'message:send',
    { allowPrivate: options.allowPrivate }
  );
  const body = {
    message,
    configuration: {
      acceptedOutputModes: options.acceptedOutputModes === undefined
        ? ['text/plain', 'application/json']
        : normalizedAcceptedOutputModes(options.acceptedOutputModes)
    }
  };
  if (target.tenant) body.tenant = target.tenant;
  return {
    url: endpoint,
    headers: {
      'content-type': isV1 ? 'application/a2a+json' : 'application/json',
      'a2a-version': protocolHeaderVersion(target.version)
    },
    body,
    requestId
  };
}

function normalizedAcceptedOutputModes(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((mode) => typeof mode !== 'string' || !mode.trim())
  ) {
    throw new TypeError(
      'acceptedOutputModes must be a non-empty array of non-empty strings'
    );
  }
  return [...new Set(value.map((mode) => mode.trim()))];
}

export function buildGetTaskRequest(target, { taskId, requestId = crypto.randomUUID(), historyLength = 50 }) {
  const isJsonRpc = target.binding === 'JSONRPC';
  const isV1 = !String(target.version).startsWith('0.');
  if (!['JSONRPC', 'HTTP+JSON'].includes(target.binding)) {
    throw new Error(`Unsupported A2A binding: ${target.binding}`);
  }
  if (!isNonEmptyString(taskId)) throw new TypeError('A2A GetTask taskId must be a non-empty string');
  if (isJsonRpc) {
    const params = { id: taskId, historyLength };
    if (target.tenant) params.tenant = target.tenant;
    return {
      url: assertSafeAgentUrl(target.url).toString(),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': protocolHeaderVersion(target.version) },
      body: {
        jsonrpc: '2.0',
        id: requestId,
        method: isV1 ? 'GetTask' : 'tasks/get',
        params
      },
      requestId
    };
  }
  const url = assertSafeAgentUrl(target.url);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/tasks/${encodeURIComponent(taskId)}`;
  url.searchParams.set('historyLength', String(historyLength));
  if (target.tenant) url.searchParams.set('tenant', target.tenant);
  return {
    url: url.toString(),
    method: 'GET',
    headers: {
      accept: isV1 ? 'application/a2a+json' : 'application/json',
      'a2a-version': protocolHeaderVersion(target.version)
    },
    body: null,
    requestId
  };
}

function normalizedInputParts(input) {
  if (typeof input === 'string' || input === null || input === undefined) {
    return [{ type: 'text', text: String(input ?? '') }];
  }
  if (!input || !Array.isArray(input.parts) || input.parts.length === 0) {
    throw new TypeError('A2A input.parts must be a non-empty array');
  }
  return input.parts;
}

function serializePart(part, isV1) {
  if (!part || typeof part !== 'object') throw new TypeError('A2A Part must be an object');
  if (part.type === 'text') {
    return copyPartMetadata(
      isV1 ? { text: String(part.text) } : { kind: 'text', text: String(part.text) },
      part,
      isV1
    );
  }
  if (part.type === 'data') {
    return copyPartMetadata(
      isV1 ? { data: part.data } : { kind: 'data', data: part.data },
      part,
      isV1
    );
  }
  if (part.type === 'raw') {
    const source = String(part.raw);
    if (
      !source ||
      source.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source)
    ) {
      throw new TypeError('A2A raw Part must contain valid base64');
    }
    const raw = Buffer.from(source, 'base64').toString('base64');
    if (raw !== source) throw new TypeError('A2A raw Part must contain canonical base64');
    if (isV1) return copyPartMetadata({ raw }, part, true);
    return { kind: 'file', file: copyLegacyFileMetadata({ bytes: raw }, part) };
  }
  if (part.type === 'url') {
    const url = assertSafeAgentUrl(String(part.url)).toString();
    if (isV1) return copyPartMetadata({ url }, part, true);
    return { kind: 'file', file: copyLegacyFileMetadata({ uri: url }, part) };
  }
  throw new TypeError(`Unsupported A2A Part type: ${part.type}`);
}

function copyPartMetadata(target, source, isV1) {
  if (!isV1) return target;
  if (source.mediaType) target.mediaType = source.mediaType;
  if (source.filename) target.filename = source.filename;
  return target;
}

function copyLegacyFileMetadata(target, source) {
  if (source.mediaType) target.mimeType = source.mediaType;
  if (source.filename) target.name = source.filename;
  return target;
}

export function parseA2AResponse(target, payload, requestId, options = {}) {
  let root = unwrapResponseEnvelope(target, payload, requestId);
  const isV1 = !String(target.version).startsWith('0.');
  if (options.operation === 'get-task') {
    validateTask(root, { isV1 });
    return root;
  }
  if (!isV1 && target.binding === 'JSONRPC') {
    if (looksLikeMessage(root)) validateMessage(root, { isV1, topLevel: true });
    else validateTask(root, { isV1 });
    return root;
  }
  if (!isPlainObject(root)) throw new Error('A2A SendMessage response wrapper is invalid');
  const choices = ['message', 'task'].filter((key) => Object.hasOwn(root, key) && root[key] !== undefined);
  if (choices.length !== 1) {
    throw new Error('A2A SendMessage response wrapper must contain exactly one message/task oneof');
  }
  if (choices[0] === 'message') validateMessage(root.message, { isV1, topLevel: true });
  else validateTask(root.task, { isV1 });
  return root;
}

export function parseA2AStreamEvent(target, payload, requestId) {
  const root = unwrapResponseEnvelope(target, payload, requestId);
  const isV1 = !String(target.version).startsWith('0.');
  let kind;
  let value;
  if (isV1 || target.binding === 'HTTP+JSON') {
    if (!isPlainObject(root)) throw new Error('A2A stream event wrapper is invalid');
    const choices = ['message', 'task', 'statusUpdate', 'artifactUpdate']
      .filter((key) => Object.hasOwn(root, key) && root[key] !== undefined);
    if (choices.length !== 1) throw new Error('A2A stream event must contain exactly one oneof value');
    [kind] = choices;
    value = root[kind];
  } else {
    value = root;
    if (value?.kind === 'message') kind = 'message';
    else if (value?.kind === 'task') kind = 'task';
    else if (value?.kind === 'status-update') kind = 'statusUpdate';
    else if (value?.kind === 'artifact-update') kind = 'artifactUpdate';
    else throw new Error('A2A 0.3 stream event kind is invalid');
  }
  if (kind === 'message') validateMessage(value, { isV1, topLevel: true });
  if (kind === 'task') validateTask(value, { isV1 });
  if (kind === 'statusUpdate') validateStatusUpdate(value, { isV1 });
  if (kind === 'artifactUpdate') validateArtifactUpdate(value, { isV1 });
  return { kind, value };
}

function unwrapResponseEnvelope(target, payload, requestId) {
  if (target.binding !== 'JSONRPC') return payload;
  if (!payload || payload.jsonrpc !== '2.0') throw new Error('A2A JSON-RPC response envelope is invalid');
  if (!isJsonRpcId(payload.id) || !isJsonRpcId(requestId) || payload.id !== requestId) {
    throw new Error('A2A 响应请求 ID does not match');
  }
  const hasResult = Object.hasOwn(payload, 'result');
  const hasError = Object.hasOwn(payload, 'error');
  if (hasResult === hasError) {
    throw new Error('A2A JSON-RPC response must contain exactly one result/error branch');
  }
  if (hasError) {
    if (
      !isPlainObject(payload.error) ||
      !Number.isInteger(payload.error.code) ||
      typeof payload.error.message !== 'string'
    ) {
      throw new Error('A2A JSON-RPC error branch is invalid');
    }
    throw Object.assign(
      new Error(`A2A protocol error: ${payload.error.message || payload.error.code || 'unknown'}`),
      { protocolCode: payload.error.code }
    );
  }
  return payload.result;
}

export function parseSseEvents(text, options = {}) {
  const maxEvents = options.maxEvents || 256;
  const maxEventBytes = options.maxEventBytes || 64 * 1024;
  const events = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (Buffer.byteLength(data) > maxEventBytes) throw new Error('SSE 单个事件超过大小限制');
    let parsed;
    try { parsed = JSON.parse(data); } catch { throw new Error('SSE data 不是合法 JSON'); }
    events.push(parsed);
    if (events.length > maxEvents) throw new Error('SSE 事件数量超过限制');
  };
  for (const rawLine of String(text).split(/\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line === 'data') dataLines.push('');
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  flush();
  return events;
}

export function validateStreamResult(target, events, requestId) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('SSE 未返回有效事件');
  let phase = 'start';
  let taskId = null;
  let contextId = null;
  let terminal = false;
  for (const [index, event] of events.entries()) {
    const parsed = parseA2AStreamEvent(target, event, requestId);
    if (phase === 'start') {
      if (parsed.kind === 'message') {
        phase = 'message';
        terminal = true;
        continue;
      }
      if (parsed.kind !== 'task') throw new Error('A2A stream update arrived before its initial Task');
      phase = 'task';
      taskId = parsed.value.id;
      contextId = parsed.value.contextId || null;
      terminal = isTerminalState(parsed.value.status?.state);
      continue;
    }
    if (phase === 'message') throw new Error('A2A Message stream must close after exactly one Message');
    if (terminal) {
      const isFinalV1HttpTask = (
        target.binding === 'HTTP+JSON' &&
        !String(target.version).startsWith('0.') &&
        parsed.kind === 'task' &&
        parsed.value.id === taskId &&
        (parsed.value.contextId || null) === contextId &&
        isTerminalState(parsed.value.status?.state) &&
        index === events.length - 1
      );
      if (isFinalV1HttpTask) continue;
      throw new Error('A2A stream emitted an invalid event after its terminal result');
    }
    if (!['statusUpdate', 'artifactUpdate'].includes(parsed.kind)) {
      throw new Error('A2A Task stream may contain only status/artifact updates');
    }
    if (parsed.value.taskId !== taskId) throw new Error('A2A stream Task id does not match');
    if (contextId && parsed.value.contextId && parsed.value.contextId !== contextId) {
      throw new Error('A2A stream contextId does not match');
    }
    if (!contextId && parsed.value.contextId) contextId = parsed.value.contextId;
    if (parsed.kind === 'statusUpdate') {
      terminal = parsed.value.final === true || isTerminalState(parsed.value.status?.state);
    }
  }
  if (!terminal) throw new Error('A2A 流在结束前未到达终态');
  return { terminal: true, eventCount: events.length, text: events.map(extractAgentText).filter(Boolean).join('\n') };
}

function validateMessage(value, { isV1, topLevel = false } = {}) {
  if (!isPlainObject(value)) throw new Error('A2A Message must be an object');
  if ((!isV1 && value.kind !== 'message') || (isV1 && Object.hasOwn(value, 'kind'))) {
    throw new Error('A2A Message kind is invalid');
  }
  if (!isNonEmptyString(value.messageId)) throw new Error('A2A Message messageId must be non-empty');
  const allowedRoles = topLevel
    ? new Set([isV1 ? 'ROLE_AGENT' : 'agent'])
    : new Set(isV1 ? ['ROLE_USER', 'ROLE_AGENT'] : ['user', 'agent']);
  if (!allowedRoles.has(value.role)) throw new Error('A2A Message role is invalid');
  if (!Array.isArray(value.parts) || value.parts.length === 0) {
    throw new Error('A2A Message Parts must be a non-empty array');
  }
  value.parts.forEach((part, index) => validatePart(part, { isV1, path: `Message.parts[${index}]` }));
  for (const key of ['taskId', 'contextId']) {
    if (value[key] !== undefined && !isNonEmptyString(value[key])) {
      throw new Error(`A2A Message ${key} must be non-empty`);
    }
  }
}

function validateTask(value, { isV1 } = {}) {
  if (!isPlainObject(value)) throw new Error('A2A GetTask/Task response must be an object');
  if ((!isV1 && value.kind !== 'task') || (isV1 && Object.hasOwn(value, 'kind'))) {
    throw new Error('A2A Task kind is invalid');
  }
  if (!isNonEmptyString(value.id)) throw new Error('A2A Task id must be non-empty');
  if (!isV1 && !isNonEmptyString(value.contextId)) {
    throw new Error('A2A 0.3 Task contextId must be non-empty');
  }
  if (value.contextId !== undefined && !isNonEmptyString(value.contextId)) {
    throw new Error('A2A Task contextId must be non-empty');
  }
  validateTaskStatus(value.status, { isV1 });
  if (value.history !== undefined) {
    if (!Array.isArray(value.history)) throw new Error('A2A Task history must be an array');
    value.history.forEach((message, index) => {
      try {
        validateMessage(message, { isV1, topLevel: false });
      } catch (error) {
        throw new Error(`A2A Task history[${index}] is invalid: ${error.message}`);
      }
    });
  }
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts)) throw new Error('A2A Task artifacts must be an array');
    value.artifacts.forEach((artifact, index) => validateArtifact(artifact, {
      isV1,
      path: `Task.artifacts[${index}]`
    }));
  }
}

function validateTaskStatus(value, { isV1 } = {}) {
  if (!isPlainObject(value) || !isNonEmptyString(value.state)) {
    throw new Error('A2A Task status/state is invalid');
  }
  const allowed = new Set(isV1
    ? [
      'TASK_STATE_UNSPECIFIED', 'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING',
      'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED',
      'TASK_STATE_REJECTED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'
    ]
    : [
      'unknown', 'submitted', 'working', 'completed', 'failed',
      'canceled', 'rejected', 'input-required', 'auth-required'
    ]);
  if (!allowed.has(value.state)) throw new Error('A2A Task status state is invalid');
  if (value.message !== undefined) validateMessage(value.message, { isV1, topLevel: true });
}

function validateStatusUpdate(value, { isV1 } = {}) {
  if (!isPlainObject(value)) throw new Error('A2A status update must be an object');
  if (
    (!isV1 && value.kind !== 'status-update') ||
    (isV1 && Object.hasOwn(value, 'kind'))
  ) {
    throw new Error('A2A status update kind is invalid');
  }
  if (!isNonEmptyString(value.taskId)) throw new Error('A2A status update taskId must be non-empty');
  if (!isNonEmptyString(value.contextId)) {
    throw new Error('A2A status update contextId must be non-empty');
  }
  if (value.contextId !== undefined && !isNonEmptyString(value.contextId)) {
    throw new Error('A2A status update contextId must be non-empty');
  }
  if (isV1 && value.final !== undefined) {
    throw new Error('A2A 1.0 status update does not define final');
  }
  if (!isV1 && typeof value.final !== 'boolean') {
    throw new Error('A2A 0.3 status update final must be boolean');
  }
  validateTaskStatus(value.status, { isV1 });
}

function validateArtifactUpdate(value, { isV1 } = {}) {
  if (!isPlainObject(value)) throw new Error('A2A artifact update must be an object');
  if (
    (!isV1 && value.kind !== 'artifact-update') ||
    (isV1 && Object.hasOwn(value, 'kind'))
  ) {
    throw new Error('A2A artifact update kind is invalid');
  }
  if (!isNonEmptyString(value.taskId)) throw new Error('A2A artifact update taskId must be non-empty');
  if (!isNonEmptyString(value.contextId)) {
    throw new Error('A2A artifact update contextId must be non-empty');
  }
  if (value.contextId !== undefined && !isNonEmptyString(value.contextId)) {
    throw new Error('A2A artifact update contextId must be non-empty');
  }
  validateArtifact(value.artifact, { isV1, path: 'artifactUpdate.artifact' });
  for (const key of ['append', 'lastChunk']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`A2A artifact update ${key} must be boolean`);
    }
  }
}

function validateArtifact(value, { isV1, path }) {
  if (!isPlainObject(value)) throw new Error(`A2A ${path} artifact must be an object`);
  if (!isNonEmptyString(value.artifactId)) {
    throw new Error(`A2A ${path} artifactId must be non-empty`);
  }
  if (!Array.isArray(value.parts) || value.parts.length === 0) {
    throw new Error(`A2A ${path} artifact Parts must be non-empty`);
  }
  value.parts.forEach((part, index) => validatePart(part, { isV1, path: `${path}.parts[${index}]` }));
}

function validatePart(value, { isV1, path }) {
  if (!isPlainObject(value)) throw new Error(`A2A ${path} Part must be an object`);
  if (isV1) {
    if (Object.hasOwn(value, 'kind')) throw new Error(`A2A ${path} Part kind is invalid`);
    const choices = ['text', 'raw', 'url', 'data'].filter((key) => Object.hasOwn(value, key));
    if (choices.length !== 1) throw new Error(`A2A ${path} Part oneof is invalid`);
    const choice = choices[0];
    if (choice === 'text' && typeof value.text !== 'string') throw new Error(`A2A ${path} text Part is invalid`);
    if (choice === 'raw') validateBase64(value.raw, `${path} raw`);
    if (choice === 'url') validateHttpUrl(value.url, `${path} url`);
    if (choice === 'data' && value.data === undefined) throw new Error(`A2A ${path} data Part is invalid`);
    for (const key of ['mediaType', 'filename']) {
      if (value[key] !== undefined && !isNonEmptyString(value[key])) {
        throw new Error(`A2A ${path} ${key} is invalid`);
      }
    }
    return;
  }
  if (!['text', 'data', 'file'].includes(value.kind)) throw new Error(`A2A ${path} legacy Part kind is invalid`);
  if (value.kind === 'text' && typeof value.text !== 'string') throw new Error(`A2A ${path} text Part is invalid`);
  if (value.kind === 'data' && !isPlainObject(value.data)) throw new Error(`A2A ${path} data Part is invalid`);
  if (value.kind === 'file') {
    if (!isPlainObject(value.file)) throw new Error(`A2A ${path} file Part is invalid`);
    const choices = ['uri', 'bytes'].filter((key) => Object.hasOwn(value.file, key));
    if (choices.length !== 1) throw new Error(`A2A ${path} file uri/bytes oneof is invalid`);
    if (choices[0] === 'uri') validateHttpUrl(value.file.uri, `${path} file.uri`);
    else validateBase64(value.file.bytes, `${path} file.bytes`);
    for (const key of ['mimeType', 'name']) {
      if (value.file[key] !== undefined && !isNonEmptyString(value.file[key])) {
        throw new Error(`A2A ${path} file.${key} is invalid`);
      }
    }
  }
}

function validateBase64(value, path) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) ||
    Buffer.from(value, 'base64').toString('base64') !== value
  ) {
    throw new Error(`A2A ${path} must be canonical base64`);
  }
}

function validateHttpUrl(value, path) {
  if (!isNonEmptyString(value)) throw new Error(`A2A ${path} must be a URL string`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`A2A ${path} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`A2A ${path} must use HTTP(S)`);
}

function isJsonRpcId(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function looksLikeMessage(value) {
  return isPlainObject(value) && (
    value.kind === 'message' ||
    Object.hasOwn(value, 'messageId') ||
    Object.hasOwn(value, 'role') ||
    Object.hasOwn(value, 'parts')
  );
}

function protocolHeaderVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)/u);
  if (!match) throw new TypeError('A2A protocol version must include major.minor');
  return `${match[1]}.${match[2]}`;
}

function appendOperation(rawUrl, operation, options = {}) {
  const url = assertSafeAgentUrl(rawUrl, options);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${operation}`;
  return url.toString();
}

function isTerminalState(value) {
  const normalized = String(value || '')
    .toUpperCase()
    .replace(/^TASK_STATE_/, '')
    .replace(/-/g, '_');
  return ['COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED', 'REJECTED', 'INTERRUPTED', 'INPUT_REQUIRED', 'AUTH_REQUIRED'].includes(normalized);
}

export function extractAgentText(payload) {
  const root = payload?.result || payload;
  const task = root?.task || root;
  const candidates = [
    root?.message?.parts,
    task?.message?.parts,
    task?.status?.message?.parts,
    root?.statusUpdate?.status?.message?.parts,
    task?.parts,
    root?.artifact?.parts,
    root?.artifactUpdate?.artifact?.parts,
    task?.artifacts?.flatMap((artifact) => artifact.parts || [])
  ].flat().filter(Boolean);
  const text = [...new Set(candidates)].map((part) => {
    if (part.text) return part.text;
    if (part?.data?.text) return part.data.text;
    if (Object.hasOwn(part || {}, 'data')) return JSON.stringify(part.data);
    return '';
  }).filter(Boolean).join('\n');
  return text;
}
