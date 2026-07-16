import { callA2AAgent, validateAgentCard } from './a2a.js';
import { configuredReviewers, reviewAgent } from './providers.js';
import { buildRoast, judgeOutput, scoreComplexity } from './scoring.js';
import { buildSkill, RUNTIMES, runSkill } from './runtimes.js';
import { average, id, now, round, stableNumber } from './utils.js';

export class EvaluationPipeline {
  constructor(store, events) { this.store = store; this.events = events; }

  async create(input) {
    const validation = validateAgentCard(input.agentCard);
    if (!validation.valid) throw Object.assign(new Error(`Agent Card 校验失败：${validation.errors.join('；')}`), { statusCode: 400 });
    if (!Array.isArray(input.cases) || !input.cases.length || input.cases.some((item) => !item?.prompt?.trim())) {
      throw Object.assign(new Error('至少提供一个包含 prompt 的使用实例'), { statusCode: 400 });
    }
    const evaluation = {
      id: id(), createdAt: now(), updatedAt: now(), status: 'queued', mode: input.mode === 'live' ? 'live' : 'demo',
      agentCard: input.agentCard, cases: input.cases.slice(0, 5), validation, progress: 0, stage: '等待评测舱', logs: []
    };
    await this.store.set(evaluation);
    queueMicrotask(() => this.run(evaluation.id).catch((error) => this.fail(evaluation.id, error)));
    return evaluation;
  }

  async run(evaluationId) {
    const item = this.store.get(evaluationId);
    await this.update(item, { status: 'running', progress: 6, stage: 'A2A 协议体检' }, 'Agent Card 结构与接口声明通过');

    const complexity = scoreComplexity(item.agentCard, item.cases);
    await this.update(item, { complexity, progress: 22, stage: '判断是否值得 Agent 化' }, `${complexity.verdict} · ${complexity.score}/100`);

    const reviewers = configuredReviewers();
    const professionalReviews = [];
    for (const reviewer of reviewers) {
      await this.update(item, { progress: 28 + professionalReviews.length * 8, stage: `${reviewer.name} 正在盲审` }, `${reviewer.model} 接过了答卷`);
      try { professionalReviews.push(await reviewAgent(reviewer, item.agentCard, complexity, item.mode)); }
      catch (error) { professionalReviews.push({ reviewer: reviewer.name, model: reviewer.model, score: 0, error: error.message, mode: item.mode }); }
    }
    const validProfessional = professionalReviews.filter((review) => review.score > 0);
    const professional = { score: round(average(validProfessional.map((review) => review.score)), 1), reviews: professionalReviews };
    await this.update(item, { professional, progress: 52, stage: 'Runtime 现场复刻' }, `${reviewers.length} 位模型评审已交卷`);

    const builds = [];
    for (const runtime of RUNTIMES) {
      try { builds.push(await buildSkill(runtime, item.agentCard, item.mode)); }
      catch (error) { builds.push({ runtime: runtime.name, runtimeId: runtime.id, mode: item.mode, error: error.message }); }
    }
    await this.update(item, { builds, progress: 66, stage: '同题竞技场' }, '三个 runtime 已根据同一份描述复刻 skill');

    const benchmark = [];
    for (let index = 0; index < item.cases.length; index += 1) {
      const testCase = item.cases[index];
      const entries = [];
      let submittedOutput;
      let submittedMode = item.mode;
      try {
        submittedOutput = item.mode === 'live'
          ? (await callA2AAgent(item.agentCard, testCase.prompt)).text
          : mockSubmittedOutput(item.agentCard, testCase);
      } catch (error) {
        submittedOutput = `执行失败：${error.message}`;
        submittedMode = 'failed';
      }
      entries.push(makeEntry('submitted', item.agentCard.name, submittedOutput, testCase, submittedMode));
      for (const build of builds) {
        if (build.error) {
          entries.push(makeEntry(build.runtimeId, build.runtime, `执行失败：${build.error}`, testCase, 'failed'));
          continue;
        }
        try {
          const output = await runSkill(build, testCase, item.mode);
          entries.push(makeEntry(build.runtimeId, build.runtime, output, testCase, build.mode));
        } catch (error) {
          entries.push(makeEntry(build.runtimeId, build.runtime, `执行失败：${error.message}`, testCase, 'failed'));
        }
      }
      benchmark.push({ case: testCase, entries });
      await this.update(item, { benchmark, progress: 70 + Math.round(((index + 1) / item.cases.length) * 22), stage: `对测 ${index + 1}/${item.cases.length}` }, `「${testCase.name || `案例 ${index + 1}`}」完成同 prompt 对打`);
    }

    const averages = Object.fromEntries(['submitted', 'claude-code', 'cursor', 'doubao'].map((competitor) => {
      const scores = benchmark.flatMap((roundItem) => roundItem.entries.filter((entry) => entry.id === competitor).map((entry) => entry.score));
      return [competitor, round(average(scores), 1)];
    }));
    const roast = buildRoast(averages.submitted, averages['claude-code'], averages.doubao, professional.score, complexity);
    await this.update(item, { averages, roast, status: 'completed', progress: 100, stage: '锐评出炉', completedAt: now() }, roast.headline);
  }

  async update(item, patch, log) {
    Object.assign(item, patch, { updatedAt: now() });
    if (log) item.logs.push({ at: now(), text: log });
    await this.store.set(item);
    this.events.emit(item.id, item);
  }

  async fail(evaluationId, error) {
    const item = this.store.get(evaluationId);
    if (!item) return;
    await this.update(item, { status: 'failed', stage: '评测中断', error: error.message }, error.message);
  }
}

function makeEntry(id, name, output, testCase, mode) {
  const judged = judgeOutput(testCase.prompt, output, id);
  if (mode === 'failed') judged.score = 0;
  return { id, name, output, mode, ...judged };
}

function mockSubmittedOutput(card, testCase) {
  const skillNames = (card.skills || []).map((skill) => skill.name).join('、');
  const quality = stableNumber(`${card.name}:${testCase.prompt}`, 0, 2);
  const detail = quality > 0 ? '\n3. 验收依据：逐项核对输入约束，保留可追溯的处理说明。' : '';
  return `已调用「${card.name}」处理该请求。\n1. 能力匹配：${skillNames}\n2. 处理结果：已按 Agent Card 声明的流程完成「${testCase.prompt}」。${detail}\n4. 边界：未提供的外部数据不会被推测为事实。`;
}
