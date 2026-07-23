import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_FILE = path.join(tmpdir(), `agent-roast-test-${process.pid}.json`);
process.env.AGENT_DIAGNOSTICS_ACCESS_KEY = 'test-diagnostics-key';
process.env.AGENT_DIAGNOSTICS_RATE_LIMIT = '100';
process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
const { server } = await import('../server.js');

let origin;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => new Promise((resolve) => server.close(resolve)));

test('health endpoint responds', async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(Number.isInteger(health.evaluationSeed), true);
  assert.equal(health.modelTemperature, 0);
  assert.equal(health.dataSource.provider, 'pandaai');
  assert.equal(typeof health.dataSource.configured, 'boolean');
  assert.equal(typeof health.dataSource.autoVerify, 'boolean');
});

test('reports PandaAI data source status without credentials', async () => {
  const response = await fetch(`${origin}/api/data-source`);
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.equal(status.provider, 'pandaai');
  assert.equal('username' in status, false);
  assert.equal('password' in status, false);
});

test('keeps the PandaAI query gateway closed without its independent access key', async () => {
  const previous = process.env.PANDA_DATA_ACCESS_KEY;
  delete process.env.PANDA_DATA_ACCESS_KEY;
  try {
    const response = await fetch(`${origin}/api/data-source/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'get_trade_cal', params: {} })
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /ACCESS_KEY/);
  } finally {
    if (previous === undefined) delete process.env.PANDA_DATA_ACCESS_KEY; else process.env.PANDA_DATA_ACCESS_KEY = previous;
  }
});

test('rejects an invalid PandaAI query gateway key before contacting the provider', async () => {
  const previous = process.env.PANDA_DATA_ACCESS_KEY;
  process.env.PANDA_DATA_ACCESS_KEY = 'test-gateway-key';
  try {
    const response = await fetch(`${origin}/api/data-source/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key' },
      body: JSON.stringify({ method: 'get_trade_cal', params: {} })
    });
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.PANDA_DATA_ACCESS_KEY; else process.env.PANDA_DATA_ACCESS_KEY = previous;
  }
});

test('serves the scoring methodology document in the web UI', async () => {
  const response = await fetch(`${origin}/methodology.html`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /净值曲线/);
  assert.match(html, /数据纪律/);
  assert.match(html, /回测可信度/);
  assert.match(html, /clamp\(18 \+ 10C/);
  assert.match(html, /clamp\(x\) = min\(100, max\(0, x\)\)/);
  assert.match(html, /Complex signal groups/);
  assert.match(html, /变量作用域/);
  assert.match(html, /同组重复出现不累计/);
  assert.match(html, /round\(59\.8\) = 60/);
  assert.match(html, /夯 \/ 人上人 \/ NPC \/ 拉/);
  assert.match(html, /最新结果替换旧结果/);
});

test('keeps the history count inline in the top navigation', async () => {
  const response = await fetch(`${origin}/styles.css`);
  const css = await response.text();
  assert.equal(response.status, 200);
  assert.match(css, /\.nav-button\s*\{[^}]*display:flex;[^}]*white-space:nowrap;/);
});

test('serves localized loading effects with reduced-motion support', async () => {
  const [cssResponse, appResponse] = await Promise.all([
    fetch(`${origin}/styles.css`),
    fetch(`${origin}/app.js`)
  ]);
  const [css, app] = await Promise.all([cssResponse.text(), appResponse.text()]);
  assert.equal(cssResponse.status, 200);
  assert.equal(appResponse.status, 200);
  assert.match(css, /\.work-loader\s*\{/);
  assert.match(css, /@keyframes work-scan/);
  assert.match(css, /\.scan-beam,\.intake-card::after,\.work-loader::after/);
  assert.match(app, /function renderWorkLoader/);
  assert.match(app, /activityOfType\(item, 'build'\)/);
  assert.match(app, /function reviewPlanFor/);
  assert.match(app, /review-card-queued/);
  const indexResponse = await fetch(`${origin}/`);
  const index = await indexResponse.text();
  assert.match(index, /app\.js\?v=20260721-finance2/);
  assert.match(index, /styles\.css\?v=20260721-finance2/);
});

test('lets the final verdict use the available desktop width', async () => {
  const response = await fetch(`${origin}/styles.css`);
  const css = await response.text();
  assert.equal(response.status, 200);
  assert.match(css, /\.verdict-hero h3\s*\{[^}]*max-width:none;[^}]*text-wrap:balance;/);
  assert.doesNotMatch(css, /\.verdict-hero h3\s*\{[^}]*max-width:18ch;/);
});

test('returns JSON 404 for unknown API routes instead of the SPA shell', async () => {
  const response = await fetch(`${origin}/api/not-a-real-route`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), { error: '接口不存在' });
});

