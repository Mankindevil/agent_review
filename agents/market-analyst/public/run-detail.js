const form = document.querySelector('#access-form');
const tokenInput = document.querySelector('#access-token');
const statusNode = document.querySelector('#status');
const detailNode = document.querySelector('#detail');

const runId = decodeURIComponent(
  location.pathname.match(/\/runs\/([^/]+)/)?.[1]
    || new URLSearchParams(location.search).get('runId')
    || ''
);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const redacted = text.replace(
    /\b([a-z0-9._%+-])([a-z0-9._%+-]*)@([a-z0-9.-]+\.[a-z]{2,})\b/gi,
    (_match, first, _rest, domain) => `${first}***@${domain}`
  );
  return redacted.length > 4_000
    ? `${redacted.slice(0, 4_000)}…[TRUNCATED]`
    : redacted;
}

function card(title, headers, rows) {
  const section = element('section', undefined, 'card');
  section.append(element('h2', title));
  if (!rows.length) {
    section.append(element('p', '无记录', 'empty'));
    return section;
  }
  const wrap = element('div', undefined, 'table-wrap');
  const table = element('table');
  const head = element('thead');
  const headerRow = element('tr');
  for (const header of headers) headerRow.append(element('th', header));
  head.append(headerRow);
  const body = element('tbody');
  for (const row of rows.slice(0, 200)) {
    const tr = element('tr');
    for (const item of row) tr.append(element('td', valueText(item)));
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  section.append(wrap);
  return section;
}

async function fetchProtected(path, token) {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  return type.includes('json') ? response.json() : response.text();
}

function render({ run, report, evidence, trace }) {
  const rawTraceLineage = Array.isArray(trace?.conclusionLineage)
    ? trace.conclusionLineage
    : (trace?.conclusionLineage && typeof trace.conclusionLineage === 'object'
      ? [trace.conclusionLineage]
      : []);
  const lineage = new Map();
  for (const item of [...(evidence?.conclusions || []), ...rawTraceLineage]) {
    const id = item.conclusion_id || item.conclusionId;
    if (id) lineage.set(id, { ...(lineage.get(id) || {}), ...item });
  }
  detailNode.replaceChildren();
  detailNode.append(
    card('运行摘要', ['字段', '值'], [
      ['运行 ID', run?.id || evidence?.runId || runId],
      ['状态', run?.status?.state || run?.status || evidence?.status],
      ['报告日', evidence?.reportDate],
      ['开始时间', run?.startedAt || trace?.startedAt],
      ['结束时间', run?.endedAt || trace?.endedAt]
    ]),
    card('技能与工具调用', ['序号', '技能', '工具', '状态', '耗时(ms)'],
      (trace?.steps || []).map((item) => [
        item.sequence, item.skillId, item.tool, item.status, item.durationMs
      ])),
    card('Panda 调用', ['序号', '方法', '耗时(ms)', '行数', '缓存', '重试', '状态'],
      (trace?.workerEvents || []).map((item) => [
        item.sequence,
        item.method || item.detail?.method,
        item.durationMs ?? item.detail?.durationMs,
        item.rowCount ?? item.detail?.rowCount,
        item.cache ?? item.cacheStatus ?? item.detail?.cache,
        item.retries ?? item.retryCount ?? item.detail?.retries,
        item.status
      ])),
    card('模型用量', ['提供方', '模型', '输入', '输出', '推理', '缓存', '总计', '成本', '币种'],
      (trace?.modelUsage || []).map((item) => [
        item.provider, item.model, item.inputTokens, item.outputTokens,
        item.reasoningTokens, item.cachedTokens, item.totalTokens, item.cost, item.currency
      ])),
    card('邮件尝试', ['状态', '时间', '收件方摘要', '错误'],
      (trace?.emailAttempts || []).map((item) => [
        item.status, item.attemptedAt || item.startedAt, item.recipients, item.error
      ])),
    card('产物', ['名称', 'SHA-256', '类型'],
      [...(run?.artifacts || []), ...(evidence?.artifacts || [])].map((item) => [
        item.name, item.sha256 || item.hash, item.mediaType || item.type
      ])),
    card('结论链路', ['结论 ID', '公式', '置信度', '来源', '指标/证据', '数据日/窗口', '限制'],
      [...lineage.entries()].map(([id, item]) => [
        id, item.formula, item.confidence,
        item.sourceIds || item.pandaCalls, item.metricIds || item.evidenceIds,
        item.dataDate || item.window || item.dataWindow, item.limitations
      ])),
    card('报告产物', ['格式', '内容'], [[
      typeof report === 'string' ? 'text' : 'structured',
      typeof report === 'string' ? report : report?.markdown || report?.text || report
    ]])
  );
  detailNode.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!runId) {
    statusNode.textContent = 'URL 中缺少运行 ID。';
    return;
  }
  const token = tokenInput.value;
  tokenInput.value = '';
  statusNode.textContent = '正在加载受保护产物…';
  detailNode.hidden = true;
  try {
    const base = `/runs/${encodeURIComponent(runId)}`;
    const [run, report, evidence, trace] = await Promise.all([
      fetchProtected(base, token),
      fetchProtected(`${base}/report`, token),
      fetchProtected(`${base}/evidence`, token),
      fetchProtected(`${base}/trace`, token)
    ]);
    render({ run, report, evidence, trace });
    statusNode.textContent = '已加载。';
  } catch (error) {
    detailNode.replaceChildren();
    statusNode.textContent = `加载失败：${error.message}`;
  }
});
