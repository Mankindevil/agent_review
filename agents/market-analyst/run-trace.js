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
const MAX_OBJECT_KEY_BYTES = 128;
const SAFE_MARKET_MESSAGE_ID =
  /^<market-report\.[a-f0-9]{64}@market-analyst\.local>$/;

export const TRACE_SANITIZATION_LIMITS = Object.freeze({
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxObjectKeyBytes: MAX_OBJECT_KEY_BYTES
});

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

function consumeBytes(context, bytes) {
  if (context.bytes + bytes > MAX_TOTAL_BYTES) {
    markTruncated(context, 'byte-budget');
    return false;
  }
  context.bytes += bytes;
  return true;
}

function redactUrlCredentials(input) {
  return input.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
    (_match, scheme) => `${scheme}${REDACTED}@`
  );
}

function redactEmails(input) {
  return input.replace(EMAIL, (_match, first, _rest, domain) => `${first}***@${domain}`);
}

function sanitizeString(input) {
  let value = String(input);
  if (SAFE_MARKET_MESSAGE_ID.test(value)) return value;
  value = redactUrlCredentials(value);
  value = value.replace(CREDENTIAL_ASSIGNMENT, (_match, prefix) => `${prefix}${REDACTED}`);
  value = value.replace(
    /\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi,
    (_match, scheme) => `${scheme} ${REDACTED}`
  );
  value = value.replace(
    /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi,
    REDACTED
  );
  value = redactEmails(value);
  if (value.length > MAX_STRING_LENGTH) {
    value = `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`;
  }
  return value;
}

function truncateUtf8(input, maxBytes, suffix = '') {
  if (Buffer.byteLength(input) <= maxBytes) return input;
  const suffixBytes = Buffer.byteLength(suffix);
  const contentLimit = Math.max(0, maxBytes - suffixBytes);
  let result = '';
  let bytes = 0;
  for (const character of input) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}

function sanitizePropertyKey(property, context) {
  let relevant = String(property);
  if (relevant.includes('@')) {
    relevant = redactEmails(redactUrlCredentials(relevant));
  }
  if (Buffer.byteLength(relevant) > MAX_STRING_LENGTH) {
    relevant = truncateUtf8(relevant, MAX_STRING_LENGTH);
  }
  const sanitized = sanitizeString(relevant);
  if (
    Buffer.byteLength(property) <= MAX_OBJECT_KEY_BYTES
    && Buffer.byteLength(sanitized) <= MAX_OBJECT_KEY_BYTES
  ) {
    return sanitized;
  }
  markTruncated(context, 'object-key-length');
  return truncateUtf8(sanitized, MAX_OBJECT_KEY_BYTES, '[TRUNCATED]');
}

function uniquePropertyKey(property, result, context) {
  if (!Object.hasOwn(result, property)) return property;
  markTruncated(context, 'object-key-collision');
  for (let collision = 1; collision <= MAX_OBJECT_KEYS; collision += 1) {
    const suffix = `~${String(collision).padStart(3, '0')}`;
    const prefix = truncateUtf8(
      property,
      MAX_OBJECT_KEY_BYTES - Buffer.byteLength(suffix)
    );
    const candidate = `${prefix}${suffix}`;
    if (!Object.hasOwn(result, candidate)) return candidate;
  }
  markTruncated(context, 'object-key-collision-limit');
  return null;
}

function defineDataProperty(target, property, value) {
  Object.defineProperty(target, property, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });
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
    if (result.length > MAX_STRING_LENGTH) markTruncated(context, 'string-length');
    return sanitize(result, context, depth, key);
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Error) {
    if (context.seen.has(value)) {
      markTruncated(context, 'circular-reference');
      return truncation('circular-reference');
    }
    context.seen.add(value);
    return sanitize({
      name: value.name,
      message: value.message,
      ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
      ...(value.code === undefined ? {} : { code: value.code })
    }, context, depth, key);
  }
  if (!consumeBudget(context)) return truncation('node-budget');
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      markTruncated(context, 'invalid-date');
      return truncation('invalid-date');
    }
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
  for (const rawProperty of entries) {
    if (context.nodes >= MAX_TOTAL_NODES || context.bytes >= MAX_TOTAL_BYTES) break;
    const sanitizedProperty = sanitizePropertyKey(rawProperty, context);
    const property = uniquePropertyKey(sanitizedProperty, result, context);
    if (property === null) break;
    if (!consumeBytes(context, Buffer.byteLength(property))) break;
    const item = value[rawProperty];
    const safeUsageMetric = TOKEN_USAGE_KEY.test(property)
      && (item === null || typeof item === 'number');
    const sanitizedItem = SECRET_KEY.test(property) && !safeUsageMetric
      ? REDACTED
      : sanitize(item, context, depth + 1, property);
    defineDataProperty(result, property, sanitizedItem);
  }
  if (Object.keys(result).length < keys.length) {
    const reason = entries.length < keys.length ? 'object-key-limit' : 'global-budget';
    markTruncated(context, reason);
    defineDataProperty(result, '_truncated', truncation(reason, {
      omitted: keys.length - Object.keys(result).length
    }));
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
    defineDataProperty(result, '_sanitization', {
      truncated: true,
      reasons: [...context.reasons].sort()
    });
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

  addEvidenceMetadata(evidence) {
    this.meta = sanitizeTraceValue({
      ...this.meta,
      applicationVersion: evidence?.applicationVersion,
      skillVersions: evidence?.skillVersions,
      metricVersion: evidence?.metricVersion,
      configFingerprint: evidence?.configFingerprint,
      lineageSummary: evidence?.lineageSummary,
      conclusionLineage: (evidence?.conclusions || []).map((item) => ({
        conclusionId: item.conclusion_id,
        formula: item.formula,
        metricIds: item.metricIds,
        evidenceIds: item.evidenceIds,
        pandaCalls: item.pandaCalls,
        confidence: item.confidence
      }))
    });
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
