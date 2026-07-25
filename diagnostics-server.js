import './src/env.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentCard } from './src/a2a.js';
import { runAgentDiagnostics } from './src/agent-diagnostics.js';
import { createDiagnosticsGuard } from './src/diagnostics-guard.js';
import { resolveServerAddress } from './src/server-address.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
const BODY_LIMIT = Math.floor(1.25 * 1024 * 1024);
const STATIC_FILES = new Map([
  ['/agent-check', 'agent-check.html'],
  ['/agent-check.html', 'agent-check.html'],
  ['/agent-check.js', 'agent-check.js'],
  ['/agent-check-helpers.js', 'agent-check-helpers.js'],
  ['/agent-check.css', 'agent-check.css']
]);

export function createDiagnosticsServer(options = {}) {
  const diagnosticsGuard = options.diagnosticsGuard || createDiagnosticsGuard();
  const runDiagnostics = options.runDiagnostics || runAgentDiagnostics;
  const resolveCard = options.resolveCard || resolveDiagnosticsCard;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(302, {
          location: '/agent-check',
          'cache-control': 'no-store'
        });
        response.end();
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json(response, 200, {
          ok: true,
          mode: 'agent-check-standalone',
          time: new Date().toISOString()
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/agent-cards/resolve') {
        const input = await readJsonBody(request, BODY_LIMIT);
        const result = await resolveCard(input.sourceType, input.url);
        return json(response, 200, result);
      }

      if (request.method === 'POST' && url.pathname === '/api/agent-diagnostics') {
        const release = diagnosticsGuard.enter();
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', () => {
          if (!response.writableEnded) abort();
        });
        try {
          const input = await readJsonBody(request, BODY_LIMIT);
          const result = await runDiagnostics(input, { signal: controller.signal });
          return json(response, 200, result);
        } finally {
          request.off('aborted', abort);
          release();
        }
      }

      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        return staticFile(STATIC_FILES.get(url.pathname), response);
      }

      return json(response, 404, { error: '接口或文件不存在' });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (error?.retryAfter) response.setHeader('retry-after', String(error.retryAfter));
      return json(response, status, {
        error: status === 500 ? '自测台内部错误' : error.message
      });
    }
  });
}

export async function startDiagnosticsServer(env = process.env) {
  const standaloneEnv = {
    ...env,
    HOST: String(env.HOST || '').trim() || 'localhost'
  };
  const { host, port } = resolveServerAddress(standaloneEnv);
  if (host.toLowerCase() !== 'localhost') {
    throw new Error('独立自测台 HOST 必须保持为本机 localhost');
  }
  const server = createDiagnosticsServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  return server;
}

async function resolveDiagnosticsCard(sourceType, url) {
  const allowPrivate =
    process.env.ALLOW_PRIVATE_DIAGNOSTICS_URLS === 'true' ||
    process.env.ALLOW_PRIVATE_AGENT_URLS === 'true';
  return resolveAgentCard(sourceType, url, 12_000, { allowPrivate });
}

async function staticFile(relativePath, response) {
  const target = path.join(publicRoot, relativePath);
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': contentType(target),
      'cache-control': 'no-cache'
    });
    createReadStream(target).pipe(response);
  } catch {
    json(response, 404, { error: '文件不存在' });
  }
}

function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (tooLarge) {
        reject(httpError(413, '请求体超过大小限制'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, '请求体必须是合法 JSON'));
      }
    });
  });
}

function contentType(file) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  })[path.extname(file)] || 'application/octet-stream';
}

function json(response, status, payload) {
  if (response.writableEnded) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startDiagnosticsServer();
  const address = server.address();
  console.log(`Agent Card 自测台已启动：http://localhost:${address.port}/agent-check`);
}
