import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSseEvents } from '../src/a2a.js';
import { runAgentDiagnostics } from '../src/agent-diagnostics.js';
import { createMarketAgentServer } from '../agents/market-analyst/a2a-server.js';
import { validateEvidencePack } from '../agents/market-analyst/schemas.js';

const A2A_HEADERS = {
  'a2a-version': '1.0',
  authorization: 'Bearer owner-a',
  'content-type': 'application/a2a+json'
};

function messageRequest(messageId, part, configuration = {}) {
  return {
    message: {
      messageId,
      role: 'ROLE_USER',
      parts: [part]
    },
    configuration
  };
}

function continuationRequest(messageId, taskId, text, configuration = {}) {
  return {
    message: {
      messageId,
      taskId,
      role: 'ROLE_USER',
      parts: [{ text }]
    },
    configuration
  };
}

function traceableRow(board, identity, sourceId, sourceRole, score = 80) {
  return {
    rank: 1,
    symbol: identity,
    dataDate: '2026-07-23',
    status: 'RANKED',
    score,
    baseScore: score,
    weightCoverage: 1,
    riskPenalty: 0,
    confidence: 1,
    metrics: [{
      id: `metric-${board}-${identity}`,
      name: sourceRole,
      sourceRole,
      raw: score,
      transformed: score,
      winsorized: score,
      percentile: score,
      originalWeight: 1,
      effectiveWeight: 1,
      contribution: score,
      penalty: 0,
      coverage: 1,
      dataDate: '2026-07-23',
      window: '20d',
      evidenceIds: [sourceId]
    }]
  };
}

function traceableConclusion(board, row, sourceId, sectionId) {
  const identity = String(row.symbol || row.id || row.name);
  return {
    id: `${board}:${identity}`,
    conclusion_id: `${board}:${identity}`,
    sectionId,
    leaderboard: board,
    entryId: identity,
    formula: `${board}-v2`,
    metricIds: row.metrics.map((metric) => metric.id),
    evidenceIds: [sourceId],
    pandaCalls: [sourceId],
    sourceIds: [sourceId],
    dataDates: ['2026-07-23'],
    windows: ['20d'],
    stale: false,
    missing: [],
    limitations: [],
    confidence: 1
  };
}

function traceableSource(id) {
  return {
    id,
    traceCallId: id,
    method: 'get_stock_daily',
    paramsHash: 'a'.repeat(64),
    fields: ['symbol', 'date', 'close'],
    dataAsOf: '2026-07-23',
    window: '2026-07-01/2026-07-23',
    coverage: 1,
    rowCount: 20,
    status: 'ok',
    responseHash: 'b'.repeat(64),
    cacheStatus: 'miss',
    retryCount: 0,
    truncated: false
  };
}

function completedArtifacts(runId = 'run-fake') {
  return [
    {
      name: 'market-report.md',
      mediaType: 'text/markdown',
      content: '# Market report\n\nEvidence-backed close.'
    },
    {
      name: 'evidence-pack.json',
      mediaType: 'application/json',
      data: {
        schemaVersion: '1.0',
        evidenceModelVersion: '2.0',
        runId,
        reportDate: '2026-07-23',
        status: 'complete',
        markets: {},
        conclusions: [],
        leaderboards: {},
        sources: []
      }
    },
    {
      name: 'run-trace.json',
      mediaType: 'application/json',
      data: {
        runId,
        authorization: 'Bearer must-never-escape',
        steps: [{ tool: 'panda-market-worker', status: 'ok' }]
      }
    }
  ];
}

function analyticalArtifacts(runId = 'run-analytical') {
  const hotRow = traceableRow('hotIndustries', 'HOT-MARKER', 'source-hot', 'ret1');
  const conceptRow = traceableRow('hotConcepts', 'CONCEPT-MARKER', 'source-hot', 'ret1');
  const sellRow = traceableRow(
    'sellPressure', 'SELL-MARKER', 'source-sell', 'downside_volume'
  );
  const potentialRow = traceableRow(
    'potentialWatchlist', 'POTENTIAL-MARKER', 'source-potential', 'trend'
  );
  return [
    {
      name: 'market-report.md',
      mediaType: 'text/markdown',
      size: 10_001,
      sha256: 'a'.repeat(64),
      content: '# Full report\n\nHOT-MARKER\n\nSELL-MARKER\n\nPOTENTIAL-MARKER'
    },
    {
      name: 'evidence-pack.json',
      mediaType: 'application/json',
      size: 10_002,
      sha256: 'b'.repeat(64),
      data: {
        schemaVersion: '1.0',
        evidenceModelVersion: '2.0',
        runId,
        reportDate: '2026-07-23',
        status: 'complete',
        markets: { unrelated: 'UNRELATED-MARKET' },
        conclusions: [
          traceableConclusion('hotIndustries', hotRow, 'source-hot', 'hot-topics'),
          traceableConclusion('hotConcepts', conceptRow, 'source-hot', 'hot-topics'),
          traceableConclusion('sellPressure', sellRow, 'source-sell', 'sell-pressure'),
          traceableConclusion(
            'potentialWatchlist', potentialRow, 'source-potential',
            'potential-watchlist'
          )
        ],
        leaderboards: {
          hotIndustries: [hotRow],
          hotConcepts: [conceptRow],
          sellPressure: [sellRow],
          potentialWatchlist: [potentialRow]
        },
        sources: [
          { ...traceableSource('source-hot'), marker: 'HOT-SOURCE' },
          { ...traceableSource('source-sell'), marker: 'SELL-SOURCE' },
          { ...traceableSource('source-potential'), marker: 'POTENTIAL-SOURCE' }
        ],
        missingData: [
          { section: 'hotIndustries', marker: 'HOT-MISSING' },
          { section: 'sellPressure', marker: 'SELL-MISSING' },
          { section: 'potentialWatchlist', marker: 'POTENTIAL-MISSING' }
        ]
      }
    },
    {
      name: 'run-trace.json',
      mediaType: 'application/json',
      size: 10_003,
      sha256: 'c'.repeat(64),
      data: {
        runId,
        steps: [
          { skillId: 'hot-topic-analysis', status: 'ok' },
          { skillId: 'sell-pressure-scan', status: 'ok' },
          { skillId: 'potential-watchlist', status: 'ok' }
        ],
        workerEvents: [{ marker: 'UNRELATED-WORKER-EVENT' }],
        modelUsage: [{ marker: 'UNRELATED-MODEL-USAGE' }],
        emailAttempts: [{ marker: 'UNRELATED-EMAIL-ATTEMPT' }]
      }
    }
  ];
}

function largeAnalyticalArtifacts(runId = 'run-large-analytical', shape = 'data') {
  const artifacts = analyticalArtifacts(runId);
  const descriptor = artifacts.find(({ name }) => name === 'evidence-pack.json');
  const evidence = descriptor.data;
  evidence.sources.push(
    ...Array.from({ length: 510 }, (_, index) =>
      traceableSource(`source-filler-${String(index).padStart(3, '0')}`)
    )
  );
  const cases = [
    [
      'hotIndustries',
      'HOT-AFTER-LIMIT',
      'source-hot-after-limit',
      'ret1',
      'hot-topics'
    ],
    [
      'sellPressure',
      'SELL-AFTER-LIMIT',
      'source-sell-after-limit',
      'downside_volume',
      'sell-pressure'
    ],
    [
      'potentialWatchlist',
      'POTENTIAL-AFTER-LIMIT',
      'source-potential-after-limit',
      'trend',
      'potential-watchlist'
    ]
  ];
  for (const [board, identity, sourceId, sourceRole, sectionId] of cases) {
    const row = traceableRow(board, identity, sourceId, sourceRole);
    evidence.leaderboards[board].push(row);
    evidence.conclusions.push(traceableConclusion(board, row, sourceId, sectionId));
    evidence.sources.push({
      ...traceableSource(sourceId),
      apiKey: 'large-lineage-secret-must-never-escape'
    });
  }
  validateEvidencePack(evidence);
  if (shape === 'content') {
    descriptor.content = JSON.stringify(evidence);
    delete descriptor.data;
  } else if (shape === 'parts') {
    descriptor.parts = [{ data: evidence, mediaType: 'application/json' }];
    delete descriptor.data;
  }
  return artifacts;
}

class FakeOrchestrator {
  constructor() {
    this.calls = [];
  }

  async run(input) {
    this.calls.push(input);
    if (input.operation.date === '2026-07-24') {
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const error = new Error('fake run canceled');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    const runId = `run-${this.calls.length}`;
    return {
      taskId: `orchestrator-task-${this.calls.length}`,
      runId,
      reportDate: input.operation.date || '2026-07-23',
      outcome: 'complete',
      taskState: 'TASK_STATE_COMPLETED',
      deliveryRequested: false,
      emailStatus: 'not-requested',
      artifacts: completedArtifacts(runId)
    };
  }
}

async function startHarness(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'market-a2a-'));
  const orchestrator = overrides.orchestrator || new FakeOrchestrator();
  const defaultRunLoader = async (runId, owner) => ({
    id: `orchestrator-${runId}`,
    runId,
    ownerScope: owner,
    reportDate: '2026-07-23',
    status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: completedArtifacts(runId)
  });
  const runLoader = Object.hasOwn(overrides, 'runLoader')
    ? overrides.runLoader
    : defaultRunLoader;
  const server = createMarketAgentServer({
    config: {
      stateDir,
      publicBaseUrl: '',
      accessToken: 'configured-secret-must-never-appear',
      timezone: 'Asia/Shanghai'
    },
    orchestrator,
    runLoader,
    authenticate({ token }) {
      return ['owner-a', 'owner-b'].includes(token) ? { owner: token } : null;
    },
    ...overrides
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, orchestrator };
}

