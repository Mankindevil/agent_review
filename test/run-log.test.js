import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectEvaluation } from '../src/evaluation-projection.js';
import { createEvaluationRecord } from '../src/evaluation-model.js';
import {
  appendRunLogFile,
  applyActiveWork,
  applyRunLog,
  createRunLogEntry,
  runLogFilePath,
  sanitizeLogText
} from '../src/run-log.js';

test('creates bounded run-log entries and activeWork without mutating history length on wait ticks', () => {
  let record = {
    runLog: [],
    activeWork: null
  };
  const first = createRunLogEntry({
    id: 'log_1',
    at: '2026-07-25T12:00:00.000Z',
    level: 'info',
    source: 'A2A',
    phase: 'qualification',
    text: '资格验证 attempt 1/3',
    refs: { attempt: 1, runId: 'run_q1' }
  });
  record = applyRunLog(record, first);
  record = applyActiveWork(record, {
    key: 'qualification:1',
    phase: 'qualification',
    label: '等待 Agent 资格验证 · 1/3',
    startedAt: '2026-07-25T12:00:00.000Z',
    kind: 'call',
    index: 1,
    total: 3
  });
  assert.equal(record.runLog.length, 1);
  assert.equal(record.activeWork.key, 'qualification:1');

  // Gemini-style wait: only startedAt/label stay in activeWork; no new runLog rows.
  record = applyActiveWork(record, {
    ...record.activeWork,
    label: '等待 Agent 资格验证 · 1/3'
  });
  assert.equal(record.runLog.length, 1);

  const done = createRunLogEntry({
    id: 'log_2',
    at: '2026-07-25T12:00:12.000Z',
    level: 'success',
    source: 'A2A',
    phase: 'qualification',
    text: '资格验证通过',
    durationMs: 12000
  });
  record = applyRunLog(record, done);
  record = applyActiveWork(record, null);
  assert.equal(record.runLog.length, 2);
  assert.equal(record.activeWork, null);
});

test('sanitizes secrets and endpoint URLs from public log text', () => {
  const text = sanitizeLogText(
    'Bearer super-secret-token https://agent.example.com/a2a/v1 failed',
    ['super-secret-token']
  );
  assert.equal(text.includes('super-secret-token'), false);
  assert.match(text, /Bearer \[redacted\]/);
  assert.match(text, /agent\.example\.com\/\[redacted-path\]/);
});

test('public projection exposes redacted runLog and activeWork only', () => {
  const record = createEvaluationRecord({
    agentCard: { value: {} },
    agentExamples: { value: [] },
    config: {}
  }, {
    id: 'eval_log',
    createdAt: '2026-07-25T12:00:00.000Z',
    participantAccess: {},
    authorizationRequired: false,
    endpointHash: 'e'.repeat(64),
    runIndex: []
  });
  record.runLog = [
    createRunLogEntry({
      id: 'log_1',
      at: '2026-07-25T12:00:01.000Z',
      level: 'info',
      source: 'A2A',
      phase: 'qualification',
      text: '资格验证 attempt 1/3',
      detail: 'Bearer leaked-token https://secret.example/path',
      refs: { attempt: 1, runId: 'run_1', hidden: 'drop-me' }
    })
  ];
  record.activeWork = {
    key: 'qualification:1',
    phase: 'qualification',
    label: '等待 Agent',
    detail: 'Bearer leaked-token',
    startedAt: '2026-07-25T12:00:01.000Z',
    kind: 'call',
    index: 1,
    total: 3
  };

  const projection = projectEvaluation(record, {
    audience: 'public',
    secrets: ['leaked-token']
  });
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes('leaked-token'), false);
  assert.equal(projection.runLog.length, 1);
  assert.equal(projection.runLog[0].refs.attempt, 1);
  assert.equal(projection.runLog[0].refs.hidden, undefined);
  assert.equal(projection.activeWork.label, '等待 Agent');
  assert.match(projection.activeWork.detail, /SECRET_REDACTED|\[redacted\]/i);
});

test('appends local ndjson diagnostics without throwing on nested dirs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runlogs-'));
  try {
    const filePath = runLogFilePath(root, 'eval_file');
    await appendRunLogFile(filePath, {
      id: 'log_1',
      evaluationId: 'eval_file',
      text: 'hello',
      internalDetail: 'stack-line'
    });
    const body = await readFile(filePath, 'utf8');
    const row = JSON.parse(body.trim());
    assert.equal(row.evaluationId, 'eval_file');
    assert.equal(row.internalDetail, 'stack-line');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
