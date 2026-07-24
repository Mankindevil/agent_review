import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as runtimeStatusModule from '../src/runtime-status.js';
import {
  createEvidenceManifestItem,
  createEvidenceRecord
} from '../src/evidence.js';

const {
  cachedRuntimeReadiness,
  clearRuntimeReadinessCache,
  getRuntimeStatus,
  probeCursorAuthentication,
  probeExecutable
} = runtimeStatusModule;

process.env.NODE_ENV = 'test';
process.env.DATA_FILE = path.join(tmpdir(), `agent-roast-test-${process.pid}.json`);
process.env.AGENT_DIAGNOSTICS_RATE_LIMIT = '100';
process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
process.env.ALLOW_PRIVATE_DIAGNOSTICS_URLS = 'true';
const API_UNSECURED_JWT = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxMjMifQ.';
const V2_FIXTURE_PARTICIPANT_TOKEN = 'T'.repeat(43);
const apiEvidenceRecord = createEvidenceRecord({
  evidenceId: 'ev_api',
  runId: 'run_api',
  grade: 'A',
  kind: 'platform-timing',
  testId: 'test_api',
  turnIndex: 0,
  repeatIndex: 0,
  capturedAt: '2026-07-24T09:00:30.000Z',
  payload: { durationMs: 30 }
});
const apiEvidenceManifestItem = createEvidenceManifestItem(apiEvidenceRecord, {
  summary: 'Completed',
  visibility: 'public'
});
const v2Fixture = {
  schemaVersion: 2,
  id: 'eval_v2_projection',
  createdAt: '2026-07-24T09:00:00.000Z',
  updatedAt: '2026-07-24T09:01:00.000Z',
  revision: 0,
  participantAccess: {
    tokenHash: createHash('sha256')
      .update(V2_FIXTURE_PARTICIPANT_TOKEN, 'utf8')
      .digest('hex'),
    createdAt: '2026-07-24T09:00:00.000Z'
  },
  execution: {
    status: 'completed',
    stage: `password=api-flat-password; apiKey=api-flat-key; session=api-flat-session; credentials=api-flat-credentials; jwt=${API_UNSECURED_JWT}`,
    progress: 100,
    authorization: 'api-auth-secret'
  },
  governance: { phase: 'waiting_model', anonymousMapping: { A: 'api-mapping-secret' } },
  qualification: { status: 'passed', attemptRunIds: ['run_api'], hiddenInput: 'api-hidden-secret' },
  evidenceManifest: {
    version: '1.0',
    items: [apiEvidenceManifestItem]
  },
  objectiveCapability: { status: 'pending', score: null },
  absoluteReview: { status: 'pending-model-review' },
  replicaArena: { status: 'sealed', seal: 'api-seal-secret' },
  resultV2: { status: 'pending', score: null },
  agentCard: { description: 'api-card-secret' },
  builds: [{
    runtimeId: 'legacy-runtime',
    skill: { name: 'leak', description: 'api-skill-secret', instructions: [], tools: [] }
  }],
  auditEvents: [{ payload: 'api-audit-secret' }],
  rawEvidence: { value: 'api-raw-top-secret' },
  logs: [{ message: 'api-sensitive-log-secret' }]
};
await writeFile(process.env.DATA_FILE, JSON.stringify({ schemaVersion: '1.0', items: [v2Fixture] }));
const serverModule = await import('../server.js');
const { server, evaluationStore, serializeEvaluationForResponse } = serverModule;

let origin;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(process.env.DATA_FILE, { force: true });
  await rm(`${process.env.DATA_FILE}.tmp`, { force: true });
});

test('health endpoint responds', async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.a2aBlackBoxV1Enabled, false);
  assert.equal(Number.isInteger(health.evaluationSeed), true);
  assert.equal(health.modelTemperature, 0);
  assert.equal(health.dataSource.provider, 'pandaai');
  assert.equal(typeof health.dataSource.configured, 'boolean');
  assert.equal(typeof health.dataSource.autoVerify, 'boolean');
});

test('keeps disabled V2 resume behind the feature flag', async () => {
  const response = await fetch(
    `${origin}/api/evaluations/${v2Fixture.id}/resume`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'T'.repeat(43)}`,
        'content-type': 'application/json',
        'idempotency-key': 'resume-api-key-00001'
      },
      body: JSON.stringify({})
    }
  );
  const result = await response.json();
  assert.equal(response.status, 409);
  assert.match(result.error, /V2|black-box|disabled/i);
});

test('preserves the legacy evaluation request body limit while V2 is disabled', async () => {
  const response = await fetch(`${origin}/api/evaluations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(1_000_000) })
  });
  assert.equal(response.status, 413);
});