function expectedOwnerScope(principal) {
  return `owner-sha256:${createHash('sha256').update(principal).digest('hex')}`;
}

async function a2aFetch(origin, pathname, options = {}) {
  const headers = {
    ...A2A_HEADERS,
    ...(options.headers || {})
  };
  if (options.body === undefined) delete headers['content-type'];
  return fetch(`${origin}${pathname}`, { ...options, headers });
}

async function json(response) {
  return JSON.parse(await response.text());
}

function assertA2aJson(response) {
  assert.match(response.headers.get('content-type') || '', /^application\/a2a\+json\b/);
}

function assertError(payload, { code, status, reason }) {
  assert.equal(payload.error.code, code);
  assert.equal(payload.error.status, status);
  assert.equal(typeof payload.error.message, 'string');
  assert.ok(payload.error.message.length > 0);
  assert.ok(Array.isArray(payload.error.details));
  assert.equal(payload.error.details[0]['@type'], 'type.googleapis.com/google.rpc.ErrorInfo');
  assert.equal(payload.error.details[0].reason, reason);
  assert.equal(payload.error.details[0].domain, 'a2a-protocol.org');
}

const SKILL_ROOT = new URL('../agents/market-analyst/skills/', import.meta.url);
const SKILL_TOOL_BOUNDARIES = {
  'daily-market-report': [
    'narrative-adapter',
    'panda-market-worker',
    'report-renderer',
    'report-validator'
  ],
  'hot-topic-analysis': [
    'narrative-adapter',
    'panda-market-worker',
    'report-renderer',
    'report-validator'
  ],
  'sell-pressure-scan': [
    'narrative-adapter',
    'panda-market-worker',
    'report-renderer',
    'report-validator'
  ],
  'potential-watchlist': [
    'narrative-adapter',
    'panda-market-worker',
    'report-renderer',
    'report-validator'
  ],
  'inspect-run-trace': ['run-store']
};

const REQUIRED_SKILL_SECTIONS = [
  'Input contract',
  'Deterministic workflow',
  'Panda-only financial data boundary',
  'Freshness, coverage, and missing-data rules',
  'Output schema and trace requirements',
  'Research-only safety boundary'
];

function parseSkillFrontMatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  assert.ok(match, 'SKILL.md must start with YAML front matter');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    fields[key] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

function parseAllowedTools(value) {
  assert.match(value || '', /^\[[^\]]*\]$/, 'allowed-tools must be an inline YAML list');
  return value.slice(1, -1)
    .split(',')
    .map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter(Boolean)
    .sort();
}

test('well-known Agent Card declares the exact A2A 1.0 market interface and five skills', async (t) => {
  const { origin } = await startHarness(t);
  const response = await fetch(`${origin}/.well-known/agent-card.json`);
  assert.equal(response.status, 200);
  assertA2aJson(response);
  const card = await json(response);

  assert.equal(card.name, 'Panda Market Analyst');
  assert.equal(card.version, '1.0.0');
  assert.deepEqual(card.supportedInterfaces, [{
    url: `${origin}/a2a/v1`,
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }]);
  assert.deepEqual(card.capabilities, {
    streaming: true,
    pushNotifications: false
  });
  assert.deepEqual(card.defaultInputModes, ['text/plain', 'application/json']);
  assert.deepEqual(card.defaultOutputModes, ['text/markdown', 'application/json']);
  assert.deepEqual(card.skills.map(({ id }) => id), [
    'daily-market-report',
    'hot-topic-analysis',
    'sell-pressure-scan',
    'potential-watchlist',
    'inspect-run-trace'
  ]);
  for (const skill of card.skills) {
    assert.ok(skill.name);
    assert.ok(skill.description);
    assert.ok(skill.tags.length);
    assert.ok(skill.examples.length);
  }
  assert.deepEqual(card.securitySchemes, {
    bearerAuth: {
      httpAuthSecurityScheme: {
        description: 'Bearer token for protected Panda Market Analyst operations',
        scheme: 'Bearer',
        bearerFormat: 'opaque'
      }
    }
  });
  assert.deepEqual(card.securityRequirements, [{
    schemes: { bearerAuth: { list: [] } }
  }]);
  assert.equal(JSON.stringify(card).includes('configured-secret-must-never-appear'), false);
});

test('diagnostics negotiates the protected market Agent Card for ordinary and streaming calls', async (t) => {
  const { origin } = await startHarness(t);
  const card = await json(await fetch(`${origin}/.well-known/agent-card.json`));

  const report = await runAgentDiagnostics({
    agentCard: card,
    authMethod: 'bearer',
    agentAuthorization: 'owner-a',
    confirmAuthorizationTarget: true,
    prompt: card.skills[0].examples[0],
    timeoutMs: 300_000,
    runStreaming: true,
    confirmStreamingSideEffects: true,
    attestations: {
      deepseekV4Pro: true,
      authorizedDataOnly: true
    }
  }, { allowPrivate: true });

  assert.equal(report.ok, true);
  assert.equal(report.streamingOk, true);
  assert.deepEqual(
    report.checks.map(({ id, status }) => [id, status]),
    [
      ['card-input', 'passed'],
      ['card-validation', 'passed'],
      ['call', 'passed'],
      ['stream', 'passed']
    ]
  );
  assert.deepEqual(
    report.checks[1].details.acceptedOutputModes,
    ['text/markdown', 'application/json']
  );
});

test('repository Skills stay synchronized with the Agent Card and tool boundaries', async (t) => {
  const { origin } = await startHarness(t);
  const card = await json(await fetch(`${origin}/.well-known/agent-card.json`));
  const expectedIds = card.skills.map(({ id }) => id).sort();
  const loaded = await Promise.all(expectedIds.map(async (id) => {
    const source = await readFile(new URL(`${id}/SKILL.md`, SKILL_ROOT), 'utf8');
    return { id, source, frontMatter: parseSkillFrontMatter(source) };
  }));

  assert.deepEqual(loaded.map(({ frontMatter }) => frontMatter.name).sort(), expectedIds);
  for (const { id, source, frontMatter } of loaded) {
    assert.equal(frontMatter.name, id, `${id} path must declare the same Skill name`);
    assert.ok(frontMatter.description, `${id} must have a trigger description`);
    assert.match(frontMatter.description, /^Use when\b/);
    assert.equal(frontMatter['financial-data-source'], 'panda_data-only');
    assert.equal(frontMatter['trading-execution'], 'prohibited');
    assert.equal(frontMatter['portfolio-execution'], 'prohibited');
    assert.equal(frontMatter['missing-data-fabrication'], 'prohibited');
    assert.equal(frontMatter['research-use'], 'only');
    const tools = parseAllowedTools(frontMatter['allowed-tools']);
    assert.deepEqual(
      tools,
      SKILL_TOOL_BOUNDARIES[id],
      `${id} exposes an unexpected internal tool`
    );
    for (const section of REQUIRED_SKILL_SECTIONS) {
      assert.match(source, new RegExp(`^## ${section}$`, 'm'), `${id} is missing ${section}`);
    }
    if (id === 'sell-pressure-scan') {
      assert.equal(
        frontMatter['score-components'],
        '[downside_volume=0.25, lhb_net_sell=0.25, northbound_reduction=0.20, margin_contraction=0.15, discount_event=0.15]'
      );
      assert.equal(frontMatter['minimum-components'], '3');
    }
    if (id === 'hot-topic-analysis') {
      assert.equal(
        frontMatter['score-components'],
        '[ret1=0.25, ret5=0.20, breadth5=0.20, turnover_heat=0.15, acceleration=0.15, lhb_activity=0.05]'
      );
      assert.equal(frontMatter['required-components'], '[ret1, ret5, breadth5, turnover_heat, acceleration]');
      assert.equal(frontMatter['optional-components'], '[lhb_activity]');
      assert.equal(frontMatter['minimum-constituents'], '5');
      assert.equal(frontMatter['minimum-constituent-price-coverage'], '0.80');
    }
    if (id === 'potential-watchlist') {
      assert.equal(
        frontMatter['score-components'],
        '[trend=0.25, theme=0.15, quality=0.20, valuation=0.15, capital=0.15, liquidity_stability=0.10]'
      );
      assert.equal(frontMatter['risk-adjustment'], 'separate-penalty');
      assert.equal(
        frontMatter.vetoes,
        '[ST_OR_DELISTING_RISK, NONSTANDARD_AUDIT, LARGE_UNLOCK_30D]'
      );
      assert.equal(frontMatter['minimum-components'], '4');
      assert.equal(frontMatter['minimum-component-weight-coverage'], '0.70');
    }
  }
});

