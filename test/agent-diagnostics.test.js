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

const baseInput = {
  agentCard: card,
  authMethod: 'none',
  prompt: 'status',
  timeoutMs: 300_000,
  attestations: {
    deepseekV4Pro: true,
    authorizedDataOnly: true
  }
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

test('accepts one bounded Agent Card and rejects legacy, array, timeout, prompt, and attestation input', () => {
  const normalized = validateDiagnosticsInput(baseInput);
  assert.equal(normalized.agentCard, card);
  assert.equal(normalized.timeoutMs, 300_000);
  assert.equal(normalized.authMethod, 'none');

  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, agentCard: [card] }),
    /单个|对象/
  );
  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, url: 'https://other.example' }),
    /旧地址字段|agentCard/
  );
  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, sourceType: 'card-url' }),
    /旧地址字段|agentCard/
  );
  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, timeoutMs: 59_999 }),
    /60000/
  );
  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, timeoutMs: 1_200_001 }),
    /1200000/
  );
  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, prompt: '  ' }),
    /prompt/i
  );
  assert.throws(
    () => validateDiagnosticsInput({
      ...baseInput,
      attestations: { deepseekV4Pro: false, authorizedDataOnly: true }
    }),
    /DeepSeek V4 Pro/
  );
  assert.throws(
    () => validateDiagnosticsInput({
      ...baseInput,
      attestations: { deepseekV4Pro: true, authorizedDataOnly: false }
    }),
    /授权数据/
  );
  assert.throws(
    () => validateDiagnosticsInput({
      ...baseInput,
      agentCard: { ...card, padding: 'x'.repeat(1024 * 1024) }
    }),
    /1 MiB/
  );
});

test('accepts exactly one complete Card URL or service root source', () => {
  for (const [type, url] of [
    ['card-url', 'https://agent.example/.well-known/agent-card.json'],
    ['service-url', 'https://agent.example']
  ]) {
    const normalized = validateDiagnosticsInput({
      ...baseInput,
      agentCard: undefined,
      cardSource: { type, url }
    });
    assert.deepEqual(normalized.cardSource, { type, url });
    assert.equal(normalized.agentCard, null);
  }

  assert.throws(
    () => validateDiagnosticsInput({
      ...baseInput,
      cardSource: { type: 'card-url', url: 'https://agent.example/card.json' }
    }),
    /只能选择一种|不能同时/
  );
  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, agentCard: undefined }),
    /Agent Card|来源/
  );
  assert.throws(
    () => validateDiagnosticsInput({
      ...baseInput,
      agentCard: undefined,
      cardSource: { type: 'other', url: 'https://agent.example' }
    }),
    /card-url|service-url/
  );
  assert.throws(
    () => validateDiagnosticsInput({
      ...baseInput,
      agentCard: undefined,
      cardSource: { type: 'card-url', url: '' }
    }),
    /URL/
  );
});

test('requires consistent Agent authentication and explicit target confirmation', () => {
  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, authMethod: 'none', agentAuthorization: 'secret' }),
    /无鉴权/
  );
  assert.throws(
    () => validateDiagnosticsInput({ ...baseInput, authMethod: 'bearer', agentAuthorization: '' }),
    /Token/
  );
  assert.throws(
    () => validateDiagnosticsInput({
      ...baseInput,
      authMethod: 'bearer',
      agentAuthorization: 'secret',
      confirmAuthorizationTarget: false
    }),
    /目标 origin/
  );
  assert.throws(
    () => validateDiagnosticsInput({
      ...baseInput,
      authMethod: 'bearer',
      agentAuthorization: 'line-one\nline-two',
      confirmAuthorizationTarget: true
    }),
    /换行|8 KiB/
  );
  const bearer = validateDiagnosticsInput({
    ...baseInput,
    authMethod: 'bearer',
    agentAuthorization: 'secret',
    confirmAuthorizationTarget: true
  });
  assert.equal(bearer.agentAuthorization, 'secret');
  assert.equal(bearer.confirmAuthorizationTarget, true);
});

test('uses the uploaded Card directly, propagates tenant, and reports technical readiness', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    assert.equal(body.params.tenant, 'finance');
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        message: {
          messageId: 'reply',
          role: 'ROLE_AGENT',
          parts: [{ text: 'healthy' }]
        }
      }
    });
  };

  const report = await runAgentDiagnostics(baseInput, { request });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://agent.example/a2a');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.timeoutMs, 300_000);
  assert.equal('authorization' in calls[0].options.headers, false);
  assert.deepEqual(report.checks.map(({ id, status }) => [id, status]), [
    ['card-input', 'passed'],
    ['card-validation', 'passed'],
    ['call', 'passed'],
    ['stream', 'skipped']
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.technicalReadinessOk, true);
  assert.deepEqual(
    report.technicalReadiness.checks.map(({ id, status }) => [id, status]),
    [
      ['agent-card', 'passed'],
      ['a2a-call', 'passed'],
      ['response-time', 'passed'],
      ['competition-attestations', 'declared']
    ]
  );
  assert.equal(report.technicalReadiness.checks[2].details.timeoutMs, 300_000);
});

