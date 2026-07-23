import {
  buildA2ARequest,
  extractAgentText,
  parseA2AResponse,
  parseSseEvents,
  selectInterface,
  validateAgentCard,
  validateStreamResult
} from './a2a.js';
import { safeHttpRequest, validateSafeUrl } from './safe-http.js';

const DEFAULT_PROMPT = '请返回一句简短的服务状态说明，不执行任何外部操作。';
const CHECK_IDS = ['discovery', 'card-validation', 'call', 'stream'];

export function validateDiagnosticsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw clientError('请求体必须是 JSON 对象');
  const sourceType = input.sourceType;
  if (!['service-url', 'card-url'].includes(sourceType)) throw clientError('sourceType 必须是 service-url 或 card-url');
  if (typeof input.url !== 'string' || !input.url.trim() || input.url.length > 2048) throw clientError('url 必须是有效且不超过 2048 字符的地址');
  let url;
  try {
    url = validateSafeUrl(input.url.trim(), { allowPrivate: process.env.ALLOW_PRIVATE_AGENT_URLS === 'true' });
  } catch (error) {
    throw clientError(error.message);
  }
  if (input.prompt !== undefined && (typeof input.prompt !== 'string' || [...input.prompt].length > 4000)) {
    throw clientError('prompt 必须是最多 4000 个字符的字符串');
  }
  if (input.agentAuthorization !== undefined) {
    if (typeof input.agentAuthorization !== 'string' || Buffer.byteLength(input.agentAuthorization) > 8192 || /[\r\n]/.test(input.agentAuthorization)) {
      throw clientError('agentAuthorization 必须是不含换行且不超过 8 KiB 的 Token');
    }
  }
  const runStreaming = input.runStreaming === true;
  if (runStreaming && input.confirmStreamingSideEffects !== true) {
    throw clientError('启用流式检查前必须确认它会再次真实执行 Prompt');
  }
  const numericTimeout = Number(input.timeoutMs ?? 30_000);
  const timeoutMs = Number.isFinite(numericTimeout) ? Math.min(60_000, Math.max(5_000, Math.round(numericTimeout))) : 30_000;
  return {
    url: url.toString(),
    sourceType,
    agentAuthorization: input.agentAuthorization || '',
    allowCrossOriginAuthorization: input.allowCrossOriginAuthorization === true,
    prompt: input.prompt?.trim() || DEFAULT_PROMPT,
    timeoutMs,
    runStreaming,
    confirmStreamingSideEffects: runStreaming
  };
}