test('health is public while A2A task and run-detail routes require Bearer authentication', async (t) => {
  const { origin } = await startHarness(t);
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await json(health), { ok: true, agent: 'panda-market-analyst' });

  for (const pathname of [
    '/a2a/v1/tasks',
    '/runs/run-1',
    '/runs/run-1/report',
    '/runs/run-1/evidence',
    '/runs/run-1/trace'
  ]) {
    const response = await fetch(`${origin}${pathname}`, {
      headers: { 'a2a-version': '1.0' }
    });
    assert.equal(response.status, 401, pathname);
    assert.match(response.headers.get('www-authenticate') || '', /^Bearer\b/);
    if (pathname.startsWith('/a2a/')) {
      assertA2aJson(response);
      assertError(await json(response), {
        code: 401,
        status: 'UNAUTHENTICATED',
        reason: 'UNAUTHENTICATED'
      });
    }
  }
});

test('tokenless mode requires an explicit loopback-only development flag', () => {
  const orchestrator = new FakeOrchestrator();
  const base = {
    stateDir: os.tmpdir(),
    accessToken: '',
    timezone: 'Asia/Shanghai'
  };
  assert.throws(
    () => createMarketAgentServer({
      config: { ...base, host: '127.0.0.1' },
      orchestrator
    }),
    /access token|loopback development/i
  );
  assert.throws(
    () => createMarketAgentServer({
      config: {
        ...base,
        host: '0.0.0.0',
        allowInsecureLoopback: true
      },
      orchestrator
    }),
    /loopback/i
  );
  const server = createMarketAgentServer({
    config: {
      ...base,
      host: '127.0.0.1',
      allowInsecureLoopback: true
    },
    orchestrator
  });
  server.close();
});

test('all A2A operations reject a missing or unsupported A2A-Version', async (t) => {
  const { origin } = await startHarness(t);
  for (const version of [undefined, '0.3', '1.1']) {
    const headers = { authorization: 'Bearer owner-a' };
    if (version !== undefined) headers['a2a-version'] = version;
    const response = await fetch(`${origin}/a2a/v1/tasks`, { headers });
    assert.equal(response.status, 400);
    assertA2aJson(response);
    assertError(await json(response), {
      code: 400,
      status: 'FAILED_PRECONDITION',
      reason: 'VERSION_NOT_SUPPORTED'
    });
  }
});

test('message:send returns a completed Task and deduplicates messageId per owner', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  const body = JSON.stringify(messageRequest(
    'message-dedupe',
    { text: '生成 2026-07-23 的每日市场报告' }
  ));

  const firstResponse = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body
  });
  assert.equal(firstResponse.status, 200);
  assertA2aJson(firstResponse);
  const first = await json(firstResponse);
  assert.equal(first.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(typeof first.task.status.timestamp, 'string');
  assert.ok(first.task.contextId);
  assert.equal(first.task.history[0].messageId, 'message-dedupe');
  assert.ok(first.task.metadata.createdAt);
  assert.ok(first.task.metadata.lastModified);

  const duplicate = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body
  }));
  assert.equal(duplicate.task.id, first.task.id);
  assert.equal(orchestrator.calls.length, 1);
  assert.deepEqual({
    owner: orchestrator.calls[0].owner,
    operation: orchestrator.calls[0].operation,
    trigger: orchestrator.calls[0].trigger,
    deliverEmail: orchestrator.calls[0].deliverEmail
  }, {
    owner: expectedOwnerScope('owner-a'),
    operation: {
      operation: 'daily-market-report',
      date: '2026-07-23',
      sections: [],
      topN: 10
    },
    trigger: 'a2a',
    deliverEmail: false
  });

  const otherOwner = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    headers: { authorization: 'Bearer owner-b' },
    body
  }));
  assert.notEqual(otherOwner.task.id, first.task.id);
  assert.equal(orchestrator.calls.length, 2);
});

test('message:stream emits Task, working status, artifacts, and terminal status in order', async (t) => {
  const { origin } = await startHarness(t);
  const response = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-stream',
      { data: { operation: 'hot-topic-analysis', date: '2026-07-23', topN: 8 } }
    ))
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream\b/);
  const events = parseSseEvents(await response.text());
  assert.ok(events.length >= 4);
  assert.deepEqual(Object.keys(events[0]), ['task']);
  assert.equal(events[0].task.status.state, 'TASK_STATE_SUBMITTED');
  assert.deepEqual(Object.keys(events[1]), ['statusUpdate']);
  assert.equal(events[1].statusUpdate.status.state, 'TASK_STATE_WORKING');
  const artifactIndexes = events
    .map((event, index) => event.artifactUpdate ? index : -1)
    .filter((index) => index >= 0);
  assert.ok(artifactIndexes.length >= 1);
  const terminalIndex = events.findIndex(
    (event) => event.statusUpdate?.status?.state === 'TASK_STATE_COMPLETED'
  );
  assert.ok(terminalIndex > Math.max(...artifactIndexes));
  for (const event of events) {
    assert.equal(
      ['task', 'statusUpdate', 'artifactUpdate'].filter((key) => key in event).length,
      1
    );
  }
});

test('stream artifact events stay within the evaluator 64 KB event limit', async (t) => {
  const artifactLoader = async () => [{
    artifactId: 'oversized-artifact-id-'.padEnd(70_000, 'i'),
    name: 'market-report.md',
    mediaType: 'text/markdown',
    content: `# Large report\n\n${'x'.repeat(100_000)}`
  }, ...completedArtifacts('run-large').slice(1)];
  const { origin } = await startHarness(t, { artifactLoader });
  const response = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-large-stream-artifact',
      { text: '生成 2026-07-23 的每日市场报告' }
    ))
  });
  const raw = await response.text();
  const events = parseSseEvents(raw);
  const artifacts = events.filter((event) => event.artifactUpdate);
  assert.ok(artifacts.length >= 1);
  for (const frame of raw.split('\n\n').filter(Boolean)) {
    assert.ok(Buffer.byteLength(`${frame}\n\n`) <= 64 * 1024);
  }
});

test('duplicate completed streams keep every SSE event within 64 KB', async (t) => {
  const artifactLoader = async () => [{
    name: 'market-report.md',
    mediaType: 'text/markdown',
    content: `# Large report\n\n${'x'.repeat(100_000)}`
  }, ...completedArtifacts('run-large-replay').slice(1)];
  const { origin } = await startHarness(t, { artifactLoader });
  const body = JSON.stringify(messageRequest(
    'message-large-stream-replay',
    { text: 'Generate the daily market report for 2026-07-23' }
  ));
  const completed = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body
  });
  assert.equal(completed.status, 200);

  const replay = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body
  });
  const events = parseSseEvents(await replay.text());
  assert.ok(events.length >= 1);
  assert.equal(events[0].task.status.state, 'TASK_STATE_COMPLETED');
  for (const event of events) {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024);
  }
});

test('duplicate streams bound aggregate artifact metadata in the initial Task event', async (t) => {
  const artifactLoader = async () => Array.from({ length: 16 }, (_, index) => ({
    name: `${`artifact-${index}-`.padEnd(195, 'n')}.json`,
    mediaType: 'application/json',
    data: { index },
    description: 'metadata'.repeat(2_000),
    size: 10_000 + index,
    sha256: 'a'.repeat(64)
  }));
  const { origin } = await startHarness(t, { artifactLoader });
  const body = JSON.stringify(messageRequest(
    'message-aggregate-stream-replay',
    { text: 'Generate the daily market report for 2026-07-23' }
  ));
  await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body
  });

  const replay = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body
  });
  const events = parseSseEvents(await replay.text());
  assert.equal(events[0].task.status.state, 'TASK_STATE_COMPLETED');
  for (const event of events) {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024);
  }
});

test('completed tasks expose Markdown, Evidence Pack, and Run Trace artifacts', async (t) => {
  const { origin } = await startHarness(t);
  const result = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-artifacts',
      { text: '分析最近一个交易日最热的行业和概念' }
    ))
  }));
  const byName = Object.fromEntries(result.task.artifacts.map((artifact) => [
    artifact.name,
    artifact
  ]));
  assert.match(byName['market-report.md'].parts[0].text, /^# hot-topic-analysis/);
  assert.equal(byName['market-report.md'].parts[0].mediaType, 'text/markdown');
  assert.equal(byName['evidence-pack.json'].parts[0].data.schemaVersion, '1.0');
  assert.ok(Array.isArray(byName['run-trace.json'].parts[0].data.steps));
  assert.equal(
    JSON.stringify(byName['run-trace.json']).includes('must-never-escape'),
    false
  );
});