test('projects every V2 list, detail, and SSE read and soft-archives V2 deletes', async () => {
  const forbidden = [
    'api-auth-secret', 'api-mapping-secret', 'api-hidden-secret',
    'api-seal-secret', 'api-card-secret', 'api-skill-secret', 'api-audit-secret',
    'api-raw-top-secret', 'api-sensitive-log-secret', 'api-flat-password',
    'api-flat-key', 'api-flat-session', 'api-flat-credentials', API_UNSECURED_JWT
  ];
  await assert.rejects(
    () => evaluationStore.mutate(v2Fixture.id, 0, (current) => ({
      ...current,
      schemaVersion: 1
    })),
    /V2|schemaVersion|identity/i
  );
  const listResponse = await fetch(`${origin}/api/evaluations`);
  const listed = (await listResponse.json()).find((item) => item.id === v2Fixture.id);
  assert.equal(listResponse.status, 200);
  assert.equal(listed.schemaVersion, 2);
  assert.equal(listed.evidenceManifest.items[0].summary, 'Completed');
  assert.equal(listed.evidenceManifest.items[0].recordHash, apiEvidenceRecord.recordHash);

  const detailResponse = await fetch(`${origin}/api/evaluations/${v2Fixture.id}`);
  const detailText = await detailResponse.text();
  assert.equal(detailResponse.status, 200);
  for (const secret of forbidden) assert.equal(detailText.includes(secret), false, `detail: ${secret}`);

  const createProjection = serializeEvaluationForResponse(v2Fixture);
  const createProjectionText = JSON.stringify(createProjection);
  assert.equal(createProjection.schemaVersion, 2);
  for (const secret of forbidden) assert.equal(createProjectionText.includes(secret), false, `create: ${secret}`);

  const participantAccessToken = V2_FIXTURE_PARTICIPANT_TOKEN;
  const createResponse = serializeEvaluationForResponse({
    evaluation: v2Fixture,
    participantAccessToken
  });
  const createResponseText = JSON.stringify(createResponse);
  assert.equal(createResponse.participantAccessToken, participantAccessToken);
  assert.equal(createResponse.schemaVersion, 2);
  assert.equal(Object.hasOwn(createResponse, 'evaluation'), false);
  for (const secret of forbidden) assert.equal(createResponseText.includes(secret), false, `create wrapper: ${secret}`);

  for (const action of ['cancel', 'retry']) {
    const response = await fetch(`${origin}/api/evaluations/${v2Fixture.id}/${action}`, {
      method: 'POST',
      headers: action === 'retry' ? { 'content-type': 'application/json' } : undefined,
      body: action === 'retry' ? JSON.stringify({ type: 'review', key: 'gpt' }) : undefined
    });
    const text = await response.text();
    assert.equal(response.status, 409, action);
    for (const secret of forbidden) assert.equal(text.includes(secret), false, `${action}: ${secret}`);
  }

  const streamResponse = await fetch(`${origin}/api/evaluations/${v2Fixture.id}/events`);
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body.getReader();
  const firstEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(firstEvent, /^data: /);
  for (const secret of forbidden) assert.equal(firstEvent.includes(secret), false, `SSE: ${secret}`);

  const skillResponse = await fetch(`${origin}/api/evaluations/${v2Fixture.id}/builds/legacy-runtime/skill`);
  const skillText = await skillResponse.text();
  assert.equal(skillResponse.status, 404);
  assert.equal(skillText.includes('api-skill-secret'), false);
  assert.equal(skillText.includes('api-card-secret'), false);

  const deleteResponse = await fetch(
    `${origin}/api/evaluations/${v2Fixture.id}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${V2_FIXTURE_PARTICIPANT_TOKEN}`
      }
    }
  );
  const deleted = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleted.id, v2Fixture.id);
  assert.equal(deleted.archived, true);
  assert.equal(deleted.deleted, false);

  const nextEvent = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('missing subsequent SSE event')), 500))
  ]);
  const nextEventText = new TextDecoder().decode(nextEvent.value);
  await reader.cancel();
  assert.match(nextEventText, /^data: /);
  for (const secret of forbidden) assert.equal(nextEventText.includes(secret), false, `subsequent SSE: ${secret}`);

  const archivedResponse = await fetch(`${origin}/api/evaluations/${v2Fixture.id}`);
  const archived = await archivedResponse.json();
  assert.equal(archivedResponse.status, 200);
  assert.equal(typeof archived.archivedAt, 'string');
  assert.equal(archived.revision, 1);
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
  assert.match(index, /app\.js\?v=20260725-a2a1/);
  assert.match(index, /styles\.css\?v=20260725-a2a1/);
});

