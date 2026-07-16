import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const definitions = [
  {
    id: 'file-organizer', port: 4181, binding: 'HTTP+JSON', protocolVersion: '1.0',
    name: '文件收纳员', version: '1.0.0',
    description: '根据文件名和扩展名生成分类、重命名与目录整理建议，不执行不可逆文件操作。',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [{ id: 'organize-files', name: '整理文件', description: '按类型和日期对文件清单分类并生成重命名映射。', tags: ['files', 'rename'], examples: ['把下载目录里的文件按类型整理。'] }],
    handle(prompt) {
      const names = [...String(prompt).matchAll(/[\w\u4e00-\u9fff-]+\.(?:pdf|docx?|xlsx?|png|jpe?g|zip|txt)/gi)].map((match) => match[0]);
      const files = names.length ? names : ['会议记录.docx', '报价单.xlsx', '架构图.png'];
      const folders = { pdf: '文档', doc: '文档', docx: '文档', xls: '表格', xlsx: '表格', png: '图片', jpg: '图片', jpeg: '图片', zip: '归档', txt: '文档' };
      const mapping = files.map((file) => `${file} → ${folders[file.split('.').pop().toLowerCase()] || '其他'}/${file}`);
      return `整理方案（仅预览，不修改文件）\n${mapping.map((value, index) => `${index + 1}. ${value}`).join('\n')}\n验收：无文件丢失；重名时追加序号；确认后再执行。`;
    }
  },
  {
    id: 'contract-reviewer', port: 4182, binding: 'JSONRPC', protocolVersion: '1.0',
    name: '合同风险猎手', version: '1.2.0',
    description: '面向企业采购的多步骤合同审查 Agent，定位原文、判断风险、给出依据与可直接使用的修改建议。',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [{ id: 'contract-review', name: '合同风险审查', description: '交叉核对合同、公司制度与审查清单，识别责任、数据、续费和争议解决风险，并对缺失信息请求确认。', tags: ['legal', 'risk', 'evidence', 'human-in-the-loop'], examples: ['审查 SaaS 采购合同的赔偿上限、数据出境和自动续费。'] }],
    handle(prompt) {
      if (/只知道|信息不足|标准合同/.test(prompt)) return '无法直接定稿。还需：①合同全文及附件；②签约主体与适用法域；③数据类型和存储地；④合同金额与可接受责任上限；⑤公司采购红线。下一步：补齐材料后按条款原文—风险—依据—修订文本四列复审。';
      return '合同锐审结果\n1. 高风险｜数据出境：须明确数据地域、分包商和跨境机制；建议加入事前书面同意与删除证明。\n2. 高风险｜赔偿上限：若供应商责任仅限最近一个月费用，无法覆盖数据事件；建议一般责任为年度费用，保密与数据违规不受该上限限制。\n3. 中风险｜自动续费：建议至少提前 30 日通知，并赋予客户无责关闭续费的权利。\n验收依据：每项均包含风险级别、问题、理由和可谈判方向；最终文本需法务结合原合同确认。';
    }
  },
  {
    id: 'incident-commander', port: 4183, binding: 'JSONRPC', protocolVersion: '0.3',
    name: '生产事故指挥官', version: '0.9.0',
    description: '处理线上生产事故：整理时间线、判断影响、分派排障、维护状态并生成对内外通报。',
    capabilities: { streaming: false, pushNotifications: true },
    skills: [{ id: 'incident-response', name: '生产事故响应', description: '根据告警和变更记录规划多线排障，在新证据到达时更新假设、回滚方案、责任人和沟通节奏。', tags: ['incident', 'workflow', 'state', 'retry', 'monitor'], examples: ['支付成功率在发布后从 99.9% 降到 82%，组织 P1 响应。'] }],
    handle(prompt) {
      return `P1 事故作战板\n影响：${/支付/.test(prompt) ? '支付链路成功率异常，直接影响交易' : '核心链路异常，影响范围待量化'}。\n0–5 分钟：冻结发布；值班负责人建立事件频道；指标负责人核对错误率、延迟和区域分布。\n5–15 分钟：变更线对比最近发布并准备回滚；依赖线检查上游超时；数据线确认是否存在重复写入。\n决策点：回滚能恢复且无数据迁移风险时立即回滚；否则切流并降级非核心能力。\n通报：每 15 分钟更新影响、动作、结果、下一决策点。\n验收：成功率恢复至基线并稳定 30 分钟；补齐时间线、根因、行动项和负责人。`;
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
    const isRest = definition.binding === 'HTTP+JSON' && request.method === 'POST' && url.pathname === '/a2a/v1/message:send';
    const isRpc = definition.binding === 'JSONRPC' && request.method === 'POST' && url.pathname === '/a2a';
    if (isRest || isRpc) {
      const body = await readBody(request);
      const expectedMethod = definition.protocolVersion === '1.0' ? 'SendMessage' : 'message/send';
      if (isRpc && body.method !== expectedMethod) return sendJson(response, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Expected ${expectedMethod}` } });
      const message = isRpc ? body.params?.message : body.message;
      const prompt = (message?.parts || []).map((part) => part.text || '').join('\n');
      const output = definition.handle(prompt);
      const result = definition.id === 'incident-commander'
        ? taskResult(output, message?.messageId)
        : messageResult(output, message?.messageId, definition.protocolVersion);
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
  return { task: { id: crypto.randomUUID(), contextId: contextId || crypto.randomUUID(), status: { state: 'completed' }, artifacts: [{ artifactId: crypto.randomUUID(), name: 'incident-action-board', parts: [{ kind: 'text', text }] }] } };
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

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const agents = await startExampleAgents();
  console.log('本地 A2A 示例已启动：');
  agents.forEach((agent) => console.log(`- ${agent.name}: ${agent.origin}/.well-known/agent-card.json`));
}
