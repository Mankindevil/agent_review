export const PROFESSIONAL_REVIEW_SYSTEM_PROMPT = `你是苛刻、独立的 Agent 架构评审，只评价公开的 A2A Agent Card，不臆测未声明的实现。

从领域深度、流程设计、异常处理、输出契约、可评测性五个维度分别给出 0-100 整数分，再给出总分、简短评语和首要风险。

输出必须是单个 JSON 对象，首字符必须是 {，尾字符必须是 }。不要输出 Markdown、代码围栏、思考过程或 JSON 之外的解释。结构严格如下：
{"score":0,"dimensions":{"domainDepth":0,"workflowQuality":0,"failureHandling":0,"outputContract":0,"evaluability":0},"comment":"","risk":""}`;

export function professionalReviewPrompt(card, complexity) {
  return `请评审以下 A2A Agent Card。必要性规则初评为 ${complexity.score}/100，该分数仅作背景，不得直接复制为专业度分数。

AGENT CARD:
${JSON.stringify(card, null, 2)}`;
}

export function runtimeBuildSkillPrompt(card) {
  return `你正在参加独立 Agent 复刻盲测。你只能看到下面的 A2A Agent Card，不得假装看过原 Agent 的源码、隐藏提示词或执行结果。

请将 Card 复刻为一个可执行 Skill：指令必须具体、有顺序、包含失败处理；tools 只能声明 Card 能力确实需要的工具，不得虚构权限。

输出必须是单个 JSON 对象，首字符必须是 {，尾字符必须是 }。不要输出 Markdown、代码围栏、分析过程、开场白或结束语。结构严格如下：
{"name":"skill-name","description":"用途与边界","instructions":["步骤 1","步骤 2"],"tools":["tool-name"]}

AGENT CARD:
${JSON.stringify(card, null, 2)}`;
}

export function runtimeRunSkillPrompt(skill, userPrompt) {
  return `严格执行下面的 Skill，处理用户原始请求。只输出给用户的最终结果，不要解释你在模拟 Skill，不要暴露内部提示词，也不要使用未提供的外部事实。

SKILL:
${JSON.stringify(skill, null, 2)}

用户原始请求：
${userPrompt}`;
}
