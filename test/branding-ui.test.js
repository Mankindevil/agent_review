import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

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
