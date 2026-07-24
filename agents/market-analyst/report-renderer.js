import { sanitizeTraceValue } from './run-trace.js';
import { validateEvidencePack } from './schemas.js';

export const REPORT_SECTIONS = Object.freeze([
  { id: 'run-overview', title: '运行概览' },
  { id: 'executive-summary', title: '市场状态摘要' },
  { id: 'a-share-market', title: 'A股核心市场' },
  { id: 'hot-topics', title: '热点行业与概念' },
  { id: 'sell-pressure', title: '卖压观察名单' },
  { id: 'potential-watchlist', title: '潜力研究观察名单' },
  { id: 'capital-transactions', title: '资金与显著交易证据' },
  { id: 'cross-market', title: '跨市场及宏观背景' },
  { id: 'event-crowding-risks', title: '事件与拥挤风险' },
  { id: 'data-methodology', title: '数据质量与方法' },
  { id: 'trace-artifacts', title: '追踪与产物' },
  { id: 'disclaimer', title: '免责声明' }
]);

export const REPORT_DISPLAY_CAPS = Object.freeze({
  detailRows: 200,
  leaderboardRows: 50,
  sources: 200,
  conclusions: 128,
  missingData: 200,
  artifacts: 50,
  conventions: 100,
  riskRows: 200,
  displayText: 4_000
});
export const DATA_DATE_UNAVAILABLE = '数据日期不可用';
export const NOT_RECORDED = '未记录';

