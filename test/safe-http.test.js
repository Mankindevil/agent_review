import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  assertPublicAddress,
  resolveSafeAddress,
  safeHttpRequest,
  validateSafeUrl
} from '../src/safe-http.js';

test('rejects unsafe URL credentials and private address ranges', () => {
  assert.throws(() => validateSafeUrl('https://user:pass@example.com/a2a'), /userinfo|凭据/);
  for (const address of [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.1.2', '172.16.0.1', '192.168.1.2',
    '224.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1'
  ]) {
    assert.throws(() => assertPublicAddress(address), /SSRF/, address);
  }
  assert.doesNotThrow(() => assertPublicAddress('8.8.8.8'));
  assert.doesNotThrow(() => assertPublicAddress('2606:4700:4700::1111'));
});

test('rejects a hostname when any DNS answer is private and pins a safe answer', async () => {
  const mixedLookup = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ];
  await assert.rejects(
    resolveSafeAddress('https://agent.example.com/a2a', { lookup: mixedLookup }),
    /SSRF/
  );

  const resolved = await resolveSafeAddress('https://agent.example.com/a2a', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }]
  });
  assert.equal(resolved.address, '8.8.8.8');
  assert.equal(resolved.family, 4);
});

test('normalizes lookup failures as DNS errors', async () => {
  await assert.rejects(
    resolveSafeAddress('https://missing.example/a2a', {
      lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }
    }),
    (error) => error.code === 'dns'
  );
});

test('includes DNS resolution in the total request timeout', { timeout: 500 }, async () => {
  await assert.rejects(
    safeHttpRequest('https://slow-dns.example/a2a', {
      lookup: async () => new Promise(() => {}),
      timeoutMs: 10
    }),
    (error) => error.code === 'timeout'
  );
});

test('uses the validated address, preserves Host, and never follows redirects', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'http://127.0.0.1/private' });
      return response.end();
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(request.headers.host);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    const result = await safeHttpRequest(`http://agent.example:${port}/host`, {
      lookup, allowPrivate: true, maxBytes: 1024
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), `agent.example:${port}`);

    const redirect = await safeHttpRequest(`http://agent.example:${port}/redirect`, {
      lookup, allowPrivate: true, maxBytes: 1024
    });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, 'http://127.0.0.1/private');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('enforces byte limits, timeout, and caller abort while reading', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/large') return response.end('0123456789');
    setTimeout(() => response.end('late'), 100);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await assert.rejects(
      safeHttpRequest(`http://agent.example:${port}/large`, { lookup, allowPrivate: true, maxBytes: 4 }),
      /大小限制/
    );
    await assert.rejects(
      safeHttpRequest(`http://agent.example:${port}/slow`, { lookup, allowPrivate: true, timeoutMs: 10 }),
      /超时/
    );
    const controller = new AbortController();
    const request = safeHttpRequest(`http://agent.example:${port}/abort`, {
      lookup, allowPrivate: true, timeoutMs: 1000, signal: controller.signal
    });
    controller.abort();
    await assert.rejects(request, /取消/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
