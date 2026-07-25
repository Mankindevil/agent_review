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
  assert.match(app, /item\.resultV2\s*\?\s*renderV2ResultView\(item,\s*\{\s*escapeHtml\s*\}\)\s*:\s*renderLegacyResult\(item\)/);
  assert.doesNotMatch(app, /function renderV2Result\(item\)/);
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
