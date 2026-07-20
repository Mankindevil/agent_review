import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkill, generateValidatedSkill, runSkill } from '../src/runtimes.js';

test('retries once when a runtime returns truncated or invalid Skill JSON', async () => {
  const prompts = [];
  const outputs = [
    { text: '{' },
    { text: '{"name":"contract-review","description":"review contracts","instructions":["read","report"],"tools":[]}', trace: { run: 2 } }
  ];
  const result = await generateValidatedSkill(async (prompt) => {
    prompts.push(prompt);
    return outputs.shift();
  }, 'build a skill');

  assert.equal(result.skill.name, 'contract-review');
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.result.trace, { run: 2 });
  assert.match(prompts[1], /上一次返回的内容不是完整、合法的 Skill JSON/);
});

test('does not retry a valid Skill response', async () => {
  let calls = 0;
  const result = await generateValidatedSkill(async () => {
    calls += 1;
    return { text: '```json\n{"name":"ok","description":"valid","instructions":["run"],"tools":[]}\n```' };
  }, 'build a skill');

  assert.equal(result.skill.name, 'ok');
  assert.equal(calls, 1);
});

test('normalizes remote runtime adapter responses to the platform contract', async () => {
  const originalFetch = globalThis.fetch;
  const originalAdapters = process.env.RUNTIME_ADAPTERS_JSON;
  const originalKey = process.env.RUNTIME_TEST_KEY;
  const requests = [];
  process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({ cursor: { url: 'https://runtime.example/cursor', apiKeyEnv: 'RUNTIME_TEST_KEY' } });
  process.env.RUNTIME_TEST_KEY = 'test-only';
  globalThis.fetch = async (_url, options) => {
    requests.push({ headers: options.headers, body: JSON.parse(options.body) });
    if (requests.at(-1).body.action === 'build_skill') {
      return new Response(JSON.stringify({ runtime: 'spoofed', mode: 'demo', model: 'Remote Model', skill: { name: 'remote', description: 'remote skill', instructions: ['run'], tools: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ output: 'visible result' }), { status: 200 });
  };
  try {
    const runtime = { id: 'cursor', name: 'Cursor Agent', model: 'Auto' };
    const build = await buildSkill(runtime, { name: 'Agent', description: 'Description', skills: [] }, 'live', { seed: 17, temperature: 0 });
    assert.equal(build.runtime, 'Cursor Agent');
    assert.equal(build.runtimeId, 'cursor');
    assert.equal(build.mode, 'live');
    assert.equal(build.adapterKind, 'remote-http');
    assert.equal(build.skill.name, 'remote');
    assert.equal(await runSkill(build, { prompt: 'same prompt' }, 'live', { seed: 18 }), 'visible result');
    assert.equal(requests[0].headers.authorization, 'Bearer test-only');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAdapters === undefined) delete process.env.RUNTIME_ADAPTERS_JSON; else process.env.RUNTIME_ADAPTERS_JSON = originalAdapters;
    if (originalKey === undefined) delete process.env.RUNTIME_TEST_KEY; else process.env.RUNTIME_TEST_KEY = originalKey;
  }
});
