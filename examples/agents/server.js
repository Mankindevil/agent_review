import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const definitions = [
  {
    id: 'factor-researcher', port: 4181, binding: 'HTTP+JSON', protocolVersion: '1.0',
    name: '因子显微镜', version: '1.0.0',
    description: '面向量化研究者的因子研究 Agent：调用授权行情与财务数据 Skills，完成时点对齐、清洗、中性化、IC/Rank IC、分组回测和稳定性解释。',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [{ id: 'factor-research', name: '因子研究', description: '按股票池、样本期与调仓频率构造因子，处理极值、缺失和行业市值暴露，输出 IC、分组收益、换手与稳健性结论。', tags: ['factor', 'point-in-time', 'IC', 'backtest'], examples: ['检验经营现金流收益率因子的 Rank IC 与五分组表现。'] }],
    handle() {
      return '因子研究单（DEMO）\n1. 数据口径：沪深 300 历史成分；样本期 2019-01-01 至 2024-12-31；财务字段按公告日 point-in-time 对齐；月频调仓。\n2. 方法：1%/99% 缩尾、行业内缺失值填充、行业与对数市值中性化，计算月度 Rank IC 和五分组多空。\n3. 待执行指标：Rank IC 均值/IR、分组单调性、年化收益、最大回撤、换手；基准为沪深 300，手续费与滑点需在回测 Skill 中显式配置。\n4. 数据状态：当前示例未连接主办方 Data Skills，因此不编造数值。\n风险提示：存在样本选择、数据时点和交易成本偏差；结果仅用于技术研究，不构成投资建议。';
    }
  },
  {
    id: 'strategy-backtester', port: 4182, binding: 'JSONRPC', protocolVersion: '1.0',
    name: '策略验钞机', version: '1.2.0',
    description: '把自然语言策略转成可审计回测：锁定股票池、样本区间、信号与成交时点，计入手续费、滑点与不可交易约束，输出收益、回撤、换手和风险暴露。',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [{ id: 'strategy-backtest', name: '策略回测', description: '解析自然语言策略并执行防未来函数的基准回测与敏感性检验。', tags: ['backtest', 'transaction-cost', 'benchmark', 'risk'], examples: ['回测沪深 300 月度动量策略，计入双边成本并和指数比较。'] }],
    handle(prompt) {
      if (/审计|未来函数|数据不足|缺口/.test(prompt)) return '回测前置审计\n1. 未来函数：月末信号必须在下一交易日开盘成交；财务字段按公告日进入可用集。\n2. 幸存者偏差：股票池必须使用历史成分，不得用当前沪深 300 成分回填历史。\n3. 可交易性：补充停牌、涨跌停、退市、复权口径与成交量约束。\n4. 可复现配置：仍缺 Data Skills 版本、行情频率、无风险利率与随机种子，因此不输出虚构收益。\n风险提示：审计通过不等于未来有效，结果仅用于研究，不构成投资建议。';
      return '策略回测单（DEMO）\n口径：沪深 300 历史成分，2018-01-01 至 2024-12-31；12-1 月动量，月末信号、下一交易日开盘成交；双边手续费 8bp、滑点 5bp；基准为沪深 300。\n待报告：年化收益、超额收益、夏普、最大回撤、月均换手、行业和风格风险暴露，并做成本 ±5bp 敏感性检验。\n数据状态：未连接主办方回测 Skill，不能生成可信数值。\n风险提示：历史回测受数据质量、样本选择和市场制度变化影响，不代表未来收益，不构成投资建议。';
    }
  },
  {
    id: 'portfolio-risk-manager', port: 4183, binding: 'JSONRPC', protocolVersion: '0.3',
    name: '组合风控台', version: '0.9.0',
    description: '面向组合经理的持仓分析 Agent：调用持仓、行情、行业与风险 Skills，按时点计算集中度、风格和行业暴露，执行压力测试并生成可解释的再平衡研究方案。',
    capabilities: { streaming: false, pushNotifications: true },
    skills: [{ id: 'portfolio-risk', name: '组合风险分析', description: '基于指定持仓快照完成集中度、风险暴露、情景压力测试和再平衡约束检查。', tags: ['portfolio', 'risk-exposure', 'stress-test', 'rebalance'], examples: ['分析行业集中度，并模拟科技板块下跌 10% 的冲击。'] }],
    handle() {
      return '组合风险快照（截至 2026-06-30）\n1. 集中度：科技 42%，高于单行业 30% 约束 12pct；现金 15% 提供部分缓冲。\n2. 压力测试：假设科技持仓线性下跌 10%、其他资产不变且忽略相关性二阶变化，组合一阶冲击约 -4.2%。\n3. 研究性再平衡：科技降至 30% 需卖出 12%；在换手不超过 15% 的约束下，可将 6% 转入低相关行业、6% 转入现金或宽基，实际方案需结合个券流动性与风险模型复核。\n4. 数据缺口：尚无个券、风格因子、波动率和相关性数据，无法计算 VaR 或完整风险贡献。\n风险提示：压力情景是简化假设，不代表真实损失；以上仅用于研究，不构成投资建议。';
    }
  }
];