test('serves an Agent Card upload readiness console with isolated credentials and explicit streaming consent', async () => {
  const [pageResponse, scriptResponse, styleResponse] = await Promise.all([
    fetch(`${origin}/agent-check.html`),
    fetch(`${origin}/agent-check.js`),
    fetch(`${origin}/agent-check.css`)
  ]);
  const [html, script, css] = await Promise.all([
    pageResponse.text(),
    scriptResponse.text(),
    styleResponse.text()
  ]);
  assert.equal(pageResponse.status, 200);
  assert.equal(scriptResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  for (const id of [
    'diagnostics-form', 'platform-key', 'agent-card-file', 'agent-card-json',
    'card-drop-zone', 'card-summary', 'auth-method', 'agent-token',
    'auth-target-origin', 'confirm-auth-target', 'diagnostic-prompt',
    'timeout-ms', 'attestation-deepseek', 'attestation-authorized',
    'run-streaming', 'confirm-streaming', 'technical-readiness',
    'check-card-input', 'check-card-validation', 'check-call', 'check-stream'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const timeout of ['60000', '300000', '600000', '1200000']) {
    assert.match(html, new RegExp(`value="${timeout}"`), timeout);
  }
  assert.match(html, /一次只测试一张 Agent Card/);
  assert.match(html, /内部多 Agent/);
  assert.match(html, /最终报名表/);
  assert.match(html, /再次真实执行 Prompt/);
  assert.match(script, /\/api\/agent-diagnostics/);
  assert.match(script, /agentCard/);
  assert.match(script, /confirmAuthorizationTarget/);
  assert.match(script, /MAX_CARD_BYTES/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.match(script, /pageshow/);
  assert.match(css, /\.card-drop-zone/);
  assert.match(css, /\.signal-rail/);
  assert.match(css, /prefers-reduced-motion/);
});

test('documents diagnostics configuration, credential scopes, side effects, and troubleshooting', async () => {
  const [guide, envExample, readme] = await Promise.all([
    readFile(new URL('../docs/AGENT_DIAGNOSTICS_GUIDE.md', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8')
  ]);
  for (const term of [
    'AGENT_DIAGNOSTICS_ACCESS_KEY',
    '平台访问密钥',
    'Agent Bearer Token',
    '再次真实执行',
    'allowCrossOriginAuthorization',
    'passed',
    'blocked',
    '429',
    'SSRF'
  ]) {
    assert.match(guide, new RegExp(term), term);
  }
  assert.match(envExample, /AGENT_DIAGNOSTICS_RATE_LIMIT=6/);
  assert.match(envExample, /AGENT_DIAGNOSTICS_CONCURRENCY=4/);
  assert.match(readme, /AGENT_DIAGNOSTICS_GUIDE\.md/);
  assert.match(readme, /agent-check\.html/);
});

test('protects diagnostics before parsing its request body', async () => {
  const missing = await fetch(`${origin}/api/agent-diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json'
  });
  assert.equal(missing.status, 401);

  const wrong = await fetch(`${origin}/api/agent-diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
    body: '{}'
  });
  assert.equal(wrong.status, 401);

  const tooLarge = await fetch(`${origin}/api/agent-diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-diagnostics-key' },
    body: JSON.stringify({ padding: 'x'.repeat(Math.floor(1.25 * 1024 * 1024) + 1) })
  });
  assert.equal(tooLarge.status, 413);
});

test('returns API input errors but keeps upstream diagnostics failures in HTTP 200 reports', async () => {
  const localCard = {
    name: 'Local Agent',
    description: 'Local failure target.',
    url: 'http://127.0.0.1:1',
    protocolVersion: '0.3',
    skills: [{ id: 'status', name: 'Status', description: 'Return status.' }]
  };
  const invalid = await fetch(`${origin}/api/agent-diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-diagnostics-key' },
    body: JSON.stringify({
      agentCard: [localCard],
      authMethod: 'none',
      prompt: 'status',
      attestations: { deepseekV4Pro: true, authorizedDataOnly: true }
    })
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /单个|对象/);

  const before = await (await fetch(`${origin}/api/evaluations`)).json();
  const response = await fetch(`${origin}/api/agent-diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-diagnostics-key' },
    body: JSON.stringify({
      agentCard: {
        ...localCard,
        description: `Local failure target.${'x'.repeat(40 * 1024)}`
      },
      authMethod: 'none',
      prompt: 'status',
      timeoutMs: 60_000,
      attestations: { deepseekV4Pro: true, authorizedDataOnly: true }
    })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const report = await response.json();
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].status, 'passed');
  assert.equal(report.checks[1].status, 'passed');
  assert.equal(report.checks[2].status, 'failed');
  assert.equal(report.technicalReadinessOk, false);
  const after = await (await fetch(`${origin}/api/evaluations`)).json();
  assert.equal(after.length, before.length);
});

test('reports honest local runtime availability', async () => {
  const response = await fetch(`${origin}/api/runtimes`);
  const runtimes = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(runtimes.map((runtime) => runtime.id), ['claude-code', 'cursor', 'doubao']);
  assert.equal(runtimes.every((runtime) => typeof runtime.runtimeReady === 'boolean'), true);
});

test('creates and completes a demo evaluation', async () => {
  const card = {
    name: 'Workflow Agent', description: 'Multi-step API workflow with retries and human review.',
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    skills: [{ id: 'flow', name: 'Workflow', description: 'Plan and execute an API workflow.' }]
  };
  const createdResponse = await fetch(`${origin}/api/evaluations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard: card, mode: 'demo', seed: 9981, cases: [{ name: 'test', prompt: 'Plan and execute this workflow with evidence.' }] }) });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();
  let result;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    result = await (await fetch(`${origin}/api/evaluations/${created.id}`)).json();
    if (result.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(result.status, 'completed');
  assert.equal(result.seed, 9981);
  assert.equal(result.temperature, 0);
  assert.equal(result.benchmark[0].entries.length, 4);
  assert.ok(result.roast.tier.label);
  assert.ok(result.logs.length > 10);
  assert.ok(result.logs.every((log) => log.source && log.phase && log.mode));

  const skillResponse = await fetch(`${origin}/api/evaluations/${created.id}/builds/claude-code/skill`);
  const skillBundle = await skillResponse.json();
  assert.equal(skillResponse.status, 200);
  assert.equal(skillBundle.files.length, 4);
  assert.equal(skillBundle.inputPolicy, 'description-only');
  assert.equal(skillBundle.legacyBaseline, false);
  assert.match(skillBundle.files.find((file) => file.path === 'SKILL.md').content, /## 执行流程/);
  assert.equal(skillBundle.files.find((file) => file.path === 'references/source-description.txt').content, card.description);
  assert.equal(skillBundle.files.some((file) => file.path === 'references/agent-card.json'), false);

  const missingSkillResponse = await fetch(`${origin}/api/evaluations/${created.id}/builds/not-a-runtime/skill`);
  assert.equal(missingSkillResponse.status, 404);

  const retryResponse = await fetch(`${origin}/api/evaluations/${created.id}/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'benchmark', key: 'submitted', caseIndex: 0 })
  });
  assert.equal(retryResponse.status, 202);
  assert.equal((await retryResponse.json()).status, 'retrying');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    result = await (await fetch(`${origin}/api/evaluations/${created.id}`)).json();
    if (result.status === 'completed' && result.retryHistory?.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(result.retryHistory.length, 1);
  assert.equal(result.retryHistory[0].type, 'benchmark');
  assert.ok(result.roast.tier.label, '重试完成后应重新生成最终锐评');

  const cancelResponse = await fetch(`${origin}/api/evaluations/${created.id}/cancel`, { method: 'POST' });
  assert.equal(cancelResponse.status, 200);
  assert.equal((await cancelResponse.json()).status, 'completed', '停止接口应当对已结束评测保持幂等');

  const deleteResponse = await fetch(`${origin}/api/evaluations/${created.id}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { id: created.id, deleted: true });
  assert.equal((await fetch(`${origin}/api/evaluations/${created.id}`)).status, 404);
});

test('returns 404 when stopping an unknown evaluation', async () => {
  const response = await fetch(`${origin}/api/evaluations/eval_missing/cancel`, { method: 'POST' });
  assert.equal(response.status, 404);
});

test('returns 404 when retrying an unknown evaluation', async () => {
  const response = await fetch(`${origin}/api/evaluations/eval_missing/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'review', key: 'gpt' })
  });
  assert.equal(response.status, 404);
});

test('returns 404 when deleting an unknown evaluation', async () => {
  const response = await fetch(`${origin}/api/evaluations/eval_missing`, { method: 'DELETE' });
  assert.equal(response.status, 404);
});

test('rejects malformed agent cards', async () => {
  const response = await fetch(`${origin}/api/evaluations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard: { name: 'Nope' }, cases: [{ prompt: 'x' }] }) });
  assert.equal(response.status, 400);
});

