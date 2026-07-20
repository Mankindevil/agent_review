import test from 'node:test';
import assert from 'node:assert/strict';
import { generateValidatedSkill } from '../src/runtimes.js';

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
