import {
  buildA2ARequest,
  extractAgentText,
  negotiateAcceptedOutputModes,
  parseA2AResponse,
  parseSseEvents,
  resolveAgentCard,
  validateAgentCard,
  validateStreamResult
} from './a2a.js';
import { safeHttpRequest, validateSafeUrl } from './safe-http.js';

const CHECK_IDS = ['card-input', 'card-validation', 'call', 'stream'];
const MIN_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 1_200_000;
const MAX_CARD_BYTES = 1024 * 1024;
const CARD_RESOLVE_TIMEOUT_MS = 12_000;

export function validateDiagnosticsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw clientError('请求体必须是 JSON 对象');
  }
  if (Object.hasOwn(input, 'url') || Object.hasOwn(input, 'sourceType')) {
    throw clientError('请提交 agentCard 或 cardSource，不要使用旧的顶层 url 或 sourceType 字段');
  }
  const hasAgentCard = input.agentCard !== undefined;
  const hasCardSource = input.cardSource !== undefined;
  if (hasAgentCard === hasCardSource) {
    throw clientError('Agent Card JSON 与 URL 来源只能选择一种，不能同时提交或同时缺少');
  }

  let agentCard = null;
  let cardBytes = null;
  let cardSource = null;
  if (hasAgentCard) {
    if (!input.agentCard || typeof input.agentCard !== 'object' || Array.isArray(input.agentCard)) {
      throw clientError('agentCard 必须是单个 JSON 对象');
    }
    agentCard = input.agentCard;
    cardBytes = serializedCardBytes(agentCard);
  } else {
    if (!input.cardSource || typeof input.cardSource !== 'object' || Array.isArray(input.cardSource)) {
      throw clientError('cardSource 必须是包含 type 和 URL 的对象');
    }
    const type = input.cardSource.type;
    if (!['card-url', 'service-url'].includes(type)) {
      throw clientError('cardSource.type 必须是 card-url 或 service-url');
    }
    const url = typeof input.cardSource.url === 'string' ? input.cardSource.url.trim() : '';
    if (!url || Buffer.byteLength(url) > 2048 || /[\r\n]/.test(url)) {
      throw clientError('cardSource.url 必须是单行且不超过 2048 字节的 URL');
    }
    cardSource = { type, url };
  }

  const authMethod = input.authMethod;
  if (!['none', 'bearer'].includes(authMethod)) {
    throw clientError('authMethod 必须是 none 或 bearer');
  }
  const token = input.agentAuthorization ?? '';
  if (typeof token !== 'string' || Buffer.byteLength(token) > 8192 || /[\r\n]/.test(token)) {
    throw clientError('agentAuthorization 必须是不含换行且不超过 8 KiB 的 Token');
  }
  if (authMethod === 'none' && token) throw clientError('无鉴权模式不得提交 Agent Token');
  if (authMethod === 'none' && input.confirmAuthorizationTarget === true) {
    throw clientError('无鉴权模式不需要确认 Agent Token 目标');
  }
  if (authMethod === 'bearer' && !token) throw clientError('Bearer 鉴权必须填写 Agent Token');
  if (authMethod === 'bearer' && input.confirmAuthorizationTarget !== true) {
    throw clientError('发送 Agent Token 前必须确认目标 origin');
  }

  if (typeof input.prompt !== 'string' || !input.prompt.trim() || [...input.prompt].length > 4000) {
    throw clientError('prompt 必须是 1–4000 个字符的字符串');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw clientError('timeoutMs 必须是 60000–1200000 之间的整数');
  }

  const runStreaming = input.runStreaming === true;
  if (runStreaming && input.confirmStreamingSideEffects !== true) {
    throw clientError('启用流式检查前必须确认它会再次真实执行 Prompt');
  }
  if (input.attestations?.deepseekV4Pro !== true) {
    throw clientError('必须确认底座模型为 DeepSeek V4 Pro');
  }
  if (input.attestations?.authorizedDataOnly !== true) {
    throw clientError('必须确认 Agent 仅访问授权数据');
  }

  return {
    agentCard,
    cardBytes,
    cardSource,
    authMethod,
    agentAuthorization: token,
    confirmAuthorizationTarget: authMethod === 'bearer',
    prompt: input.prompt.trim(),
    timeoutMs,
    runStreaming,
    confirmStreamingSideEffects: runStreaming,
    attestations: {
      deepseekV4Pro: true,
      authorizedDataOnly: true
    }
  };
}

