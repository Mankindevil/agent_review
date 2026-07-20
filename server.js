import './src/env.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { EvaluationPipeline } from './src/pipeline.js';
import { EvaluationStore } from './src/store.js';
import { normalizeSeed, normalizeTemperature, readJsonBody } from './src/utils.js';
import { resolveAgentCard } from './src/a2a.js';
import { getRuntimeStatus } from './src/runtime-status.js';
import { createSkillBundle } from './src/runtimes.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
const store = new EvaluationStore(process.env.DATA_FILE || path.join(root, 'data/evaluations.json'));
const events = new EventEmitter();
events.setMaxListeners(100);
const pipeline = new EvaluationPipeline(store, events);
await store.load();
await pipeline.recoverInterrupted();

export const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, {
      ok: true, mode: 'full-stack', time: new Date().toISOString(),
      evaluationSeed: normalizeSeed(process.env.EVALUATION_SEED), modelTemperature: normalizeTemperature(process.env.MODEL_TEMPERATURE, 0)
    });
    if (request.method === 'GET' && url.pathname === '/api/runtimes') return json(response, 200, await getRuntimeStatus());
    if (request.method === 'POST' && url.pathname === '/api/agent-cards/resolve') {
      const input = await readJsonBody(request);
      try {
        return json(response, 200, await resolveAgentCard(input.sourceType, input.url));
      } catch (error) {
        error.statusCode = /获取失败|fetch|timeout/i.test(error.message) ? 502 : 400;
        throw error;
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/evaluations') return json(response, 200, store.list().map(summary));
    if (request.method === 'POST' && url.pathname === '/api/evaluations') {
      const item = await pipeline.create(await readJsonBody(request));
      return json(response, 202, item);
    }
    const cancelMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const item = await pipeline.cancel(cancelMatch[1]);
      return item ? json(response, 200, item) : json(response, 404, { error: '评测不存在' });
    }
    const retryMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/retry$/);
    if (request.method === 'POST' && retryMatch) {
      const item = await pipeline.retry(retryMatch[1], await readJsonBody(request));
      return item ? json(response, 202, item) : json(response, 404, { error: '评测不存在' });
    }
    const skillMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/builds\/([^/]+)\/skill$/);
    if (request.method === 'GET' && skillMatch) {
      const item = store.get(skillMatch[1]);
      if (!item) return json(response, 404, { error: '评测不存在' });
      const runtimeId = decodeURIComponent(skillMatch[2]);
      const build = item.builds?.find((candidate) => candidate.runtimeId === runtimeId);
      if (!build) return json(response, 404, { error: 'Runtime 复刻记录不存在' });
      if (build.error || !build.skill) return json(response, 409, { error: build.error || '该 Runtime 没有 Skill 产物' });
      try {
        return json(response, 200, createSkillBundle(build, item.agentCard));
      } catch (error) {
        return json(response, 409, { error: error.message || 'Skill 产物无法标准化' });
      }
    }
    const match = url.pathname.match(/^\/api\/evaluations\/([^/]+)$/);
    if (request.method === 'DELETE' && match) {
      const item = store.get(match[1]);
      if (!item) return json(response, 404, { error: '评测不存在' });
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(item.status)) {
        return json(response, 409, { error: '运行中的评测不能删除，请先停止本次评测' });
      }
      await store.delete(match[1]);
      return json(response, 200, { id: match[1], deleted: true });
    }
    if (request.method === 'GET' && match) {
      const item = store.get(match[1]);
      return item ? json(response, 200, item) : json(response, 404, { error: '评测不存在' });
    }
    const eventMatch = url.pathname.match(/^\/api\/evaluations\/([^/]+)\/events$/);
    if (request.method === 'GET' && eventMatch) return streamEvents(request, response, eventMatch[1]);
    if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
    if (request.method === 'GET') return staticFile(url.pathname, response);
    return json(response, 404, { error: '接口不存在' });
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) console.error(error);
    return json(response, error.statusCode || 500, { error: error.message || '服务器内部错误' });
  }
});

function streamEvents(request, response, evaluationId) {
  const item = store.get(evaluationId);
  if (!item) return json(response, 404, { error: '评测不存在' });
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  send(item);
  const listener = (value) => send(value);
  events.on(evaluationId, listener);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
  request.on('close', () => { clearInterval(heartbeat); events.off(evaluationId, listener); });
}

async function staticFile(pathname, response) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(publicRoot, `.${requested}`);
  if (target !== publicRoot && !target.startsWith(`${publicRoot}${path.sep}`)) return json(response, 403, { error: '禁止访问' });
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not file');
    response.writeHead(200, { 'content-type': contentType(target), 'cache-control': 'no-cache' });
    createReadStream(target).pipe(response);
  } catch {
    if (!path.extname(pathname)) return staticFile('/index.html', response);
    return json(response, 404, { error: '文件不存在' });
  }
}

function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
}
function json(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload)); }
function summary(item) { return { id: item.id, name: item.agentCard.name, createdAt: item.createdAt, status: item.status, progress: item.progress, tier: item.roast?.tier, score: item.averages?.submitted }; }

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 4173);
  server.listen(port, () => console.log(`Agent 锐评系统已启动：http://localhost:${port}`));
}
