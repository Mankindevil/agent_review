import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeBuildSkillPrompt } from '../src/prompts.js';
import { buildSkill, createSkillBundle, runSkill } from '../src/runtimes.js';

test('Panda interface reference exposes only allowlisted contracts and omits bulky response samples', async () => {
  const { buildPandaInterfaceReference } = await import('../src/panda-runtime.js');
  const reference = buildPandaInterfaceReference(`**1. get_factor - 获取回测因子**

**1.1. 方法名：get_factor**

**1.2. 入参**

| start_date | string | 开始日期 | 必填 |

**响应示例**

\`\`\`text
FACTOR_RESPONSE_SENTINEL
\`\`\`

**2. get_secret_data - 私有数据**

**2.1. 方法名：get_secret_data**

| token | string | 密钥 | 必填 |
`, ['get_factor']);

  assert.match(reference, /接口文档\.md/u);
  assert.match(reference, /get_factor/u);
  assert.match(reference, /start_date/u);
  assert.doesNotMatch(reference, /get_secret_data|FACTOR_RESPONSE_SENTINEL|token/u);
});

test('Panda interface reference rejects a budget that cannot contain every allowlisted method', async () => {
  const { buildPandaInterfaceReference } = await import('../src/panda-runtime.js');
  const document = `**1. get_factor - 因子**

| date | string | 日期 |

**2. get_fina_reports - 财务**

| report_date | string | 报告期 |
`;

  assert.throws(
    () => buildPandaInterfaceReference(document, ['get_factor', 'get_fina_reports'], {
      maxSectionChars: 500,
      maxTotalChars: 100
    }),
    (error) => error.code === 'MODEL_CONTEXT_BUDGET_EXCEEDED'
  );
});

test('Runtime build preflight reports exceeded remote context without calling the provider', async () => {
  const originalAdapters = process.env.RUNTIME_ADAPTERS_JSON;
  const originalFetch = globalThis.fetch;
  const usageRecords = [];
  let providerCalls = 0;
  process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({
    doubao: { kind: 'remote-http', url: 'https://runtime.example/build' }
  });
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('provider must not be called');
  };

  try {
    await assert.rejects(
      () => buildSkill({ id: 'doubao', name: 'Doubao Agent', model: 'Seed' }, '中'.repeat(500_000), 'live', {
        onContextUsage: (usage) => usageRecords.push(usage)
      }),
      (error) => error.code === 'MODEL_CONTEXT_BUDGET_EXCEEDED'
    );
    assert.equal(providerCalls, 0);
    assert.deepEqual(usageRecords.map((usage) => usage.scope), ['runtime-remote-request:doubao']);
    assert.deepEqual(usageRecords.map((usage) => usage.status), ['exceeded']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAdapters === undefined) delete process.env.RUNTIME_ADAPTERS_JSON;
    else process.env.RUNTIME_ADAPTERS_JSON = originalAdapters;
  }
});

test('financial reconstruction receives the Panda interface contract during Skill construction', () => {
  const prompt = runtimeBuildSkillPrompt(
    '检验经营现金流收益率因子并报告 Rank IC。',
    {
      pandaData: {
        allowedMethods: ['get_factor', 'get_fina_reports'],
        interfaceReference: '## get_factor\nstart_date / end_date / factors / index_component'
      }
    }
  );

  assert.match(prompt, /Panda Data 接口文档/u);
  assert.match(prompt, /get_factor/u);
  assert.match(prompt, /get_fina_reports/u);
  assert.match(prompt, /tools.*panda_data/su);
  assert.match(prompt, /不得声称没有数据接口/u);
});

