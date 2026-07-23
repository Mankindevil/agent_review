import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticsGuard } from '../src/diagnostics-guard.js';
import { runAgentDiagnostics, validateDiagnosticsInput } from '../src/agent-diagnostics.js';

const card = {
  name: 'Diagnostic Agent',
  description: 'Returns a diagnostic response.',
  supportedInterfaces: [{
    url: 'https://agent.example/a2a',
    protocolBinding: 'JSONRPC',
    protocolVersion: '1.0',
    tenant: 'finance'
  }],
  capabilities: { streaming: true },
  skills: [{ id: 'status', name: 'Status', description: 'Return service status.' }]
};

test('protects diagnostics with configuration, access key, rate, and concurrency limits', () => {
  const missing = createDiagnosticsGuard({ accessKey: '' });
  assert.throws(() => missing.enter('Bearer any'), (error) => error.statusCode === 503);

  let now = 1000;
  const guard = createDiagnosticsGuard({
    accessKey: 'platform-secret',
    rateLimit: 2,
    concurrency: 1,
    windowMs: 60_000,
    now: () => now
  });
  assert.throws(() => guard.enter(''), (error) => error.statusCode === 401);
  assert.throws(() => guard.enter('Bearer wrong'), (error) => error.statusCode === 401);

  const release = guard.enter('Bearer platform-secret');
  assert.throws(() => guard.enter('Bearer platform-secret'), (error) => error.statusCode === 503);
  release();
  guard.enter('Bearer platform-secret')();
  assert.throws(
    () => guard.enter('Bearer platform-secret'),
    (error) => error.statusCode === 429 && error.retryAfter > 0
  );
  now += 60_001;
  assert.doesNotThrow(() => guard.enter('Bearer platform-secret')());
});

test('validates bounded input and requires confirmation for a second streaming call', () => {
  assert.throws(
    () => validateDiagnosticsInput({ url: 'https://agent.example', sourceType: 'service-url', runStreaming: true }),
    /再次真实执行/
  );
  assert.throws(
    () => validateDiagnosticsInput({ url: 'https://user:pass@agent.example', sourceType: 'service-url' }),
    /userinfo|凭据/
  );
  assert.throws(
    () => validateDiagnosticsInput({ url: 'https://agent.example', sourceType: 'service-url', prompt: 'x'.repeat(4001) }),
    /prompt/i
  );
  assert.throws(
    () => validateDiagnosticsInput({ url: 'http://127.0.0.1/a2a', sourceType: 'service-url' }),
    (error) => error.statusCode === 400
  );
});

test('returns stable dependency states when discovery fails', async () => {
  const report = await runAgentDiagnostics(
    { url: 'https://agent.example', sourceType: 'service-url' },
    { request: async () => { throw Object.assign(new Error('lookup failed'), { code: 'dns' }); } }
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.map((check) => [check.id, check.status]), [
    ['discovery', 'failed'],
    ['card-validation', 'blocked'],
    ['call', 'blocked'],
    ['stream', 'blocked']
  ]);
  assert.match(report.checks[0].suggestion, /DNS|域名/);
});

test('reports an unsafe or malformed interface URL as a card validation failure', async () => {
  for (const url of ['not-a-url', 'http://127.0.0.1/a2a']) {
    const unsafeCard = {
      ...card,
      supportedInterfaces: [{ ...card.supportedInterfaces[0], url }]
    };
    const report = await runAgentDiagnostics(
      { url: 'https://agent.example', sourceType: 'service-url' },
      { request: async () => jsonResponse(unsafeCard) }
    );
    assert.equal(report.ok, false);
    assert.equal(report.checks[1].status, 'failed');
    assert.equal(report.checks[2].status, 'blocked');
    assert.equal(report.checks[3].status, 'blocked');
  }
});

test('keeps platform and Agent credentials scoped and skips streaming by default', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (options.method !== 'POST') return jsonResponse(card);
    const body = JSON.parse(options.body);
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: { message: { messageId: 'reply', role: 'ROLE_AGENT', parts: [{ text: 'healthy agent-secret' }] } }
    });
  };
  const report = await runAgentDiagnostics({
    url: 'https://agent.example',
    sourceType: 'service-url',
    agentAuthorization: 'agent-secret',
    prompt: 'status'
  }, { request, secrets: ['platform-secret'] });

  assert.equal(report.ok, true);
  assert.equal(report.streamingOk, null);
  assert.equal(report.checks[3].status, 'skipped');
  assert.equal('authorization' in calls[0].options.headers, false);
  assert.equal(calls[1].options.headers.authorization, 'Bearer agent-secret');
  assert.doesNotMatch(JSON.stringify(report), /agent-secret|platform-secret/);
  assert.match(JSON.stringify(report), /\[REDACTED\]/);
});

test('blocks cross-origin Agent credentials unless the user explicitly authorizes the target', async () => {
  const crossOriginCard = {
    ...card,
    supportedInterfaces: [{ ...card.supportedInterfaces[0], url: 'https://runtime.example/a2a' }]
  };
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(crossOriginCard);
  };
  const report = await runAgentDiagnostics({
    url: 'https://cards.example/agent-card.json',
    sourceType: 'card-url',
    agentAuthorization: 'agent-secret'
  }, { request });
  assert.equal(report.checks[2].status, 'blocked');
  assert.equal(report.checks[3].status, 'skipped');
  assert.equal(calls.length, 1);
  assert.match(report.checks[2].suggestion, /跨域/);

  calls.length = 0;
  const allowedRequest = async (url, options) => {
    calls.push({ url, options });
    if (options.method !== 'POST') return jsonResponse(crossOriginCard);
    const body = JSON.parse(options.body);
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: { message: { messageId: 'reply', role: 'ROLE_AGENT', parts: [{ text: 'authorized' }] } }
    });
  };
  const allowed = await runAgentDiagnostics({
    url: 'https://cards.example/agent-card.json',
    sourceType: 'card-url',
    agentAuthorization: 'agent-secret',
    allowCrossOriginAuthorization: true
  }, { request: allowedRequest });
  assert.equal(allowed.checks[2].status, 'passed');
  assert.equal(calls.length, 2);
  assert.equal('authorization' in calls[0].options.headers, false);
  assert.equal(calls[1].url, 'https://runtime.example/a2a');
  assert.equal(calls[1].options.headers.authorization, 'Bearer agent-secret');
});

test('validates an explicitly confirmed streaming terminal event independently', async () => {
  const request = async (_url, options) => {
    if (options.method !== 'POST') return jsonResponse(card);
    const body = JSON.parse(options.body);
    if (body.method === 'SendStreamingMessage') {
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: Buffer.from(`data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { message: { messageId: 'stream-reply', role: 'ROLE_AGENT', parts: [{ text: 'stream ok' }] } }
        })}\n\n`)
      };
    }
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: { message: { messageId: 'reply', role: 'ROLE_AGENT', parts: [{ text: 'normal ok' }] } }
    });
  };
  const report = await runAgentDiagnostics({
    url: 'https://agent.example',
    sourceType: 'service-url',
    runStreaming: true,
    confirmStreamingSideEffects: true
  }, { request });
  assert.equal(report.ok, true);
  assert.equal(report.streamingOk, true);
  assert.equal(report.checks[3].status, 'passed');
  assert.equal(report.checks[3].details.eventCount, 1);
});

function jsonResponse(payload, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify(payload))
  };
}
