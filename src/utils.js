import { createHash, randomUUID } from 'node:crypto';

export const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
export const round = (value, digits = 0) => Number(value.toFixed(digits));
export const now = () => new Date().toISOString();
export const id = (prefix = 'eval') => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

export function normalizeSeed(value, fallback = 20_260_720) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric)) return Math.abs(numeric) % 2_147_483_647;
  return stableNumber(String(value), 1, 2_147_483_646);
}

export function deriveSeed(seed, scope) {
  return stableNumber(`${normalizeSeed(seed)}:${scope}`, 1, 2_147_483_646);
}

export function normalizeTemperature(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(2, Math.max(0, numeric)) : fallback;
}

export function stableNumber(input, min, max) {
  const hex = createHash('sha256').update(String(input)).digest('hex').slice(0, 8);
  return min + (Number.parseInt(hex, 16) % (max - min + 1));
}

export function average(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}

export function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function networkFailureMessage(error) {
  if (!error) return 'remote connection failed';
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = current instanceof Error
      ? current.message
      : typeof current === 'string'
        ? current
        : '';
    if (message && !parts.includes(message)) parts.push(message);
    current = current.cause;
  }
  return parts.join(': ') || 'remote connection failed';
}

export function isTransientNetworkFailure(error) {
  const code = String(error?.code || error?.cause?.code || '');
  if ([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT'
  ].includes(code)) {
    return true;
  }
  return /socket hang up|disconnected before secure tls|network socket|econnreset|econnrefused|etimedout|fetch failed|tls handshake/iu
    .test(networkFailureMessage(error));
}

export async function withTransientNetworkRetry(operation, {
  attempts = 3,
  delaysMs = [250, 750, 1500]
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation is required');
  const total = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 3;
  let lastError;
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkFailure(error) || attempt >= total - 1) throw error;
      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)] || 250;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function safeJson(text, options = {}) {
  const requiredKeys = Array.isArray(options.requiredKeys)
    ? options.requiredKeys.filter((key) => typeof key === 'string' && key)
    : [];
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [];

  try {
    candidates.push(JSON.parse(cleaned));
  } catch {
    // Some CLIs add prose before or after the JSON value.
  }

  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{' && cleaned[start] !== '[') continue;
    const end = findJsonEnd(cleaned, start);
    if (end === -1) continue;
    try {
      candidates.push(JSON.parse(cleaned.slice(start, end + 1)));
    } catch {
      // Try the next balanced value.
    }
  }

  const usable = requiredKeys.length
    ? candidates.filter((value) => hasRequiredKeys(value, requiredKeys))
    : candidates;
  if (!usable.length) {
    throw new SyntaxError(
      requiredKeys.length
        ? `模型输出中未找到包含 ${requiredKeys.join(', ')} 的合法 JSON`
        : '模型输出中未找到合法 JSON'
    );
  }
  return usable.reduce((best, current) => (
    jsonSize(current) > jsonSize(best) ? current : best
  ));
}

function hasRequiredKeys(value, requiredKeys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && requiredKeys.every((key) => Object.hasOwn(value, key));
}

function jsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function findJsonEnd(text, start) {
  const stack = [];
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

export async function readJsonBody(request, limit = 1_000_000) {
  return (await readJsonBodyWithSize(request, limit)).value;
}

export async function readJsonBodyWithSize(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体超过大小限制'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return {
      value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      size
    };
  } catch {
    throw Object.assign(
      new Error('请求体不是合法 JSON'),
      { statusCode: 400, bodySize: size }
    );
  }
}
