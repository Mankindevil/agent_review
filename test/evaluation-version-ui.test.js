import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('offers shareable V1 and V2 homepage links with accessible copy', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('public/index.html', root), 'utf8'),
    readFile(new URL('public/styles.css', root), 'utf8')
  ]);
  assert.match(html, /<nav[^>]*class="evaluation-version-switch"[^>]*aria-label="评测版本"/);
  assert.match(html, /href="\/\?version=v1"[^>]*data-evaluation-version="v1"/);
  assert.match(html, /href="\/\?version=v2"[^>]*data-evaluation-version="v2"/);
  assert.match(html, />V1 经典评测</);
  assert.match(html, />V2 证据评测</);
  assert.match(css, /\.evaluation-version-switch\s*\{/);
  assert.match(css, /\.evaluation-version-switch a\[aria-current="page"\]/);
  assert.match(css, /@media \(max-width: 700px\)/);
});

test('dispatches and renders from selected version instead of capability alone', async () => {
  const script = await readFile(new URL('public/app.js', root), 'utf8');
  assert.match(script, /requestedEvaluationVersion\(location\.search\)/);
  assert.match(script, /resolveEvaluationVersion\(requestedVersion,\s*mode\.enabled\)/);
  assert.match(script, /state\.selectedVersion === 'v2'/);
  assert.match(script, /data-evaluation-version/);
  assert.match(script, /setAttribute\('aria-current', 'page'\)/);
  assert.match(script, /V2 证据评测当前未启用/);
  assert.doesNotMatch(script, /if \(state\.blackBoxEnabled\) return submitV2Evaluation/);
});