export async function runAgentDiagnostics(rawInput, options = {}) {
  let input = validateDiagnosticsInput(rawInput);
  const request = options.request || safeHttpRequest;
  const resolveCard = options.resolveCard || resolveAgentCard;
  const allowPrivate = options.allowPrivate ??
    (
      process.env.ALLOW_PRIVATE_DIAGNOSTICS_URLS === 'true' ||
      process.env.ALLOW_PRIVATE_AGENT_URLS === 'true'
    );
  const startedAt = Date.now();
  const checks = CHECK_IDS.map((id) => emptyCheck(id));
  const secrets = [input.agentAuthorization, ...(options.secrets || [])].filter(Boolean);
  const requestOptions = (overrides = {}) => ({
    allowPrivate,
    signal: options.signal,
    timeoutMs: input.timeoutMs,
    ...overrides
  });

  const inputStarted = Date.now();
  if (input.cardSource) {
    try {
      const resolved = await resolveCard(
        input.cardSource.type,
        input.cardSource.url,
        CARD_RESOLVE_TIMEOUT_MS,
        { allowPrivate }
      );
      const cardBytes = serializedCardBytes(resolved.card);
      input = { ...input, agentCard: resolved.card, cardBytes };
      checks[0] = passed('card-input', inputStarted, '已从 URL 获取 Agent Card JSON', {
        sourceType: input.cardSource.type,
        sourceUrl: input.cardSource.url,
        resolvedUrl: resolved.resolvedUrl,
        sourceScope: urlScopeLabel(resolved.resolvedUrl),
        name: truncate(input.agentCard.name, 240),
        sizeBytes: input.cardBytes
      });
    } catch (error) {
      checks[0] = failed('card-input', inputStarted, error);
      block(checks, 1, 'Agent Card 获取失败，无法校验或调用 Agent');
      return redactReport(finalize(checks, input, startedAt), secrets);
    }
  } else {
    checks[0] = passed('card-input', inputStarted, '已接收单个 Agent Card JSON', {
      sourceType: 'json',
      name: truncate(input.agentCard.name, 240),
      sizeBytes: input.cardBytes
    });
  }

  const card = input.agentCard;
  const validationStarted = Date.now();
  const validation = validateAgentCard(card, { allowPrivate });
  const target = validation.valid ? validation.selectedInterface : null;
  if (!validation.valid || !target) {
    const reason = !validation.valid
      ? validation.errors.join('；')
      : 'Agent Card 没有平台支持的接口 binding';
    checks[1] = failed('card-validation', validationStarted, stageError(reason, 'protocol'));
    block(checks, 2, 'Card 校验失败，无法调用 Agent');
    return redactReport(finalize(checks, input, startedAt), secrets);
  }

  let targetUrl;
  let acceptedOutputModes;
  try {
    targetUrl = validateSafeUrl(target.url, {
      allowPrivate
    });
    acceptedOutputModes = negotiateDiagnosticOutputModes(card);
  } catch (error) {
    checks[1] = failed('card-validation', validationStarted, error);
    block(checks, 2, 'Card 接口地址校验失败，无法调用 Agent');
    return redactReport(finalize(checks, input, startedAt), secrets);
  }
  checks[1] = passed('card-validation', validationStarted, 'Agent Card 与接口声明有效', {
    version: validation.version,
    binding: target.binding,
    executionVersion: target.version,
    targetOrigin: targetUrl.origin,
    networkPolicy: allowPrivate ? '允许内网/本机' : '仅公网',
    targetScope: urlScopeLabel(targetUrl),
    streaming: card.capabilities?.streaming === true,
    acceptedOutputModes,
    tenant: target.tenant || null,
    skillsCount: card.skills.length,
    warnings: validation.warnings
  });

  const callStarted = Date.now();
  try {
    const normalRequest = buildA2ARequest(target, input.prompt, {
      allowPrivate,
      acceptedOutputModes
    });
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
    try {
      payload = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw stageError('A2A 响应不是合法 JSON', 'json');
    }
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
      const streamRequest = buildA2ARequest(target, input.prompt, {
        streaming: true,
        allowPrivate,
        acceptedOutputModes
      });
      const headers = withAgentAuthorization(streamRequest.headers, input.agentAuthorization);
      const response = await request(streamRequest.url, requestOptions({
        method: 'POST',
        headers,
        body: JSON.stringify(streamRequest.body),
        maxBytes: 2 * 1024 * 1024
      }));
      requireSuccess(response, 'A2A 流式');
      requireContentType(response, ['text/event-stream'], 'A2A 流式');
      const events = parseSseEvents(response.body.toString('utf8'), {
        maxEvents: 256,
        maxEventBytes: 64 * 1024
      });
      const result = validateStreamResult(target, events, streamRequest.requestId);
      checks[3] = passed('stream', streamStarted, '流式 A2A 调用到达终态', {
        eventCount: result.eventCount,
        preview: truncate(result.text, 4096)
      });
    } catch (error) {
      checks[3] = failed('stream', streamStarted, error);
    }
  }

  return redactReport(finalize(checks, input, startedAt), secrets);
}