test('get and list hide tasks owned by another authenticated caller', async (t) => {
  const { origin } = await startHarness(t);
  const created = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-private',
      { text: '列出卖压最明显的十只 A 股' }
    ))
  }));

  const ownGet = await a2aFetch(origin, `/a2a/v1/tasks/${created.task.id}`);
  assert.equal(ownGet.status, 200);
  assert.equal((await json(ownGet)).id, created.task.id);

  const hiddenGet = await a2aFetch(origin, `/a2a/v1/tasks/${created.task.id}`, {
    headers: { authorization: 'Bearer owner-b' }
  });
  assert.equal(hiddenGet.status, 404);
  assertError(await json(hiddenGet), {
    code: 404,
    status: 'NOT_FOUND',
    reason: 'TASK_NOT_FOUND'
  });

  const ownList = await json(await a2aFetch(origin, '/a2a/v1/tasks'));
  assert.deepEqual(ownList.tasks.map(({ id }) => id), [created.task.id]);
  assert.equal(ownList.totalSize, 1);

  const hiddenList = await json(await a2aFetch(origin, '/a2a/v1/tasks', {
    headers: { authorization: 'Bearer owner-b' }
  }));
  assert.deepEqual(hiddenList.tasks, []);
  assert.equal(hiddenList.totalSize, 0);
});

test('list uses descending status time, opaque pagination, filters, and optional artifacts', async (t) => {
  const { origin } = await startHarness(t);
  const first = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-list-first', { text: '生成报告' }))
  }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-list-second', { text: '生成报告' }))
  }));

  const firstPage = await json(await a2aFetch(
    origin,
    '/a2a/v1/tasks?pageSize=1'
  ));
  assert.deepEqual(firstPage.tasks.map(({ id }) => id), [second.task.id]);
  assert.equal('artifacts' in firstPage.tasks[0], false);
  assert.ok(firstPage.nextPageToken);
  assert.notEqual(firstPage.nextPageToken, '1');

  const secondPage = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks?pageSize=1&pageToken=${encodeURIComponent(firstPage.nextPageToken)}`
  ));
  assert.deepEqual(secondPage.tasks.map(({ id }) => id), [first.task.id]);
  assert.equal(secondPage.nextPageToken, '');

  const filtered = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks?statusTimestampAfter=${encodeURIComponent(second.task.status.timestamp)}`
  ));
  assert.deepEqual(filtered.tasks.map(({ id }) => id), [second.task.id]);

  const withArtifacts = await json(await a2aFetch(
    origin,
    '/a2a/v1/tasks?includeArtifacts=true&pageSize=1'
  ));
  assert.ok(withArtifacts.tasks[0].artifacts.length >= 3);
});

test('list cursor remains stable when a newer task is inserted between pages', async (t) => {
  const { origin } = await startHarness(t);
  const oldest = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cursor-oldest',
      { text: 'Generate the daily market report' }
    ))
  }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const pageAnchor = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cursor-anchor',
      { text: 'Generate the daily market report' }
    ))
  }));
  const firstPage = await json(await a2aFetch(origin, '/a2a/v1/tasks?pageSize=1'));
  assert.deepEqual(firstPage.tasks.map(({ id }) => id), [pageAnchor.task.id]);

  await new Promise((resolve) => setTimeout(resolve, 2));
  await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cursor-newer',
      { text: 'Generate the daily market report' }
    ))
  });
  const secondPage = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks?pageSize=1&pageToken=${encodeURIComponent(firstPage.nextPageToken)}`
  ));
  assert.deepEqual(secondPage.tasks.map(({ id }) => id), [oldest.task.id]);
});

test('cancel is idempotent for a canceled task and aborts active orchestration', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  const submitted = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cancel',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  assert.ok([
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING'
  ].includes(submitted.task.status.state));

  const firstCancel = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks/${submitted.task.id}:cancel`,
    { method: 'POST', body: '{}' }
  ));
  assert.equal(firstCancel.status.state, 'TASK_STATE_CANCELED');

  const secondCancel = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks/${submitted.task.id}:cancel`,
    { method: 'POST', body: '{}' }
  ));
  assert.equal(secondCancel.id, firstCancel.id);
  assert.equal(secondCancel.status.state, 'TASK_STATE_CANCELED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(orchestrator.calls[0].signal.aborted, true);
});

test('cancellation during artifact loading emits nothing after the canceled terminal event', async (t) => {
  let releaseArtifacts;
  let markArtifactLoadStarted;
  const artifactLoadStarted = new Promise((resolve) => {
    markArtifactLoadStarted = resolve;
  });
  const artifactLoader = async () => {
    markArtifactLoadStarted();
    return new Promise((resolve) => {
      releaseArtifacts = () => resolve(completedArtifacts('run-delayed'));
    });
  };
  const { origin, server } = await startHarness(t, { artifactLoader });
  const active = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-cancel-artifacts',
      { data: { operation: 'daily-market-report', date: '2026-07-23' } },
      { returnImmediately: true }
    ))
  }));
  await artifactLoadStarted;
  const events = [];
  const unsubscribe = server.marketTaskService.subscribe(
    active.task.id,
    'owner-a',
    (event) => events.push(event)
  );
  await a2aFetch(origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
  releaseArtifacts();
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();

  const canceled = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks/${active.task.id}`
  ));
  assert.equal(canceled.status.state, 'TASK_STATE_CANCELED');
  assert.deepEqual(canceled.artifacts, []);
  assert.deepEqual(
    events.map((event) => Object.keys(event)[0]),
    ['statusUpdate']
  );
  assert.equal(events[0].statusUpdate.status.state, 'TASK_STATE_CANCELED');
});

test('subscribe rejects terminal tasks and streams an active task through cancellation', async (t) => {
  const { origin, server } = await startHarness(t);
  const completed = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-terminal-subscribe',
      { text: '生成每日市场报告' }
    ))
  }));
  const terminalResponse = await a2aFetch(
    origin,
    `/a2a/v1/tasks/${completed.task.id}:subscribe`,
    { method: 'POST', body: '{}' }
  );
  assert.equal(terminalResponse.status, 400);
  assertError(await json(terminalResponse), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });

  const active = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-active-subscribe',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  const subscribe = await a2aFetch(
    origin,
    `/a2a/v1/tasks/${active.task.id}:subscribe`,
    { method: 'POST', body: '{}' }
  );
  assert.equal(subscribe.status, 200);
  await a2aFetch(origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
  const events = parseSseEvents(await subscribe.text());
  assert.deepEqual(Object.keys(events[0]), ['task']);
  assert.equal(events.at(-1).statusUpdate.status.state, 'TASK_STATE_CANCELED');
  assert.equal(
    server.marketTaskService.tasks.get(active.task.id).emitter.listenerCount('event'),
    0
  );
});

test('active task subscriptions have a hard per-task listener bound', async (t) => {
  const { origin, server } = await startHarness(t);
  const active = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-listener-bound',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  const releases = Array.from({ length: 64 }, () =>
    server.marketTaskService.subscribe(active.task.id, 'owner-a', () => {})
  );
  assert.throws(
    () => server.marketTaskService.subscribe(active.task.id, 'owner-a', () => {}),
    (error) => error.reason === 'RESOURCE_EXHAUSTED' && error.statusCode === 429
  );
  const overflowResponse = await a2aFetch(
    origin,
    `/a2a/v1/tasks/${active.task.id}:subscribe`,
    {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(1_000)
    }
  );
  assert.equal(overflowResponse.status, 429);
  assertError(await json(overflowResponse), {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    reason: 'RESOURCE_EXHAUSTED'
  });
  releases.forEach((release) => release());
  await a2aFetch(origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
});

test('task capacity preserves unexpired idempotency and active admission is capped', async (t) => {
  const { origin, server, orchestrator } = await startHarness(t, {
    maxTasks: 2,
    maxActiveTasks: 1
  });
  const completed = [];
  for (let index = 0; index < 2; index += 1) {
    completed.push(await json(await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(
        `message-bounded-${index}`,
        { text: '生成报告' }
      ))
    })));
  }
  const retainedOverflow = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-bounded-2',
      { text: 'Generate the daily market report' }
    ))
  });
  assert.equal(retainedOverflow.status, 429);
  assert.equal(server.marketTaskService.tasks.size, 2);
  assert.equal(server.marketTaskService.idempotency.size, 2);
  const replay = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-bounded-0',
      { text: 'Generate the daily market report' }
    ))
  }));
  assert.equal(replay.task.id, completed[0].task.id);
  assert.equal(orchestrator.calls.length, 2);

  const activeHarness = await startHarness(t, {
    maxTasks: 2,
    maxActiveTasks: 1
  });
  const active = await json(await a2aFetch(activeHarness.origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-active-limit-1',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  const overflow = await a2aFetch(activeHarness.origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-active-limit-2',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  });
  assert.equal(overflow.status, 429);
  assertError(await json(overflow), {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    reason: 'RESOURCE_EXHAUSTED'
  });
  await a2aFetch(activeHarness.origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
});

