import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { buildSkill, createSkillBundle, generateValidatedSkill, localCliArgs, localCliEnv, localRuntimeTimeout, probeRuntimeReadiness, runSkill, withRuntimeWorkspace } from '../src/runtimes.js';
import { prepareRuntimeWorkspace } from '../src/runtime-sandbox.js';
import { runtimeBuildSkillPrompt } from '../src/prompts.js';
import { applyArkClaudeEnv } from '../src/claude-env.js';

const runtimeProcessModule = await import('../src/runtime-process.js').catch(() => ({}));

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
    '--output-format', 'json',
    '--trust',
    '--force'
  ]);
  assert.deepEqual(localCliArgs('cursor', 'READY', { readiness: true }), [
    '-p', 'READY',
    '--output-format', 'text',
    '--trust',
    '--force'
  ]);
});

test('uses an unambiguous exact-token prompt for local readiness', async () => {
  let receivedPrompt;
  let receivedSampling;
  const ready = await probeRuntimeReadiness('claude-code', {
    source: 'local',
    kind: 'local-cli',
    command: 'claude'
  }, {
    env: { RUNTIME_PROBE_TIMEOUT_MS: '1000' },
    localCall: async (_runtimeId, prompt, _signal, sampling) => {
      receivedPrompt = prompt;
      receivedSampling = sampling;
      return { text: 'READY' };
    }
  });

  assert.equal(ready, true);
  assert.equal(receivedSampling?.readiness, true);
  assert.equal(
    receivedPrompt,
    'Output exactly the five ASCII letters READY with no punctuation or other text.'
  );
});

