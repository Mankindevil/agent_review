import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const requiredIds = [
  'judge-access-form',
  'assignment-list',
  'submission-panel',
  'test-filter',
  'evidence-timeline',
  'model-opinions',
  'disagreement-summary',
  'human-score-form',
  'draft-status',
  'submit-review',
  'recuse-review',
  'replica-seal-notice'
];

test('judge workbench exposes the governed review controls and safety copy', async () => {
  const [html, script, css, index] = await Promise.all([
    readFile(new URL('../public/judge.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/judge.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/judge.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  ]);

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }

  assert.match(html, /模型先评/u);
  assert.match(html, /人工不盲审/u);
  assert.match(html, />\s*15\s*分|大于\s*15\s*分/u);
  assert.match(html, /复刻结果.*绝对分锁定.*密封/u);
  assert.match(index, /href="\/judge.html"/);
  assert.match(script, /If-Match/);
  assert.match(script, /pagehide/);
  assert.match(script, /pageshow/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(`${html}\n${script}`, /localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML/);
});

test('judge workbench renders complete non-blind review inputs and reloads draft conflicts', async () => {
  const script = await readFile(new URL('../public/judge.js', import.meta.url), 'utf8');

  assert.match(script, /examples\.forEach/);
  assert.match(script, /example\.name/);
  assert.match(script, /testType/);
  assert.match(script, /primary\.map/);
  assert.match(script, /reviewRunId/);
  assert.match(script, /arbitration/);
  assert.match(script, /counterEvidence/);
  assert.match(script, /response\.status === 409/);
  assert.match(script, /草稿版本冲突/);
  assert.match(script, /addEventListener\('click', loadAssignment\)/);
});