test('malformed requests and unsupported operations use structured A2A errors', async (t) => {
  const { origin } = await startHarness(t);
  const malformed = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: '{"message":'
  });
  assert.equal(malformed.status, 400);
  assertError(await json(malformed), {
    code: 400,
    status: 'INVALID_ARGUMENT',
    reason: 'INVALID_REQUEST'
  });

  const unsupported = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-unsupported',
      { data: { operation: 'arbitrary-panda-method' } }
    ))
  });
  assert.equal(unsupported.status, 400);
  assertError(await json(unsupported), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });

  const pushConfiguration = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-push',
      { text: '生成报告' },
      { taskPushNotificationConfig: { url: 'https://attacker.example/webhook' } }
    ))
  });
  assert.equal(pushConfiguration.status, 400);
  assertError(await json(pushConfiguration), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED'
  });

  const pushRoute = await a2aFetch(
    origin,
    '/a2a/v1/tasks/task-1/pushNotificationConfigs',
    {
      method: 'POST',
      body: '{}'
    }
  );
  assert.equal(pushRoute.status, 400);
  assertError(await json(pushRoute), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED'
  });

  const unknownRoute = await a2aFetch(origin, '/a2a/v1/unknown:operation', {
    method: 'POST',
    body: '{}'
  });
  assert.equal(unknownRoute.status, 400);
  assertError(await json(unknownRoute), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });
});

test('request bodies require application/a2a+json and are limited to 1 MB', async (t) => {
  const { origin } = await startHarness(t);
  const wrongType = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(messageRequest('message-type', { text: '生成报告' }))
  });
  assert.equal(wrongType.status, 400);
  assertError(await json(wrongType), {
    code: 400,
    status: 'INVALID_ARGUMENT',
    reason: 'CONTENT_TYPE_NOT_SUPPORTED'
  });

  const oversized = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-large',
      { text: `生成报告${'x'.repeat(1024 * 1024)}` }
    ))
  });
  assert.equal(oversized.status, 413);
  assertError(await json(oversized), {
    code: 413,
    status: 'RESOURCE_EXHAUSTED',
    reason: 'REQUEST_TOO_LARGE'
  });
});

test('structured operations are whitelisted and A2A never forwards caller overrides or email', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-whitelist', {
      data: {
        operation: 'potential-watchlist',
        date: '2026-07-23',
        topN: 7,
        pandaMethod: 'get_arbitrary_method',
        deliverEmail: true,
        recipient: 'attacker@example.com',
        outputPath: 'C:\\attacker-output'
      }
    }))
  });
  const call = orchestrator.calls[0];
  assert.deepEqual(call.operation, {
    operation: 'potential-watchlist',
    date: '2026-07-23',
    sections: [],
    topN: 7
  });
  assert.equal(call.trigger, 'a2a');
  assert.equal(call.deliverEmail, false);
  assert.equal('forceDelivery' in call, false);
  assert.equal('recipient' in call, false);
  assert.equal('pandaMethod' in call.operation, false);
  assert.equal('outputPath' in call.operation, false);
});

