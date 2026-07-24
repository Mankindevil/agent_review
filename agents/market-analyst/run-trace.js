const REDACTED = '[REDACTED]';
const SECRET_KEY = /password|token|secret|authorization|username|jwt|credential|api[-_]?key|access[-_]?key|^user$/i;
const TOKEN_USAGE_KEY = /^(?:input|output|reasoning|cached|total)Tokens$/;
const EMAIL = /\b([a-z0-9._%+-])([a-z0-9._%+-]*)@([a-z0-9.-]+\.[a-z]{2,})\b/gi;
const CREDENTIAL_NAME = [
  'authorization(?:[_ -]?header)?',
  'proxy[_ -]?authorization(?:[_ -]?header)?',
  'password',
  'passphrase',
  'token',
  'jwt',
  'secret',
  'client[_ -]?secret',
  'api[_ -]?key',
  'access[_ -]?key',
  'credentials?',
  'username'
].join('|');
const CREDENTIAL_ASSIGNMENT = new RegExp(
  `(["']?(?:${CREDENTIAL_NAME})["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^;,}\\r\\n]+)`,
  'gi'
);
const MAX_STRING_LENGTH = 4_000;
const MAX_ARRAY_LENGTH = 500;
const MAX_OBJECT_KEYS = 500;
const MAX_DEPTH = 16;
const MAX_TOTAL_NODES = 4_096;
const MAX_TOTAL_BYTES = 256 * 1024;

export const TRACE_LIMITS = Object.freeze({
  steps: 128,
  workerEvents: 512,
  modelUsage: 64,
  emailAttempts: 64,
  conclusionLineage: 128
});

function truncation(reason, detail) {
  return {
    _truncated: true,
    reason,
    ...(detail === undefined ? {} : { detail })
  };
}

function markTruncated(context, reason) {
  context.reasons.add(reason);
}

function consumeBudget(context, bytes = 0) {
  context.nodes += 1;
  context.bytes += bytes;
  if (context.nodes > MAX_TOTAL_NODES) {
    markTruncated(context, 'node-budget');
    return false;
  }
  if (context.bytes > MAX_TOTAL_BYTES) {
    markTruncated(context, 'byte-budget');
    return false;
  }
  return true;
}

function sanitizeString(input) {
  let value = String(input);
  value = value.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
    (_match, scheme) => `${scheme}${REDACTED}@`
  );
  value = value.replace(CREDENTIAL_ASSIGNMENT, (_match, prefix) => `${prefix}${REDACTED}`);
  value = value.replace(
    /\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi,
    (_match, scheme) => `${scheme} ${REDACTED}`
  );
  value = value.replace(
    /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi,
    REDACTED
  );
  value = value.replace(EMAIL, (_match, first, _rest, domain) => `${first}***@${domain}`);
  if (value.length > MAX_STRING_LENGTH) {
    value = `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`;
  }
  return value;
}

