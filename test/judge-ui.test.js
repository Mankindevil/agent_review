import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const requiredIds = [
  'replica-seal-notice',
  'queue-status',
  'queue-list',
  'queue-card-template',
  'queue-leaf-template'
];

test('open review desk exposes the public queue controls and safety copy without a token gate', async () => {
  const [html, script, css, index] = await Promise.all([
    readFile(new URL('../public/judge.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/judge.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/judge.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  ]);

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }

  assert.doesNotMatch(html, /judge-access-form|assignment-list|human-score-form/);
  assert.match(html, /模型先评/u);
  assert.match(html, /复刻结果.*绝对分锁定.*密封/u);
  assert.match(index, /href="\/judge.html"/);
  assert.match(script, /\/api\/review-queue/);
  assert.match(script, /\/skip-human-review/);
  assert.match(script, /\/human-reviews/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(`${html}\n${script}`, /localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML/);
});

test('open review desk lets anyone skip or submit a single human review without an assignment', async () => {
  const script = await readFile(new URL('../public/judge.js', import.meta.url), 'utf8');

  assert.match(script, /function renderQueue/);
  assert.match(script, /function renderCard/);
  assert.match(script, /function applicableLeaves/);
  assert.match(script, /function skipHumanReview/);
  assert.match(script, /function submitHumanReview/);
  assert.match(script, /idempotency-key/);
  assert.match(script, /modelDisposition/);
  assert.match(script, /overturn/);
});