test('inspect-run-trace is store-only and protected run routes return sanitized artifacts', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  const inspected = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-inspect', {
      data: { operation: 'inspect-run-trace', runId: 'run-existing' }
    }))
  }));
  assert.equal(orchestrator.calls.length, 0);
  assert.equal(inspected.task.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(
    inspected.task.artifacts.map(({ name }) => name),
    ['run-trace.json']
  );

  const detail = await json(await fetch(`${origin}/runs/run-existing`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.equal(detail.runId, 'run-existing');

  const report = await json(await fetch(`${origin}/runs/run-existing/report`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.match(report.report, /^# Market report/);

  const evidence = await json(await fetch(`${origin}/runs/run-existing/evidence`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.equal(evidence.schemaVersion, '1.0');

  const traceResponse = await fetch(`${origin}/runs/run-existing/trace`, {
    headers: { authorization: 'Bearer owner-a' }
  });
  const traceText = await traceResponse.text();
  assert.equal(traceText.includes('must-never-escape'), false);
  assert.ok(JSON.parse(traceText).steps);
});

test('inspect-run-trace returns an authorized trace directly for analytical runs', async (t) => {
  const runId = 'run-analytical-inspect';
  const orchestrator = new FakeOrchestrator();
  const artifacts = analyticalArtifacts(runId);
  artifacts[2].data.authorization = 'Bearer inspect-secret';
  const { origin } = await startHarness(t, {
    orchestrator,
    runLoader: async (loadedRunId, ownerScope) => ({
      id: `orchestrator-${loadedRunId}`,
      runId: loadedRunId,
      ownerScope,
      reportDate: '2026-07-23',
      operation: 'daily-market-report',
      requestedOperation: 'hot-topic-analysis',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts
    }),
    artifactLoader: async () => artifacts
  });
  const inspectPart = {
    data: { operation: 'inspect-run-trace', runId }
  };

  const sent = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-inspect-analytical-send', inspectPart))
  }));
  assert.equal(sent.task.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(sent.task.artifacts.map(({ name }) => name), ['run-trace.json']);
  const sentTrace = sent.task.artifacts[0].parts[0].data;
  assert.deepEqual(
    sentTrace.workerEvents,
    [{ marker: 'UNRELATED-WORKER-EVENT' }]
  );
  assert.equal(JSON.stringify(sentTrace).includes('inspect-secret'), false);

  const taskDetail = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks/${sent.task.id}`
  ));
  assert.deepEqual(taskDetail.artifacts.map(({ name }) => name), ['run-trace.json']);
  assert.deepEqual(
    taskDetail.artifacts[0].parts[0].data.workerEvents,
    sentTrace.workerEvents
  );

  const streamed = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body: JSON.stringify(messageRequest('message-inspect-analytical-stream', inspectPart))
  });
  assert.equal(streamed.status, 200);
  const events = parseSseEvents(await streamed.text());
  const streamTrace = events.find(({ artifactUpdate }) =>
    artifactUpdate?.artifact?.name === 'run-trace.json'
  )?.artifactUpdate?.artifact;
  assert.ok(streamTrace);
  assert.deepEqual(
    streamTrace.parts[0].data.workerEvents,
    sentTrace.workerEvents
  );
  assert.equal(
    events.at(-1).statusUpdate.status.state,
    'TASK_STATE_COMPLETED'
  );
  assert.equal(orchestrator.calls.length, 0);
});

test('custom run loaders must attest the exact owner instead of failing open', async (t) => {
  const { origin } = await startHarness(t, {
    runLoader: async (runId) => ({
      runId,
      reportDate: '2026-07-23',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: completedArtifacts(runId)
    })
  });
  const response = await fetch(`${origin}/runs/run-global`, {
    headers: { authorization: 'Bearer owner-a' }
  });
  assert.equal(response.status, 404);
  assert.equal((await json(response)).error.status, 'NOT_FOUND');

  const mismatched = await startHarness(t, {
    runLoader: async (_runId, owner) => ({
      runId: 'run-different',
      ownerScope: owner,
      reportDate: '2026-07-23',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: completedArtifacts('run-different')
    })
  });
  const mismatchedResponse = await fetch(`${mismatched.origin}/runs/run-requested`, {
    headers: { authorization: 'Bearer owner-a' }
  });
  assert.equal(mismatchedResponse.status, 404);
});

test('persisted owner scope, not an in-memory task summary, authorizes every run route', async (t) => {
  const runId = 'run-persisted-owner-a';
  const persisted = {
    id: 'orchestrator-owner-a',
    runId,
    ownerScope: expectedOwnerScope('owner-a'),
    reportDate: '2026-07-23',
    status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: completedArtifacts(runId)
  };
  const orchestrator = {
    calls: [],
    store: {
      async list() {
        return [persisted];
      }
    },
    async run(input) {
      this.calls.push(input);
      return {
        taskId: `orchestrator-${this.calls.length}`,
        runId,
        reportDate: '2026-07-23',
        outcome: 'complete',
        taskState: 'TASK_STATE_COMPLETED',
        artifacts: completedArtifacts(runId)
      };
    }
  };
  const { origin } = await startHarness(t, {
    orchestrator,
    runLoader: undefined
  });

  for (const [token, messageId] of [
    ['owner-a', 'message-owner-a-run'],
    ['owner-b', 'message-owner-b-run']
  ]) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(messageRequest(
        messageId,
        { text: 'Generate the daily market report for 2026-07-23' }
      ))
    });
    assert.equal(response.status, 200);
  }

  for (const suffix of ['', '/report', '/evidence', '/trace']) {
    const ownerA = await fetch(`${origin}/runs/${runId}${suffix}`, {
      headers: { authorization: 'Bearer owner-a' }
    });
    assert.equal(ownerA.status, 200, `owner A ${suffix || '/detail'}`);

    const ownerB = await fetch(`${origin}/runs/${runId}${suffix}`, {
      headers: { authorization: 'Bearer owner-b' }
    });
    assert.equal(ownerB.status, 404, `owner B ${suffix || '/detail'}`);
  }
});

test('custom principals with a shared 200-character prefix never collide', async (t) => {
  const prefix = 'principal-prefix-'.padEnd(220, 'x');
  const principals = {
    'long-owner-a': `${prefix}A`,
    'long-owner-b': `${prefix}B`
  };
  const { origin, orchestrator } = await startHarness(t, {
    authenticate({ token }) {
      return principals[token] ? { owner: principals[token] } : null;
    }
  });
  const ids = [];
  for (const token of Object.keys(principals)) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(messageRequest(
        'same-message-id',
        { text: 'Generate the daily market report for 2026-07-23' }
      ))
    });
    assert.equal(response.status, 200);
    ids.push((await json(response)).task.id);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(orchestrator.calls.length, 2);
  assert.notEqual(orchestrator.calls[0].owner, orchestrator.calls[1].owner);
  assert.match(orchestrator.calls[0].owner, /^owner-sha256:[a-f0-9]{64}$/);
  assert.match(orchestrator.calls[1].owner, /^owner-sha256:[a-f0-9]{64}$/);
});

test('a scope-shaped custom principal cannot impersonate the principal that hashes to it', async (t) => {
  const victim = 'victim-principal';
  const principals = {
    victim,
    attacker: expectedOwnerScope(victim)
  };
  const { origin, orchestrator } = await startHarness(t, {
    authenticate({ token }) {
      return principals[token] ? { owner: principals[token] } : null;
    }
  });
  const ids = [];
  for (const token of Object.keys(principals)) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(messageRequest(
        'same-scope-shaped-message-id',
        { text: 'Generate the daily market report for 2026-07-23' }
      ))
    });
    assert.equal(response.status, 200);
    ids.push((await json(response)).task.id);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(orchestrator.calls.length, 2);
  assert.notEqual(orchestrator.calls[0].owner, orchestrator.calls[1].owner);
});

test('all advertised analytical skills return only their requested report section', async (t) => {
  const { origin } = await startHarness(t, {
    artifactLoader: async (summary) => analyticalArtifacts(summary.runId)
  });
  const cases = [
    {
      operation: 'hot-topic-analysis',
      leaderboardKeys: ['hotIndustries', 'hotConcepts'],
      sourceId: 'source-hot',
      missingSections: ['hotIndustries'],
      marker: 'HOT-MARKER',
      excluded: ['SELL-MARKER', 'POTENTIAL-MARKER']
    },
    {
      operation: 'sell-pressure-scan',
      leaderboardKeys: ['sellPressure'],
      sourceId: 'source-sell',
      missingSections: ['sellPressure'],
      marker: 'SELL-MARKER',
      excluded: ['HOT-MARKER', 'POTENTIAL-MARKER']
    },
    {
      operation: 'potential-watchlist',
      leaderboardKeys: ['potentialWatchlist'],
      sourceId: 'source-potential',
      missingSections: ['potentialWatchlist'],
      marker: 'POTENTIAL-MARKER',
      excluded: ['HOT-MARKER', 'SELL-MARKER']
    }
  ];

  for (const item of cases) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(
        `message-${item.operation}`,
        { data: { operation: item.operation, date: '2026-07-23', topN: 10 } }
      ))
    });
    assert.equal(response.status, 200, item.operation);
    const { task } = await json(response);
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(task.metadata.operation, item.operation);
    assert.deepEqual(
      task.artifacts.map(({ name }) => name),
      ['market-report.md', 'evidence-pack.json', 'run-trace.json']
    );
    const byName = Object.fromEntries(task.artifacts.map((artifact) => [
      artifact.name,
      artifact.parts[0]
    ]));
    assert.ok(task.artifacts.every(({ metadata }) =>
      !Object.hasOwn(metadata, 'size') && !Object.hasOwn(metadata, 'sha256')
    ));
    assert.match(byName['market-report.md'].text, new RegExp(item.marker));
    for (const marker of item.excluded) {
      assert.equal(byName['market-report.md'].text.includes(marker), false);
    }
    assert.deepEqual(
      Object.keys(byName['evidence-pack.json'].data.leaderboards),
      item.leaderboardKeys
    );
    assert.deepEqual(byName['evidence-pack.json'].data.markets, {});
    assert.doesNotThrow(() =>
      validateEvidencePack(byName['evidence-pack.json'].data)
    );
    assert.deepEqual(
      byName['evidence-pack.json'].data.sources.map(({ id }) => id),
      [item.sourceId]
    );
    assert.deepEqual(
      byName['evidence-pack.json'].data.missingData.map(({ section }) => section),
      item.missingSections
    );
    assert.equal(byName['run-trace.json'].data.requestedOperation, item.operation);
    assert.ok(byName['run-trace.json'].data.steps.every(
      ({ skillId }) => skillId === item.operation
    ));
    assert.equal('workerEvents' in byName['run-trace.json'].data, false);
    assert.equal('modelUsage' in byName['run-trace.json'].data, false);
    assert.equal('emailAttempts' in byName['run-trace.json'].data, false);
  }
});

test('large Evidence Pack lineage remains valid for every analytical projection', async (t) => {
  const cases = [
    {
      operation: 'hot-topic-analysis',
      shape: 'data',
      leaderboardKeys: ['hotIndustries', 'hotConcepts'],
      sourceId: 'source-hot-after-limit'
    },
    {
      operation: 'sell-pressure-scan',
      shape: 'content',
      leaderboardKeys: ['sellPressure'],
      sourceId: 'source-sell-after-limit'
    },
    {
      operation: 'potential-watchlist',
      shape: 'parts',
      leaderboardKeys: ['potentialWatchlist'],
      sourceId: 'source-potential-after-limit'
    }
  ];
  const shapeByOperation = Object.fromEntries(cases.map(({ operation, shape }) => [
    operation,
    shape
  ]));
  const { origin } = await startHarness(t, {
    artifactLoader: async (summary, { requestedOperation }) =>
      largeAnalyticalArtifacts(summary.runId, shapeByOperation[requestedOperation])
  });

  for (const item of cases) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(
        `message-large-lineage-${item.operation}`,
        { data: { operation: item.operation, date: '2026-07-23', topN: 10 } }
      ))
    });
    assert.equal(response.status, 200, item.operation);
    const { task } = await json(response);
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED', item.operation);
    const evidence = task.artifacts.find(
      ({ name }) => name === 'evidence-pack.json'
    ).parts[0].data;
    assert.deepEqual(Object.keys(evidence.leaderboards), item.leaderboardKeys);
    assert.doesNotThrow(() => validateEvidencePack(evidence));
    assert.ok(evidence.sources.some(({ id }) => id === item.sourceId));
    assert.equal(
      JSON.stringify(evidence).includes('large-lineage-secret-must-never-escape'),
      false
    );
  }
});

test('protected analytical run detail always applies the persisted public projection', async (t) => {
  const runId = 'run-protected-hot';
  const requestedOperation = 'hot-topic-analysis';
  const contexts = [];
  const { origin } = await startHarness(t, {
    runLoader: async (loadedRunId, ownerScope) => ({
      id: `orchestrator-${loadedRunId}`,
      runId: loadedRunId,
      ownerScope,
      reportDate: '2026-07-23',
      operation: 'daily-market-report',
      requestedOperation,
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: analyticalArtifacts(loadedRunId)
    }),
    artifactLoader: async (summary, context) => {
      contexts.push({ summary, context });
      return analyticalArtifacts(summary.runId);
    }
  });

  const detailResponse = await fetch(`${origin}/runs/${runId}`, {
    headers: { authorization: 'Bearer owner-a' }
  });
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(detail.requestedOperation, requestedOperation);
  assert.equal(JSON.stringify(detail).includes('SELL-MARKER'), false);
  assert.equal(JSON.stringify(detail).includes('POTENTIAL-MARKER'), false);

  const report = await json(await fetch(`${origin}/runs/${runId}/report`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.match(report.report, /HOT-MARKER/);
  assert.equal(report.report.includes('SELL-MARKER'), false);
  assert.equal(report.report.includes('POTENTIAL-MARKER'), false);

  const evidence = await json(await fetch(`${origin}/runs/${runId}/evidence`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.doesNotThrow(() => validateEvidencePack(evidence));
  assert.deepEqual(evidence.markets, {});
  assert.deepEqual(
    Object.keys(evidence.leaderboards),
    ['hotIndustries', 'hotConcepts']
  );
  assert.deepEqual(evidence.sources.map(({ id }) => id), ['source-hot']);
  assert.equal(JSON.stringify(evidence).includes('SELL-MARKER'), false);
  assert.equal(JSON.stringify(evidence).includes('POTENTIAL-MARKER'), false);
  assert.equal(JSON.stringify(evidence).includes('UNRELATED-MARKET'), false);

  const trace = await json(await fetch(`${origin}/runs/${runId}/trace`, {
    headers: { authorization: 'Bearer owner-a' }
  }));
  assert.equal(trace.requestedOperation, requestedOperation);
  assert.ok(trace.steps.every(({ skillId }) => skillId === requestedOperation));
  assert.equal(JSON.stringify(trace).includes('sell-pressure-scan'), false);
  assert.equal(JSON.stringify(trace).includes('potential-watchlist'), false);
  assert.ok(contexts.length >= 4);
  const expectedOwner = expectedOwnerScope('owner-a');
  assert.ok(contexts.every(({ summary, context }) =>
    summary.runId === runId
    && context.owner === expectedOwner
    && context.ownerScope === expectedOwner
    && context.runId === runId
    && context.requestedOperation === requestedOperation
    && context.taskId === `run-${runId}`
  ));
});

test('oversized analytical stream artifacts never link to an unprojected run artifact', async (t) => {
  const artifactLoader = async (summary) => {
    const artifacts = analyticalArtifacts(summary.runId);
    const rows = Array.from(
      { length: 60 },
      (_, index) => traceableRow(
        'hotIndustries',
        `HOT-${String(index).padStart(4, '0')}`,
        'source-hot',
        'ret1'
      )
    );
    artifacts[1].data.leaderboards.hotIndustries = rows;
    artifacts[1].data.conclusions = [
      ...artifacts[1].data.conclusions.filter(
        ({ leaderboard }) => leaderboard !== 'hotIndustries'
      ),
      ...rows.map((row) =>
        traceableConclusion('hotIndustries', row, 'source-hot', 'hot-topics')
      )
    ];
    return artifacts;
  };
  const { origin } = await startHarness(t, { artifactLoader });
  const request = messageRequest(
    'message-large-analytical-projection',
    { data: { operation: 'hot-topic-analysis', date: '2026-07-23' } }
  );
  const response = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body: JSON.stringify(request)
  });
  const raw = await response.text();
  const evidence = parseSseEvents(raw)
    .find(({ artifactUpdate }) =>
      artifactUpdate?.artifact?.name === 'evidence-pack.json'
    )?.artifactUpdate?.artifact;
  assert.ok(evidence, raw);
  assert.equal(evidence.parts.some(({ url }) => url?.startsWith('/runs/')), false);
  assert.equal(JSON.stringify(evidence).includes('SELL-MARKER'), false);
  for (const frame of raw.split('\n\n').filter(Boolean)) {
    assert.ok(Buffer.byteLength(`${frame}\n\n`) <= 64 * 1024);
  }

  const replay = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body: JSON.stringify(request)
  });
  const replayEvents = parseSseEvents(await replay.text());
  const replayEvidence = replayEvents[0].task.artifacts.find(
    ({ name }) => name === 'evidence-pack.json'
  );
  const replayMessage = replayEvidence.parts[0].data.message;
  assert.match(
    replayMessage,
    new RegExp(`/a2a/v1/tasks/${replayEvents[0].task.id}`)
  );
  assert.equal(replayMessage.includes('/runs/'), false);
});

test('analytical operations reject caller-selected arbitrary report sections', async (t) => {
  const { origin } = await startHarness(t);
  const response = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-arbitrary-sections',
      {
        data: {
          operation: 'hot-topic-analysis',
          date: '2026-07-23',
          sections: ['../../private-artifact']
        }
      }
    ))
  });
  assert.equal(response.status, 400);
  assertError(await json(response), {
    code: 400,
    status: 'INVALID_ARGUMENT',
    reason: 'INVALID_REQUEST'
  });
});

test('new message.taskId requests cannot mutate active deterministic operations', async (t) => {
  const { origin, orchestrator } = await startHarness(t);
  const active = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-continuation-root',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  const taskId = active.task.id;
  const continuationResponse = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(continuationRequest(
      'message-continuation-one',
      taskId,
      'Attempt to change the active deterministic operation',
      { returnImmediately: true, historyLength: 2 }
    ))
  });
  assert.equal(continuationResponse.status, 400);
  assertError(await json(continuationResponse), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });
  assert.equal(orchestrator.calls.length, 1);
  const unchanged = await json(await a2aFetch(origin, `/a2a/v1/tasks/${taskId}`));
  assert.deepEqual(
    unchanged.history.map(({ messageId }) => messageId),
    ['message-continuation-root']
  );

  const streamResponse = await a2aFetch(origin, '/a2a/v1/message:stream', {
    method: 'POST',
    body: JSON.stringify(continuationRequest(
      'message-continuation-stream',
      taskId,
      'Attempt to stream a mutation of the active operation'
    ))
  });
  if (streamResponse.status === 200) {
    await a2aFetch(origin, `/a2a/v1/tasks/${taskId}:cancel`, {
      method: 'POST',
      body: '{}'
    });
    await streamResponse.text();
  }
  assert.equal(streamResponse.status, 400);
  assertError(await json(streamResponse), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });
  await a2aFetch(origin, `/a2a/v1/tasks/${taskId}:cancel`, {
    method: 'POST',
    body: '{}'
  });
});

test('same-task messageId replay wins after exact context and even after completion', async (t) => {
  const { origin } = await startHarness(t);
  const terminal = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-terminal-replay-root',
      { data: { operation: 'daily-market-report', date: '2026-07-23' } }
    ))
  }));
  assert.equal(terminal.task.status.state, 'TASK_STATE_COMPLETED');

  const replayRequest = {
    message: {
      messageId: 'message-terminal-replay-root',
      taskId: terminal.task.id,
      contextId: terminal.task.contextId,
      role: 'ROLE_USER',
      parts: [{ text: 'This duplicate payload cannot mutate the task' }]
    },
    configuration: { historyLength: 1 }
  };
  const replayResponse = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(replayRequest)
  });
  assert.equal(replayResponse.status, 200);
  const replay = await json(replayResponse);
  assert.equal(replay.task.id, terminal.task.id);
  assert.equal(replay.task.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(
    replay.task.history.map(({ messageId }) => messageId),
    terminal.task.history.slice(-1).map(({ messageId }) => messageId)
  );

  const mismatchResponse = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify({
      ...replayRequest,
      message: {
        ...replayRequest.message,
        contextId: 'different-context'
      }
    })
  });
  assert.equal(mismatchResponse.status, 400);
  assertError(await json(mismatchResponse), {
    code: 400,
    status: 'INVALID_ARGUMENT',
    reason: 'INVALID_REQUEST'
  });
});

test('supplied contextId must be a nonempty bounded string and is preserved exactly', async (t) => {
  const { origin } = await startHarness(t);
  const validContext = 'c'.repeat(200);
  const validRequest = messageRequest(
    'message-context-valid',
    { data: { operation: 'daily-market-report', date: '2026-07-23' } }
  );
  validRequest.message.contextId = validContext;
  const validResponse = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(validRequest)
  });
  assert.equal(validResponse.status, 200);
  assert.equal((await json(validResponse)).task.contextId, validContext);

  for (const [index, contextId] of [
    '',
    42,
    null,
    { invalid: true },
    'x'.repeat(201)
  ].entries()) {
    const request = messageRequest(
      `message-context-invalid-${index}`,
      { data: { operation: 'daily-market-report', date: '2026-07-23' } }
    );
    request.message.contextId = contextId;
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(request)
    });
    assert.equal(response.status, 400, `contextId case ${index}`);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'INVALID_REQUEST'
    });
  }
});

test('task duplicate contextId comparison cannot be bypassed by truncation or type loss', async (t) => {
  const { origin } = await startHarness(t);
  const contextId = 'shared-context-prefix'.padEnd(200, 'x');
  const request = messageRequest(
    'message-context-duplicate-root',
    { data: { operation: 'daily-market-report', date: '2026-07-23' } }
  );
  request.message.contextId = contextId;
  const original = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(request)
  }));
  assert.equal(original.task.contextId, contextId);

  for (const [index, invalidContextId] of [
    `${contextId}attacker-suffix`,
    '',
    7
  ].entries()) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          messageId: request.message.messageId,
          taskId: original.task.id,
          contextId: invalidContextId,
          role: 'ROLE_USER',
          parts: [{ text: 'Duplicate request with an invalid context' }]
        }
      })
    });
    assert.equal(response.status, 400, `duplicate contextId case ${index}`);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'INVALID_REQUEST'
    });
  }

  const exactResponse = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify({
      message: {
        messageId: request.message.messageId,
        taskId: original.task.id,
        contextId,
        role: 'ROLE_USER',
        parts: [{ text: 'Exact duplicate context' }]
      }
    })
  });
  assert.equal(exactResponse.status, 200);
  assert.equal((await json(exactResponse)).task.id, original.task.id);
});

test('message.taskId hides inaccessible tasks and rejects terminal continuations', async (t) => {
  const { origin } = await startHarness(t);
  const active = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-continuation-private-root',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true }
    ))
  }));
  for (const [taskId, token] of [
    ['task-does-not-exist', 'owner-a'],
    [active.task.id, 'owner-b']
  ]) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(continuationRequest(
        `message-hidden-${token}`,
        taskId,
        'Continue hidden task',
        { returnImmediately: true }
      ))
    });
    assert.equal(response.status, 404);
    assertError(await json(response), {
      code: 404,
      status: 'NOT_FOUND',
      reason: 'TASK_NOT_FOUND'
    });
  }

  const terminal = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-continuation-terminal-root',
      { text: 'Generate the daily market report for 2026-07-23' }
    ))
  }));
  const response = await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(continuationRequest(
      'message-continuation-terminal',
      terminal.task.id,
      'Continue a completed task',
      { returnImmediately: true }
    ))
  });
  assert.equal(response.status, 400);
  assertError(await json(response), {
    code: 400,
    status: 'FAILED_PRECONDITION',
    reason: 'UNSUPPORTED_OPERATION'
  });
  await a2aFetch(origin, `/a2a/v1/tasks/${active.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });
});

test('historyLength is exact on send, get, and list and rejects invalid values', async (t) => {
  const { origin } = await startHarness(t);
  const noHistory = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-history-zero',
      { text: 'Generate the daily market report for 2026-07-23' },
      { historyLength: 0 }
    ))
  }));
  assert.deepEqual(noHistory.task.history, []);

  const oneHistory = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-history-one',
      { text: 'Generate the daily market report for 2026-07-23' },
      { historyLength: 1 }
    ))
  }));
  assert.equal(oneHistory.task.history.length, 1);

  const get = await json(await a2aFetch(
    origin,
    `/a2a/v1/tasks/${oneHistory.task.id}?historyLength=0`
  ));
  assert.deepEqual(get.history, []);
  const list = await json(await a2aFetch(
    origin,
    '/a2a/v1/tasks?historyLength=1&includeArtifacts=true'
  ));
  assert.ok(list.tasks.every(({ history }) => history.length <= 1));
  const immediate = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-history-immediate-zero',
      { data: { operation: 'daily-market-report', date: '2026-07-24' } },
      { returnImmediately: true, historyLength: 0 }
    ))
  }));
  assert.deepEqual(immediate.task.history, []);
  await a2aFetch(origin, `/a2a/v1/tasks/${immediate.task.id}:cancel`, {
    method: 'POST',
    body: '{}'
  });

  for (const value of [-1, 1.5, 'one', 33]) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(
        `message-history-invalid-${value}`,
        { text: 'Generate the daily market report for 2026-07-23' },
        { historyLength: value }
      ))
    });
    assert.equal(response.status, 400, `configuration ${value}`);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'INVALID_REQUEST'
    });
  }
  for (const pathname of [
    `/a2a/v1/tasks/${oneHistory.task.id}?historyLength=-1`,
    `/a2a/v1/tasks/${oneHistory.task.id}?historyLength=1.5`,
    '/a2a/v1/tasks?historyLength=one',
    '/a2a/v1/tasks?historyLength=33'
  ]) {
    const response = await a2aFetch(origin, pathname);
    assert.equal(response.status, 400, pathname);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'INVALID_REQUEST'
    });
  }
});

