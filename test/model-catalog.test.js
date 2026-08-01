import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDisplayName, ARK_MODELS } from '../src/model-catalog.js';
import { reviewAgent } from '../src/providers.js';

test('maps supported Ark endpoint IDs to stable user-facing model names', () => {
  assert.deepEqual(ARK_MODELS.doubao, [
    { name: 'Doubao-Seed-2-Pro', id: 'ep-20260722093003-7swj9' },
    { name: 'Doubao-Seed-2.1-pro', id: 'ep-20260720110725-5rbml' },
    { name: 'Doubao-Seed-2.0-lite', id: 'ep-20260723165418-pqgfr' }
  ]);
  assert.deepEqual(ARK_MODELS.deepseek, [
    { name: 'DeepSeek-V4-Pro', id: 'ep-20260708162855-pcf9x' },
    { name: 'DeepSeek-V4-flash', id: 'ep-20260609142502-bmrkt' }
  ]);
  assert.equal(modelDisplayName('ep-20260720110725-5rbml'), 'Doubao-Seed-2.1-pro');
  assert.equal(modelDisplayName('ep-20260708162855-pcf9x'), 'DeepSeek-V4-Pro');
  assert.equal(modelDisplayName('claude-sonnet-4-6'), 'Claude Sonnet 4.6');
  assert.equal(modelDisplayName('custom-model'), 'custom-model');
});

test('publishes a friendly model name in Agent Card reviews while retaining the endpoint ID', async () => {
  const endpoint = 'ep-20260720110725-5rbml';
  const review = await reviewAgent(
    { id: 'doubao', name: '豆包评审', model: endpoint, kind: 'mock' },
    { name: 'Card', description: '因子研究 Agent', skills: [] },
    { score: 70 },
    'demo'
  );
  assert.equal(review.model, 'Doubao-Seed-2.1-pro');
  assert.equal(review.modelId, endpoint);
});
