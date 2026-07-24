import { safeHttpRequest, validateSafeUrl } from './safe-http.js';

const LEGACY_BINDINGS = { JSONRPC: 'JSONRPC', 'JSON-RPC': 'JSONRPC', HTTP_JSON: 'HTTP+JSON', 'HTTP+JSON': 'HTTP+JSON' };

export function validateAgentCard(card) {
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

  const schemaVersion = Array.isArray(card?.supportedInterfaces) ||
    Object.hasOwn(card || {}, 'supportedInterfaces')
    ? '1.x'
    : '0.3';
  const interfaces = schemaVersion === '1.x'
    ? validateV1Interfaces(card?.supportedInterfaces, errors)
    : validateV03Interface(card, errors);
  const selectedInterface = interfaces.find(isSupportedInterface) || null;
  if (!selectedInterface) errors.push('Agent Card must declare at least one supported interface');
  return {
    valid: errors.length === 0,
    errors,
    version: inferVersion(card),
    schemaVersion,
    interfaces,
    selectedInterface
  };
}

export function inferVersion(card) {
  return card?.protocolVersion || card?.supportedInterfaces?.[0]?.protocolVersion || (card?.url ? '0.3-compatible' : '1.0');
}

export function getInterfaces(card) {
  if (Array.isArray(card?.supportedInterfaces)) {
    return card.supportedInterfaces
      .filter((item) => isNonEmptyString(item?.url))
      .map((item) => {
        const normalized = {
          url: item.url,
          binding: LEGACY_BINDINGS[item.protocolBinding] || item.protocolBinding || '',
          version: item.protocolVersion || card.protocolVersion || ''
        };
        if (isNonEmptyString(item.tenant)) normalized.tenant = item.tenant;
        return normalized;
      });
  }
  if (isNonEmptyString(card?.url)) {
    return [{ url: card.url, binding: LEGACY_BINDINGS[card.preferredTransport] || 'JSONRPC', version: card.protocolVersion || '0.3' }];
  }
  return [];
}

export function selectInterface(card) {
  return getInterfaces(card).find(isSupportedInterface) || null;
}

function isNonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }

function validateV1Interfaces(value, errors) {
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
    const url = validateDeclaredUrl(item.url, `${path}.url`, errors);
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

function validateV03Interface(card, errors) {
  const url = validateDeclaredUrl(card?.url, 'url', errors);
  let version = card?.protocolVersion === undefined
    ? '0.3'
    : validateRequiredString(card.protocolVersion, 'protocolVersion', errors);
  if (version && !/^0\.3(?:\.|$)/u.test(version)) {
    errors.push('protocolVersion 必须是 0.3 兼容版本');
    version = null;
  }
  const transport = card?.preferredTransport === undefined
    ? 'JSONRPC'
    : validateRequiredString(card.preferredTransport, 'preferredTransport', errors);
  if (!url || !version || !transport) return [];
  return [{
    url,
    binding: LEGACY_BINDINGS[transport] || transport,
    version
  }];
}

function validateDeclaredUrl(value, path, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${path} 必须是非空 URL 字符串`);
    return null;
  }
  try {
    return validateSafeUrl(value, {
      allowPrivate: process.env.ALLOW_PRIVATE_AGENT_URLS === 'true'
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

export function assertSafeAgentUrl(rawUrl) {
  return validateSafeUrl(rawUrl, { allowPrivate: process.env.ALLOW_PRIVATE_AGENT_URLS === 'true' });
}

export async function resolveAgentCard(sourceType, rawUrl, timeoutMs = 12_000) {
  if (!['card-url', 'service-url'].includes(sourceType)) throw new Error('不支持的 Agent Card 发现方式');
  const input = assertSafeAgentUrl(rawUrl);
  const target = sourceType === 'service-url'
    ? new URL('/.well-known/agent-card.json', input.origin)
    : input;
  const response = await safeHttpRequest(target.toString(), {
    headers: { accept: 'application/json, application/a2a+json' },
    timeoutMs,
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

export async function callA2AAgent(card, prompt, timeoutMs = 45_000, signal) {
  const { executeA2ATurn } = await import('./a2a-executor.js');
  const run = await executeA2ATurn({
    card,
    input: { parts: [{ type: 'text', text: String(prompt) }] },
    timeoutMs,
    signal
  });
  if (run.outcome.status !== 'succeeded') throw new Error(run.error?.message || 'A2A execution failed');
  return {
    raw: run.response.rawObjects.at(-1),
    text: run.response.normalized.text,
    run
  };
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
  if (isJsonRpc) {
    return {
      url: assertSafeAgentUrl(target.url).toString(),
      headers: { 'content-type': 'application/json', 'a2a-version': target.version },
      body: {
        jsonrpc: '2.0',
        id: requestId,
        method: streaming ? (isV1 ? 'SendStreamingMessage' : 'message/stream') : (isV1 ? 'SendMessage' : 'message/send'),
        params
      },
      requestId
    };
  }
  const endpoint = appendOperation(target.url, streaming ? 'message:stream' : 'message:send');
  const body = {
    message,
    configuration: { acceptedOutputModes: ['text/plain', 'application/json'] }
  };
  if (target.tenant) body.tenant = target.tenant;
  return {
    url: endpoint,
    headers: { 'content-type': isV1 ? 'application/a2a+json' : 'application/json', 'a2a-version': target.version },
    body,
    requestId
  };
}

export function buildGetTaskRequest(target, { taskId, requestId = crypto.randomUUID(), historyLength = 50 }) {
  const isJsonRpc = target.binding === 'JSONRPC';
  const isV1 = !String(target.version).startsWith('0.');
  if (!['JSONRPC', 'HTTP+JSON'].includes(target.binding)) {
    throw new Error(`Unsupported A2A binding: ${target.binding}`);
  }
  if (isJsonRpc) {
    const params = { id: taskId, historyLength };
    if (target.tenant) params.tenant = target.tenant;
    return {
      url: assertSafeAgentUrl(target.url).toString(),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': target.version },
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
      'a2a-version': target.version
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

export function parseA2AResponse(target, payload, requestId) {
  let root = payload;
  if (target.binding === 'JSONRPC') {
    if (!payload || payload.jsonrpc !== '2.0') throw new Error('A2A JSON-RPC 响应结构无效');
    if (String(payload.id) !== String(requestId)) throw new Error('A2A 响应请求 ID 不匹配');
    if (payload.error) throw new Error(`A2A 协议错误：${payload.error.message || payload.error.code || 'unknown'}`);
    root = payload.result;
  }
  const directPayload = isMessageLike(root) || isTaskLike(root);
  if (!root || typeof root !== 'object' || (!root.message && !root.task && !directPayload)) {
    throw new Error('A2A 响应缺少 Message 或 Task');
  }
  if (root.message && !isMessageLike(root.message)) throw new Error('A2A Message 响应结构无效');
  if (root.task && !isTaskLike(root.task)) throw new Error('A2A Task 响应结构无效');
  return root;
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
  if (!events.length) throw new Error('SSE 未返回有效事件');
  let terminal = false;
  for (const event of events) {
    let value = event;
    if (target.binding === 'JSONRPC') {
      if (event?.jsonrpc !== '2.0') throw new Error('SSE JSON-RPC 事件结构无效');
      if (String(event.id) !== String(requestId)) throw new Error('SSE 事件请求 ID 不匹配');
      if (event.error) throw new Error(`A2A 流式协议错误：${event.error.message || event.error.code || 'unknown'}`);
      value = event.result;
    }
    if (!value || typeof value !== 'object') throw new Error('SSE 事件缺少协议结果');
    if (value.message || (String(target.version).startsWith('0.') && isMessageLike(value))) terminal = true;
    if (value.statusUpdate?.final === true || (value.kind === 'status-update' && value.final === true)) terminal = true;
    const state = value.task?.status?.state || value.statusUpdate?.status?.state || value.status?.state;
    if (isTerminalState(state)) terminal = true;
  }
  if (!terminal) throw new Error('A2A 流在结束前未到达终态');
  return { terminal: true, eventCount: events.length, text: events.map(extractAgentText).filter(Boolean).join('\n') };
}

function appendOperation(rawUrl, operation) {
  const url = assertSafeAgentUrl(rawUrl);
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

function isMessageLike(value) {
  return typeof value?.messageId === 'string' &&
    typeof value?.role === 'string' &&
    Array.isArray(value?.parts) &&
    (value.kind === undefined || value.kind === 'message');
}

function isTaskLike(value) {
  return typeof value?.id === 'string' &&
    value?.status &&
    typeof value.status === 'object' &&
    (value.kind === undefined || value.kind === 'task');
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