test('financial Skill snapshot records the Panda interface input policy and allowlist', () => {
  const bundle = createSkillBundle({
    runtime: 'Claude Code',
    runtimeId: 'claude-code',
    model: 'test-model',
    mode: 'live',
    baselineInput: 'description+panda-interface',
    pandaData: {
      provider: 'pandaai',
      sdk: 'panda_data',
      interfaceDocument: '接口文档.md',
      allowedMethods: ['get_factor', 'get_fina_reports']
    },
    skill: {
      name: 'factor-research',
      description: '因子研究',
      instructions: ['使用真实数据'],
      tools: ['panda_data']
    }
  }, '检验经营现金流收益率因子。');

  assert.equal(bundle.inputPolicy, 'description+panda-interface');
  assert.equal(bundle.legacyBaseline, false);
  const reference = bundle.files.find((file) =>
    file.path === 'references/panda-data-interface.json'
  );
  assert.deepEqual(JSON.parse(reference.content), {
    provider: 'pandaai',
    sdk: 'panda_data',
    interfaceDocument: '接口文档.md',
    allowedMethods: ['get_factor', 'get_fina_reports']
  });
  assert.deepEqual(JSON.parse(
    bundle.files.find((file) => file.path === '.agent-roast/manifest.json').content
  ).pandaData, JSON.parse(reference.content));
});

test('live financial Runtime plans allowlisted Panda queries and receives real query results', async () => {
  const originalAdapters = process.env.RUNTIME_ADAPTERS_JSON;
  const originalKey = process.env.PANDA_RUNTIME_TEST_KEY;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const queries = [];
  process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({
    doubao: {
      kind: 'model-api',
      baseUrl: 'https://runtime.example/v1',
      apiKeyEnv: 'PANDA_RUNTIME_TEST_KEY',
      model: 'runtime-model'
    }
  });
  process.env.PANDA_RUNTIME_TEST_KEY = 'test-only';
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const content = requests.length === 1
      ? JSON.stringify({
          queries: [{
            method: 'get_factor',
            params: {
              start_date: '20240101',
              end_date: '20241231',
              factors: ['close'],
              index_component: '000300',
              type: 'stock'
            },
            purpose: '取得沪深 300 月末收益计算所需数据'
          }]
        })
      : '已使用 Panda Data 完成计算并报告 Rank IC。';
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const output = await runSkill({
      runtime: 'Doubao Agent',
      runtimeId: 'doubao',
      mode: 'live',
      skill: {
        name: 'factor-research',
        description: '研究量化因子',
        instructions: ['使用 Panda Data 取数后计算'],
        tools: ['panda_data']
      }
    }, {
      prompt: '在沪深 300 内检验经营现金流收益率因子，报告 Rank IC。'
    }, 'live', {
      pandaData: {
        enabled: true,
        allowedMethods: ['get_factor'],
        interfaceReference: '## get_factor\nstart_date / end_date / factors / index_component',
        query: async (method, params) => {
          queries.push({ method, params });
          return {
            provider: 'pandaai',
            method,
            rowCount: 1,
            truncated: false,
            data: [{ date: '20241231', symbol: '000001.SZ', close: 10.5 }]
          };
        }
      }
    });

    assert.equal(output, '已使用 Panda Data 完成计算并报告 Rank IC。');
    assert.equal(requests.length, 2);
    assert.deepEqual(queries, [{
      method: 'get_factor',
      params: {
        start_date: '20240101',
        end_date: '20241231',
        factors: ['close'],
        index_component: '000300',
        type: 'stock'
      }
    }]);
    assert.match(requests[0].messages[0].content, /Panda Data 查询计划/u);
    assert.match(requests[0].messages[0].content, /get_factor/u);
    assert.match(requests[1].messages[0].content, /"provider":"pandaai"/u);
    assert.match(requests[1].messages[0].content, /"close":10\.5/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAdapters === undefined) delete process.env.RUNTIME_ADAPTERS_JSON;
    else process.env.RUNTIME_ADAPTERS_JSON = originalAdapters;
    if (originalKey === undefined) delete process.env.PANDA_RUNTIME_TEST_KEY;
    else process.env.PANDA_RUNTIME_TEST_KEY = originalKey;
  }
});

