import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSeed, normalizeSeed, normalizeTemperature, safeJson } from '../src/utils.js';

test('normalizes and derives deterministic evaluation seeds', () => {
  assert.equal(normalizeSeed('20260720'), 20260720);
  assert.equal(normalizeSeed(''), 20260720);
  assert.equal(normalizeSeed('named-seed'), normalizeSeed('named-seed'));
  assert.equal(deriveSeed(42, 'review:gpt'), deriveSeed(42, 'review:gpt'));
  assert.notEqual(deriveSeed(42, 'review:gpt'), deriveSeed(42, 'review:claude'));
  assert.equal(normalizeTemperature('0'), 0);
  assert.equal(normalizeTemperature('9'), 2);
});

test('parses plain and fenced JSON model output', () => {
  assert.deepEqual(safeJson('{"name":"plain"}'), { name: 'plain' });
  assert.deepEqual(safeJson('```json\n{"name":"fenced"}\n```'), { name: 'fenced' });
});

test('extracts balanced JSON when a CLI adds Chinese prose', () => {
  const claudeStyle = '我来分析这个 A2A Agent。\n```json\n{"name":"合同审查","description":"审查合同","instructions":["读取","判断"],"tools":[]}\n```\n以上是复刻结果。';
  const cursorStyle = '先查看 Skill 要求。\n{"name":"review","description":"Review {evidence}","instructions":["保留 \\"原文\\""],"tools":["filesystem"]}\n处理完成。';
  assert.equal(safeJson(claudeStyle).name, '合同审查');
  assert.deepEqual(safeJson(cursorStyle).instructions, ['保留 "原文"']);
});

test('reports a stable error when no JSON value exists', () => {
  assert.throws(() => safeJson('只有说明，没有结构化结果'), /未找到合法 JSON/);
});

test('prefers the largest balanced JSON object and can require root keys', () => {
  const prose = 'note {"taskCompleted":"partial"} then {"reviews":[{"subcriterionId":"a"}],"meta":1} done';
  assert.deepEqual(safeJson(prose), {
    reviews: [{ subcriterionId: 'a' }],
    meta: 1
  });

  const truncated =
    '{"reviews":[{"subcriterionId":"a","score":1,"conclusions":{"taskCompleted":"partial","criticalRisk":"no"}},{"subcriterionId":"b","conclusions":{"taskCompleted":"no"';
  assert.throws(
    () => safeJson(truncated, { requiredKeys: ['reviews'] }),
    /reviews|未找到合法 JSON/u
  );
});
