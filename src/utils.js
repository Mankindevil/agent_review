import { createHash, randomUUID } from 'node:crypto';

export const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
export const round = (value, digits = 0) => Number(value.toFixed(digits));
export const now = () => new Date().toISOString();
export const id = (prefix = 'eval') => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

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

export function safeJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* Some CLIs add prose before or after the JSON value. */ }

  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{' && cleaned[start] !== '[') continue;
    const end = findJsonEnd(cleaned, start);
    if (end === -1) continue;
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* Try the next balanced value. */ }
  }
  throw new SyntaxError('模型输出中未找到合法 JSON');
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
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体超过 1 MB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 });
  }
}