test('acceptedOutputModes filters A2A artifacts and never exposes HTML or plain text', async (t) => {
  const artifactLoader = async (summary) => [
    ...completedArtifacts(summary.runId),
    {
      name: 'market-report.html',
      mediaType: 'text/html',
      content: '<h1>private email rendering</h1>'
    },
    {
      name: 'market-report.txt',
      mediaType: 'text/plain',
      content: 'private email rendering'
    }
  ];
  const { origin } = await startHarness(t, { artifactLoader });
  const cases = [
    {
      modes: ['text/markdown'],
      names: ['market-report.md']
    },
    {
      modes: ['application/json'],
      names: ['evidence-pack.json', 'run-trace.json']
    },
    {
      modes: ['text/markdown', 'application/json'],
      names: ['market-report.md', 'evidence-pack.json', 'run-trace.json']
    }
  ];
  for (const [index, item] of cases.entries()) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(
        `message-output-modes-${index}`,
        { text: 'Generate the daily market report for 2026-07-23' },
        { acceptedOutputModes: item.modes }
      ))
    });
    assert.equal(response.status, 200);
    const { task } = await json(response);
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(task.artifacts.map(({ name }) => name), item.names);
  }

  const defaultResponse = await json(await a2aFetch(origin, '/a2a/v1/message:send', {
    method: 'POST',
    body: JSON.stringify(messageRequest(
      'message-output-modes-default',
      { text: 'Generate the daily market report for 2026-07-23' }
    ))
  }));
  assert.deepEqual(
    defaultResponse.task.artifacts.map(({ name }) => name),
    ['market-report.md', 'evidence-pack.json', 'run-trace.json']
  );

  for (const modes of [[], ['text/html'], ['text/plain'], 'application/json']) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(
        `message-output-modes-invalid-${JSON.stringify(modes)}`,
        { text: 'Generate the daily market report for 2026-07-23' },
        { acceptedOutputModes: modes }
      ))
    });
    assert.equal(response.status, 400);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'INVALID_REQUEST'
    });
  }
});

