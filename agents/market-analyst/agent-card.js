const SKILLS = [
  {
    id: 'daily-market-report',
    name: '每日市场报告',
    description: '生成基于 panda_data 的完整收盘报告、Evidence Pack 和 Run Trace。',
    tags: ['panda_data', 'A股', '收盘复盘', '市场报告'],
    examples: ['生成 2026-07-23 的每日市场报告']
  },
  {
    id: 'hot-topic-analysis',
    name: '热点主题分析',
    description: '根据涨幅、广度、成交、持续性和资金证据排名行业与概念热点。',
    tags: ['panda_data', '行业', '概念', '市场热点'],
    examples: ['分析最近一个交易日最热的行业和概念']
  },
  {
    id: 'sell-pressure-scan',
    name: '卖压观察榜',
    description: '识别多项市场行为证据汇聚的卖压观察标的，不推断未知卖方身份。',
    tags: ['panda_data', '卖压', '风险', '观察榜'],
    examples: ['列出卖压最明显的十只 A 股']
  },
  {
    id: 'potential-watchlist',
    name: '潜力研究观察榜',
    description: '综合趋势、主题、质量、估值、资金、流动性和风险生成研究候选。',
    tags: ['panda_data', '潜力', '研究候选', '观察榜'],
    examples: ['生成十只潜力研究候选并给出证据']
  },
  {
    id: 'inspect-run-trace',
    name: '运行溯源查询',
    description: '读取指定运行的工具、接口、耗时、Token、错误和结论证据链。',
    tags: ['运行追踪', 'Token', '接口耗时', '结论溯源'],
    examples: ['查看运行 run-20260723 的全部调用和结论来源']
  }
];

export function buildMarketAgentCard(origin, config = {}) {
  const base = String(origin || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new TypeError('origin must be an HTTP(S) origin');
  const card = {
    name: 'Panda Market Analyst',
    description: '基于 panda_data 的可追溯市场收盘分析 Agent，生成热点、卖压与潜力观察榜。',
    version: '1.0.0',
    supportedInterfaces: [{
      url: `${base}/a2a/v1`,
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0'
    }],
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/markdown', 'application/json'],
    skills: structuredClone(SKILLS)
  };
  if (config.accessToken || config.accessProtected) {
    card.securitySchemes = {
      bearerAuth: {
        httpAuthSecurityScheme: {
          description: 'Bearer token for protected Panda Market Analyst operations',
          scheme: 'Bearer',
          bearerFormat: 'opaque'
        }
      }
    };
    card.securityRequirements = [{
      schemes: { bearerAuth: { list: [] } }
    }];
  }
  return card;
}
