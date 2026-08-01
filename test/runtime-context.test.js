import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeContextBudgetError,
  compactPandaQueries,
  inspectRuntimeContext
} from '../src/runtime-context.js';

const rows = Array.from({ length: 4 }, (_, index) => ({
  date: `2024010${index + 1}`,
  symbol: `00000${index + 1}.SZ`,
  close: 10 + index
}));

test('Runtime context reports warning and rejects before invocation when required input exceeds 1.5 MB', () => {
  const warning = inspectRuntimeContext('system', '中'.repeat(40), {
    scope: 'runtime-final', maxInputBytes: 128, warnRatio: 0.8
  });
  assert.equal(warning.usage.status, 'warning');
  assert.throws(
    () => inspectRuntimeContext('system', '中'.repeat(100), {
      scope: 'runtime-final', maxInputBytes: 128
    }),
    (error) => error.code === 'MODEL_CONTEXT_BUDGET_EXCEEDED'
  );
});

test('Runtime context reports UTF-8 usage to observers before rejecting', () => {
  const usageRecords = [];

  assert.throws(
    () => inspectRuntimeContext('系统', '中'.repeat(50), {
      scope: 'runtime-build:doubao',
      maxInputBytes: 128,
      onUsage: (usage) => usageRecords.push(usage)
    }),
    RuntimeContextBudgetError
  );

  assert.deepEqual(usageRecords.map((usage) => usage.status), ['exceeded']);
  assert.equal(usageRecords[0].inputBytes, Buffer.byteLength(`系统${'中'.repeat(50)}`));
  assert.equal(usageRecords[0].estimatedTokens, Math.ceil(usageRecords[0].inputBytes / 4));
});

test('Panda compaction keeps complete rows under per-query and aggregate byte budgets', () => {
  const compacted = compactPandaQueries([
    { method: 'get_factor', status: 'ready', result: { rowCount: 4, data: rows } },
    { method: 'get_fina_reports', status: 'ready', result: { rowCount: 4, data: rows } }
  ], { perQueryBytes: 180, totalBytes: 300 });
  assert.ok(Buffer.byteLength(JSON.stringify(compacted.queries[0])) <= 180);
  assert.ok(Buffer.byteLength(JSON.stringify(compacted.queries)) <= 300);
  assert.equal(compacted.queries[0].result.truncated, true);
  assert.equal(
    compacted.queries[0].result.originalRows,
    compacted.queries[0].result.keptRows + compacted.queries[0].result.droppedRows
  );
});

test('Panda compaction keeps result metadata while omitting only complete rows', () => {
  const compacted = compactPandaQueries([{
    method: 'get_factor',
    status: 'ready',
    result: {
      provider: 'pandaai',
      rowCount: 2,
      dataCutoff: '20240131',
      data: [
        { symbol: '000001.SZ', close: 10 },
        { symbol: '000002.SZ', close: 11 }
      ]
    }
  }], { perQueryBytes: 210, totalBytes: 210 });

  const result = compacted.queries[0].result;
  assert.equal(result.provider, 'pandaai');
  assert.equal(result.dataCutoff, '20240131');
  assert.equal(result.originalRows, 2);
  assert.equal(result.keptRows + result.droppedRows, 2);
  assert.ok(result.data.every((row) => typeof row.symbol === 'string'));
});

test('Panda compaction accounts for rows omitted by an already truncated source result', () => {
  const compacted = compactPandaQueries([{
    method: 'get_factor',
    status: 'ready',
    result: {
      rowCount: 1000,
      truncated: true,
      data: Array.from({ length: 500 }, (_, index) => ({ symbol: `${index}` }))
    }
  }]);

  const result = compacted.queries[0].result;
  assert.equal(result.originalRows, 1000);
  assert.equal(result.keptRows, 500);
  assert.equal(result.droppedRows, 500);
  assert.equal(result.truncated, true);
});
