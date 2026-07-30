import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pages = [
  'public/index.html',
  'public/methodology.html',
  'public/judge.html',
  'public/agent-check.html',
  'public/appeal.html',
  'public/evidence.html'
];

test('publishes local PandaAI brand assets with the official mark geometry', async () => {
  const [mark, logo, favicon] = await Promise.all([
    readFile(new URL('public/assets/pandaai-mark.svg', root), 'utf8'),
    readFile(new URL('public/assets/pandaai-logo.svg', root), 'utf8'),
    readFile(new URL('public/favicon.svg', root), 'utf8')
  ]);

  for (const asset of [mark, logo, favicon]) {
    assert.match(asset, /viewBox="0 0 195 206"|viewBox="0 0 148 27"/);
    assert.match(asset, /m96\.07,94\.87/);
    assert.match(asset, /m91\.21,4\.05/);
    assert.match(asset, /m100\.02,45\.14/);
  }
  assert.match(logo, />PandaAI</);
  assert.doesNotMatch(`${mark}\n${logo}\n${favicon}`, /(?:href|src)="https?:\/\//);
});

test('brands every primary page as Panda AI锐评局 with local assets', async () => {
  for (const page of pages) {
    const html = await readFile(new URL(page, root), 'utf8');
    assert.match(html, /<title>[^<]*Panda AI锐评局[^<]*<\/title>/, page);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, page);
    assert.match(html, /aria-label="Panda AI锐评局首页"/, page);
    assert.match(html, /src="\/assets\/pandaai-logo\.svg"/, page);
    assert.match(html, /srcset="\/assets\/pandaai-mark\.svg"/, page);
    assert.match(html, />锐评局</, page);
    assert.doesNotMatch(html, /class="brand-mark">锐</, page);
  }
});

test('reserves separate mobile header rows for the brand and navigation', async () => {
  const styles = await readFile(new URL('public/styles.css', root), 'utf8');

  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.site-header \{[^}]*display:grid;[^}]*grid-template-rows:38px 38px;/
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.site-header nav \{[^}]*grid-column:1\/-1;[^}]*grid-row:2;/
  );
});
