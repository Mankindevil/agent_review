export const ARK_MODELS = deepFreeze({
  doubao: [
    { name: 'Doubao-Seed-2-Pro', id: 'ep-20260722093003-7swj9' },
    { name: 'Doubao-Seed-2.1-pro', id: 'ep-20260720110725-5rbml' },
    { name: 'Doubao-Seed-2.0-lite', id: 'ep-20260723165418-pqgfr' }
  ],
  deepseek: [
    { name: 'DeepSeek-V4-Pro', id: 'ep-20260708162855-pcf9x' },
    { name: 'DeepSeek-V4-flash', id: 'ep-20260609142502-bmrkt' }
  ]
});

const MODEL_NAMES = new Map([
  ...Object.values(ARK_MODELS).flat().map(({ id, name }) => [id, name]),
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
  ['cs4.6', 'Claude Sonnet 4.6'],
  ['Claude Sonnet', 'Claude Sonnet 4.6'],
  ['Doubao Seed', 'Doubao-Seed-2.1-pro'],
  ['Seed', 'Doubao-Seed-2.1-pro'],
  ['DeepSeek', 'DeepSeek-V4-Pro']
]);

export function modelDisplayName(modelId) {
  const value = typeof modelId === 'string' ? modelId.trim() : '';
  return MODEL_NAMES.get(value) || value;
}

export const arkModelDisplayName = modelDisplayName;

export function publicModelFields(modelId) {
  const model = modelDisplayName(modelId);
  return model && model !== modelId ? { model, modelId } : { model };
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}