export async function runAgentDiagnostics(rawInput, options = {}) {
  const input = validateDiagnosticsInput(rawInput);
  const request = options.request || safeHttpRequest;
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  const checks = CHECK_IDS.map((id) => emptyCheck(id));
  const secrets = [input.agentAuthorization, ...(options.secrets || [])].filter(Boolean);
  const requestOptions = (overrides = {}) => ({
    signal: options.signal,
    timeoutMs: Math.max(1, deadline - Date.now()),
    ...overrides
  });
  const discoveryUrl = input.sourceType === 'service-url'
    ? new URL('/.well-known/agent-card.json', new URL(input.url).origin).toString()
    : input.url;

  let card;
  const discoveryStarted = Date.now();
  try {
    const response = await request(discoveryUrl, requestOptions({
      headers: { accept: 'application/json, application/a2a+json' },
      maxBytes: 1024 * 1024
    }));
    requireSuccess(response, 'Agent Card');
    requireContentType(response, ['application/json', 'application/a2a+json'], 'Agent Card');
    try { card = JSON.parse(response.body.toString('utf8')); } catch { throw stageError('Agent Card 不是合法 JSON', 'json'); }
    checks[0] = passed('discovery', discoveryStarted, '已读取 Agent Card', {
      resolvedUrl: safeDisplayUrl(discoveryUrl),
      contentType: String(response.headers['content-type'] || '')
    });
  } catch (error) {
    checks[0] = failed('discovery', discoveryStarted, error);
    block(checks, 1, '发现阶段失败，无法继续校验或调用');
    return redactReport(finalize(checks, input.runStreaming, startedAt), secrets);
  }

  const validationStarted = Date.now();
  const validation = validateAgentCard(card);
  const target = validation.valid ? selectInterface(card) : null;
  if (!validation.valid || !target) {
    const reason = !validation.valid ? validation.errors.join('；') : 'Agent Card 没有平台支持的接口 binding';
    checks[1] = failed('card-validation', validationStarted, stageError(reason, 'protocol'));
    block(checks, 2, 'Card 校验失败，无法调用 Agent');
    return redactReport(finalize(checks, input.runStreaming, startedAt), secrets);
  }
  let targetUrl;
  try {
    targetUrl = validateSafeUrl(target.url, { allowPrivate: process.env.ALLOW_PRIVATE_AGENT_URLS === 'true' });
  } catch (error) {
    checks[1] = failed('card-validation', validationStarted, error);
    block(checks, 2, 'Card 接口地址校验失败，无法调用 Agent');
    return redactReport(finalize(checks, input.runStreaming, startedAt), secrets);
  }
  checks[1] = passed('card-validation', validationStarted, 'Agent Card 与接口声明有效', {
    version: validation.version,
    binding: target.binding,
    targetOrigin: targetUrl.origin,
    streaming: card.capabilities?.streaming === true,
    tenant: target.tenant || null
  });

  const hasCrossOriginSecret = Boolean(input.agentAuthorization) &&
    targetUrl.origin !== new URL(discoveryUrl).origin &&
    !input.allowCrossOriginAuthorization;
  if (hasCrossOriginSecret) {
    checks[2] = blockedCheck('call', 'Agent Token 的目标接口与发现地址不同源', '确认目标 origin 后启用跨域凭据授权并重试。');
    checks[3] = input.runStreaming
      ? blockedCheck('stream', 'Agent Token 的跨域转发未获授权', '确认目标 origin 后启用跨域凭据授权并重试。')
      : skipped('stream', '未启用流式检查');
    return redactReport(finalize(checks, input.runStreaming, startedAt), secrets);
  }

  const callStarted = Date.now();
  try {
    const normalRequest = buildA2ARequest(target, input.prompt);
    const headers = withAgentAuthorization(normalRequest.headers, input.agentAuthorization);
    const response = await request(normalRequest.url, requestOptions({
      method: 'POST',
      headers,
      body: JSON.stringify(normalRequest.body),
      maxBytes: 2 * 1024 * 1024
    }));
    requireSuccess(response, 'A2A');
    requireContentType(response, ['application/json', 'application/a2a+json'], 'A2A');
    let payload;
    try { payload = JSON.parse(response.body.toString('utf8')); } catch { throw stageError('A2A 响应不是合法 JSON', 'json'); }
    const parsed = parseA2AResponse(target, payload, normalRequest.requestId);
    checks[2] = passed('call', callStarted, '普通 A2A 调用成功', {
      binding: target.binding,
      preview: truncate(extractAgentText(parsed), 4096)
    });
  } catch (error) {
    checks[2] = failed('call', callStarted, error);
  }

  if (!input.runStreaming) {
    checks[3] = skipped('stream', '未启用流式检查');
  } else if (card.capabilities?.streaming !== true) {
    checks[3] = skipped('stream', 'Agent Card 未声明流式能力');
  } else {
    const streamStarted = Date.now();
    try {
      const streamRequest = buildA2ARequest(target, input.prompt, { streaming: true });
      const headers = withAgentAuthorization(streamRequest.headers, input.agentAuthorization);
      const response = await request(streamRequest.url, requestOptions({
        method: 'POST',
        headers,
        body: JSON.stringify(streamRequest.body),
        maxBytes: 2 * 1024 * 1024
      }));
      requireSuccess(response, 'A2A 流式');
      requireContentType(response, ['text/event-stream'], 'A2A 流式');
      const events = parseSseEvents(response.body.toString('utf8'), { maxEvents: 256, maxEventBytes: 64 * 1024 });
      const result = validateStreamResult(target, events, streamRequest.requestId);
      checks[3] = passed('stream', streamStarted, '流式 A2A 调用到达终态', {
        eventCount: result.eventCount,
        preview: truncate(result.text, 4096)
      });
    } catch (error) {
      checks[3] = failed('stream', streamStarted, error);
    }
  }
  return redactReport(finalize(checks, input.runStreaming, startedAt), secrets);
}