test('serves the feature-gated V2 chain-of-custody intake editor', async () => {
  const [pageResponse, scriptResponse, styleResponse] = await Promise.all([
    fetch(`${origin}/`),
    fetch(`${origin}/app.js`),
    fetch(`${origin}/styles.css`)
  ]);
  const [html, script, css] = await Promise.all([
    pageResponse.text(),
    scriptResponse.text(),
    styleResponse.text()
  ]);
  assert.equal(pageResponse.status, 200);
  assert.equal(scriptResponse.status, 200);
  assert.equal(styleResponse.status, 200);

  assert.match(html, /id="start-evaluation"[^>]*disabled/);
  assert.match(html, /id="legacy-intake"/);
  assert.match(html, /id="v2-intake"[^>]*class="[^"]*hidden/);
  assert.match(html, />A2A Agent Card</);
  assert.match(html, />Agent 使用示例</);
  assert.match(html, /id="v2-example-list"/);
  assert.match(html, /id="add-v2-example"/);
  assert.match(html, /id="agent-authorization"[^>]*type="password"/);
  assert.match(html, /id="participant-token-receipt"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="participant-token-output"/);
  assert.doesNotMatch(html, /Skill 使用示例|skillId/);

  for (const level of ['example', 'turn', 'part', 'criterion']) {
    assert.match(script, new RegExp(`data-a2a-${level}`), level);
  }
  for (const partType of ['text', 'data', 'raw', 'url']) {
    assert.match(script, new RegExp(`value="${partType}"`), partType);
  }
  for (const criterionType of ['contains', 'exact', 'json-schema', 'numeric', 'model']) {
    assert.match(script, new RegExp(`value="${criterionType}"`), criterionType);
  }
  assert.match(script, /expectedDeliverable/);
  assert.match(script, /acceptanceCriteria/);
  assert.match(script, /constraints/);
  assert.match(script, /evaluationModeFromHealth\(payload\)/);
  assert.match(script, /function setBlackBoxMode/);
  assert.match(script, /function setBlackBoxModeUnavailable/);
  assert.match(script, /nextAvailableEditorId\(/);
  assert.match(script, /data-record-kind="v2"/);
  assert.match(script, /recordActionCopy\(isV2\)/);
  assert.match(script, /recordActionFailure\(isV2, payload\.error\)/);
  assert.match(script, /recordActionFailure\(isV2, error\.message\)/);

  assert.match(css, /\.a2a-custody-rail/);
  assert.match(css, /\.agent-auth-panel/);
  assert.match(css, /\.participant-token-receipt/);
  for (const selector of [
    'a2a-example-list',
    'a2a-custody-rail',
    'a2a-turn-list',
    'a2a-turn'
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s*\\{[^}]*min-width:0;`),
      `${selector} must shrink inside the intake card`
    );
  }
  assert.match(css, /\.a2a-part\s*\{[^}]*grid-template-columns:[^;}]*minmax\(0,/);
  assert.match(css, /\.a2a-criterion\s*\{[^}]*grid-template-columns:[^;}]*minmax\(0,/);
  assert.match(css, /\.a2a-check input\s*\{[^}]*min-width:16px;[^}]*height:16px;/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('keeps V2 browser secrets memory-only and renders nested projections safely', async () => {
  const [response, actionsResponse] = await Promise.all([
    fetch(`${origin}/app.js`),
    fetch(`${origin}/evaluation-actions.js`)
  ]);
  const [script, actions] = await Promise.all([
    response.text(),
    actionsResponse.text()
  ]);
  assert.equal(response.status, 200);
  assert.equal(actionsResponse.status, 200);

  assert.match(script, /participantTokens:\s*new Map\(\)/);
  assert.match(script, /from '.\/evaluation-actions\.js/);
  assert.match(script, /function statusOf\(item\)/);
  assert.match(script, /function stageOf\(item\)/);
  assert.match(script, /function progressOf\(item\)/);
  assert.match(script, /function renderV2Result\(item\)/);
  assert.match(script, /function renderV2HistoryItem\(item\)/);
  assert.match(script, /schemaVersion:\s*2,\s*agentCard,\s*agentExamples/);
  assert.match(script, /participantAccessToken/);
  assert.match(script, /participant-token-output'\)\.textContent/);
  assert.match(script, /agent-authorization'\)\.value = ''/);
  assert.match(script, /authorization:\s*`Bearer \$\{participantToken\}`/);
  assert.match(script, /'idempotency-key':\s*crypto\.randomUUID\(\)/);
  assert.doesNotMatch(
    `${script}\n${actions}`,
    /localStorage|sessionStorage|indexedDB|document\.cookie|console\./
  );
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
  const [
    pageResponse,
    aliasResponse,
    scriptResponse,
    helperResponse,
    styleResponse
  ] = await Promise.all([
    fetch(`${origin}/agent-check.html`),
    fetch(`${origin}/agent-check`),
    fetch(`${origin}/agent-check.js`),
    fetch(`${origin}/agent-check-helpers.js`),
    fetch(`${origin}/agent-check.css`)
  ]);
  const [html, aliasHtml, script, helper, css] = await Promise.all([
    pageResponse.text(),
    aliasResponse.text(),
    scriptResponse.text(),
    helperResponse.text(),
    styleResponse.text()
  ]);
  assert.equal(pageResponse.status, 200);
  assert.equal(aliasResponse.status, 200);
  assert.match(aliasHtml, /diagnostics-form/);
  assert.equal(scriptResponse.status, 200);
  assert.equal(helperResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  for (const id of [
    'diagnostics-form', 'agent-card-file', 'agent-card-json',
    'card-source-json', 'card-source-card-url', 'card-source-service-url',
    'json-source-panel', 'url-source-panel', 'agent-card-url',
    'private-network-note',
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
  assert.doesNotMatch(html, /href="\/"/);
  assert.match(html, /<div class="brand"/);
  assert.match(html, /<a class="back-link" href="\/agent-check"/);
  assert.doesNotMatch(html, /平台访问密钥|platform-key|AGENT_DIAGNOSTICS_ACCESS_KEY/);
  assert.match(script, /\/api\/agent-diagnostics/);
  assert.match(script, /agentCard/);
  assert.match(script, /cardSource/);
  assert.match(script, /card-url/);
  assert.match(script, /service-url/);
  assert.match(script, /\/api\/agent-cards\/resolve/);
  assert.match(helper, /promptForAgentCard/);
  assert.match(helper, /skills/);
  assert.match(script, /confirmAuthorizationTarget/);
  assert.match(script, /MAX_CARD_BYTES/);
  assert.doesNotMatch(script, /platformKey|platform-key/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.match(script, /pageshow/);
  assert.match(css, /\.card-drop-zone/);
  assert.match(css, /\.card-source-switch/);
  assert.match(css, /\.signal-rail/);
  assert.match(css, /prefers-reduced-motion/);
});

test('resolves a service root and runs diagnostics through the public API', async () => {
  let agentOrigin = '';
  const agentServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/.well-known/agent-card.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        name: 'URL Diagnostic Agent',
        description: 'Exercises URL discovery.',
        supportedInterfaces: [{
          url: `${agentOrigin}/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0'
        }],
        skills: [{ id: 'status', name: 'Status', description: 'Return status.' }]
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/a2a') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            message: {
              messageId: 'url-reply',
              role: 'ROLE_AGENT',
              parts: [{ text: 'discovery healthy' }]
            }
          }
        }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => agentServer.listen(0, '127.0.0.1', resolve));
  agentOrigin = `http://127.0.0.1:${agentServer.address().port}`;

  try {
    const response = await fetch(`${origin}/api/agent-diagnostics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cardSource: { type: 'service-url', url: agentOrigin },
        authMethod: 'none',
        prompt: 'status',
        timeoutMs: 60_000,
        attestations: { deepseekV4Pro: true, authorizedDataOnly: true }
      })
    });
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.equal(report.ok, true);
    assert.equal(
      report.checks[0].details.resolvedUrl,
      `${agentOrigin}/.well-known/agent-card.json`
    );
    assert.equal(report.checks[1].details.targetOrigin, agentOrigin);
    assert.match(report.checks[2].details.preview, /discovery healthy/);
  } finally {
    await new Promise((resolve) => agentServer.close(resolve));
  }
});

test('documents diagnostics configuration, credential scopes, side effects, and troubleshooting', async () => {
  const [guide, envExample, readme] = await Promise.all([
    readFile(new URL('../docs/AGENT_DIAGNOSTICS_GUIDE.md', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8')
  ]);
  for (const term of [
    'ALLOW_PRIVATE_DIAGNOSTICS_URLS',
    'Agent Card JSON',
    '完整 Agent Card URL',
    '服务根地址',
    '/.well-known/agent-card.json',
    '一次只测试一张',
    '多 Agent',
    'tenant',
    'Agent Bearer Token',
    'DeepSeek V4 Pro',
    '最终报名表',
    'confirmAuthorizationTarget',
    '再次真实执行',
    '1 MiB',
    '1.25 MiB',
    '20 分钟',
    'technicalReadinessOk',
    'declared',
    'passed',
    'blocked',
    '429',
    'SSRF'
  ]) {
    assert.match(guide, new RegExp(term), term);
  }
  assert.match(envExample, /AGENT_DIAGNOSTICS_RATE_LIMIT=6/);
  assert.match(envExample, /AGENT_DIAGNOSTICS_CONCURRENCY=4/);
  assert.match(envExample, /ALLOW_PRIVATE_DIAGNOSTICS_URLS=false/);
  assert.doesNotMatch(`${guide}\n${envExample}\n${readme}`, /AGENT_DIAGNOSTICS_ACCESS_KEY|平台访问密钥/);
  assert.match(readme, /AGENT_DIAGNOSTICS_GUIDE\.md/);
  assert.match(readme, /\/agent-check\b/);
  assert.doesNotMatch(readme, /\/agent-check\.html/);
  assert.match(readme, /Agent Card JSON 技术预检/);
  assert.match(readme, /20 分钟/);
});

test('documents the opt-in V2 create, one-time participant token, and resume contract', async () => {
  const readme = await readFile(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /A2A_BLACK_BOX_V1_ENABLED=true/u);
  assert.match(readme, /POST \/api\/evaluations\b/u);
  assert.match(readme, /participantAccessToken/u);
  assert.match(readme, /POST \/api\/evaluations\/:id\/resume/u);
  assert.match(readme, /Idempotency-Key/u);
  assert.match(readme, /only once|one-time/iu);
  assert.match(readme, /non-idempotent/iu);
  assert.match(readme, /lost response|response is lost/iu);
  assert.match(readme, /public Agent[\s\S]*\{\}/iu);
  assert.match(readme, /fresh Agent authorization/iu);
});

test('documents production runtime tool configuration and independent model responsibilities', async () => {
  const [envExample, readme, design, plan] = await Promise.all([
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/superpowers/specs/2026-07-24-runtime-cli-production-install-design.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/superpowers/plans/2026-07-24-runtime-cli-production-install.md', import.meta.url), 'utf8')
  ]);
  assert.match(envExample, /^CURSOR_AUTH_CONFIG_HOME=\/var\/lib\/agent-review\/cursor-auth$/m);
  assert.doesNotMatch(envExample, /^CURSOR_API_KEY=/m);
  assert.match(envExample, /\/opt\/agent-review\/tools\/bin/);
  assert.match(envExample, /^ENABLE_LOCAL_CLAUDE_CODE=false$/m);
  assert.match(envExample, /^ENABLE_LOCAL_CURSOR_AGENT=false$/m);
  assert.match(readme, /评审模型与 Runtime 模型独立配置/);
  assert.match(readme, /Cursor Agent.*CURSOR_AUTH_CONFIG_HOME/s);
  assert.doesNotMatch(readme, /--mode ask|--sandbox enabled|CURSOR_API_KEY/);
  assert.match(readme, /\/opt\/agent-review\/tools\/claude\/releases\/2\.1\.218/);
  assert.match(readme, /\/opt\/agent-review\/tools\/cursor-agent\/releases\/2026\.07\.23-e383d2b/);
  assert.match(readme, /生产.*ENABLE_LOCAL_CLAUDE_CODE=true.*ENABLE_LOCAL_CURSOR_AGENT=true/s);
  assert.match(readme, /评审模型、Runtime 模型、参赛 Agent 资格是三件事/);
  assert.match(readme, /只有参赛 Agent Card 与最终报名表的声明要求 DeepSeek V4 Pro/);
  assert.match(readme, /评审模型以及 Claude、Cursor、Doubao Runtime 不受该底模限制/);
  assert.match(readme, /GET \/api\/runtimes/);
  assert.match(readme, /runtimeReady/);
  assert.doesNotMatch(`${design}\n${plan}`, /Cursor Agent 使用独立 Cursor API Key|Cursor API key requirements|Cursor's independent API key|independently supplied Cursor API Key|Cursor ready only when.*API key/i);
});

test('validates public diagnostics request bodies without an access key', async () => {
  const malformed = await fetch(`${origin}/api/agent-diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json'
  });
  assert.equal(malformed.status, 400);

  const tooLarge = await fetch(`${origin}/api/agent-diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    headers: { 'content-type': 'application/json' },
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
    headers: { 'content-type': 'application/json' },
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
  for (const runtime of runtimes) {
    assert.equal(typeof runtime.installed, 'boolean');
    assert.equal(typeof runtime.authenticated, 'boolean');
    assert.equal(typeof runtime.enabled, 'boolean');
    assert.equal(typeof runtime.runtimeReady, 'boolean');
  }
});

test('reports enablement independently from local installation', async () => {
  const previousClaude = process.env.ENABLE_LOCAL_CLAUDE_CODE;
  const previousCursor = process.env.ENABLE_LOCAL_CURSOR_AGENT;
  const previousPath = process.env.PATH;
  const previousRemoteAdapters = process.env.RUNTIME_ADAPTERS_JSON;
  try {
    process.env.ENABLE_LOCAL_CLAUDE_CODE = 'true';
    process.env.ENABLE_LOCAL_CURSOR_AGENT = 'true';
    process.env.PATH = '';
    process.env.RUNTIME_ADAPTERS_JSON = '{}';
    const runtimes = await getRuntimeStatus();
    const claude = runtimes.find((item) => item.id === 'claude-code');
    const cursor = runtimes.find((item) => item.id === 'cursor');
    assert.equal(claude.enabled, true);
    assert.equal(cursor.enabled, true);
    assert.equal(claude.installed, false);
    assert.equal(cursor.installed, false);
    assert.equal(claude.runtimeReady, false);
    assert.equal(cursor.runtimeReady, false);
  } finally {
    restoreEnv('ENABLE_LOCAL_CLAUDE_CODE', previousClaude);
    restoreEnv('ENABLE_LOCAL_CURSOR_AGENT', previousCursor);
    restoreEnv('PATH', previousPath);
    restoreEnv('RUNTIME_ADAPTERS_JSON', previousRemoteAdapters);
  }
});

test('reports local authentication independently from adapter enablement', async () => {
  const env = {
    PATH: '',
    CLAUDE_BACKEND: 'deepseek',
    DEEPSEEK_API_KEY: 'deepseek-runtime-token',
    CURSOR_AUTH_CONFIG_HOME: '/var/lib/agent-review/cursor-auth'
  };
  const status = await getRuntimeStatus({
    env,
    probeExecutableImpl: async (command) => ({
      installed: command === 'claude' || command === 'cursor-agent',
      version: 'test-version',
      executable: `/runtime/bin/${command}`
    }),
    probeCursorAuthImpl: async () => true,
    liveProbe: async () => assert.fail('disabled adapters must not run live probes')
  });
  assert.equal(runtimeFor(status, 'claude-code').authenticated, true);
  assert.equal(runtimeFor(status, 'claude-code').enabled, false);
  assert.equal(runtimeFor(status, 'cursor').authenticated, true);
  assert.equal(runtimeFor(status, 'cursor').enabled, false);
  assert.equal(runtimeFor(status, 'cursor').runtimeReady, false);
});

test('does not treat an unresolved authentication Promise as a credential', async () => {
  const probeExecutableImpl = async (command) => ({
    installed: command === 'claude',
    version: command === 'claude' ? '2.1.218' : null,
    executable: command === 'claude' ? '/runtime/bin/claude' : null
  });
  let liveCalls = 0;
  let status = await getRuntimeStatus({
    env: { PATH: '', ENABLE_LOCAL_CLAUDE_CODE: 'true' },
    probeExecutableImpl,
    liveProbe: async () => {
      liveCalls += 1;
      return true;
    }
  });
  assert.equal(runtimeFor(status, 'claude-code').authenticated, false);
  assert.equal(runtimeFor(status, 'claude-code').runtimeReady, false);
  assert.equal(liveCalls, 0);

  status = await getRuntimeStatus({
    env: {
      PATH: '',
      RUNTIME_ADAPTERS_JSON: JSON.stringify({
        'claude-code': {
          kind: 'model-api',
          baseUrl: 'https://runtime.example/v1',
          apiKeyEnv: 'MISSING_CLAUDE_KEY',
          model: 'runtime-model'
        }
      })
    },
    probeExecutableImpl,
    liveProbe: async () => {
      liveCalls += 1;
      return true;
    }
  });
  assert.equal(runtimeFor(status, 'claude-code').authenticated, false);
  assert.equal(runtimeFor(status, 'claude-code').runtimeReady, false);
  assert.equal(liveCalls, 0);
});

test('probes executable version with X_OK and a disposable minimal environment', async () => {
  assert.equal(typeof probeExecutable, 'function');
  let accessMode;
  let execOptions;
  let removed = false;
  const result = await probeExecutable('claude', {
    env: {
      PATH: '/runtime/bin',
      LANG: 'C.UTF-8',
      ARK_API_KEY: 'must-not-leak',
      HOME: '/persistent/home'
    },
    accessImpl: async (_candidate, mode) => { accessMode = mode; },
    execFileImpl: async (_command, _args, options) => {
      execOptions = options;
      return { stdout: '2.1.218 (Claude Code)\n', stderr: '' };
    },
    createWorkspace: async () => '/tmp/runtime-probe',
    removeWorkspace: async (_workspace, options) => {
      removed = options.recursive === true && options.force === true;
    }
  });

  assert.equal(accessMode, fsConstants.X_OK);
  assert.equal(result.installed, true);
  assert.equal(result.version, '2.1.218 (Claude Code)');
  assert.equal(execOptions.cwd, '/tmp/runtime-probe');
  assert.equal(execOptions.env.HOME, '/tmp/runtime-probe');
  assert.equal(execOptions.env.ARK_API_KEY, undefined);
  assert.equal(removed, true);
});

test('does not call a failed version probe installed', async () => {
  assert.equal(typeof probeExecutable, 'function');
  const result = await probeExecutable('claude', {
    env: { PATH: '/runtime/bin' },
    accessImpl: async () => {},
    execFileImpl: async () => { throw new Error('version failed'); },
    createWorkspace: async () => '/tmp/runtime-probe-failure',
    removeWorkspace: async () => {}
  });
  assert.deepEqual(result, { installed: false, version: null, executable: null });
});

test('probes Cursor login with a disposable config directory', async () => {
  assert.equal(typeof probeCursorAuthentication, 'function');
  let options;
  const authenticated = await probeCursorAuthentication('/runtime/bin/cursor-agent', {
    env: {
      PATH: '/runtime/bin',
      CURSOR_AUTH_CONFIG_HOME: '/var/lib/agent-review/cursor-auth',
      CURSOR_API_KEY: 'must-not-leak',
      ARK_API_KEY: 'must-not-leak'
    },
    execFileImpl: async (_command, _args, execOptions) => {
      options = execOptions;
      return { stdout: 'Logged in as production-reviewer\n', stderr: '' };
    },
    createWorkspace: async () => '/tmp/cursor-status-probe',
    removeWorkspace: async () => {}
  });
  assert.equal(authenticated, true);
  assert.equal(options.env.HOME, '/tmp/cursor-status-probe');
  assert.equal(options.env.XDG_CONFIG_HOME, '/tmp/cursor-status-probe');
  assert.equal(options.env.XDG_CACHE_HOME, '/tmp/cursor-status-probe');
  assert.equal(options.env.AGENT_CLI_CREDENTIAL_STORE, 'file');
  assert.equal(options.env.CURSOR_API_KEY, undefined);
  assert.equal(options.env.ARK_API_KEY, undefined);

  for (const stdout of ['', 'Not logged in', 'Logged out']) {
    assert.equal(await probeCursorAuthentication('/runtime/bin/cursor-agent', {
      env: { PATH: '/runtime/bin', CURSOR_AUTH_CONFIG_HOME: '/var/lib/agent-review/cursor-auth' },
      execFileImpl: async () => ({ stdout, stderr: '' }),
      createWorkspace: async () => '/tmp/cursor-negative-probe',
      removeWorkspace: async () => {}
    }), false);
  }
});

test('rejects imprecise and unusable remote runtime adapter configuration', async () => {
  await withRuntimeStatusEnv(async () => {
    for (const remoteConfig of [
      JSON.stringify({ note: 'claude-code cursor doubao' }),
      '{"claude-code":',
      JSON.stringify({
        'claude-code': { kind: 'remote-http', url: 'ftp://runtime.example/claude' },
        cursor: { kind: 'remote-http', url: 'not-a-url' },
        doubao: { kind: 'remote-http', url: 'https://runtime.example/doubao', apiKeyEnv: '' }
      })
    ]) {
      process.env.RUNTIME_ADAPTERS_JSON = remoteConfig;
      const runtimes = await getRuntimeStatus();
      for (const runtime of runtimes) {
        assert.equal(runtime.enabled, false, `${runtime.id} should reject ${remoteConfig}`);
        assert.equal(runtime.runtimeReady, false, `${runtime.id} should not be ready for ${remoteConfig}`);
      }
    }
  });
});

test('keeps remote enablement, authentication, and live readiness independent', async () => {
  await withRuntimeStatusEnv(async () => {
    process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({
      'claude-code': { kind: 'remote-http', url: 'https://runtime.example/claude' },
      cursor: { kind: 'remote-http', url: 'http://runtime.example/cursor' },
      doubao: { kind: 'remote-http', url: 'https://runtime.example/doubao', apiKeyEnv: 'RUNTIME_STATUS_TEST_KEY' }
    });
    let probes = 0;
    let runtimes = await getRuntimeStatus({ liveProbe: async () => { probes += 1; return false; } });
    assert.equal(runtimeFor(runtimes, 'claude-code').enabled, true);
    assert.equal(runtimeFor(runtimes, 'claude-code').authenticated, true);
    assert.equal(runtimeFor(runtimes, 'claude-code').runtimeReady, false);
    assert.equal(runtimeFor(runtimes, 'cursor').enabled, true);
    assert.equal(runtimeFor(runtimes, 'cursor').authenticated, true);
    assert.equal(runtimeFor(runtimes, 'cursor').runtimeReady, false);
    assert.equal(runtimeFor(runtimes, 'doubao').enabled, true);
    assert.equal(runtimeFor(runtimes, 'doubao').authenticated, false);
    assert.equal(runtimeFor(runtimes, 'doubao').runtimeReady, false);
    assert.equal(probes, 2);

    process.env.RUNTIME_STATUS_TEST_KEY = 'test-runtime-key';
    runtimes = await getRuntimeStatus({ liveProbe: async () => true });
    assert.equal(runtimeFor(runtimes, 'doubao').enabled, true);
    assert.equal(runtimeFor(runtimes, 'doubao').authenticated, true);
    assert.equal(runtimeFor(runtimes, 'doubao').runtimeReady, true);

    process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({
      cursor: { kind: 'remote-http', url: 'https://runtime.example/cursor', apiKeyEnv: 'toString' }
    });
    runtimes = await getRuntimeStatus({ liveProbe: async () => assert.fail('inherited API key must not trigger a probe') });
    assert.equal(runtimeFor(runtimes, 'cursor').enabled, true);
    assert.equal(runtimeFor(runtimes, 'cursor').authenticated, false);
    assert.equal(runtimeFor(runtimes, 'cursor').runtimeReady, false);
  });
});

test('coalesces and briefly caches expensive live readiness probes', async () => {
  assert.equal(typeof cachedRuntimeReadiness, 'function');
  assert.equal(typeof clearRuntimeReadinessCache, 'function');
  clearRuntimeReadinessCache();
  const config = {
    source: 'remote',
    kind: 'remote-http',
    url: 'https://runtime.example/cursor'
  };
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return true;
  };

  const first = await Promise.all([
    cachedRuntimeReadiness('cursor', config, { env: {}, probe, ttlMs: 60_000 }),
    cachedRuntimeReadiness('cursor', config, { env: {}, probe, ttlMs: 60_000 })
  ]);
  assert.deepEqual(first, [true, true]);
  assert.equal(await cachedRuntimeReadiness('cursor', config, { env: {}, probe, ttlMs: 60_000 }), true);
  assert.equal(calls, 1);

  await cachedRuntimeReadiness('cursor', { ...config, url: 'https://runtime.example/other' }, {
    env: {},
    probe,
    ttlMs: 60_000
  });
  assert.equal(calls, 2);
  clearRuntimeReadinessCache();
});

test('validates remote model-api adapters against the execution contract', async () => {
  await withRuntimeStatusEnv(async () => {
    const config = {
      kind: 'model-api',
      baseUrl: 'https://runtime.example/v1',
      apiKeyEnv: 'RUNTIME_STATUS_MODEL_API_KEY',
      model: 'runtime-model'
    };
    process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({ doubao: config });
    let runtimes = await getRuntimeStatus({ liveProbe: async () => assert.fail('missing key must skip probe') });
    assert.equal(runtimeFor(runtimes, 'doubao').enabled, true);
    assert.equal(runtimeFor(runtimes, 'doubao').authenticated, false);
    assert.equal(runtimeFor(runtimes, 'doubao').runtimeReady, false);

    process.env.RUNTIME_STATUS_MODEL_API_KEY = 'test-model-api-key';
    runtimes = await getRuntimeStatus({ liveProbe: async () => false });
    assert.equal(runtimeFor(runtimes, 'doubao').enabled, true);
    assert.equal(runtimeFor(runtimes, 'doubao').authenticated, true);
    assert.equal(runtimeFor(runtimes, 'doubao').runtimeReady, false);
    runtimes = await getRuntimeStatus({ liveProbe: async () => true });
    assert.equal(runtimeFor(runtimes, 'doubao').runtimeReady, true);

    for (const invalidConfig of [
      { ...config, model: '' },
      { ...config, baseUrl: 'ftp://runtime.example/v1' },
      { ...config, apiKeyEnv: '' }
    ]) {
      process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({ doubao: invalidConfig });
      runtimes = await getRuntimeStatus({ liveProbe: async () => true });
      assert.equal(runtimeFor(runtimes, 'doubao').enabled, false);
      assert.equal(runtimeFor(runtimes, 'doubao').runtimeReady, false);
    }
  });
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withRuntimeStatusEnv(run) {
  const names = [
    'RUNTIME_ADAPTERS_JSON', 'RUNTIME_STATUS_TEST_KEY', 'RUNTIME_STATUS_MODEL_API_KEY', 'ENABLE_LOCAL_CLAUDE_CODE',
    'ENABLE_LOCAL_CURSOR_AGENT', 'PATH', 'ARK_BASE_URL', 'ARK_API_KEY',
    'REVIEW_MODEL_DOUBAO', 'CURSOR_API_KEY', 'CURSOR_AUTH_CONFIG_HOME'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.PATH = '';
    await run();
  } finally {
    for (const name of names) restoreEnv(name, previous[name]);
  }
}

function runtimeFor(runtimes, id) {
  const runtime = runtimes.find((item) => item.id === id);
  assert.ok(runtime, `missing ${id} runtime`);
  return runtime;
}

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
