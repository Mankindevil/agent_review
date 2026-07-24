import { safeHttpRequest, validateSafeUrl } from './safe-http.js';

const LEGACY_BINDINGS = { JSONRPC: 'JSONRPC', 'JSON-RPC': 'JSONRPC', HTTP_JSON: 'HTTP+JSON', 'HTTP+JSON': 'HTTP+JSON' };

export function validateAgentCard(card) {
  const errors = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) errors.push('Agent Card 必须是 JSON 对象');
  if (!isNonEmptyString(card?.name)) errors.push('name 必须是非空字符串');
  if (!isNonEmptyString(card?.description)) errors.push('description 必须是非空字符串');
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
    });
  }
  if (!getInterfaces(card).length) errors.push('缺少 supportedInterfaces 或旧版 url');
  return { valid: errors.length === 0, errors, version: inferVersion(card), interfaces: getInterfaces(card) };
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
  return getInterfaces(card).find((item) =>
    ['HTTP+JSON', 'JSONRPC'].includes(item.binding) &&
    (/^1\./.test(String(item.version)) || /^0\.3(?:\.|$)/.test(String(item.version)))
  ) || null;
}

function isNonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }

export function assertSafeAgentUrl(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ??
    process.env.ALLOW_PRIVATE_AGENT_URLS === 'true';
  return validateSafeUrl(rawUrl, { allowPrivate });
}

export async function resolveAgentCard(sourceType, rawUrl, timeoutMs = 12_000, options = {}) {
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
  const target = selectInterface(card);
  if (!target) throw new Error('没有可调用的 A2A 接口');
  assertSafeAgentUrl(target.url);
  const requestId = crypto.randomUUID();
  const request = buildA2ARequest(target, prompt, { requestId, messageId: crypto.randomUUID() });
  const response = await safeHttpRequest(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
    timeoutMs,
    maxBytes: 2_000_000
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`A2A 返回 HTTP ${response.status}`);
  let payload;
  try { payload = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('A2A 返回的不是合法 JSON'); }
  const parsed = parseA2AResponse(target, payload, requestId);
  return { raw: payload, text: extractAgentText(parsed) };
}

export function buildA2ARequest(target, prompt, options = {}) {
  const requestId = options.requestId || crypto.randomUUID();
  const messageId = options.messageId || crypto.randomUUID();
  const streaming = options.streaming === true;
  const isJsonRpc = target.binding === 'JSONRPC';
  const isV1 = !String(target.version).startsWith('0.');
  if (!['JSONRPC', 'HTTP+JSON'].includes(target.binding)) throw new Error(`不支持的 A2A binding：${target.binding}`);
  const message = {
    role: isV1 ? 'ROLE_USER' : 'user',
    messageId,
    parts: [isV1 ? { text: String(prompt) } : { kind: 'text', text: String(prompt) }]
  };
  const params = { message };
  if (target.tenant) params.tenant = target.tenant;
  if (isJsonRpc) {
    return {
      url: assertSafeAgentUrl(target.url, { allowPrivate: options.allowPrivate }).toString(),
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
  const endpoint = appendOperation(
    target.url,
    streaming ? 'message:stream' : 'message:send',
    { allowPrivate: options.allowPrivate }
  );
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

export function parseA2AResponse(target, payload, requestId) {
  let root = payload;
  if (target.binding === 'JSONRPC') {
    if (!payload || payload.jsonrpc !== '2.0') throw new Error('A2A JSON-RPC 响应结构无效');
    if (String(payload.id) !== String(requestId)) throw new Error('A2A 响应请求 ID 不匹配');
    if (payload.error) throw new Error(`A2A 协议错误：${payload.error.message || payload.error.code || 'unknown'}`);
    root = payload.result;
  }
  const legacyPayload = String(target.version).startsWith('0.') && (isMessageLike(root) || isTaskLike(root));
  if (!root || typeof root !== 'object' || (!root.message && !root.task && !legacyPayload)) {
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

function appendOperation(rawUrl, operation, options = {}) {
  const url = assertSafeAgentUrl(rawUrl, options);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${operation}`;
  return url.toString();
}

function isTerminalState(value) {
  const normalized = String(value || '').toUpperCase().replace(/^TASK_STATE_/, '');
  return ['COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED', 'REJECTED', 'INTERRUPTED', 'INPUT_REQUIRED', 'AUTH_REQUIRED'].includes(normalized);
}

function isMessageLike(value) {
  return value?.kind === 'message' ||
    (typeof value?.messageId === 'string' && typeof value?.role === 'string' && Array.isArray(value?.parts));
}

function isTaskLike(value) {
  return value?.kind === 'task' ||
    (typeof value?.id === 'string' && value?.status && typeof value.status === 'object');
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
  const text = candidates.map((part) => part.text || part?.data?.text || '').filter(Boolean).join('\n');
  return text || JSON.stringify(root);
}