function emptyCheck(id) {
  return { id, status: 'blocked', durationMs: 0, summary: '尚未执行', details: {}, suggestion: null };
}

function passed(id, startedAt, summary, details = {}) {
  return { id, status: 'passed', durationMs: Date.now() - startedAt, summary, details, suggestion: null };
}

function failed(id, startedAt, error) {
  const category = classifyError(error);
  return {
    id,
    status: 'failed',
    durationMs: Date.now() - startedAt,
    summary: safeErrorMessage(error, category),
    details: { category },
    suggestion: suggestionFor(category)
  };
}

function skipped(id, summary) {
  return { id, status: 'skipped', durationMs: 0, summary, details: {}, suggestion: null };
}

function blockedCheck(id, summary, suggestion) {
  return { id, status: 'blocked', durationMs: 0, summary, details: {}, suggestion };
}

function block(checks, start, reason) {
  for (let index = start; index < checks.length; index += 1) checks[index] = blockedCheck(checks[index].id, reason, '先修复前置阶段后重新诊断。');
}

function finalize(checks, streamingRequested, startedAt) {
  const requiredPassed = checks.slice(0, 3).every((check) => check.status === 'passed');
  return {
    ok: requiredPassed,
    durationMs: Date.now() - startedAt,
    streamingRequested,
    streamingOk: streamingRequested ? checks[3].status === 'passed' : null,
    checks
  };
}

function withAgentAuthorization(headers, token) {
  return token ? { ...headers, authorization: `Bearer ${token}` } : { ...headers };
}

function requireSuccess(response, label) {
  if (!response || response.status < 200 || response.status >= 300) {
    throw stageError(`${label} 返回 HTTP ${response?.status || 0}`, 'http');
  }
}

function requireContentType(response, accepted, label) {
  const value = String(response.headers?.['content-type'] || '').toLowerCase();
  if (!accepted.some((type) => value.includes(type))) throw stageError(`${label} Content-Type 不符合协议`, 'content-type');
}

function classifyError(error) {
  if (error?.code) return error.code;
  if (/JSON/i.test(error?.message)) return 'json';
  if (/HTTP/i.test(error?.message)) return 'http';
  return 'protocol';
}

function safeErrorMessage(error, category) {
  if (['protocol', 'json', 'http', 'content-type'].includes(category)) return error?.message || '协议检查失败';
  const labels = {
    dns: '域名解析失败',
    connection: '无法连接 Agent',
    tls: 'TLS 握手失败',
    timeout: '诊断请求超时',
    'response-too-large': '远程响应超过大小限制',
    security: '目标地址被安全策略阻止',
    cancelled: '诊断已取消'
  };
  return labels[category] || '诊断阶段失败';
}

function suggestionFor(category) {
  const suggestions = {
    dns: '检查域名和 DNS 记录是否公开可解析。',
    connection: '确认 Agent 服务已启动、防火墙允许公网访问。',
    tls: '检查证书有效期、域名和完整证书链。',
    http: '检查接口路径、鉴权和服务端错误日志。',
    'content-type': '返回规范要求的 JSON 或 text/event-stream Content-Type。',
    json: '确保响应正文是完整、合法的 JSON。',
    protocol: '按 Agent Card 声明的 A2A 版本和 binding 修正响应结构。',
    timeout: '缩短 Agent 执行时间或适当提高诊断超时。',
    'response-too-large': '缩短 Agent 输出并限制流式事件数量。',
    security: '使用公开可访问的 HTTP(S) 地址，不要指向内网或本机。',
    cancelled: '保持页面连接后重新诊断。'
  };
  return suggestions[category] || '检查 Agent 配置后重试。';
}

function redactReport(value, secrets) {
  if (typeof value === 'string') {
    return secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, value);
  }
  if (Array.isArray(value)) return value.map((item) => redactReport(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactReport(item, secrets)]));
  }
  return value;
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function safeDisplayUrl(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function stageError(message, code) {
  return Object.assign(new Error(message), { code });
}

function clientError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
