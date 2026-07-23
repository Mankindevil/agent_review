import { createHash, timingSafeEqual } from 'node:crypto';

export function createDiagnosticsGuard(options = {}) {
  const accessKey = options.accessKey ?? process.env.AGENT_DIAGNOSTICS_ACCESS_KEY ?? '';
  const rateLimit = positiveInteger(options.rateLimit ?? process.env.AGENT_DIAGNOSTICS_RATE_LIMIT, 6);
  const concurrency = positiveInteger(options.concurrency ?? process.env.AGENT_DIAGNOSTICS_CONCURRENCY, 4);
  const windowMs = positiveInteger(options.windowMs, 60_000);
  const now = options.now || Date.now;
  const buckets = new Map();
  let active = 0;

  function enter(authorization) {
    if (!accessKey) throw httpError(503, 'Agent 诊断访问密钥未配置');
    const supplied = parseBearer(authorization);
    if (!supplied || !sameSecret(supplied, accessKey)) throw httpError(401, 'Agent 诊断访问密钥无效');
    const current = now();
    const keyHash = digest(supplied);
    const recent = (buckets.get(keyHash) || []).filter((timestamp) => current - timestamp < windowMs);
    if (recent.length >= rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (current - recent[0])) / 1000));
      throw Object.assign(httpError(429, 'Agent 诊断请求过于频繁'), { retryAfter });
    }
    if (active >= concurrency) throw httpError(503, 'Agent 诊断当前已达到并发上限');
    recent.push(current);
    buckets.set(keyHash, recent);
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
    };
  }

  return { enter };
}

function parseBearer(value) {
  const match = String(value || '').match(/^Bearer ([^\r\n]+)$/i);
  return match?.[1] || '';
}

function sameSecret(left, right) {
  return timingSafeEqual(Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'));
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