export function negotiateDiagnosticOutputModes(card) {
  try {
    return negotiateAcceptedOutputModes(card);
  } catch (error) {
    throw stageError(
      'Agent Card 声明的输出模式与诊断平台支持的 output mode 不兼容',
      'protocol'
    );
  }
}

function emptyCheck(id) {
  return {
    id,
    status: 'blocked',
    durationMs: 0,
    summary: '尚未执行',
    details: {},
    suggestion: null
  };
}

function passed(id, startedAt, summary, details = {}) {
  return {
    id,
    status: 'passed',
    durationMs: Date.now() - startedAt,
    summary,
    details,
    suggestion: null
  };
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
  return {
    id,
    status: 'skipped',
    durationMs: 0,
    summary,
    details: {},
    suggestion: null
  };
}

function blockedCheck(id, summary, suggestion) {
  return {
    id,
    status: 'blocked',
    durationMs: 0,
    summary,
    details: {},
    suggestion
  };
}

function block(checks, start, reason) {
  for (let index = start; index < checks.length; index += 1) {
    checks[index] = blockedCheck(
      checks[index].id,
      reason,
      '先修复前置阶段后重新诊断。'
    );
  }
}

function finalize(checks, input, startedAt) {
  const requiredPassed = checks.slice(0, 3).every((check) => check.status === 'passed');
  const technicalReadiness = buildTechnicalReadiness(checks, input.timeoutMs);
  return {
    ok: requiredPassed && technicalReadiness.ok,
    technicalReadinessOk: technicalReadiness.ok,
    technicalReadiness: { checks: technicalReadiness.checks },
    durationMs: Date.now() - startedAt,
    timeoutMs: input.timeoutMs,
    streamingRequested: input.runStreaming,
    streamingOk: input.runStreaming ? checks[3].status === 'passed' : null,
    checks
  };
}

function buildTechnicalReadiness(checks, timeoutMs) {
  const card = checks.find((check) => check.id === 'card-validation');
  const call = checks.find((check) => check.id === 'call');
  const cardStatus = readinessStatus(card);
  const callStatus = readinessStatus(call);
  const responseStatus = readinessStatus(call);
  const readinessChecks = [
    readinessCheck(
      'agent-card',
      cardStatus,
      card?.summary || 'Agent Card 尚未校验'
    ),
    readinessCheck(
      'a2a-call',
      callStatus,
      call?.summary || 'A2A 调用尚未执行'
    ),
    readinessCheck(
      'response-time',
      responseStatus,
      call?.status === 'passed'
        ? `普通调用在 ${timeoutMs} ms 上限内完成`
        : '普通调用未在上限内完成',
      { timeoutMs, durationMs: call?.durationMs || 0 }
    ),
    readinessCheck(
      'competition-attestations',
      'declared',
      '两项参评声明已确认，仍需人工核验'
    )
  ];
  return {
    ok: readinessChecks.slice(0, 3).every((check) => check.status === 'passed'),
    checks: readinessChecks
  };
}

