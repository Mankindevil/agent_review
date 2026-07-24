export function createDiagnosticsGuard(options = {}) {
  const rateLimit = positiveInteger(options.rateLimit ?? process.env.AGENT_DIAGNOSTICS_RATE_LIMIT, 6);
  const concurrency = positiveInteger(options.concurrency ?? process.env.AGENT_DIAGNOSTICS_CONCURRENCY, 4);
  const windowMs = positiveInteger(options.windowMs, 60_000);
  const now = options.now || Date.now;
  const buckets = new Map();
  let active = 0;

  function enter() {
    const current = now();
    const recent = (buckets.get('global') || []).filter((timestamp) => current - timestamp < windowMs);
    if (recent.length >= rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (current - recent[0])) / 1000));
      throw Object.assign(httpError(429, 'Agent 诊断请求过于频繁'), { retryAfter });
    }
    if (active >= concurrency) throw httpError(503, 'Agent 诊断当前已达到并发上限');
    recent.push(current);
    buckets.set('global', recent);
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

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