test('resolves both URL source modes before running the existing diagnostics flow', async () => {
  for (const [type, url, resolvedUrl] of [
    [
      'card-url',
      'https://agent.example/custom-card.json',
      'https://agent.example/custom-card.json'
    ],
    [
      'service-url',
      'https://agent.example',
      'https://agent.example/.well-known/agent-card.json'
    ]
  ]) {
    const resolutions = [];
    const calls = [];
    const report = await runAgentDiagnostics({
      ...baseInput,
      agentCard: undefined,
      cardSource: { type, url }
    }, {
      allowPrivate: true,
      resolveCard: async (...args) => {
        resolutions.push(args);
        return {
          card,
          resolvedUrl,
          validation: { valid: true, errors: [], version: '1.0' }
        };
      },
      request: async (target, options) => {
        calls.push(target);
        const body = JSON.parse(options.body);
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            message: {
              messageId: 'reply',
              role: 'ROLE_AGENT',
              parts: [{ text: 'healthy' }]
            }
          }
        });
      }
    });

    assert.deepEqual(resolutions, [[type, url, 12_000, { allowPrivate: true }]]);
    assert.deepEqual(calls, ['https://agent.example/a2a']);
    assert.equal(report.ok, true);
    assert.equal(report.checks[0].details.sourceType, type);
    assert.equal(report.checks[0].details.sourceUrl, url);
    assert.equal(report.checks[0].details.resolvedUrl, resolvedUrl);
  }
});

test('allows and labels private targets when the platform policy enables them', async () => {
  const privateCard = {
    ...card,
    supportedInterfaces: [{
      ...card.supportedInterfaces[0],
      url: 'http://127.0.0.1:3000/a2a'
    }]
  };
  const request = async (_url, options) => {
    const body = JSON.parse(options.body);
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        message: {
          messageId: 'private-reply',
          role: 'ROLE_AGENT',
          parts: [{ text: 'private healthy' }]
        }
      }
    });
  };

  const report = await runAgentDiagnostics(
    { ...baseInput, agentCard: privateCard },
    { request, allowPrivate: true }
  );

  assert.equal(report.ok, true);
  assert.equal(report.checks[1].details.networkPolicy, '允许内网/本机');
  assert.equal(report.checks[1].details.targetScope, '本机或非公网地址');
});

test('reports URL resolution failures and blocks Agent calls', async () => {
  let calls = 0;
  const report = await runAgentDiagnostics({
    ...baseInput,
    agentCard: undefined,
    cardSource: {
      type: 'service-url',
      url: 'https://missing.example'
    }
  }, {
    resolveCard: async () => {
      throw Object.assign(new Error('lookup failed'), { code: 'dns' });
    },
    request: async () => {
      calls += 1;
      throw new Error('must not run');
    }
  });

  assert.equal(calls, 0);
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.map(({ id, status }) => [id, status]), [
    ['card-input', 'failed'],
    ['card-validation', 'blocked'],
    ['call', 'blocked'],
    ['stream', 'blocked']
  ]);
  assert.match(report.checks[0].suggestion, /DNS|域名/);
});

test('blocks malformed and unsafe Cards before any network request', async () => {
  for (const agentCard of [
    { ...card, skills: [] },
    {
      ...card,
      supportedInterfaces: [{ ...card.supportedInterfaces[0], url: 'http://127.0.0.1/a2a' }]
    }
  ]) {
    let calls = 0;
    const report = await runAgentDiagnostics(
      { ...baseInput, agentCard },
      { request: async () => { calls += 1; throw new Error('must not run'); } }
    );
    assert.equal(calls, 0);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].status, 'passed');
    assert.equal(report.checks[1].status, 'failed');
    assert.equal(report.checks[2].status, 'blocked');
    assert.equal(report.checks[3].status, 'blocked');
    assert.equal(report.technicalReadinessOk, false);
  }
});

test('scopes and redacts a confirmed Bearer Token', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        message: {
          messageId: 'reply',
          role: 'ROLE_AGENT',
          parts: [{ text: 'healthy agent-secret' }]
        }
      }
    });
  };
  const report = await runAgentDiagnostics({
    ...baseInput,
    authMethod: 'bearer',
    agentAuthorization: 'agent-secret',
    confirmAuthorizationTarget: true
  }, { request, secrets: ['platform-secret'] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, 'Bearer agent-secret');
  assert.doesNotMatch(JSON.stringify(report), /agent-secret|platform-secret/);
  assert.match(JSON.stringify(report), /\[REDACTED\]/);
});

test('reports a failed ordinary call in both diagnostics and readiness results', async () => {
  const report = await runAgentDiagnostics(baseInput, {
    request: async () => {
      throw Object.assign(new Error('lookup failed'), { code: 'dns' });
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.technicalReadinessOk, false);
  assert.equal(report.checks[2].status, 'failed');
  assert.match(report.checks[2].suggestion, /DNS|域名/);
  assert.deepEqual(
    report.technicalReadiness.checks.slice(1, 3).map((check) => check.status),
    ['failed', 'failed']
  );
});

test('uses an independent full timeout for an explicitly confirmed streaming call', async () => {
  const timeouts = [];
  const request = async (_url, options) => {
    timeouts.push(options.timeoutMs);
    const body = JSON.parse(options.body);
    if (body.method === 'SendStreamingMessage') {
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: Buffer.from(`data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            message: {
              messageId: 'stream-reply',
              role: 'ROLE_AGENT',
              parts: [{ text: 'stream ok' }]
            }
          }
        })}\n\n`)
      };
    }
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        message: {
          messageId: 'reply',
          role: 'ROLE_AGENT',
          parts: [{ text: 'normal ok' }]
        }
      }
    });
  };
  const report = await runAgentDiagnostics({
    ...baseInput,
    timeoutMs: 1_200_000,
    runStreaming: true,
    confirmStreamingSideEffects: true
  }, { request });

  assert.deepEqual(timeouts, [1_200_000, 1_200_000]);
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