function readinessStatus(check) {
  if (check?.status === 'passed') return 'passed';
  if (check?.status === 'failed') return 'failed';
  return 'blocked';
}

function readinessCheck(id, status, summary, details = {}) {
  return { id, status, summary, details };
}

function withAgentAuthorization(headers, token) {
  return token
    ? { ...headers, authorization: `Bearer ${token}` }
    : { ...headers };
}

function requireSuccess(response, label) {
  if (!response || response.status < 200 || response.status >= 300) {
    throw stageError(`${label} 返回 HTTP ${response?.status || 0}`, 'http');
  }
}

function requireContentType(response, accepted, label) {
  const value = String(response.headers?.['content-type'] || '').toLowerCase();
  if (!accepted.some((type) => value.includes(type))) {
    throw stageError(`${label} Content-Type 不符合协议`, 'content-type');
  }
}

function classifyError(error) {
  if (error?.code) return error.code;
  if (/JSON/i.test(error?.message)) return 'json';
  if (/HTTP/i.test(error?.message)) return 'http';
  return 'protocol';
}

function safeErrorMessage(error, category) {
  if (['protocol', 'json', 'http', 'content-type'].includes(category)) {
    return error?.message || '协议检查失败';
  }
  const labels = {
    dns: '域名解析失败',
    connection: '无法连接 Agent',
    tls: 'TLS 握手失败',
    timeout: '诊断请求超时',
    'response-too-large': '远程响应超过大小限制',
    security: '目标地址被安全策略阻止',
    cancelled: '诊断已取消',
    instrumentation: 'platform instrumentation error'
  };
  return labels[category] || '诊断阶段失败';
}

function suggestionFor(category) {
  const suggestions = {
    dns: '检查域名和平台服务器使用的 DNS 记录是否可解析。',
    connection: '确认 Agent 服务已启动，且平台服务器到目标地址的网络与防火墙策略允许访问。',
    tls: '检查证书有效期、域名和完整证书链。',
    http: '检查接口路径、鉴权和服务端错误日志。',
    'content-type': '返回规范要求的 JSON 或 text/event-stream Content-Type。',
    json: '确保响应正文是完整、合法的 JSON。',
    protocol: '按 Agent Card 声明的 A2A 版本和 binding 修正响应结构。',
    timeout: '缩短 Agent 执行时间或适当提高诊断超时。',
    'response-too-large': '缩短 Agent 输出并限制流式事件数量。',
    security: '检查 URL 协议、内嵌凭据和当前部署的内网访问策略。',
    cancelled: '保持页面连接后重新诊断。',
    instrumentation: '检查 platform instrumentation timing hook 后重试。'
  };
  return suggestions[category] || '检查 Agent 配置后重试。';
}

function redactReport(value, secrets) {
  if (typeof value === 'string') {
    return secrets.reduce(
      (text, secret) => secret ? text.split(secret).join('[REDACTED]') : text,
      value
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactReport(item, secrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactReport(item, secrets)])
    );
  }
  return value;
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stageError(message, code) {
  return Object.assign(new Error(message), { code });
}

function clientError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function serializedCardBytes(card) {
  let cardBytes;
  try {
    cardBytes = Buffer.byteLength(JSON.stringify(card));
  } catch {
    throw clientError('agentCard 必须可以序列化为 JSON');
  }
  if (cardBytes > MAX_CARD_BYTES) throw clientError('agentCard 不能超过 1 MiB');
  return cardBytes;
}

function urlScopeLabel(rawUrl) {
  let hostname;
  try {
    hostname = (rawUrl instanceof URL ? rawUrl : new URL(rawUrl)).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
  } catch {
    return '地址格式待校验';
  }
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname === '::1' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^(fc|fd|fe8|fe9|fea|feb)/.test(hostname)
  ) {
    return '本机或非公网地址';
  }
  return '公网地址或待 DNS 解析';
}
