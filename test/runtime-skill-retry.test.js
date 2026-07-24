import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkill, createSkillBundle, generateValidatedSkill, localCliArgs, localCliEnv, runSkill } from '../src/runtimes.js';
import { runtimeBuildSkillPrompt } from '../src/prompts.js';

test('uses supported read-only Claude Code arguments', () => {
  const args = localCliArgs('claude-code', 'build a skill', { budget: '0.25' });

  assert.deepEqual(args.slice(0, 3), ['-p', 'build a skill', '--system-prompt']);
  assert.equal(typeof args[3], 'string');
  assert.match(args[3], /只输出/);
  assert.deepEqual(args.slice(4), [
    '--output-format', 'json',
    '--tools', '',
    '--permission-mode', 'plan',
    '--safe-mode',
    '--no-session-persistence',
    '--max-turns', '1',
    '--max-budget-usd', '0.25'
  ]);
});

test('uses documented Cursor Agent print arguments', () => {
  assert.deepEqual(localCliArgs('cursor', 'build a skill'), [
    '-p', 'build a skill',
    '--output-format', 'json'
  ]);
});

test('isolates Cursor Agent from host secrets and persistent user directories', () => {
  const workspace = '/tmp/agent-roast-cursor';
  const env = localCliEnv('cursor', workspace, {
    CURSOR_API_KEY: 'cursor-only-key',
    PATH: '/safe/bin',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    DEEPSEEK_API_KEY: 'must-not-leak',
    HOME: '/persistent/home',
    XDG_CONFIG_HOME: '/persistent/config',
    XDG_CACHE_HOME: '/persistent/cache',
    TMPDIR: '/persistent/tmp'
  });

  assert.equal(env.CURSOR_API_KEY, 'cursor-only-key');
  assert.equal(env.PATH, '/safe/bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.HOME, workspace);
  assert.equal(env.USERPROFILE, workspace);
  assert.equal(env.APPDATA, workspace);
  assert.equal(env.LOCALAPPDATA, workspace);
  assert.equal(env.XDG_CONFIG_HOME, workspace);
  assert.equal(env.XDG_CACHE_HOME, workspace);
  assert.equal(env.XDG_DATA_HOME, workspace);
  assert.equal(env.XDG_STATE_HOME, workspace);
  assert.equal(env.TMPDIR, workspace);
  assert.equal(env.TMP, workspace);
  assert.equal(env.TEMP, workspace);
  assert.equal(env.NO_COLOR, '1');
});

test('preserves the Claude Code environment behavior', () => {
  const env = localCliEnv('claude-code', '/tmp/agent-roast-claude', {
    DEEPSEEK_API_KEY: 'available-to-claude',
    HOME: '/persistent/home'
  });

  assert.deepEqual(env, {
    DEEPSEEK_API_KEY: 'available-to-claude',
    HOME: '/persistent/home',
    NO_COLOR: '1'
  });
});

test('materializes a read-only portable folder from normalized runtime output', () => {
  const bundle = createSkillBundle({
    runtime: 'Claude Code', runtimeId: 'claude-code', model: 'test-model', mode: 'live', adapterKind: 'local-cli', seed: 17,
    baselineInput: 'description-only',
    skill: { name: 'contract-review', description: 'Review contracts safely', instructions: ['Read clauses', 'Report evidence'], tools: ['filesystem'] }
  }, 'Review contracts');

  assert.equal(bundle.root, 'contract-review');
  assert.equal(bundle.source, 'normalized-runtime-output');
  assert.equal(bundle.inputPolicy, 'description-only');
  assert.equal(bundle.legacyBaseline, false);
  assert.deepEqual(bundle.files.map((file) => file.path), ['SKILL.md', 'skill.json', 'references/source-description.txt', '.agent-roast/manifest.json']);
  assert.match(bundle.files[0].content, /## 执行流程/);
  assert.match(bundle.files[0].content, /1\. Read clauses/);
  assert.equal(bundle.files[2].content, 'Review contracts');
  assert.equal(JSON.parse(bundle.files[3].content).seed, 17);
  assert.equal(JSON.parse(bundle.files[3].content).inputPolicy, 'description-only');
});

test('marks historical Skill snapshots as an unfair legacy baseline without exposing the Agent Card', () => {
  const bundle = createSkillBundle({
    runtime: 'Claude Code', runtimeId: 'claude-code', mode: 'live',
    skill: { name: 'legacy', description: 'legacy', instructions: ['run'], tools: [] }
  }, 'Only this description may be shown');

  assert.equal(bundle.legacyBaseline, true);
  assert.equal(bundle.inputPolicy, 'legacy-full-card-possible');
  assert.equal(bundle.files.some((file) => file.path === 'references/agent-card.json'), false);
  assert.equal(bundle.files.find((file) => file.path === 'references/source-description.txt').content, 'Only this description may be shown');
  assert.match(bundle.files.find((file) => file.path === 'references/legacy-input-warning.txt').content, /不能作为公平基线/);
});

test('the reconstruction prompt contains only the supplied description, not other Agent Card fields', async () => {
  const card = {
    name: 'SECRET_NAME_SENTINEL',
    description: 'Review production incidents.',
    skills: [{ name: 'SECRET_SKILL_SENTINEL' }],
    capabilities: { secret: 'SECRET_CAPABILITY_SENTINEL' },
    url: 'https://secret-endpoint.invalid'
  };
  const prompt = runtimeBuildSkillPrompt(card.description);

  assert.match(prompt, /Review production incidents\./);
  assert.doesNotMatch(prompt, /SECRET_NAME_SENTINEL|SECRET_SKILL_SENTINEL|SECRET_CAPABILITY_SENTINEL|secret-endpoint/);
  await assert.rejects(
    buildSkill({ id: 'cursor', name: 'Cursor Agent', model: 'Auto' }, card, 'demo'),
    /缺少非空 description/
  );
});

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
    const build = await buildSkill(runtime, 'Description', 'live', { seed: 17, temperature: 0 });
    assert.equal(build.runtime, 'Cursor Agent');
    assert.equal(build.runtimeId, 'cursor');
    assert.equal(build.mode, 'live');
    assert.equal(build.adapterKind, 'remote-http');
    assert.equal(build.baselineInput, 'description-only');
    assert.equal(build.skill.name, 'remote');
    assert.equal(await runSkill(build, { prompt: 'same prompt' }, 'live', { seed: 18 }), 'visible result');
    assert.equal(requests[0].headers.authorization, 'Bearer test-only');
    assert.deepEqual(requests[0].body, { action: 'build_skill', description: 'Description', inputPolicy: 'description-only', seed: 17, temperature: 0 });
    assert.equal('agentCard' in requests[0].body, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAdapters === undefined) delete process.env.RUNTIME_ADAPTERS_JSON; else process.env.RUNTIME_ADAPTERS_JSON = originalAdapters;
    if (originalKey === undefined) delete process.env.RUNTIME_TEST_KEY; else process.env.RUNTIME_TEST_KEY = originalKey;
  }
});
