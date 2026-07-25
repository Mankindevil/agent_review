import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const RUN_LOG_STORE_LIMIT = 500;
export const RUN_LOG_PUBLIC_LIMIT = 200;

export function createRunLogEntry(fields = {}) {
  const entry = {
    id: String(fields.id || ''),
    at: String(fields.at || ''),
    level: normalizeLevel(fields.level),
    source: String(fields.source || 'PIPELINE'),
    phase: String(fields.phase || 'pipeline'),
    text: String(fields.text || '')
  };
  if (fields.detail != null && fields.detail !== '') {
    entry.detail = String(fields.detail);
  }
  if (Number.isFinite(fields.durationMs)) {
    entry.durationMs = Math.max(0, Math.round(fields.durationMs));
  }
  if (fields.refs && typeof fields.refs === 'object' && !Array.isArray(fields.refs)) {
    entry.refs = sanitizeRefs(fields.refs);
  }
  return entry;
}

export function applyRunLog(record, entry, { limit = RUN_LOG_STORE_LIMIT } = {}) {
  const runLog = Array.isArray(record?.runLog) ? record.runLog : [];
  return {
    ...record,
    runLog: [...runLog, entry].slice(-limit)
  };
}

export function applyActiveWork(record, work) {
  return {
    ...record,
    activeWork: work == null ? null : freezeActiveWork(work)
  };
}

export function sanitizeLogText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) {
    if (typeof secret !== 'string' || !secret) continue;
    text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}/[redacted-path]`;
    } catch {
      return '[redacted-url]';
    }
  });
  return text.slice(0, 500);
}

export function runLogFilePath(root, evaluationId) {
  return path.join(root, `${evaluationId}.ndjson`);
}

export async function appendRunLogFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function normalizeLevel(level) {
  return ['info', 'warn', 'error', 'success'].includes(level) ? level : 'info';
}

function sanitizeRefs(refs) {
  const out = {};
  for (const key of [
    'attempt', 'runId', 'testId', 'turnIndex', 'repeatIndex', 'runtimeId', 'judgeId'
  ]) {
    if (!Object.hasOwn(refs, key)) continue;
    const value = refs[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function freezeActiveWork(work) {
  return {
    key: String(work.key || 'work'),
    phase: String(work.phase || 'pipeline'),
    label: String(work.label || '正在处理'),
    startedAt: String(work.startedAt || ''),
    kind: String(work.kind || 'wait'),
    ...(work.detail != null && work.detail !== '' ? { detail: String(work.detail) } : {}),
    ...(Number.isInteger(work.index) ? { index: work.index } : {}),
    ...(Number.isInteger(work.total) ? { total: work.total } : {})
  };
}