test('writes deny-by-default Cursor permissions only inside the temporary workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-sandbox-'));
  try {
    await prepareRuntimeWorkspace('cursor', root, {
      cursorAuthConfigHome: '/var/lib/agent-review/cursor-auth'
    });
    const payload = JSON.parse(await readFile(path.join(root, '.cursor', 'cli.json'), 'utf8'));
    assert.deepEqual(payload.permissions.allow, []);
    assert.ok(payload.permissions.deny.includes('Shell(*)'));
    assert.ok(payload.permissions.deny.includes('Write(**)'));
    assert.ok(payload.permissions.deny.includes('Read(**)'));
    assert.ok(payload.permissions.deny.includes('Read(**/.env*)'));
    assert.ok(payload.permissions.deny.includes('Read(**/*.key)'));
    for (const rule of [
      'WebFetch(*)', 'WebSearch(*)', 'Mcp(*)',
      'Read(/**)', 'Write(/**)',
      'Read(/proc/**)', 'Read(/run/**)', 'Read(/tmp/**)',
      'Read(/sys/**)', 'Read(/dev/**)',
      'Read(/var/lib/agent-review/cursor-auth/**)'
    ]) {
      assert.ok(payload.permissions.deny.includes(rule), `missing absolute deny rule ${rule}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleans the temporary workspace when Cursor sandbox preparation fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-sandbox-failure-'));
  let removed = false;

  await assert.rejects(
    withRuntimeWorkspace('cursor', async () => assert.fail('runtime must not start'), {
      createWorkspace: async () => root,
      prepareWorkspace: async () => { throw new Error('sandbox initialization failed'); },
      removeWorkspace: async (workspace, options) => {
        removed = true;
        assert.equal(workspace, root);
        await rm(workspace, options);
      }
    }),
    /sandbox initialization failed/
  );

  assert.equal(removed, true);
  await assert.rejects(access(root), { code: 'ENOENT' });
});

test('cleans the temporary workspace when Cursor runtime startup fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-startup-failure-'));

  await assert.rejects(
    withRuntimeWorkspace('cursor', async () => { throw new Error('cursor startup failed'); }, {
      createWorkspace: async () => root
    }),
    /cursor startup failed/
  );

  await assert.rejects(access(root), { code: 'ENOENT' });
});

test('isolates Cursor Agent from host secrets and persistent user directories', () => {
  const workspace = '/tmp/agent-roast-cursor';
  const authConfigHome = '/var/lib/agent-review/cursor-auth';
  const sessionConfigHome = '/tmp/agent-roast-cursor/cursor-xdg-session';
  const env = localCliEnv('cursor', workspace, {
    CURSOR_AUTH_CONFIG_HOME: authConfigHome,
    CURSOR_API_KEY: 'must-not-leak',
    PATH: '/safe/bin',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    DEEPSEEK_API_KEY: 'must-not-leak',
    HOME: '/persistent/home',
    XDG_CONFIG_HOME: '/persistent/config',
    XDG_CACHE_HOME: '/persistent/cache',
    TMPDIR: '/persistent/tmp'
  }, { cursorConfigHome: sessionConfigHome });

  assert.equal(env.CURSOR_API_KEY, undefined);
  assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, 'file');
  assert.equal(env.PATH, '/safe/bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.HOME, workspace);
  assert.equal(env.USERPROFILE, workspace);
  // Windows Cursor CLI reads %APPDATA%\Cursor\auth.json, so APPDATA must follow
  // the durable/session auth home when one is supplied.
  assert.equal(
    env.APPDATA,
    process.platform === 'win32' ? sessionConfigHome : workspace
  );
  assert.equal(env.LOCALAPPDATA, workspace);
  assert.equal(env.XDG_CONFIG_HOME, sessionConfigHome);
  assert.notEqual(env.XDG_CONFIG_HOME, authConfigHome);
  assert.equal(env.XDG_CACHE_HOME, workspace);
  assert.equal(env.XDG_DATA_HOME, workspace);
  assert.equal(env.XDG_STATE_HOME, workspace);
  assert.equal(env.TMPDIR, workspace);
  assert.equal(env.TMP, workspace);
  assert.equal(env.TEMP, workspace);
  assert.equal(env.NO_COLOR, '1');

  const envWithoutSessionConfigHome = localCliEnv('cursor', workspace, {
    CURSOR_AUTH_CONFIG_HOME: authConfigHome,
    PATH: '/safe/bin'
  });
  assert.equal(envWithoutSessionConfigHome.XDG_CONFIG_HOME, workspace);
});

test('terminates the whole Linux CLI process group with TERM then KILL at the hard timeout', async () => {
  const { runLocalCliProcess } = runtimeProcessModule;
  assert.equal(typeof runLocalCliProcess, 'function');

  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4312;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.directKills = [];
    }

    kill(signal) {
      this.directKills.push(signal);
      return true;
    }
  }

  const child = new FakeChild();
  const groupKills = [];
  let spawnOptions;
  const promise = runLocalCliProcess('cursor-agent', ['-p', 'probe'], {
    cwd: '/tmp/runtime',
    env: { PATH: '/safe/bin' },
    timeoutMs: 5,
    graceMs: 5,
    platform: 'linux',
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
    killImpl: (pid, signal) => {
      groupKills.push([pid, signal]);
      return true;
    }
  });
  const rejected = assert.rejects(promise, (error) => {
    assert.equal(error.code, 'LOCAL_RUNTIME_TIMEOUT');
    return true;
  });

  const killDeadline = Date.now() + 250;
  while (groupKills.length < 2 && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(groupKills, [[-4312, 'SIGTERM'], [-4312, 'SIGKILL']]);
  assert.deepEqual(child.directKills, []);
  child.emit('close', null, 'SIGKILL');
  await rejected;
});

test('injects the model API readiness transport without mutating global fetch', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  const ready = await probeRuntimeReadiness('doubao', {
    source: 'remote',
    kind: 'model-api',
    baseUrl: 'https://runtime.example/v1',
    apiKeyEnv: 'RUNTIME_PROBE_KEY',
    model: 'runtime-model'
  }, {
    env: {
      RUNTIME_PROBE_KEY: 'test-key',
      RUNTIME_PROBE_TIMEOUT_MS: '1000'
    },
    fetchImpl: async (url, options) => {
      assert.equal(globalThis.fetch, originalFetch);
      request = { url, options };
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'READY' } }]
      }), { status: 200 });
    }
  });

  assert.equal(ready, true);
  assert.equal(request.url, 'https://runtime.example/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer test-key');
  assert.equal(globalThis.fetch, originalFetch);
});

test('rejects noncompliant nonempty readiness output', async () => {
  const ready = await probeRuntimeReadiness('doubao', {
    source: 'remote',
    kind: 'model-api',
    baseUrl: 'https://runtime.example/v1',
    apiKeyEnv: 'RUNTIME_PROBE_KEY',
    model: 'runtime-model'
  }, {
    env: {
      RUNTIME_PROBE_KEY: 'test-key',
      RUNTIME_PROBE_TIMEOUT_MS: '1000'
    },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'I cannot confirm readiness.' } }]
    }), { status: 200 })
  });

  assert.equal(ready, false);
});

test('isolates Claude Code from inherited provider credentials and persistent user directories', () => {
  const workspace = '/tmp/agent-roast-claude';
  const env = localCliEnv('claude-code', workspace, {
    PATH: '/safe/bin',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    LANG: 'C.UTF-8',
    ANTHROPIC_AUTH_TOKEN: 'claude-only-token',
    ANTHROPIC_MODEL: 'claude-only-model',
    CURSOR_API_KEY: 'must-not-leak',
    ARK_API_KEY: 'must-not-leak',
    REVIEW_MODEL_DEEPSEEK: 'must-not-leak',
    DEEPSEEK_API_KEY: 'must-not-leak',
    AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    HOME: '/persistent/home'
  });

  assert.equal(env.PATH, '/safe/bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(env.LANG, 'C.UTF-8');
  for (const name of [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'CURSOR_API_KEY',
    'ARK_API_KEY',
    'REVIEW_MODEL_DEEPSEEK',
    'DEEPSEEK_API_KEY',
    'AWS_SECRET_ACCESS_KEY'
  ]) {
    assert.equal(env[name], undefined, `${name} must not reach Claude`);
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP']) {
    assert.equal(env[name], workspace, `${name} must be workspace-scoped`);
  }
});

test('derives Ark bridge variables for Claude without preserving Ark credentials', () => {
  const workspace = '/tmp/agent-roast-claude-ark';
  const env = localCliEnv('claude-code', workspace, {
    PATH: '/safe/bin',
    ARK_BASE_URL: 'https://ark.example/api/v3',
    ARK_API_KEY: 'ark-secret',
    CLAUDE_ARK_MODEL: 'ep-deepseek',
    REVIEW_MODEL_DEEPSEEK: 'reviewer-model',
    CURSOR_API_KEY: 'cursor-secret'
  });
  applyArkClaudeEnv(env, 'http://127.0.0.1:45678', 'ep-deepseek');

  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45678');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'local-ark-proxy');
  assert.equal(env.ANTHROPIC_MODEL, 'ep-deepseek');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'ep-deepseek');
  for (const name of ['ARK_BASE_URL', 'ARK_API_KEY', 'CLAUDE_ARK_MODEL', 'REVIEW_MODEL_DEEPSEEK', 'CURSOR_API_KEY']) {
    assert.equal(env[name], undefined, `${name} must not reach Claude`);
  }
});

test('normalizes local runtime timeout values with a 20-minute ceiling', () => {
  assert.equal(localRuntimeTimeout(), 180_000);
  assert.equal(localRuntimeTimeout('300000'), 300_000);
  assert.equal(localRuntimeTimeout('1200001'), 1_200_000);

  for (const invalidValue of ['NaN', 'Infinity', '-Infinity', '0', '-1', '1.5']) {
    assert.equal(localRuntimeTimeout(invalidValue), 180_000);
  }
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
  process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({ cursor: { kind: 'remote-http', url: 'https://runtime.example/cursor', apiKeyEnv: 'RUNTIME_TEST_KEY' } });
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
