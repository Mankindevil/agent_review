import { callA2AAgent, validateAgentCard } from './a2a.js';
import { configuredReviewers, reviewAgent } from './providers.js';
import { buildRoast, judgeOutput, scoreComplexity } from './scoring.js';
import { buildSkill, RUNTIMES, runSkill } from './runtimes.js';
import { average, id, now, round, stableNumber } from './utils.js';

export class EvaluationPipeline {
  constructor(store, events) {
    this.store = store;
    this.events = events;
    this.activeRuns = new Map();
  }

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
    const controller = new AbortController();
    this.activeRuns.set(evaluation.id, controller);
    queueMicrotask(() => this.run(evaluation.id, controller.signal)
      .catch((error) => this.fail(evaluation.id, error))
      .finally(() => this.activeRuns.delete(evaluation.id)));
    return evaluation;
  }

  async cancel(evaluationId) {
    const item = this.store.get(evaluationId);
    if (!item) return null;
    if (isTerminal(item.status)) return item;
    const reason = new Error('用户停止了本次评测');
    reason.name = 'AbortError';
    this.activeRuns.get(evaluationId)?.abort(reason);
    await this.update(item, { status: 'cancelled', stage: '评测已停止', stoppedAt: now() }, {
      level: 'error', source: 'SYSTEM', phase: 'cancelled', text: '用户停止了本次评测', detail: '已保留停止前完成的所有阶段产物', mode: item.mode
    });
    return item;
  }

  async recoverInterrupted() {
    for (const item of this.store.list().filter((value) => ['queued', 'running'].includes(value.status))) {
      await this.update(item, { status: 'interrupted', stage: '服务重启，评测已中断', stoppedAt: now(), error: '执行进程在评测期间重启；已保留重启前完成的阶段产物。' }, {
        level: 'error', source: 'SYSTEM', phase: 'interrupted', text: '检测到未完成的遗留评测', detail: '执行进程已重启，旧任务不再实际运行', mode: item.mode
      });
    }
  }

  async run(evaluationId, signal) {
    const item = this.store.get(evaluationId);
    signal?.throwIfAborted();
    const target = item.validation.interfaces[0];
    await this.update(item, { status: 'running', progress: 6, stage: 'A2A 协议体检' }, {
      level: 'success', source: 'A2A', phase: 'protocol', text: 'Agent Card 结构与接口声明通过',
      detail: `${target.binding} · v${target.version} · ${redactUrl(target.url)}`, mode: item.mode
    });

    const complexity = scoreComplexity(item.agentCard, item.cases);
    await this.update(item, { complexity, progress: 22, stage: '判断是否值得 Agent 化' }, {
      level: 'info', source: 'SCORER', phase: 'complexity', text: `${complexity.verdict} · ${complexity.score}/100`,
      detail: Object.entries(complexity.dimensions).map(([key, value]) => `${key}=${value}`).join(' · '), mode: 'rules'
    });

    const reviewers = configuredReviewers();
    const professionalReviews = [];
    for (const reviewer of reviewers) {
      signal?.throwIfAborted();
      const startedAt = Date.now();
      await this.update(item, { progress: 28 + professionalReviews.length * 8, stage: `${reviewer.name} 正在盲审` }, {
        level: 'info', source: 'MODEL', phase: 'review', text: `${reviewer.model} 接过了答卷`, mode: item.mode
      });
      try {
        const review = await reviewAgent(reviewer, item.agentCard, complexity, item.mode, signal);
        professionalReviews.push(review);
        await this.update(item, { professional: professionalSnapshot(professionalReviews) }, { level: 'success', source: 'MODEL', phase: 'review', text: `${reviewer.model} 完成盲审 · ${review.score}/100`, mode: review.mode, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        professionalReviews.push({ reviewer: reviewer.name, model: reviewer.model, score: 0, error: error.message, mode: item.mode });
        await this.update(item, { professional: professionalSnapshot(professionalReviews) }, { level: 'error', source: 'MODEL', phase: 'review', text: `${reviewer.model} 调用失败`, detail: error.message, mode: item.mode, durationMs: Date.now() - startedAt });
      }
    }
    const validProfessional = professionalReviews.filter((review) => review.score > 0);
    const professional = professionalSnapshot(professionalReviews);
    const professionalMode = professional.mode;
    await this.update(item, { professional, progress: 52, stage: 'Runtime 现场复刻' }, { level: 'success', source: 'MODEL', phase: 'review', text: `${reviewers.length} 位模型评审已交卷`, detail: `有效评审 ${validProfessional.length} · 均分 ${professional.score}`, mode: professionalMode });

    const builds = [];
    for (const runtime of RUNTIMES) {
      signal?.throwIfAborted();
      const startedAt = Date.now();
      await this.update(item, {}, { level: 'info', source: 'RUNTIME', phase: 'build', text: `${runtime.name} 开始复刻 skill`, mode: item.mode });
      try {
        const build = await buildSkill(runtime, item.agentCard, item.mode, { signal });
        builds.push(build);
        await this.update(item, { builds: [...builds] }, { level: 'success', source: 'RUNTIME', phase: 'build', text: `${runtime.name} 复刻完成`, detail: build.skill?.name, mode: build.mode, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        builds.push({ runtime: runtime.name, runtimeId: runtime.id, mode: item.mode, error: error.message });
        await this.update(item, { builds: [...builds] }, { level: 'error', source: 'RUNTIME', phase: 'build', text: `${runtime.name} 复刻失败`, detail: error.message, mode: item.mode, durationMs: Date.now() - startedAt });
      }
    }
    const runtimeMode = summarizeModes(builds.map((build) => build.error ? 'failed' : build.mode));
    await this.update(item, { builds, progress: 66, stage: '同题竞技场' }, { level: 'success', source: 'RUNTIME', phase: 'build', text: 'Runtime 复刻阶段结束', detail: builds.map((build) => `${build.runtime}:${build.mode}${build.error ? ':failed' : ''}`).join(' · '), mode: runtimeMode });

    const benchmark = [];
    for (let index = 0; index < item.cases.length; index += 1) {
      signal?.throwIfAborted();
      const testCase = item.cases[index];
      const entries = [];
      benchmark.push({ case: testCase, entries });
      let submittedOutput;
      let submittedMode = item.mode;
      let startedAt = Date.now();
      try {
        submittedOutput = item.mode === 'live'
          ? (await callA2AAgent(item.agentCard, testCase.prompt, 45_000, signal)).text
          : mockSubmittedOutput(item.agentCard, testCase);
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        submittedOutput = `执行失败：${error.message}`;
        submittedMode = 'failed';
      }
      entries.push(makeEntry('submitted', item.agentCard.name, submittedOutput, testCase, submittedMode));
      await this.update(item, { benchmark, progress: 70 + Math.round((index / item.cases.length) * 22), stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, {
        level: submittedMode === 'failed' ? 'error' : 'success', source: 'A2A', phase: 'benchmark', text: `${item.agentCard.name} 完成「${testCase.name}」`, detail: `score=${entries.at(-1).score}`, mode: submittedMode, durationMs: Date.now() - startedAt
      });
      for (const build of builds) {
        signal?.throwIfAborted();
        if (build.error) {
          entries.push(makeEntry(build.runtimeId, build.runtime, `执行失败：${build.error}`, testCase, 'failed'));
          await this.update(item, { benchmark, stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, { level: 'error', source: 'RUNTIME', phase: 'benchmark', text: `${build.runtime} 无法进入「${testCase.name}」`, detail: build.error, mode: 'failed' });
          continue;
        }
        startedAt = Date.now();
        try {
          const output = await runSkill(build, testCase, item.mode, { signal });
          entries.push(makeEntry(build.runtimeId, build.runtime, output, testCase, build.mode));
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error;
          entries.push(makeEntry(build.runtimeId, build.runtime, `执行失败：${error.message}`, testCase, 'failed'));
        }
        await this.update(item, { benchmark, stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, { level: entries.at(-1).mode === 'failed' ? 'error' : 'success', source: 'RUNTIME', phase: 'benchmark', text: `${build.runtime} 完成「${testCase.name}」`, detail: `score=${entries.at(-1).score}`, mode: entries.at(-1).mode, durationMs: Date.now() - startedAt });
      }
      await this.update(item, { benchmark, progress: 70 + Math.round(((index + 1) / item.cases.length) * 22), stage: `对测 ${index + 1}/${item.cases.length} 完成` }, { level: 'success', source: 'ARENA', phase: 'benchmark', text: `「${testCase.name || `案例 ${index + 1}`}」完成同 prompt 对打`, detail: entries.map((entry) => `${entry.name}=${entry.score}`).join(' · '), mode: summarizeModes(entries.map((entry) => entry.mode)) });
    }

    const averages = Object.fromEntries(['submitted', 'claude-code', 'cursor', 'doubao'].map((competitor) => {
      const scores = benchmark.flatMap((roundItem) => roundItem.entries.filter((entry) => entry.id === competitor).map((entry) => entry.score));
      return [competitor, round(average(scores), 1)];
    }));
    const roast = buildRoast(averages.submitted, averages['claude-code'], averages.doubao, professional.score, complexity);
    const coverage = { agent: item.mode === 'live' ? 'live' : 'demo', models: professionalMode, runtimes: runtimeMode };
    const overallMode = summarizeModes(Object.values(coverage));
    await this.update(item, { averages, roast, coverage, overallMode, status: 'completed', progress: 100, stage: '锐评出炉', completedAt: now() }, { level: 'success', source: 'VERDICT', phase: 'complete', text: roast.headline, detail: `tier=${roast.tier.label} · submitted=${averages.submitted} · claude=${averages['claude-code']} · doubao=${averages.doubao}`, mode: overallMode });
  }

  async update(item, patch, log) {
    Object.assign(item, patch, { updatedAt: now() });
    const logs = Array.isArray(log) ? log : log ? [log] : [];
    logs.forEach((entry) => item.logs.push({ at: now(), level: 'info', source: 'SYSTEM', phase: 'pipeline', ...(typeof entry === 'string' ? { text: entry } : entry) }));
    await this.store.set(item);
    this.events.emit(item.id, item);
  }

  async fail(evaluationId, error) {
    const item = this.store.get(evaluationId);
    if (!item || ['cancelled', 'interrupted'].includes(item.status)) return;
    await this.update(item, { status: 'failed', stage: '评测中断', error: error.message }, { level: 'error', source: 'SYSTEM', phase: 'failed', text: '评测中断', detail: error.message, mode: item.mode });
  }
}

function professionalSnapshot(reviews) {
  const valid = reviews.filter((review) => review.score > 0);
  return { score: round(average(valid.map((review) => review.score)), 1), mode: summarizeModes(reviews.map((review) => review.mode)), reviews: [...reviews] };
}

function isTerminal(status) { return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status); }

function redactUrl(rawUrl) {
  try { const url = new URL(rawUrl); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return 'invalid-url'; }
}

function summarizeModes(modes) {
  const unique = new Set(modes.filter(Boolean));
  if (unique.size === 1) return [...unique][0];
  return 'mixed';
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