function sanitize(value, context, depth, key) {
  if (depth > MAX_DEPTH) {
    markTruncated(context, 'depth-limit');
    return truncation('depth-limit');
  }
  if (value === null || value === undefined) {
    consumeBudget(context);
    return value;
  }
  if (typeof value === 'string') {
    const result = sanitizeString(value);
    if (!consumeBudget(context, Buffer.byteLength(result))) return truncation('byte-budget');
    return result;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    consumeBudget(context, 8);
    return value;
  }
  if (typeof value === 'bigint') {
    const result = value.toString();
    consumeBudget(context, result.length);
    return result;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (!consumeBudget(context)) return truncation('node-budget');
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      markTruncated(context, 'invalid-date');
      return truncation('invalid-date');
    }
  }
  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
      ...(value.code ? { code: sanitizeString(value.code) } : {})
    };
  }
  if (context.seen.has(value)) {
    markTruncated(context, 'circular-reference');
    return truncation('circular-reference');
  }
  context.seen.add(value);

  if (Array.isArray(value)) {
    const configuredLimit = /lineage/i.test(key || '')
      ? TRACE_LIMITS.conclusionLineage
      : MAX_ARRAY_LENGTH;
    const limit = Math.min(value.length, configuredLimit);
    const result = [];
    for (let index = 0; index < limit; index += 1) {
      if (context.nodes >= MAX_TOTAL_NODES || context.bytes >= MAX_TOTAL_BYTES) break;
      result.push(sanitize(value[index], context, depth + 1, key));
    }
    if (result.length < value.length) {
      const reason = result.length >= configuredLimit ? 'array-limit' : 'global-budget';
      markTruncated(context, reason);
      if (result.length >= configuredLimit && result.length > 0) result.pop();
      result.push(truncation(reason, { omitted: value.length - result.length }));
    }
    return result;
  }

  const result = {};
  const keys = Object.keys(value);
  const entries = keys.slice(0, MAX_OBJECT_KEYS);
  for (const property of entries) {
    if (context.nodes >= MAX_TOTAL_NODES || context.bytes >= MAX_TOTAL_BYTES) break;
    context.bytes += Buffer.byteLength(property);
    const item = value[property];
    const safeUsageMetric = TOKEN_USAGE_KEY.test(property)
      && (item === null || typeof item === 'number');
    result[property] = SECRET_KEY.test(property) && !safeUsageMetric
      ? REDACTED
      : sanitize(item, context, depth + 1, property);
  }
  if (Object.keys(result).length < keys.length) {
    const reason = entries.length < keys.length ? 'object-key-limit' : 'global-budget';
    markTruncated(context, reason);
    result._truncated = truncation(reason, {
      omitted: keys.length - Object.keys(result).length
    });
  }
  return result;
}

export function sanitizeTraceValue(value) {
  const context = {
    seen: new WeakSet(),
    nodes: 0,
    bytes: 0,
    reasons: new Set()
  };
  const result = sanitize(value, context, 0, '');
  if (context.reasons.size && result && typeof result === 'object' && !Array.isArray(result)) {
    result._sanitization = {
      truncated: true,
      reasons: [...context.reasons].sort()
    };
  }
  return result;
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
    this.limitSequences = new Map();
  }

  appendBounded(collection, category, limit, value) {
    if (collection.length < limit - 1) {
      const sequence = this.nextSequence++;
      collection.push({ ...sanitizeTraceValue(value), sequence });
      return sequence;
    }
    if (this.limitSequences.has(category)) return this.limitSequences.get(category);
    const sequence = this.nextSequence++;
    collection.push({
      sequence,
      type: 'trace-truncated',
      category,
      status: 'truncated',
      detail: { reason: `${category}-limit`, limit }
    });
    this.limitSequences.set(category, sequence);
    return sequence;
  }

  startStep({ skillId, tool, parentSequence, detail } = {}) {
    if (this.steps.length >= TRACE_LIMITS.steps - 1) {
      return this.appendBounded(
        this.steps,
        'steps',
        TRACE_LIMITS.steps,
        { type: 'trace-truncated' }
      );
    }
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
    if (step.type === 'trace-truncated') return sequence;
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
    return this.appendBounded(
      this.workerEvents,
      'workerEvents',
      TRACE_LIMITS.workerEvents,
      event
    );
  }

  addModelUsage(usage) {
    return this.appendBounded(
      this.modelUsage,
      'modelUsage',
      TRACE_LIMITS.modelUsage,
      usage
    );
  }

  addEmailAttempt(attempt) {
    return this.appendBounded(
      this.emailAttempts,
      'emailAttempts',
      TRACE_LIMITS.emailAttempts,
      attempt
    );
  }

  toJSON() {
    const endedTimes = this.steps
      .map((step) => step.endedAt)
      .filter(Boolean)
      .map((value) => Date.parse(value))
      .filter(Number.isFinite);
    const lastEnded = endedTimes.length ? Math.max(...endedTimes) : undefined;
    return sanitizeTraceValue({
      ...this.meta,
      schemaVersion: '1.0',
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