test('remote Runtime executes platform Panda queries and receives compacted evidence without Panda credentials', async () => {
  const originalAdapters = process.env.RUNTIME_ADAPTERS_JSON;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const platformQueries = [];
  process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({
    cursor: { kind: 'remote-http', url: 'https://runtime.example/cursor' }
  });
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ request, headers: options.headers });
    if (request.action === 'panda_query_plan') {
      return new Response(JSON.stringify({
        queries: [{
          method: 'get_factor',
          params: { start_date: '20240101', end_date: '20240131', factors: ['close'] },
          purpose: '取得月末收盘价'
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(request.action, 'run_skill');
    assert.equal(request.pandaEvidence.queries[0].result.data[0].close, 10.5);
    assert.equal(request.pandaEvidence.queries[0].result.originalRows, 1);
    assert.equal(request.pandaInstructions.requireTruncationDisclosure, true);
    return new Response(JSON.stringify({ output: '远程 Runtime 已使用平台 Panda 证据。' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const output = await runSkill({
      runtime: 'Cursor Agent',
      runtimeId: 'cursor',
      mode: 'live',
      skill: {
        name: 'factor-research',
        description: '研究量化因子',
        instructions: ['先取数后计算'],
        tools: ['panda_data']
      }
    }, { prompt: '研究沪深 300 收盘价。' }, 'live', {
      pandaData: {
        enabled: true,
        allowedMethods: ['get_factor'],
        interfaceReference: '## get_factor\nstart_date / end_date / factors',
        query: async (method, params) => {
          platformQueries.push({ method, params });
          return {
            provider: 'pandaai',
            method,
            rowCount: 1,
            data: [{ date: '20240131', symbol: '000001.SZ', close: 10.5 }]
          };
        }
      }
    });

    assert.equal(output, '远程 Runtime 已使用平台 Panda 证据。');
    assert.deepEqual(requests.map(({ request }) => request.action), ['panda_query_plan', 'run_skill']);
    assert.equal(requests[0].headers.authorization, undefined);
    assert.deepEqual(platformQueries, [{
      method: 'get_factor',
      params: { start_date: '20240101', end_date: '20240131', factors: ['close'] }
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAdapters === undefined) delete process.env.RUNTIME_ADAPTERS_JSON;
    else process.env.RUNTIME_ADAPTERS_JSON = originalAdapters;
  }
});

test('Panda query planning rejects methods outside the configured allowlist without querying', async () => {
  const originalAdapters = process.env.RUNTIME_ADAPTERS_JSON;
  const originalKey = process.env.PANDA_RUNTIME_TEST_KEY;
  const originalFetch = globalThis.fetch;
  let queryCalls = 0;
  process.env.RUNTIME_ADAPTERS_JSON = JSON.stringify({
    doubao: {
      kind: 'model-api',
      baseUrl: 'https://runtime.example/v1',
      apiKeyEnv: 'PANDA_RUNTIME_TEST_KEY',
      model: 'runtime-model'
    }
  });
  process.env.PANDA_RUNTIME_TEST_KEY = 'test-only';
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: { content: '{"queries":[{"method":"get_secret_data","params":{},"purpose":"越权"}]}' }
    }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    await assert.rejects(() => runSkill({
      runtime: 'Doubao Agent',
      runtimeId: 'doubao',
      mode: 'live',
      skill: {
        name: 'factor-research',
        description: '研究量化因子',
        instructions: ['查询后计算'],
        tools: ['panda_data']
      }
    }, { prompt: '查询量化因子。' }, 'live', {
      pandaData: {
        enabled: true,
        allowedMethods: ['get_factor'],
        interfaceReference: '## get_factor',
        query: async () => { queryCalls += 1; }
      }
    }), /不在白名单.*get_secret_data/u);
    assert.equal(queryCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAdapters === undefined) delete process.env.RUNTIME_ADAPTERS_JSON;
    else process.env.RUNTIME_ADAPTERS_JSON = originalAdapters;
    if (originalKey === undefined) delete process.env.PANDA_RUNTIME_TEST_KEY;
    else process.env.PANDA_RUNTIME_TEST_KEY = originalKey;
  }
});