export function truncationMarker(label, omitted) {
  return `TRUNCATED:${label}:${omitted}`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function boundedDisplay(value) {
  const text = String(value);
  return text.length > REPORT_DISPLAY_CAPS.displayText
    ? `${text.slice(0, REPORT_DISPLAY_CAPS.displayText)}…[TRUNCATED]`
    : text;
}

function markdownText(value) {
  return escapeHtml(boundedDisplay(value ?? '—'))
    .replaceAll('\\', '\\\\')
    .replace(/([\[\]()])/g, '\\$1')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return boundedDisplay(value);
  if (Array.isArray(value)) {
    return value.length ? boundedDisplay(value.map(valueText).join(', ')) : '—';
  }
  if (typeof value === 'object') {
    return boundedDisplay(
      Object.entries(value).map(([key, item]) => `${key}:${valueText(item)}`).join(', ')
    ) || '—';
  }
  return boundedDisplay(value);
}

function cappedTableRows(items, limit, label, project, width) {
  const values = Array.isArray(items) ? items : [];
  const rows = values.slice(0, limit).map(project);
  if (values.length > limit) {
    rows.push([truncationMarker(label, values.length - limit), ...Array(width - 1).fill('—')]);
  }
  return rows;
}

function narrativeFor(narrative, id) {
  const sections = Array.isArray(narrative) ? narrative : narrative?.sections;
  return Array.isArray(sections)
    ? sections.find((section) => section?.id === id && typeof section.text === 'string')?.text
    : undefined;
}

function dataCutoffs(markets) {
  return Object.entries(markets || {})
    .map(([market, value]) => `${market}: ${value?.dataDate || DATA_DATE_UNAVAILABLE}`)
    .join('；') || '—';
}

function contributions(row) {
  if (row?.scoreContributions && typeof row.scoreContributions === 'object') {
    return valueText(row.scoreContributions);
  }
  if (Array.isArray(row?.componentsUsed) && row.componentsUsed.length) {
    const available = row.componentsUsed.filter((key) => row[key] !== null && row[key] !== undefined);
    if (available.length === row.componentsUsed.length) {
      return available.map((key) => `${key}:${valueText(row[key])}`).join(', ');
    }
    return `componentsUsed:${row.componentsUsed.join(', ')}, finalScore:${valueText(row.score)}`;
  }
  return `score:${valueText(row?.score)}`;
}

function leaderboardRows(rows) {
  return cappedTableRows(rows, REPORT_DISPLAY_CAPS.leaderboardRows, 'leaderboard', (row, index) => [
    row.rank ?? index + 1,
    row.symbol || row.id || '—',
    row.name || '—',
    row.dataDate || DATA_DATE_UNAVAILABLE,
    row.score,
    contributions(row),
    row.confidence,
    row.status || 'RANKED',
    valueText(row.vetoes)
  ], 9);
}

function sourceRows(sources) {
  return cappedTableRows(sources, REPORT_DISPLAY_CAPS.sources, 'sources', (source) => [
    source.method,
    source.dataAsOf || DATA_DATE_UNAVAILABLE,
    source.window || source.dataWindow,
    source.coverage,
    source.rowCount,
    source.traceSequence ?? source.sequence ?? source.id,
    source.status
  ], 7);
}

function markdownTable(headers, rows) {
  if (!rows.length) return '_无可用数据_';
  const line = (cells) => `| ${cells.map(markdownText).join(' | ')} |`;
  return [
    line(headers),
    line(headers.map(() => '---')),
    ...rows.map(line)
  ].join('\n');
}

function htmlTable(headers, rows) {
  if (!rows.length) return '<p class="empty">无可用数据</p>';
  return `<div class="table-wrap"><table><thead><tr>${
    headers.map((item) => `<th>${escapeHtml(item)}</th>`).join('')
  }</tr></thead><tbody>${
    rows.map((row) => `<tr>${row.map((item) => `<td>${escapeHtml(valueText(item))}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

function marketRows(markets) {
  return Object.entries(markets || {}).slice(0, 32).map(([market, details]) => [
    market,
    details?.dataDate || DATA_DATE_UNAVAILABLE,
    details?.rowCount,
    Object.entries(details || {})
      .filter(([key]) => !['dataDate', 'rowCount'].includes(key))
      .map(([key, value]) => `${key}:${valueText(value)}`)
      .join(', ')
  ]);
}

function conclusionRows(conclusions) {
  return cappedTableRows(conclusions, REPORT_DISPLAY_CAPS.conclusions, 'conclusions', (item) => [
    item.conclusion_id,
    item.formula,
    item.confidence,
    valueText(item.limitations)
  ], 4);
}

function missingRows(missingData) {
  return cappedTableRows(missingData, REPORT_DISPLAY_CAPS.missingData, 'missing-data', (item) => [
    item.section,
    item.method,
    item.status,
    item.coverage,
    item.error
  ], 5);
}

function htmlConclusionTable(conclusions) {
  const items = Array.isArray(conclusions) ? conclusions : [];
  const rows = items.slice(0, REPORT_DISPLAY_CAPS.conclusions);
  if (!rows.length) return '<p class="empty">无可用数据</p>';
  return `<div class="table-wrap"><table><thead><tr>${
    ['结论 ID', '公式版本', '置信度', '限制']
      .map((item) => `<th>${escapeHtml(item)}</th>`).join('')
  }</tr></thead><tbody>${
    rows.map((item) => `<tr id="${escapeHtml(valueText(item.conclusion_id))}">${
      [
        item.conclusion_id,
        item.formula,
        item.confidence,
        valueText(item.limitations)
      ].map((value) => `<td>${escapeHtml(valueText(value))}</td>`).join('')
    }</tr>`).join('')
  }${items.length > REPORT_DISPLAY_CAPS.conclusions
    ? `<tr><td>${escapeHtml(truncationMarker(
      'conclusions',
      items.length - REPORT_DISPLAY_CAPS.conclusions
    ))}</td><td>—</td><td>—</td><td>—</td></tr>`
    : ''
  }</tbody></table></div>`;
}

function safeDetailHref(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return value.startsWith('/') && !value.startsWith('//') ? value : null;
  }
}

function sectionContent(evidence, narrative) {
  const allSources = sourceRows(evidence.sources);
  const transactionSources = (evidence.sources || []).filter((source) =>
    /lhb|connect|margin|block|capital|transaction/i.test(source.method || '')
  );
  const otherMarkets = Object.fromEntries(
    Object.entries(evidence.markets || {}).filter(([market]) => market !== 'aShare')
  );
  const allVetoRows = Object.entries(evidence.leaderboards || {}).flatMap(([board, rows]) =>
    (rows || []).filter((row) => Array.isArray(row.vetoes) && row.vetoes.length)
      .map((row) => [board, row.symbol || row.id, valueText(row.vetoes), row.dataDate || DATA_DATE_UNAVAILABLE])
  );
  const vetoRows = cappedTableRows(
    allVetoRows,
    REPORT_DISPLAY_CAPS.riskRows,
    'risk-rows',
    (row) => row,
    4
  );
  const artifacts = Array.isArray(evidence.artifacts) && evidence.artifacts.length
    ? cappedTableRows(
      evidence.artifacts,
      REPORT_DISPLAY_CAPS.artifacts,
      'artifacts',
      (item) => [item.name, item.sha256 || item.hash || NOT_RECORDED],
      2
    )
    : [['evidence-pack.json', NOT_RECORDED]];
  const degraded = evidence.status === 'degraded';
  const overview = [
    ['报告日', evidence.reportDate],
    ['数据截止', dataCutoffs(evidence.markets)],
    ['运行状态', evidence.status],
    ['完整性', degraded ? '数据不完整' : '完整'],
    ['覆盖率', valueText(evidence.coverage)]
  ];
  const deterministicSummary = markdownTable(
    ['结论 ID', '公式版本', '置信度', '限制'],
    conclusionRows(evidence.conclusions)
  );
  const summaryNarrative = narrativeFor(narrative, 'executive-summary');
  const methodologyNarrative = narrativeFor(narrative, 'data-methodology');
  return {
    'run-overview': {
      markdown: markdownTable(['字段', '值'], overview),
      html: htmlTable(['字段', '值'], overview)
    },
    'executive-summary': {
      markdown: summaryNarrative ? `${markdownText(summaryNarrative)}\n\n${deterministicSummary}` : deterministicSummary,
      html: `${summaryNarrative ? `<p>${escapeHtml(summaryNarrative)}</p>` : ''}${
        htmlConclusionTable(evidence.conclusions)
      }`
    },
    'a-share-market': {
      markdown: markdownTable(['市场', '数据日', '行数', '指标'], marketRows({ aShare: evidence.markets?.aShare || {} })),
      html: htmlTable(['市场', '数据日', '行数', '指标'], marketRows({ aShare: evidence.markets?.aShare || {} }))
    },
    'hot-topics': {
      markdown: [
        '### 热门行业',
        markdownTable(
          ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
          leaderboardRows(evidence.leaderboards?.hotIndustries)
        ),
        '### 热门概念',
        markdownTable(
          ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
          leaderboardRows(evidence.leaderboards?.hotConcepts)
        )
      ].join('\n\n'),
      html: `<h3>热门行业</h3>${
        htmlTable(
          ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
          leaderboardRows(evidence.leaderboards?.hotIndustries)
        )
      }<h3>热门概念</h3>${
        htmlTable(
          ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
          leaderboardRows(evidence.leaderboards?.hotConcepts)
        )
      }`
    },
    'sell-pressure': {
      markdown: markdownTable(
        ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
        leaderboardRows(evidence.leaderboards?.sellPressure)
      ),
      html: htmlTable(
        ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
        leaderboardRows(evidence.leaderboards?.sellPressure)
      )
    },
    'potential-watchlist': {
      markdown: markdownTable(
        ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
        leaderboardRows(evidence.leaderboards?.potentialWatchlist)
      ),
      html: htmlTable(
        ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
        leaderboardRows(evidence.leaderboards?.potentialWatchlist)
      )
    },
    'capital-transactions': {
      markdown: markdownTable(
        ['Panda 方法', '数据日', '窗口', '覆盖率', '行数', '追踪序号', '状态'],
        sourceRows(transactionSources)
      ),
      html: htmlTable(
        ['Panda 方法', '数据日', '窗口', '覆盖率', '行数', '追踪序号', '状态'],
        sourceRows(transactionSources)
      )
    },
    'cross-market': {
      markdown: markdownTable(['市场', '数据日', '行数', '指标'], marketRows(otherMarkets)),
      html: htmlTable(['市场', '数据日', '行数', '指标'], marketRows(otherMarkets))
    },
    'event-crowding-risks': {
      markdown: markdownTable(['榜单', '标识', '风险/否决', '数据日'], vetoRows),
      html: htmlTable(['榜单', '标识', '风险/否决', '数据日'], vetoRows)
    },
    'data-methodology': {
      markdown: [
        methodologyNarrative ? markdownText(methodologyNarrative) : '',
        '### 缺失接口',
        markdownTable(['章节', 'Panda 方法', '状态', '覆盖率', '错误'], missingRows(evidence.missingData)),
        '### 来源与新鲜度',
        markdownTable(
          ['Panda 方法', '数据日', '窗口', '覆盖率', '行数', '追踪序号', '状态'],
          allSources
        ),
        '### 计算约定',
        ...(evidence.conventions || []).slice(0, REPORT_DISPLAY_CAPS.conventions)
          .map((item) => `- ${markdownText(item)}`),
        ...(evidence.conventions || []).length > REPORT_DISPLAY_CAPS.conventions
          ? [`- ${truncationMarker(
            'conventions',
            evidence.conventions.length - REPORT_DISPLAY_CAPS.conventions
          )}`]
          : []
      ].filter(Boolean).join('\n\n'),
      html: `${methodologyNarrative ? `<p>${escapeHtml(methodologyNarrative)}</p>` : ''
      }<h3>缺失接口</h3>${
        htmlTable(['章节', 'Panda 方法', '状态', '覆盖率', '错误'], missingRows(evidence.missingData))
      }<h3>来源与新鲜度</h3>${
        htmlTable(
          ['Panda 方法', '数据日', '窗口', '覆盖率', '行数', '追踪序号', '状态'],
          allSources
        )
      }<h3>计算约定</h3><ul>${
        (evidence.conventions || []).slice(0, REPORT_DISPLAY_CAPS.conventions)
          .map((item) => `<li>${escapeHtml(valueText(item))}</li>`).join('')
      }${(evidence.conventions || []).length > REPORT_DISPLAY_CAPS.conventions
        ? `<li>${escapeHtml(truncationMarker(
          'conventions',
          evidence.conventions.length - REPORT_DISPLAY_CAPS.conventions
        ))}</li>`
        : ''
      }</ul>`
    },
    'trace-artifacts': {
      markdown: [
        markdownTable(['产物', 'SHA-256'], artifacts),
        evidence.detailUrl ? `受保护详情：${markdownText(evidence.detailUrl)}` : ''
      ].filter(Boolean).join('\n\n'),
      html: `${htmlTable(['产物', 'SHA-256'], artifacts)}${evidence.detailUrl ? (() => {
        const href = safeDetailHref(evidence.detailUrl);
        return href
          ? `<p>受保护详情：<a href="${escapeHtml(href)}">${
            escapeHtml(valueText(evidence.detailUrl))
          }</a></p>`
          : `<p>受保护详情：${escapeHtml(valueText(evidence.detailUrl))}</p>`;
      })() : ''}`
    },
    disclaimer: {
      markdown: '本报告仅供研究与信息交流，不构成投资建议、收益承诺或价格预测。观察名单不代表买卖建议。',
      html: '<p>本报告仅供研究与信息交流，不构成投资建议、收益承诺或价格预测。观察名单不代表买卖建议。</p>'
    }
  };
}

export function renderReport(evidence, narrative) {
  validateEvidencePack(evidence);
  const degraded = evidence.status === 'degraded';
  const title = `${evidence.reportDate} 每日市场报告${degraded ? '（数据不完整）' : ''}`;
  const content = sectionContent(evidence, narrative);
  const renderedSection = (section, format) => {
    const prose = ['executive-summary', 'data-methodology'].includes(section.id)
      ? undefined
      : narrativeFor(narrative, section.id);
    if (!prose) return content[section.id][format];
    return format === 'html'
      ? `<p>${escapeHtml(prose)}</p>${content[section.id].html}`
      : `${markdownText(prose)}\n\n${content[section.id].markdown}`;
  };
  const markdown = [
    `# ${markdownText(title)}`,
    ...REPORT_SECTIONS.map((section) =>
      `## ${section.title}\n\n${renderedSection(section, 'markdown')}`
    )
  ].join('\n\n');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${
    '<meta name="viewport" content="width=device-width,initial-scale=1">'
  }<title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${
    REPORT_SECTIONS.map((section) =>
      `<section id="${section.id}"><h2>${escapeHtml(section.title)}</h2>${
        renderedSection(section, 'html')
      }</section>`
    ).join('')
  }</main></body></html>`;
  const text = [
    title,
    ...REPORT_SECTIONS.map((section) =>
      `${section.title}\n${renderedSection(section, 'markdown')
        .replace(/^#{1,6}\s+/gm, '')
        .replaceAll('\\|', '|')
        .replace(/\|?\s*:?-{3,}:?\s*(?=\|)/g, '')}`
    )
  ].join('\n\n');
  return { markdown, html, text };
}

function detailCollection(items) {
  const values = Array.isArray(items) ? items : [];
  const sentinel = values.at(-1);
  if (sentinel?._truncated === true) {
    const omitted = Number.isSafeInteger(sentinel.detail?.omitted)
      && sentinel.detail.omitted >= 0
      ? sentinel.detail.omitted
      : 1;
    return {
      values: values.slice(0, -1),
      total: Math.max(0, values.length - 1 + omitted),
      truncated: true
    };
  }
  return { values, total: values.length, truncated: false };
}

function mergeDetailCollections(...items) {
  const collections = items.map(detailCollection);
  return {
    values: collections.flatMap((collection) => collection.values),
    total: collections.reduce((sum, collection) => sum + collection.total, 0),
    truncated: collections.some((collection) => collection.truncated)
  };
}

function detailTable(headers, items, section, project = (item) => item) {
  const collection = Array.isArray(items) ? detailCollection(items) : items;
  const values = collection?.values || [];
  const shown = values.slice(0, REPORT_DISPLAY_CAPS.detailRows);
  const rows = shown.map(project);
  if (collection?.truncated || collection?.total > REPORT_DISPLAY_CAPS.detailRows) {
    rows.push([
      `TRUNCATED:detail:${section}`,
      `shown=${shown.length}; total=${collection.total}; omitted=${collection.total - shown.length}`,
      ...Array(Math.max(0, headers.length - 2)).fill('—')
    ]);
  }
  return htmlTable(headers, rows);
}

export function renderRunDetail({ run = {}, evidence = {}, trace = {} } = {}) {
  run = sanitizeTraceValue(run) || {};
  evidence = sanitizeTraceValue(evidence) || {};
  trace = sanitizeTraceValue(trace) || {};
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const workerEvents = Array.isArray(trace.workerEvents) ? trace.workerEvents : [];
  const modelUsage = Array.isArray(trace.modelUsage) ? trace.modelUsage : [];
  const emailAttempts = Array.isArray(trace.emailAttempts) ? trace.emailAttempts : [];
  const artifacts = mergeDetailCollections(run.artifacts, evidence.artifacts);
  const conclusions = Array.isArray(evidence.conclusions) ? evidence.conclusions : [];
  const traceLineage = Array.isArray(trace.conclusionLineage)
    ? trace.conclusionLineage
    : (trace.conclusionLineage && typeof trace.conclusionLineage === 'object'
      ? [trace.conclusionLineage]
      : []);
  const lineageItems = mergeDetailCollections(conclusions, traceLineage);
  const lineage = new Map();
  for (const item of lineageItems.values.slice(0, REPORT_DISPLAY_CAPS.detailRows)) {
    const id = item.conclusion_id || item.conclusionId;
    if (!id) continue;
    lineage.set(id, { ...(lineage.get(id) || {}), ...item });
  }
  return `<main class="run-detail"><h1>运行详情 ${escapeHtml(run.id || evidence.runId || '—')}</h1>${
    '<section><h2>运行摘要</h2>'
  }${htmlTable(['字段', '值'], [
    ['运行 ID', run.id || evidence.runId],
    ['状态', run.status || evidence.status],
    ['报告日', evidence.reportDate],
    ['开始时间', run.startedAt || trace.startedAt],
    ['结束时间', run.endedAt || trace.endedAt]
  ])}</section><section><h2>技能与工具调用</h2>${
    detailTable(['序号', '技能', '工具', '状态', '耗时(ms)'], steps, 'steps', (item) => [
      item.sequence, item.skillId, item.tool, item.status, item.durationMs
    ])
  }</section><section><h2>Panda 调用</h2>${
    detailTable(
      ['序号', '方法', '耗时(ms)', '行数', '缓存', '重试', '状态'],
      workerEvents,
      'worker-events',
      (item) => [
        item.sequence,
        item.method || item.detail?.method,
        item.durationMs ?? item.detail?.durationMs,
        item.rowCount ?? item.detail?.rowCount,
        item.cache ?? item.cacheStatus ?? item.detail?.cache,
        item.retries ?? item.retryCount ?? item.detail?.retries,
        item.status
      ]
    )
  }</section><section><h2>模型用量</h2>${
    detailTable(
      ['提供方', '模型', '输入', '输出', '推理', '缓存', '总计', '成本', '币种'],
      modelUsage,
      'model-usage',
      (item) => [
        item.provider, item.model, item.inputTokens, item.outputTokens, item.reasoningTokens,
        item.cachedTokens, item.totalTokens, item.cost, item.currency
      ]
    )
  }</section><section><h2>邮件尝试</h2>${
    detailTable(['状态', '时间', '收件方摘要', '错误'], emailAttempts, 'email-attempts', (item) => [
      item.status, item.attemptedAt || item.startedAt, valueText(item.recipients), item.error
    ])
  }</section><section><h2>产物</h2>${
    detailTable(['名称', 'SHA-256', '类型'], artifacts, 'artifacts', (item) => [
      item.name, item.sha256 || item.hash, item.mediaType || item.type
    ])
  }</section><section><h2>结论链路</h2>${
    detailTable(
      ['结论 ID', '公式', '置信度', '来源', '指标/证据', '数据日/窗口', '限制'],
      {
        values: [...lineage.entries()],
        total: lineageItems.total,
        truncated: lineageItems.truncated
      },
      'lineage',
      ([id, item]) => [
        id,
        item.formula,
        item.confidence,
        valueText(item.sourceIds || item.pandaCalls),
        valueText(item.metricIds || item.evidenceIds),
        valueText(item.dataDate || item.window || item.dataWindow),
        valueText(item.limitations)
      ]
    )
  }</section></main>`;
}
