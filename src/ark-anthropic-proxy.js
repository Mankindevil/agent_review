import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { withTimeout } from './utils.js';

export async function startArkAnthropicProxy({ baseUrl, apiKey, model, fetchImpl = fetch, signal, seed, temperature }) {
  if (!baseUrl || !apiKey || !model) throw new Error('启动 Ark Claude 协议桥需要 baseUrl、apiKey 和 model');
  const endpoint = chatCompletionsUrl(baseUrl);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname.endsWith('/messages/count_tokens')) {
        const payload = await readBody(request);
        return sendJson(response, 200, { input_tokens: estimateTokens(JSON.stringify(payload)) });
      }
      if (request.method !== 'POST' || !url.pathname.endsWith('/messages')) {
        return sendJson(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'Unsupported local proxy route' } });
      }

      const payload = await readBody(request);
      const upstream = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: Math.min(Number(payload.max_tokens) || 4096, 16_384),
          temperature: Number.isFinite(temperature) ? temperature : Number.isFinite(payload.temperature) ? payload.temperature : 0,
          ...(Number.isInteger(seed) ? { seed } : {}),
          messages: anthropicToOpenAIMessages(payload)
        }),
        signal: withTimeout(signal, 120_000)
      });
      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 500);
        return sendJson(response, 502, { type: 'error', error: { type: 'api_error', message: `Ark 返回 HTTP ${upstream.status}${detail ? `：${detail}` : ''}` } });
      }
      const result = await upstream.json();
      const text = openAIContentText(result.choices?.[0]?.message?.content);
      if (!text) return sendJson(response, 502, { type: 'error', error: { type: 'api_error', message: 'Ark 没有返回可见文本' } });
      const message = anthropicMessage(model, text, result.usage);
      return payload.stream ? sendEventStream(response, message) : sendJson(response, 200, message);
    } catch (error) {
      return sendJson(response, 500, { type: 'error', error: { type: 'api_error', message: error.message } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  };
}

export function anthropicToOpenAIMessages(payload) {
  const messages = [];
  const system = contentText(payload.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of payload.messages || []) {
    const content = contentText(message.content);
    if (content) messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return messages;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'tool_result') return contentText(part.content);
    return '';
  }).filter(Boolean).join('\n');
}

function openAIContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');
}

function anthropicMessage(model, text, usage = {}) {
  return {
    id: `msg_ark_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || estimateTokens(text) }
  };
}

function sendEventStream(response, message) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  event(response, 'message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } } });
  event(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  event(response, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } });
  event(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  event(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  event(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function event(response, name, data) { response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); }
function sendJson(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload)); }
function estimateTokens(value) { return Math.max(1, Math.ceil(String(value || '').length / 4)); }
function chatCompletionsUrl(baseUrl) { const base = baseUrl.replace(/\/$/, ''); return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`; }

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Claude 请求体超过 2 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
