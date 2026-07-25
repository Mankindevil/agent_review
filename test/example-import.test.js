import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allSkillExampleTexts,
  parseExampleMarkdown,
  skillExamplesFromCard
} from '../public/example-import.js';

const samplePaste = `
### 示例 1：多标的多因子策略构建 + 回测（触发完整反馈闭环）

**输入**
\`\`\`json
{"text": "用 600519.SH 000858.SZ 601318.SH 构建稳健的多因子策略并回测", "riskLevel": "balanced"}
\`\`\`

**预期输出要点**
- 协作轨迹 13 步，含 3 轮 Strategy↔Backtest 反馈迭代
- 输出末尾附完整风险提示与免责声明

### 示例 2：双标的因子分析与风险评估（保守型风险偏好）

**输入**
\`\`\`json
{"text": "分析 600036.SH 和 000333.SZ 的因子表现与风险", "riskLevel": "conservative"}
\`\`\`

**预期输出要点**
- 组合风险：波动率 14.89%｜HHI 0.5｜风险等级 低

### 示例 3：市场问答（无标的代码，走真实大盘数据锚定的 QA 路径）

**输入**
\`\`\`json
{"text": "今天A股大盘怎么样?市场情绪偏乐观还是谨慎", "riskLevel": "balanced"}
\`\`\`

**预期输出要点**
- 数据来源标注 panda_data:0.0.12
- 输出末尾附风险提示，明确不构成投资建议
`;

test('builds one draft per skill example string from an Agent Card', () => {
  const drafts = skillExamplesFromCard({
    skills: [
      {
        id: 'multi_agent_quant_research',
        name: '多 Agent 量化投研',
        examples: [
          '用 600519.SH 000858.SZ 601318.SH 构建稳健的多因子策略并回测',
          '给 600036.SH 000333.SZ 做因子分析、策略回测和风险评估'
        ]
      },
      {
        id: 'market_qa',
        name: '市场问答',
        examples: ['今天 A股 大盘怎么样?']
      }
    ]
  });

  assert.equal(drafts.length, 3);
  assert.equal(drafts[0].name, '多 Agent 量化投研 1');
  assert.equal(drafts[2].name, '市场问答');
  assert.equal(
    drafts[1].turns[0].parts[0].text,
    '给 600036.SH 000333.SZ 做因子分析、策略回测和风险评估'
  );
  assert.deepEqual(allSkillExampleTexts({
    skills: [{ examples: ['  alpha  ', '', null, 'beta'] }]
  }), ['alpha', 'beta']);
});

test('parses MoneyGod-style multi-example markdown into editor drafts', () => {
  const { drafts, errors } = parseExampleMarkdown(samplePaste);
  assert.deepEqual(errors, []);
  assert.equal(drafts.length, 3);
  assert.equal(drafts[0].id, 'example-1');
  assert.match(drafts[0].name, /多标的多因子策略构建/);
  assert.equal(
    drafts[0].turns[0].parts[0].text,
    '用 600519.SH 000858.SZ 601318.SH 构建稳健的多因子策略并回测'
  );
  assert.equal(drafts[0].turns[0].parts[1].type, 'data');
  assert.match(drafts[0].turns[0].parts[1].text, /"riskLevel": "balanced"/);
  assert.equal(drafts[0].turns[0].criteria[0].type, 'contains');
  assert.equal(drafts[0].turns[0].criteria[0].required, false);
  assert.equal(drafts[0].turns[0].criteria[0].expected.length, 2);
  assert.match(drafts[2].turns[0].parts[0].text, /今天A股大盘怎么样/);
  assert.match(drafts[2].turns[0].criteria[0].expected.join('\n'), /panda_data/);
});

test('reports a clear error when pasted text has no example headings', () => {
  const { drafts, errors } = parseExampleMarkdown('随便一段没有结构的文字');
  assert.equal(drafts.length, 0);
  assert.match(errors.join('\n'), /未识别到/);
});