test('message part mediaType must match the supported text or data representation', async (t) => {
  const { origin } = await startHarness(t);
  for (const [messageId, part] of [
    [
      'message-media-text-json',
      { text: 'Generate the daily market report', mediaType: 'application/json' }
    ],
    [
      'message-media-data-text',
      {
        data: { operation: 'daily-market-report', date: '2026-07-23' },
        mediaType: 'text/plain'
      }
    ],
    [
      'message-media-html',
      { text: 'Generate the daily market report', mediaType: 'text/html' }
    ]
  ]) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(messageId, part))
    });
    assert.equal(response.status, 400, messageId);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'CONTENT_TYPE_NOT_SUPPORTED'
    });
  }
  for (const [messageId, part] of [
    [
      'message-media-text-valid',
      { text: 'Generate the daily market report', mediaType: 'text/plain' }
    ],
    [
      'message-media-data-valid',
      {
        data: { operation: 'daily-market-report', date: '2026-07-23' },
        mediaType: 'application/json'
      }
    ]
  ]) {
    const response = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(messageRequest(messageId, part))
    });
    assert.equal(response.status, 200, messageId);
  }
});

test('list rejects invalid status and includeArtifacts query values', async (t) => {
  const { origin } = await startHarness(t);
  for (const pathname of [
    '/a2a/v1/tasks?status=TASK_STATE_UNKNOWN',
    '/a2a/v1/tasks?includeArtifacts=1',
    '/a2a/v1/tasks?includeArtifacts=TRUE',
    '/a2a/v1/tasks?includeArtifacts='
  ]) {
    const response = await a2aFetch(origin, pathname);
    assert.equal(response.status, 400, pathname);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'INVALID_REQUEST'
    });
  }
  const valid = await a2aFetch(
    origin,
    '/a2a/v1/tasks?status=TASK_STATE_COMPLETED&includeArtifacts=false'
  );
  assert.equal(valid.status, 200);
});

test('list accepts only strict ASCII pageSize and valid UTC instant query grammar', async (t) => {
  const { origin } = await startHarness(t);
  for (const pageSize of ['1e2', '0x10', '%201', '01', '+1']) {
    const response = await a2aFetch(
      origin,
      `/a2a/v1/tasks?pageSize=${pageSize}`
    );
    assert.equal(response.status, 400, `pageSize=${pageSize}`);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'INVALID_REQUEST'
    });
  }
  for (const value of [
    '',
    '2026-07-25',
    '2026-07-25T00:00:00+08:00',
    '2026-02-30T00:00:00Z',
    '2026-07-25t00:00:00z',
    '2026-07-25T24:00:00Z'
  ]) {
    const response = await a2aFetch(
      origin,
      `/a2a/v1/tasks?statusTimestampAfter=${encodeURIComponent(value)}`
    );
    assert.equal(response.status, 400, value);
    assertError(await json(response), {
      code: 400,
      status: 'INVALID_ARGUMENT',
      reason: 'INVALID_REQUEST'
    });
  }
  for (const query of [
    'pageSize=1',
    'pageSize=100',
    `statusTimestampAfter=${encodeURIComponent('2026-07-25T00:00:00Z')}`,
    `statusTimestampAfter=${encodeURIComponent('2026-07-25T00:00:00.123Z')}`
  ]) {
    const response = await a2aFetch(origin, `/a2a/v1/tasks?${query}`);
    assert.equal(response.status, 200, query);
  }
});

test('SSE event bounds include the data prefix and terminating newlines', async (t) => {
  const frameSizeFor = async (padding, suffix) => {
    const artifactLoader = async () => [{
      name: 'market-report.md',
      mediaType: 'text/markdown',
      content: `# Frame calibration\n\n${'x'.repeat(padding)}`
    }];
    const { origin } = await startHarness(t, { artifactLoader });
    const request = messageRequest(
      `message-frame-${suffix}`,
      { data: { operation: 'daily-market-report', date: '2026-07-23' } }
    );
    const completed = await a2aFetch(origin, '/a2a/v1/message:send', {
      method: 'POST',
      body: JSON.stringify(request)
    });
    assert.equal(completed.status, 200);
    const stream = await a2aFetch(origin, '/a2a/v1/message:stream', {
      method: 'POST',
      body: JSON.stringify(request)
    });
    const raw = await stream.text();
    const firstFrame = raw.match(/^data: .*\n\n/)?.[0];
    assert.ok(firstFrame);
    return Buffer.byteLength(firstFrame);
  };

  const basePadding = 50_000;
  const baseSize = await frameSizeFor(basePadding, 'base');
  const targetPadding = basePadding + (64 * 1024 - baseSize) + 1;
  assert.ok(
    targetPadding > basePadding && targetPadding < 70_000,
    `base frame was ${baseSize} bytes; target padding was ${targetPadding}`
  );
  const framedSize = await frameSizeFor(targetPadding, 'target');
  assert.ok(framedSize <= 64 * 1024, `framed SSE event was ${framedSize} bytes`);
});
