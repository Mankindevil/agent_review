import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const requiredIds = [
  'replica-seal-notice',
  'queue-status',
  'queue-list',
  'queue-card-template',
  'queue-leaf-template',
  'queue-replica-card-template',
  'queue-replica-source-template'
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
  assert.match(html, /双轨终审结算前保持密封/u);
  assert.match(html, /TRACK \/ 绝对分/u);
  assert.match(html, /TRACK \/ 复刻/u);
  assert.doesNotMatch(index, /href="\/judge.html"/);
  assert.doesNotMatch(index, /href="\/appeal.html"/);
  assert.match(script, /\/api\/review-queue/);
  assert.match(script, /\/skip-human-review/);
  assert.match(script, /\/human-reviews/);
  assert.match(script, /\/replica-human-reviews/);
  assert.match(script, /\/replica-human-reviews\/lock/);
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

test('open review desk lists both absolute and replica tracks from the review queue', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/judge.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/judge.js', import.meta.url), 'utf8')
  ]);

  assert.match(script, /function renderReplicaCard/);
  assert.match(script, /function submitReplicaReview/);
  assert.match(script, /replicaHumanReview\?\.trackPhase === 'open'/);
  assert.match(script, /governance\?\.phase === 'human_open'/);
  assert.match(script, /\/replica-human-reviews\/lock/);
  for (const dim of ['taskConstraint', 'professionalQuality', 'evidenceRisk', 'artifactUsability']) {
    assert.match(html, new RegExp(`data-dim="${dim}"`), dim);
  }
});

test('open review desk renders absolute and replica review dossiers from the queue payload', async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL('../public/judge.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/judge.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/judge.css', import.meta.url), 'utf8')
  ]);

  assert.match(html, /data-role="absolute-dossier"/);
  assert.match(html, /data-role="replica-dossier"/);
  assert.match(html, /novalidate/);
  assert.match(script, /function renderAbsoluteDossier/);
  assert.match(script, /function renderReplicaDossier/);
  assert.match(script, /reviewDossier/);
  assert.match(script, /模型对照/);
  assert.match(script, /同题对照/);
  assert.match(script, /请先填齐全部/);
  assert.match(script, /锁定失败/);
  assert.match(script, /finalizePending/);
  assert.match(css, /\.review-dossier/);
  const replicaFormIdx = html.indexOf('data-role="replica-score-form"');
  const replicaDossierIdx = html.indexOf('data-role="replica-dossier"');
  assert.ok(replicaFormIdx > 0 && replicaDossierIdx > replicaFormIdx, 'score form should sit above dossier');
});
