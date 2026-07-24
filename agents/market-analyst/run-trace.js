const REDACTED = '[REDACTED]';
const SECRET_KEY = /password|token|secret|authorization|username|jwt|credential|api[-_]?key|access[-_]?key|^user$/i;
const TOKEN_USAGE_KEY = /^(?:input|output|reasoning|cached|total)Tokens$/;
const EMAIL = /\b([a-z0-9._%+-])([a-z0-9._%+-]*)@([a-z0-9.-]+\.[a-z]{2,})\b/gi;
const MAX_STRING_LENGTH = 4_000;
const MAX_ARRAY_LENGTH = 500;
const MAX_OBJECT_KEYS = 500;

function sanitizeString(input) {
  let value = String(input);
  value = value.replace(EMAIL, (_match, first, _rest, domain) => `${first}***@${domain}`);
  value = value.replace(
    /\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi,
    (_match, scheme) => `${scheme} ${REDACTED}`
  );
  value = value.replace(
    /\b(authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi,
    (_match, key) => `${key}=${REDACTED}`
  );
  value = value.replace(
    /\b(password|token|secret|username|jwt|access[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
    (_match, key) => `${key}=${REDACTED}`
  );
  value = value.replace(
    /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi,
    REDACTED
  );
  if (value.length > MAX_STRING_LENGTH) {
    value = `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`;
  }
  return value;
}

function sanitize(value, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
      ...(value.code ? { code: sanitizeString(value.code) } : {})
    };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitize(item, seen));
    if (value.length > MAX_ARRAY_LENGTH) result.push(`[${value.length - MAX_ARRAY_LENGTH} ITEMS TRUNCATED]`);
    return result;
  }
  const result = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  for (const [key, item] of entries) {
    const safeUsageMetric = TOKEN_USAGE_KEY.test(key) && (item === null || typeof item === 'number');
    result[key] = SECRET_KEY.test(key) && !safeUsageMetric ? REDACTED : sanitize(item, seen);
  }
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    result._truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
  }
  return result;
}

export function sanitizeTraceValue(value) {
  return sanitize(value, new WeakSet());
}

class RunTrace {
  constructor(meta) {
    this.meta = sanitizeTraceValue(meta || {});
    this.startedAt = new Date().toISOString();
    this.steps = [];
    this.workerEvents = [];
    this.modelUsage = [];
    this.emailAttempts = [];
    this.nextSequence = 1;
  }

  startStep({ skillId, tool, parentSequence, detail } = {}) {
    const sequence = this.nextSequence++;
    const startedAt = new Date();
    this.steps.push({
      sequence,
      ...(parentSequence === undefined ? {} : { parentSequence }),
      skillId: sanitizeTraceValue(skillId),
      tool: sanitizeTraceValue(tool),
      startedAt: startedAt.toISOString(),
      status: 'working',
      detail: sanitizeTraceValue(detail),
      _startedMs: startedAt.getTime()
    });
    return sequence;
  }

  finishStep(sequence, { status = 'ok', detail, error } = {}) {
    const step = this.steps.find((item) => item.sequence === sequence);
    if (!step) {
      const cause = new RangeError(`unknown trace sequence: ${sequence}`);
      cause.code = 'TRACE_SEQUENCE_NOT_FOUND';
      throw cause;
    }
    if (step.endedAt) {
      const cause = new Error(`trace sequence already finished: ${sequence}`);
      cause.code = 'TRACE_SEQUENCE_FINISHED';
      throw cause;
    }
    const endedAt = new Date();
    step.endedAt = endedAt.toISOString();
    step.durationMs = Math.max(0, endedAt.getTime() - step._startedMs);
    step.status = sanitizeTraceValue(status);
    if (detail !== undefined) step.detail = sanitizeTraceValue(detail);
    if (error !== undefined) step.error = sanitizeTraceValue(error);
    delete step._startedMs;
    return sequence;
  }

  addWorkerEvent(event) {
    const sequence = this.nextSequence++;
    this.workerEvents.push({ ...sanitizeTraceValue(event), sequence });
    return sequence;
  }

  addModelUsage(usage) {
    const sequence = this.nextSequence++;
    this.modelUsage.push({ ...sanitizeTraceValue(usage), sequence });
    return sequence;
  }

  addEmailAttempt(attempt) {
    const sequence = this.nextSequence++;
    this.emailAttempts.push({ ...sanitizeTraceValue(attempt), sequence });
    return sequence;
  }

  toJSON() {
    const endedTimes = this.steps
      .map((step) => step.endedAt)
      .filter(Boolean)
      .map((value) => Date.parse(value))
      .filter(Number.isFinite);
    const lastEnded = endedTimes.length ? Math.max(...endedTimes) : undefined;
    return sanitizeTraceValue({
      schemaVersion: '1.0',
      ...this.meta,
      startedAt: this.startedAt,
      ...(lastEnded === undefined ? {} : {
        endedAt: new Date(lastEnded).toISOString(),
        durationMs: Math.max(0, lastEnded - Date.parse(this.startedAt))
      }),
      steps: this.steps,
      workerEvents: this.workerEvents,
      modelUsage: this.modelUsage,
      emailAttempts: this.emailAttempts
    });
  }
}

export function createRunTrace(meta = {}) {
  return new RunTrace(meta);
}