export async function startExampleAgents(options = {}) {
  const requestedPorts = options.ports || definitions.map((item) => item.port);
  const running = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    const server = createAgentServer(definition, requestedPorts[index]);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPorts[index], '127.0.0.1', resolve);
    });
    const port = server.address().port;
    running.push({ id: definition.id, name: definition.name, port, origin: `http://127.0.0.1:${port}`, server });
  }
  return running;
}

export async function stopExampleAgents(agents) {
  await Promise.all(agents.map(({ server }) => new Promise((resolve) => server.close(resolve))));
}

function createAgentServer(definition, requestedPort) {
  let server;
  server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address()?.port || requestedPort}`;
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      return sendJson(response, 200, buildCard(definition, origin), { etag: `"${definition.id}-${definition.version}"`, 'cache-control': 'public, max-age=60' });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return sendHtml(response, definition, origin);
    }
    const isRest = definition.binding === 'HTTP+JSON' && request.method === 'POST' && url.pathname === '/a2a/v1/message:send';
    const isRpc = definition.binding === 'JSONRPC' && request.method === 'POST' && url.pathname === '/a2a';
    if (isRest || isRpc) {
      const body = await readBody(request);
      const expectedMethod = definition.protocolVersion === '1.0' ? 'SendMessage' : 'message/send';
      if (isRpc && body.method !== expectedMethod) return sendJson(response, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Expected ${expectedMethod}` } });
      const message = isRpc ? body.params?.message : body.message;
      const prompt = (message?.parts || []).map((part) => part.text || '').join('\n');
      const output = definition.handle(prompt);
      const result = definition.id === 'portfolio-risk-manager'
        ? taskResult(output, message?.contextId)
        : messageResult(output, message?.contextId, definition.protocolVersion);
      return sendJson(response, 200, isRpc ? { jsonrpc: '2.0', id: body.id, result } : result);
    }
    if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true, agent: definition.id });
    return sendJson(response, 404, { error: 'not_found' });
  });
  return server;
}

function buildCard(definition, origin) {
  const endpoint = definition.binding === 'HTTP+JSON' ? `${origin}/a2a/v1` : `${origin}/a2a`;
  if (definition.protocolVersion === '0.3') {
    return {
      name: definition.name, description: definition.description, version: definition.version,
      url: endpoint, protocolVersion: '0.3', preferredTransport: 'JSONRPC',
      capabilities: definition.capabilities, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: definition.skills
    };
  }
  return {
    name: definition.name, description: definition.description, version: definition.version,
    supportedInterfaces: [{ url: endpoint, protocolBinding: definition.binding, protocolVersion: '1.0' }],
    capabilities: definition.capabilities, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: definition.skills
  };
}

function messageResult(text, contextId, version) {
  return { message: { messageId: crypto.randomUUID(), contextId: contextId || crypto.randomUUID(), role: version === '1.0' ? 'ROLE_AGENT' : 'agent', parts: version === '1.0' ? [{ text }] : [{ kind: 'text', text }] } };
}

function taskResult(text, contextId) {
  return {
    kind: 'task',
    id: crypto.randomUUID(),
    contextId: contextId || crypto.randomUUID(),
    status: { state: 'completed' },
    artifacts: [{
      artifactId: crypto.randomUUID(),
      name: 'incident-action-board',
      parts: [{ kind: 'text', text }]
    }]
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, definition, origin) {
  const card = buildCard(definition, origin);
  const endpoint = card.supportedInterfaces?.[0]?.url || card.url;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${definition.name} · A2A</title><style>body{max-width:760px;margin:9vh auto;padding:24px;font:15px/1.7 system-ui;color:#202428;background:#eef1f2}main{background:white;border:1px solid #bdc3c7;padding:32px;box-shadow:8px 8px 0 #202428}b{color:#e9352b}code{display:block;padding:10px;background:#202428;color:#c8f54b;overflow:auto}a{color:#315cf4}</style><main><small>A2A EXAMPLE AGENT</small><h1>${definition.name}</h1><p>${definition.description}</p><p><b>ONLINE</b> · A2A ${definition.protocolVersion} · ${definition.binding}</p><h3>Agent Card</h3><a href="/.well-known/agent-card.json">${origin}/.well-known/agent-card.json</a><h3>调用接口</h3><code>${endpoint}</code><p>这个根页面只用于人工检查。评测平台会读取 Agent Card，然后按照声明的 binding 调用接口。</p></main>`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const agents = await startExampleAgents();
  console.log('本地 A2A 示例已启动：');
  agents.forEach((agent) => console.log(`- ${agent.name}: ${agent.origin}/.well-known/agent-card.json`));
}
