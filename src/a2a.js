import { isIP } from 'node:net';

const LEGACY_BINDINGS = { JSONRPC: 'JSONRPC', 'JSON-RPC': 'JSONRPC', HTTP_JSON: 'HTTP+JSON', 'HTTP+JSON': 'HTTP+JSON' };

export function validateAgentCard(card) {
  const errors = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) errors.push('Agent Card 必须是 JSON 对象');
  if (!card?.name?.trim()) errors.push('缺少 name');
  if (!card?.description?.trim()) errors.push('缺少 description');
  if (!Array.isArray(card?.skills) || card.skills.length === 0) errors.push('至少声明一个 skill');
  card?.skills?.forEach((skill, index) => {
    if (!skill.id) errors.push(`skills[${index}] 缺少 id`);
    if (!skill.name) errors.push(`skills[${index}] 缺少 name`);
    if (!skill.description) errors.push(`skills[${index}] 缺少 description`);
  });
  if (!getInterfaces(card).length) errors.push('缺少 supportedInterfaces 或旧版 url');
  return { valid: errors.length === 0, errors, version: inferVersion(card), interfaces: getInterfaces(card) };
}

export function inferVersion(card) {
  return card?.protocolVersion || card?.supportedInterfaces?.[0]?.protocolVersion || (card?.url ? '0.3-compatible' : '1.0');
}

export function getInterfaces(card) {
  if (Array.isArray(card?.supportedInterfaces)) {
    return card.supportedInterfaces
      .filter((item) => item?.url)
      .map((item) => ({
        url: item.url,
        binding: LEGACY_BINDINGS[item.protocolBinding] || item.protocolBinding || 'HTTP+JSON',
        version: item.protocolVersion || card.protocolVersion || '1.0'
      }));
  }
  if (card?.url) {
    return [{ url: card.url, binding: LEGACY_BINDINGS[card.preferredTransport] || 'JSONRPC', version: card.protocolVersion || '0.3' }];
  }
  return [];
}

export function assertSafeAgentUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Agent 接口 URL 不合法'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Agent 接口仅支持 HTTP(S)');
  const hostname = url.hostname.toLowerCase();
  const privateName = hostname === 'localhost' || hostname.endsWith('.local');
  const privateIp = isIP(hostname) && (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || hostname === '::1');
  if ((privateName || privateIp) && process.env.ALLOW_PRIVATE_AGENT_URLS !== 'true') {
    throw new Error('为防止 SSRF，默认禁止内网 Agent URL；本地开发可设置 ALLOW_PRIVATE_AGENT_URLS=true');
  }
  return url;
}

export async function resolveAgentCard(sourceType, rawUrl, timeoutMs = 12_000) {
  if (!['card-url', 'service-url'].includes(sourceType)) throw new Error('不支持的 Agent Card 发现方式');
  const input = assertSafeAgentUrl(rawUrl);
  const target = sourceType === 'service-url'
    ? new URL('/.well-known/agent-card.json', input.origin)
    : input;
  const response = await fetch(target, {
    headers: { accept: 'application/json, application/a2a+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Agent Card 获取失败：HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error('Agent Card 超过 1 MB');
  let card;
  try { card = JSON.parse(text); } catch { throw new Error('远程地址没有返回合法 JSON'); }
  const validation = validateAgentCard(card);
  if (!validation.valid) throw new Error(`远程 Agent Card 校验失败：${validation.errors.join('；')}`);
  return { card, resolvedUrl: target.toString(), validation };
}

export async function callA2AAgent(card, prompt, timeoutMs = 45_000) {
  const [target] = getInterfaces(card);
  if (!target) throw new Error('没有可调用的 A2A 接口');
  const url = assertSafeAgentUrl(target.url);
  const messageId = crypto.randomUUID();
  const isJsonRpc = target.binding === 'JSONRPC';
  const isV1 = !String(target.version).startsWith('0.');
  const endpoint = isJsonRpc ? url : new URL(url.pathname.endsWith('/') ? 'message:send' : `${url.pathname}/message:send`, url);
  const body = isJsonRpc
    ? { jsonrpc: '2.0', id: messageId, method: isV1 ? 'SendMessage' : 'message/send', params: { message: { role: isV1 ? 'ROLE_USER' : 'user', messageId, parts: [isV1 ? { text: prompt } : { kind: 'text', text: prompt }] } } }
    : { message: { role: 'ROLE_USER', messageId, parts: [{ text: prompt }] }, configuration: { acceptedOutputModes: ['text/plain', 'application/json'] } };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': isJsonRpc ? 'application/json' : 'application/a2a+json', 'a2a-version': target.version },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`A2A 返回 HTTP ${response.status}`);
  const payload = await response.json();
  return { raw: payload, text: extractAgentText(payload) };
}

export function extractAgentText(payload) {
  const root = payload?.result || payload;
  const task = root?.task || root;
  const candidates = [
    root?.message?.parts,
    task?.message?.parts,
    task?.parts,
    task?.artifacts?.flatMap((artifact) => artifact.parts || [])
  ].flat().filter(Boolean);
  const text = candidates.map((part) => part.text || part?.data?.text || '').filter(Boolean).join('\n');
  return text || JSON.stringify(root);
}
