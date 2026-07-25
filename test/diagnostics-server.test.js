import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiagnosticsServer,
  formatDiagnosticsStartupMessage,
  startDiagnosticsServer
} from '../diagnostics-server.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('formats the Windows-visible startup confirmation as ASCII', () => {
  const message = formatDiagnosticsStartupMessage(4173);
  assert.equal(message, 'Agent Card Check ready: http://localhost:4173/agent-check');
  assert.equal(Buffer.from(message).every((byte) => byte < 0x80), true);
});

test('serves only the standalone diagnostics surface', async () => {
  const server = createDiagnosticsServer();
  const origin = await listen(server);
  try {
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/agent-check');

    for (const pathname of [
      '/agent-check',
      '/agent-check.html',
      '/agent-check.js',
      '/agent-check-helpers.js',
      '/example-import.js',
      '/agent-check.css'
    ]) {
      const response = await fetch(`${origin}${pathname}`);
      assert.equal(response.status, 200, pathname);
    }

    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.mode, 'agent-check-standalone');
    assert.equal(Number.isNaN(Date.parse(healthBody.time)), false);

    for (const pathname of [
      '/api/evaluations',
      '/api/runtimes',
      '/index.html',
      '/app.js',
      '/styles.css',
      '/methodology.html',
      '/server.js'
    ]) {
      const response = await fetch(`${origin}${pathname}`);
      assert.equal(response.status, 404, pathname);
    }
  } finally {
    await close(server);
  }
});

test('mounts Card resolution and diagnostics without exposing evaluation routes', async () => {
  const calls = [];
  const server = createDiagnosticsServer({
    diagnosticsGuard: {
      enter() {
        calls.push('enter');
        return () => calls.push('release');
      }
    },
    async resolveCard(sourceType, url) {
      return { sourceType, url, resolved: true };
    },
    async runDiagnostics(input, options) {
      return {
        prompt: input.prompt,
        hasAbortSignal: options.signal instanceof AbortSignal
      };
    }
  });
  const origin = await listen(server);
  try {
    const resolved = await fetch(`${origin}/api/agent-cards/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'service-url',
        url: 'https://agent.example'
      })
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), {
      sourceType: 'service-url',
      url: 'https://agent.example',
      resolved: true
    });

    const diagnosed = await fetch(`${origin}/api/agent-diagnostics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'ping' })
    });
    assert.equal(diagnosed.status, 200);
    assert.deepEqual(await diagnosed.json(), {
      prompt: 'ping',
      hasAbortSignal: true
    });
    assert.deepEqual(calls, ['enter', 'release']);

    const wrongMethod = await fetch(`${origin}/api/agent-diagnostics`);
    assert.equal(wrongMethod.status, 404);
    assert.equal((await fetch(`${origin}/api/evaluations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })).status, 404);
  } finally {
    await close(server);
  }
});

test('rejects malformed and oversized JSON and preserves safe client errors', async () => {
  const server = createDiagnosticsServer({
    diagnosticsGuard: { enter: () => () => {} },
    resolveCard: async () => {
      throw Object.assign(new Error('Card 地址无效'), { statusCode: 422 });
    },
    runDiagnostics: async () => ({ ok: true })
  });
  const origin = await listen(server);
  try {
    const malformed = await fetch(`${origin}/api/agent-diagnostics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    assert.equal(malformed.status, 400);

    const oversized = await fetch(`${origin}/api/agent-diagnostics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1_400_000) })
    });
    assert.equal(oversized.status, 413);

    const clientError = await fetch(`${origin}/api/agent-cards/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'card-url',
        url: 'https://agent.example/card.json'
      })
    });
    assert.equal(clientError.status, 422);
    assert.deepEqual(await clientError.json(), { error: 'Card 地址无效' });
  } finally {
    await close(server);
  }
});

test('starts only on the deployed machine localhost name', async () => {
  await assert.rejects(
    startDiagnosticsServer({ HOST: '0.0.0.0', PORT: '4173' }),
    /localhost|本机|回环/
  );
  await assert.rejects(
    startDiagnosticsServer({ HOST: '192.168.1.10', PORT: '4173' }),
    /localhost|本机|回环/
  );
});
