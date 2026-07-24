import { createHash } from 'node:crypto';

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

const MAX_DETAIL_ROWS = 200;
const MAX_REPORT_ROWS = 50;
const MAX_REPORT_SOURCES = 200;
const MAX_REPORT_CONCLUSIONS = 128;
const MAX_DISPLAY_TEXT = 4_000;

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function boundedDisplay(value) {
  const text = String(value);
  return text.length > MAX_DISPLAY_TEXT
    ? `${text.slice(0, MAX_DISPLAY_TEXT)}…[TRUNCATED]`
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

function artifactHash(evidence) {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function narrativeFor(narrative, id) {
  const sections = Array.isArray(narrative) ? narrative : narrative?.sections;
  return Array.isArray(sections)
    ? sections.find((section) => section?.id === id && typeof section.text === 'string')?.text
    : undefined;
}

function dataCutoffs(markets) {
  return Object.entries(markets || {})
    .map(([market, value]) => `${market}: ${value?.dataDate || '—'}`)
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

function leaderboardRows(rows, evidence) {
  return (Array.isArray(rows) ? rows.slice(0, MAX_REPORT_ROWS) : []).map((row, index) => [
    row.rank ?? index + 1,
    row.symbol || row.id || '—',
    row.name || '—',
    row.dataDate || evidence.markets?.aShare?.dataDate || evidence.reportDate,
    row.score,
    contributions(row),
    row.confidence,
    row.status || 'RANKED',
    valueText(row.vetoes)
  ]);
}

function sourceRows(sources) {
  return (Array.isArray(sources) ? sources.slice(0, MAX_REPORT_SOURCES) : []).map((source) => [
    source.method,
    source.dataAsOf,
    source.window || source.dataWindow,
    source.coverage,
    source.rowCount,
    source.traceSequence ?? source.sequence ?? source.id,
    source.status
  ]);
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
    details?.dataDate,
    details?.rowCount,
    Object.entries(details || {})
      .filter(([key]) => !['dataDate', 'rowCount'].includes(key))
      .map(([key, value]) => `${key}:${valueText(value)}`)
      .join(', ')
  ]);
}

function conclusionRows(conclusions) {
  return (Array.isArray(conclusions) ? conclusions.slice(0, MAX_REPORT_CONCLUSIONS) : []).map((item) => [
    item.conclusion_id,
    item.formula,
    item.confidence,
    valueText(item.limitations)
  ]);
}

function missingRows(missingData) {
  return (Array.isArray(missingData) ? missingData.slice(0, MAX_REPORT_SOURCES) : []).map((item) => [
    item.section,
    item.method,
    item.status,
    item.coverage,
    item.error
  ]);
}

function htmlConclusionTable(conclusions) {
  const rows = Array.isArray(conclusions)
    ? conclusions.slice(0, MAX_REPORT_CONCLUSIONS)
    : [];
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
  const vetoRows = Object.entries(evidence.leaderboards || {}).flatMap(([board, rows]) =>
    (rows || []).filter((row) => Array.isArray(row.vetoes) && row.vetoes.length)
      .map((row) => [board, row.symbol || row.id, valueText(row.vetoes), row.dataDate || evidence.reportDate])
  );
  const artifacts = Array.isArray(evidence.artifacts) && evidence.artifacts.length
    ? evidence.artifacts.slice(0, 50).map((item) => [item.name, item.sha256 || item.hash])
    : [['evidence-pack.json', artifactHash(evidence)]];
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
          leaderboardRows(evidence.leaderboards?.hotIndustries, evidence)
        ),
        '### 热门概念',
        markdownTable(
          ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
          leaderboardRows(evidence.leaderboards?.hotConcepts, evidence)
        )
      ].join('\n\n'),
      html: `<h3>热门行业</h3>${
        htmlTable(
          ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
          leaderboardRows(evidence.leaderboards?.hotIndustries, evidence)
        )
      }<h3>热门概念</h3>${
        htmlTable(
          ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
          leaderboardRows(evidence.leaderboards?.hotConcepts, evidence)
        )
      }`
    },
    'sell-pressure': {
      markdown: markdownTable(
        ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
        leaderboardRows(evidence.leaderboards?.sellPressure, evidence)
      ),
      html: htmlTable(
        ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
        leaderboardRows(evidence.leaderboards?.sellPressure, evidence)
      )
    },
    'potential-watchlist': {
      markdown: markdownTable(
        ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
        leaderboardRows(evidence.leaderboards?.potentialWatchlist, evidence)
      ),
      html: htmlTable(
        ['排名', '标识', '名称', '数据日', '总分', '分数贡献', '置信度', '状态', '否决'],
        leaderboardRows(evidence.leaderboards?.potentialWatchlist, evidence)
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
        ...(evidence.conventions || []).slice(0, 100).map((item) => `- ${markdownText(item)}`)
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
        (evidence.conventions || []).slice(0, 100)
          .map((item) => `<li>${escapeHtml(valueText(item))}</li>`).join('')
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

function detailTable(headers, rows) {
  return htmlTable(headers, rows.slice(0, MAX_DETAIL_ROWS));
}

export function renderRunDetail({ run = {}, evidence = {}, trace = {} } = {}) {
  run = sanitizeTraceValue(run) || {};
  evidence = sanitizeTraceValue(evidence) || {};
  trace = sanitizeTraceValue(trace) || {};
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const workerEvents = Array.isArray(trace.workerEvents) ? trace.workerEvents : [];
  const modelUsage = Array.isArray(trace.modelUsage) ? trace.modelUsage : [];
  const emailAttempts = Array.isArray(trace.emailAttempts) ? trace.emailAttempts : [];
  const artifacts = [
    ...(Array.isArray(run.artifacts) ? run.artifacts : []),
    ...(Array.isArray(evidence.artifacts) ? evidence.artifacts : [])
  ];
  const conclusions = Array.isArray(evidence.conclusions) ? evidence.conclusions : [];
  const traceLineage = Array.isArray(trace.conclusionLineage)
    ? trace.conclusionLineage
    : (trace.conclusionLineage && typeof trace.conclusionLineage === 'object'
      ? [trace.conclusionLineage]
      : []);
  const lineage = new Map();
  for (const item of [...conclusions, ...traceLineage]) {
    const id = item.conclusion_id || item.conclusionId;
    if (!id) continue;
    lineage.set(id, { ...(lineage.get(id) || {}), ...item });
  }
  return `<main class="run-detail"><h1>运行详情 ${escapeHtml(run.id || evidence.runId || '—')}</h1>${
    '<section><h2>运行摘要</h2>'
  }${detailTable(['字段', '值'], [
    ['运行 ID', run.id || evidence.runId],
    ['状态', run.status || evidence.status],
    ['报告日', evidence.reportDate],
    ['开始时间', run.startedAt || trace.startedAt],
    ['结束时间', run.endedAt || trace.endedAt]
  ])}</section><section><h2>技能与工具调用</h2>${
    detailTable(['序号', '技能', '工具', '状态', '耗时(ms)'], steps.map((item) => [
      item.sequence, item.skillId, item.tool, item.status, item.durationMs
    ]))
  }</section><section><h2>Panda 调用</h2>${
    detailTable(
      ['序号', '方法', '耗时(ms)', '行数', '缓存', '重试', '状态'],
      workerEvents.map((item) => [
        item.sequence,
        item.method || item.detail?.method,
        item.durationMs ?? item.detail?.durationMs,
        item.rowCount ?? item.detail?.rowCount,
        item.cache ?? item.cacheStatus ?? item.detail?.cache,
        item.retries ?? item.retryCount ?? item.detail?.retries,
        item.status
      ])
    )
  }</section><section><h2>模型用量</h2>${
    detailTable(
      ['提供方', '模型', '输入', '输出', '推理', '缓存', '总计', '成本', '币种'],
      modelUsage.map((item) => [
        item.provider, item.model, item.inputTokens, item.outputTokens, item.reasoningTokens,
        item.cachedTokens, item.totalTokens, item.cost, item.currency
      ])
    )
  }</section><section><h2>邮件尝试</h2>${
    detailTable(['状态', '时间', '收件方摘要', '错误'], emailAttempts.map((item) => [
      item.status, item.attemptedAt || item.startedAt, valueText(item.recipients), item.error
    ]))
  }</section><section><h2>产物</h2>${
    detailTable(['名称', 'SHA-256', '类型'], artifacts.map((item) => [
      item.name, item.sha256 || item.hash, item.mediaType || item.type
    ]))
  }</section><section><h2>结论链路</h2>${
    detailTable(
      ['结论 ID', '公式', '置信度', '来源', '指标/证据', '数据日/窗口', '限制'],
      [...lineage.entries()].map(([id, item]) => [
        id,
        item.formula,
        item.confidence,
        valueText(item.sourceIds || item.pandaCalls),
        valueText(item.metricIds || item.evidenceIds),
        valueText(item.dataDate || item.window || item.dataWindow),
        valueText(item.limitations)
      ])
    )
  }</section></main>`;
}
