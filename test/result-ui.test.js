import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('publishes the ordered evidence-led dual-track result surface', async () => {
  const [renderer, evidencePage, evidenceScript, evidenceStyle, app] = await Promise.all([
    readFile(new URL('public/result-v2.js', root), 'utf8'),
    readFile(new URL('public/evidence.html', root), 'utf8'),
    readFile(new URL('public/evidence.js', root), 'utf8'),
    readFile(new URL('public/evidence.css', root), 'utf8'),
    readFile(new URL('public/app.js', root), 'utf8')
  ]);

  for (const section of [
    'absolute-total',
    'rating-status',
    'replica-advantage',
    'capability-declared-observed',
    'test-matrix',
    'findings-and-humor',
    'human-opinions',
    'evidence-gaps'
  ]) {
    assert.match(renderer, new RegExp(`data-result-section="${section}"`), section);
  }
  assert.match(renderer, /三维绝对分：Agent 本身做得怎么样/);
  assert.match(renderer, /复刻优势：是否胜过五分钟临时 Skill/);
  assert.match(renderer, /Replica results never enter the absolute total/);
  assert.match(renderer, /差异未稳定/);
  assert.match(renderer, /待复刻/);
  assert.match(renderer, /same-track only/);
  assert.match(app, /function renderResult\(item\)/);
  assert.match(app, /item\.schemaVersion === 2/);
  assert.match(
    app,
    /#result-content[\s\S]*?innerHTML\s*=\s*renderV2ResultView\(item,\s*\{\s*escapeHtml\s*\}\)/
  );
  assert.match(app, /renderLegacyResult\(item\)/);
  assert.doesNotMatch(app, /function renderV2Result\(item\)/);
  assert.doesNotMatch(app, /if \(!item\.resultV2\) return renderLegacyResult/);
  assert.match(renderer, /data-result-section="v2-live-progress"/);
  assert.match(renderer, /证据链采集进行中/);
  assert.doesNotMatch(renderer, /0 \/ 4 组已出/);
  assert.match(renderer, /absoluteReview\?\.modelPanel/);
  assert.match(renderer, /item\.resultV2\?\.humor/);
  assert.match(renderer, /item\.humanReviewAggregate/);
  assert.match(renderer, /replica\.runtimes/);
  assert.match(renderer, /Δc/);

  for (const id of [
    'evidence-filter-test-type',
    'evidence-filter-test-id',
    'evidence-filter-repeat',
    'evidence-filter-turn',
    'evidence-filter-grade',
    'evidence-filter-kind',
    'evidence-list',
    'evidence-detail'
  ]) {
    assert.match(evidencePage, new RegExp(`id="${id}"`), id);
  }
  assert.match(evidenceScript, /evidence-manifest/);
  assert.match(evidenceScript, /URLSearchParams/);
  assert.match(evidenceScript, /authorization/);
  assert.match(evidenceScript, /textContent/);
  assert.doesNotMatch(evidenceScript, /innerHTML/);
  assert.match(evidenceStyle, /prefers-reduced-motion/);
});

test('surfaces dual-track progress, replica-human hand-off, and finalize control', async () => {
  const [renderer, app, indexHtml, styles, projection] = await Promise.all([
    readFile(new URL('public/result-v2.js', root), 'utf8'),
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('public/index.html', root), 'utf8'),
    readFile(new URL('public/styles.css', root), 'utf8'),
    readFile(new URL('src/evaluation-projection.js', root), 'utf8')
  ]);

  assert.match(renderer, /trackStatus\.subStatusLabel/);
  assert.match(renderer, /进行中/);
  assert.match(projection, /等双轨/);
  assert.match(projection, /等绝对分/);
  assert.match(projection, /等复刻人工/);
  assert.match(renderer, /function renderFinalizePanel/);
  assert.match(renderer, /data-finalize-dual-track="/);
  assert.match(renderer, /trackStatus\.canFinalize/);
  assert.match(renderer, /function replicaTrackCopy/);
  assert.match(renderer, /replicaHumanReview\?\.trackPhase/);
  assert.match(renderer, /前往复刻人工评审台/);

  assert.match(app, /data-finalize-dual-track/);
  assert.match(app, /finalize-dual-track/);
  assert.match(app, /function collectReplicaReviewPolicy/);
  assert.match(app, /function applyReplicaReviewPolicy/);
  assert.match(app, /replica-review-policy/);
  assert.match(app, /skip-human-review/);
  assert.match(app, /skipHumanReview/);

  assert.match(indexHtml, /id="skip-human-review"/);
  assert.match(indexHtml, /id="replica-policy-visibility"/);
  assert.match(indexHtml, /id="replica-policy-required-primaries"/);
  assert.match(indexHtml, /id="replica-policy-force-separate-judges"/);
  assert.match(styles, /\.replica-policy-panel/);
});