test('rejects non-string case prompts as a client error', async () => {
  const card = {
    name: 'Typed Agent', description: 'Valid card used to verify input typing.',
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    skills: [{ id: 'typed', name: 'Typed', description: 'Validate prompt fields.' }]
  };
  const response = await fetch(`${origin}/api/evaluations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard: card, cases: [{ prompt: 42 }] })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /prompt/);
});

test('rejects malformed benchmark data query plans', async () => {
  const card = {
    name: 'Data Agent', description: 'Valid card used to verify data query typing.',
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    skills: [{ id: 'data', name: 'Data', description: 'Validate data query fields.' }]
  };
  const response = await fetch(`${origin}/api/evaluations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentCard: card, cases: [{ prompt: 'test', dataQueries: [{ method: 'get_index_daily', params: [] }] }] })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /dataQueries.*params|params 必须/);
});

test('rejects an out-of-range evaluation seed', async () => {
  const card = {
    name: 'Seed Agent', description: 'Valid card with invalid seed.',
    supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    skills: [{ id: 'seed', name: 'Seed', description: 'Test seed validation.' }]
  };
  const response = await fetch(`${origin}/api/evaluations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentCard: card, mode: 'demo', seed: 2_147_483_647, cases: [{ prompt: 'test' }] })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Seed/);
});
