import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { anthropicToOpenAIMessages, startArkAnthropicProxy } from '../src/ark-anthropic-proxy.js';

test('converts Anthropic system and message blocks to OpenAI messages', () => {
  assert.deepEqual(anthropicToOpenAIMessages({
    system: [{ type: 'text', text: 'system rules' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, { role: 'assistant', content: 'hi' }]
  }), [
    { role: 'system', content: 'system rules' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' }
  ]);
});

test('bridges Ark chat completions into Anthropic JSON and SSE responses', async () => {
  const observed = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'Ark DeepSeek result' } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startArkAnthropicProxy({ baseUrl: `http://127.0.0.1:${upstream.address().port}/api/v3`, apiKey: 'ark-test-key', model: 'ep-deepseek', seed: 8848, temperature: 0 });
  try {
    const basePayload = { model: 'claude-sonnet', max_tokens: 100, system: 'system', messages: [{ role: 'user', content: 'hello' }] };
    const jsonResponse = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(basePayload) });
    const message = await jsonResponse.json();
    assert.equal(message.content[0].text, 'Ark DeepSeek result');
    assert.equal(message.model, 'ep-deepseek');

    const streamResponse = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...basePayload, stream: true }) });
    const stream = await streamResponse.text();
    assert.match(stream, /event: message_start/);
    assert.match(stream, /Ark DeepSeek result/);
    assert.match(stream, /event: message_stop/);

    assert.equal(observed.length, 2);
    assert.equal(observed[0].url, '/api/v3/chat/completions');
    assert.equal(observed[0].authorization, 'Bearer ark-test-key');
    assert.equal(observed[0].body.model, 'ep-deepseek');
    assert.equal(observed[0].body.seed, 8848);
    assert.equal(observed[0].body.temperature, 0);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
