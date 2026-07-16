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

export function safeJson(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
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
