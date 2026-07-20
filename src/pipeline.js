import { callA2AAgent, validateAgentCard } from './a2a.js';
import { configuredReviewers, reviewAgent } from './providers.js';
import { buildRoast, judgeOutput, scoreComplexity } from './scoring.js';
import { buildSkill, RUNTIMES, runSkill } from './runtimes.js';
import { average, deriveSeed, id, normalizeSeed, normalizeTemperature, now, round, stableNumber } from './utils.js';

export class EvaluationPipeline {
  constructor(store, events) {
    this.store = store;
    this.events = events;
    this.activeRuns = new Map();
  }

  async create(input) {
    const validation = validateAgentCard(input.agentCard);
    if (!validation.valid) throw Object.assign(new Error(`Agent Card 校验失败：${validation.errors.join('；')}`), { statusCode: 400 });
    if (!Array.isArray(input.cases) || !input.cases.length || input.cases.some((item) => typeof item?.prompt !== 'string' || !item.prompt.trim())) {
      throw Object.assign(new Error('至少提供一个包含 prompt 的使用实例'), { statusCode: 400 });
    }
    if (input.seed !== undefined && (!Number.isSafeInteger(Number(input.seed)) || Number(input.seed) < 0 || Number(input.seed) > 2_147_483_646)) {
      throw Object.assign(new Error('Seed 必须是 0–2147483646 的整数'), { statusCode: 400 });
    }
    const seed = normalizeSeed(input.seed ?? process.env.EVALUATION_SEED);
    const temperature = normalizeTemperature(process.env.MODEL_TEMPERATURE, 0);
    const reviewPlan = publicReviewPlan(configuredReviewers());
    const runtimePlan = publicRuntimePlan();
    const evaluation = {
      id: id(), createdAt: now(), updatedAt: now(), status: 'queued', mode: input.mode === 'live' ? 'live' : 'demo',
      agentCard: input.agentCard, cases: input.cases.slice(0, 5), validation, seed, temperature, reviewPlan, runtimePlan, progress: 0, stage: '等待评测舱', activeWork: null, logs: []
    };
    await this.store.set(evaluation);
    const controller = new AbortController();
    this.activeRuns.set(evaluation.id, controller);
    queueMicrotask(() => this.run(evaluation.id, controller.signal)
      .catch((error) => this.fail(evaluation.id, error))
      .finally(() => { if (this.activeRuns.get(evaluation.id) === controller) this.activeRuns.delete(evaluation.id); }));
    return evaluation;
  }

  async cancel(evaluationId) {
    const item = this.store.get(evaluationId);
    if (!item) return null;
    if (isTerminal(item.status)) return item;
    const reason = new Error('用户停止了本次评测');
    reason.name = 'AbortError';
    this.activeRuns.get(evaluationId)?.abort(reason);
    await this.update(item, { status: 'cancelled', stage: '评测已停止', stoppedAt: now(), retrying: null, activeWork: null }, {
      level: 'error', source: 'SYSTEM', phase: 'cancelled', text: '用户停止了本次评测', detail: '已保留停止前完成的所有阶段产物', mode: item.mode
    });
    return item;
  }

  async retry(evaluationId, input) {
    const item = this.store.get(evaluationId);
    if (!item) return null;
    if (!isTerminal(item.status)) throw Object.assign(new Error('主评测仍在执行，请结束后再单独重试步骤'), { statusCode: 409 });
    const step = resolveRetryStep(item, input);
    const previous = retryTargetSummary(item, step);
    const previousStatus = item.status;
    const controller = new AbortController();
    this.activeRuns.set(evaluationId, controller);
    await this.update(item, { status: 'retrying', stage: step.label, retrying: step, activeWork: retryActivity(step) }, {
      level: 'info', source: 'RETRY', phase: step.type, text: step.label, detail: '旧结果保留至新结果返回，完成后自动重算总评', mode: item.mode
    });
    queueMicrotask(() => this.runRetry(item, step, previous, previousStatus, controller.signal)
      .catch((error) => this.failRetry(item, step, previous, previousStatus, error))
      .finally(() => { if (this.activeRuns.get(evaluationId) === controller) this.activeRuns.delete(evaluationId); }));
    return item;
  }

  async recoverInterrupted() {
    for (const item of this.store.list().filter((value) => ['queued', 'running', 'retrying'].includes(value.status))) {
      await this.update(item, { status: 'interrupted', stage: '服务重启，评测已中断', stoppedAt: now(), error: '执行进程在评测期间重启；已保留重启前完成的阶段产物。', activeWork: null }, {
        level: 'error', source: 'SYSTEM', phase: 'interrupted', text: '检测到未完成的遗留评测', detail: '执行进程已重启，旧任务不再实际运行', mode: item.mode
      });
    }
  }

  async runRetry(item, step, previous, previousStatus, signal) {
    const startedAt = Date.now();
    signal.throwIfAborted();
    if (step.type === 'review') await this.retryReview(item, step, signal);
    if (step.type === 'build') await this.retryBuild(item, step, signal);
    if (step.type === 'benchmark') await this.retryBenchmark(item, step, signal);
    signal.throwIfAborted();
    const result = retryTargetSummary(item, step);
    appendRetryHistory(item, step, previous, result, Date.now() - startedAt);
    const derived = recalculateDerived(item);
    const completed = hasCompleteBenchmark(item);
    await this.update(item, {
      ...derived,
      status: completed ? 'completed' : previousStatus,
      stage: completed ? '单步复核完成，锐评已重算' : '单步复核完成',
      retrying: null,
      activeWork: null,
      ...(completed ? { completedAt: now() } : {})
    }, {
      level: result.error ? 'error' : 'success', source: 'RETRY', phase: step.type,
      text: result.error ? `${step.shortLabel} 重试仍失败` : `${step.shortLabel} 重试完成，综合评分已更新`,
      detail: retryDeltaText(previous, result), mode: result.mode || item.mode, durationMs: Date.now() - startedAt
    });
  }

  async retryReview(item, step, signal) {
    const reviewer = configuredReviewers().find((candidate) => retryReviewerKey(candidate) === step.key || candidate.model === step.key || candidate.name === step.key);
    const reviews = [...(item.professional?.reviews || [])];
    const index = reviews.findIndex((review) => retryReviewResultKey(review) === step.key || review.model === step.key || review.reviewer === step.key || review.reviewer === step.reviewerName);
    let next;
    try {
      next = { ...(await reviewAgent(reviewer, item.agentCard, item.complexity, item.mode, signal, phaseSampling(item, `review:${reviewer.id}`))), reviewerId: reviewer.id };
    } catch (error) {
      if (signal.aborted) throw signal.reason || error;
      next = { reviewerId: reviewer.id, reviewer: reviewer.name, model: reviewer.model, score: 0, error: error.message, mode: 'failed' };
    }
    if (index === -1) reviews.push(next); else reviews[index] = next;
    item.professional = professionalSnapshot(reviews);
  }

  async retryBuild(item, step, signal) {
    const runtime = RUNTIMES.find((candidate) => candidate.id === step.key);
    const builds = [...(item.builds || [])];
    const index = builds.findIndex((build) => build.runtimeId === step.key);
    let next;
    try {
      next = await buildSkill(runtime, item.agentCard.description, item.mode, { signal, ...phaseSampling(item, `build:${runtime.id}`) });
    } catch (error) {
      if (signal.aborted) throw signal.reason || error;
      next = { runtime: runtime.name, runtimeId: runtime.id, mode: item.mode, error: error.message };
    }
    if (index === -1) builds.push(next); else builds[index] = next;
    item.builds = builds;
    await this.update(item, { builds, stage: `${step.shortLabel} 已重新直出，正在执行同 Prompt 对测`, activeWork: null }, {
      level: next.error ? 'error' : 'success', source: 'RETRY', phase: 'build',
      text: next.error ? `${step.shortLabel} 重建仍失败` : `${step.shortLabel} Skill 重建完成`,
      detail: next.error || next.skill?.name, mode: next.error ? 'failed' : next.mode
    });
    for (let caseIndex = 0; caseIndex < (item.benchmark || []).length; caseIndex += 1) {
      signal.throwIfAborted();
      await this.update(item, {
        activeWork: benchmarkActivity(step.key, step.shortLabel, item.benchmark[caseIndex].case, caseIndex, item.benchmark.length, true),
        stage: `${step.shortLabel} 对测 ${caseIndex + 1}/${item.benchmark.length}`
      });
      await this.replaceBenchmarkEntry(item, caseIndex, step.key, signal);
      const entry = item.benchmark[caseIndex].entries.find((candidate) => candidate.id === step.key);
      await this.update(item, { benchmark: item.benchmark, stage: `${step.shortLabel} 对测 ${caseIndex + 1}/${item.benchmark.length}` }, {
        level: entry?.mode === 'failed' ? 'error' : 'success', source: 'RETRY', phase: 'benchmark',
        text: `${step.shortLabel} 完成「${item.benchmark[caseIndex].case.name}」重新对测`, detail: `score=${entry?.score ?? 0}`, mode: entry?.mode || item.mode
      });
    }
  }

  async retryBenchmark(item, step, signal) {
    await this.replaceBenchmarkEntry(item, step.caseIndex, step.key, signal);
  }

  async replaceBenchmarkEntry(item, caseIndex, competitorId, signal) {
    const roundItem = item.benchmark?.[caseIndex];
    if (!roundItem) throw new Error(`用例 ${caseIndex + 1} 不存在`);
    const testCase = roundItem.case;
    let output;
    let mode = item.mode;
    let name = item.agentCard.name;
    try {
      if (competitorId === 'submitted') {
        output = item.mode === 'live' ? (await callA2AAgent(item.agentCard, testCase.prompt, 45_000, signal)).text : mockSubmittedOutput(item.agentCard, testCase);
      } else {
        const build = item.builds?.find((candidate) => candidate.runtimeId === competitorId);
        if (!build || build.error) throw new Error(build?.error || '对应 Runtime Skill 尚未生成');
        name = build.runtime;
        mode = build.mode;
        output = await runSkill(build, testCase, item.mode, { signal, ...phaseSampling(item, `run:${caseIndex}:${competitorId}`) });
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason || error;
      output = `执行失败：${error.message}`;
      mode = 'failed';
      if (competitorId !== 'submitted') name = item.builds?.find((candidate) => candidate.runtimeId === competitorId)?.runtime || competitorId;
    }
    const next = makeEntry(competitorId, name, output, testCase, mode, deriveSeed(item.seed, `judge:${caseIndex}:${competitorId}`));
    const entryIndex = roundItem.entries.findIndex((entry) => entry.id === competitorId);
    if (entryIndex === -1) roundItem.entries.push(next); else roundItem.entries[entryIndex] = next;
  }

  async failRetry(item, step, previous, previousStatus, error) {
    if (item.status === 'cancelled') return;
    appendRetryHistory(item, step, previous, { error: error.message }, 0);
    await this.update(item, { status: previousStatus, stage: '单步复核异常', retrying: null, activeWork: null }, {
      level: 'error', source: 'RETRY', phase: step.type, text: `${step.shortLabel} 重试异常`, detail: error.message, mode: item.mode
    });
  }

  async run(evaluationId, signal) {
    const item = this.store.get(evaluationId);
    signal?.throwIfAborted();
    const target = item.validation.interfaces[0];
    await this.update(item, { status: 'running', progress: 6, stage: 'A2A 协议体检', activeWork: { type: 'protocol', key: 'a2a', label: '正在校验 A2A 协议与接口声明', target: item.agentCard.name, detail: '确认 Card 结构、协议版本与调用入口', index: 1, total: 1, retry: false } }, {
      level: 'success', source: 'A2A', phase: 'protocol', text: 'Agent Card 结构与接口声明通过',
      detail: `${target.binding} · v${target.version} · seed=${item.seed} · temperature=${item.temperature} · ${redactUrl(target.url)}`, mode: item.mode
    });

    const complexity = scoreComplexity(item.agentCard, item.cases);
    await this.update(item, { complexity, progress: 22, stage: '判断是否值得 Agent 化' }, {
      level: 'info', source: 'SCORER', phase: 'complexity', text: `${complexity.verdict} · ${complexity.score}/100`,
      detail: Object.entries(complexity.dimensions).map(([key, value]) => `${key}=${value}`).join(' · '), mode: 'rules'
    });

    const reviewers = configuredReviewers();
    item.reviewPlan = publicReviewPlan(reviewers);
    item.runtimePlan = publicRuntimePlan();
    const professionalReviews = [];
    for (const reviewer of reviewers) {
      signal?.throwIfAborted();
      const startedAt = Date.now();
      await this.update(item, {
        progress: 28 + professionalReviews.length * 8,
        stage: `${reviewer.name} 正在审稿`,
        activeWork: { type: 'review', key: reviewer.id, label: `${reviewer.name} 正在审稿`, target: reviewer.model, detail: '五项金融研究指标、评语与首要风险生成中', index: professionalReviews.length + 1, total: reviewers.length, retry: false }
      }, {
        level: 'info', source: 'MODEL', phase: 'review', text: `${reviewer.model} 接过了答卷`, mode: item.mode
      });
      try {
        const review = { ...(await reviewAgent(reviewer, item.agentCard, complexity, item.mode, signal, phaseSampling(item, `review:${reviewer.id}`))), reviewerId: reviewer.id };
        professionalReviews.push(review);
        await this.update(item, { professional: professionalSnapshot(professionalReviews) }, { level: 'success', source: 'MODEL', phase: 'review', text: `${reviewer.model} 完成盲审 · ${review.score}/100`, mode: review.mode, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        professionalReviews.push({ reviewerId: reviewer.id, reviewer: reviewer.name, model: reviewer.model, score: 0, error: error.message, mode: 'failed' });
        await this.update(item, { professional: professionalSnapshot(professionalReviews) }, { level: 'error', source: 'MODEL', phase: 'review', text: `${reviewer.model} 调用失败`, detail: error.message, mode: 'failed', durationMs: Date.now() - startedAt });
      }
    }
    const validProfessional = professionalReviews.filter((review) => review.score > 0);
    const professional = professionalSnapshot(professionalReviews);
    const professionalMode = professional.mode;
    await this.update(item, { professional, progress: 52, stage: 'Runtime description-only 直出', activeWork: null }, { level: 'success', source: 'MODEL', phase: 'review', text: `${reviewers.length} 位模型评审已交卷`, detail: `有效评审 ${validProfessional.length} · 均分 ${professional.score}`, mode: professionalMode });

    const builds = [];
    for (const runtime of RUNTIMES) {
      signal?.throwIfAborted();
      const startedAt = Date.now();
      await this.update(item, {
        activeWork: { type: 'build', key: runtime.id, label: `${runtime.name} 正在直出 Skill`, target: runtime.name, detail: '唯一输入：Agent 顶层 description 原文', index: builds.length + 1, total: RUNTIMES.length, retry: false }
      }, { level: 'info', source: 'RUNTIME', phase: 'build', text: `${runtime.name} 开始仅凭 description 直出 Skill`, mode: item.mode });
      try {
        const build = await buildSkill(runtime, item.agentCard.description, item.mode, { signal, ...phaseSampling(item, `build:${runtime.id}`) });
        builds.push(build);
        await this.update(item, { builds: [...builds] }, { level: 'success', source: 'RUNTIME', phase: 'build', text: `${runtime.name} description-only 直出完成`, detail: build.skill?.name, mode: build.mode, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        builds.push({ runtime: runtime.name, runtimeId: runtime.id, mode: item.mode, error: error.message });
        await this.update(item, { builds: [...builds] }, { level: 'error', source: 'RUNTIME', phase: 'build', text: `${runtime.name} 复刻失败`, detail: error.message, mode: item.mode, durationMs: Date.now() - startedAt });
      }
    }
    const runtimeMode = summarizeModes(builds.map((build) => build.error ? 'failed' : build.mode));
    await this.update(item, { builds, progress: 66, stage: '同题竞技场', activeWork: null }, { level: 'success', source: 'RUNTIME', phase: 'build', text: 'Runtime 直出阶段结束', detail: builds.map((build) => `${build.runtime}:${build.mode}${build.error ? ':failed' : ''}`).join(' · '), mode: runtimeMode });

    const benchmark = [];
    for (let index = 0; index < item.cases.length; index += 1) {
      signal?.throwIfAborted();
      const testCase = item.cases[index];
      const entries = [];
      benchmark.push({ case: testCase, entries });
      let submittedOutput;
      let submittedMode = item.mode;
      let startedAt = Date.now();
      await this.update(item, {
        benchmark,
        stage: `对测 ${index + 1}/${item.cases.length} · 0/${builds.length + 1}`,
        activeWork: benchmarkActivity('submitted', item.agentCard.name, testCase, index, item.cases.length, false)
      }, { level: 'info', source: 'A2A', phase: 'benchmark', text: `${item.agentCard.name} 开始执行「${testCase.name}」`, mode: item.mode });
      try {
        submittedOutput = item.mode === 'live'
          ? (await callA2AAgent(item.agentCard, testCase.prompt, 45_000, signal)).text
          : mockSubmittedOutput(item.agentCard, testCase);
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        submittedOutput = `执行失败：${error.message}`;
        submittedMode = 'failed';
      }
      entries.push(makeEntry('submitted', item.agentCard.name, submittedOutput, testCase, submittedMode, deriveSeed(item.seed, `judge:${index}:submitted`)));
      await this.update(item, { benchmark, progress: 70 + Math.round((index / item.cases.length) * 22), stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, {
        level: submittedMode === 'failed' ? 'error' : 'success', source: 'A2A', phase: 'benchmark', text: `${item.agentCard.name} 完成「${testCase.name}」`, detail: `score=${entries.at(-1).score}`, mode: submittedMode, durationMs: Date.now() - startedAt
      });
      for (const build of builds) {
        signal?.throwIfAborted();
        await this.update(item, {
          benchmark,
          activeWork: benchmarkActivity(build.runtimeId, build.runtime, testCase, index, item.cases.length, false),
          stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}`
        }, { level: 'info', source: 'RUNTIME', phase: 'benchmark', text: `${build.runtime} 开始执行「${testCase.name}」`, mode: build.error ? 'failed' : build.mode });
        if (build.error) {
          entries.push(makeEntry(build.runtimeId, build.runtime, `执行失败：${build.error}`, testCase, 'failed', deriveSeed(item.seed, `judge:${index}:${build.runtimeId}`)));
          await this.update(item, { benchmark, stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, { level: 'error', source: 'RUNTIME', phase: 'benchmark', text: `${build.runtime} 无法进入「${testCase.name}」`, detail: build.error, mode: 'failed' });
          continue;
        }
        startedAt = Date.now();
        try {
          const output = await runSkill(build, testCase, item.mode, { signal, ...phaseSampling(item, `run:${index}:${build.runtimeId}`) });
          entries.push(makeEntry(build.runtimeId, build.runtime, output, testCase, build.mode, deriveSeed(item.seed, `judge:${index}:${build.runtimeId}`)));
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error;
          entries.push(makeEntry(build.runtimeId, build.runtime, `执行失败：${error.message}`, testCase, 'failed', deriveSeed(item.seed, `judge:${index}:${build.runtimeId}`)));
        }
        await this.update(item, { benchmark, stage: `对测 ${index + 1}/${item.cases.length} · ${entries.length}/${builds.length + 1}` }, { level: entries.at(-1).mode === 'failed' ? 'error' : 'success', source: 'RUNTIME', phase: 'benchmark', text: `${build.runtime} 完成「${testCase.name}」`, detail: `score=${entries.at(-1).score}`, mode: entries.at(-1).mode, durationMs: Date.now() - startedAt });
      }
      await this.update(item, { benchmark, progress: 70 + Math.round(((index + 1) / item.cases.length) * 22), stage: `对测 ${index + 1}/${item.cases.length} 完成`, activeWork: null }, { level: 'success', source: 'ARENA', phase: 'benchmark', text: `「${testCase.name || `案例 ${index + 1}`}」完成同 prompt 对打`, detail: entries.map((entry) => `${entry.name}=${entry.score}`).join(' · '), mode: summarizeModes(entries.map((entry) => entry.mode)) });
    }

    const averages = Object.fromEntries(['submitted', 'claude-code', 'cursor', 'doubao'].map((competitor) => {
      const scores = benchmark.flatMap((roundItem) => roundItem.entries.filter((entry) => entry.id === competitor).map((entry) => entry.score));
      return [competitor, round(average(scores), 1)];
    }));
    const roast = buildRoast(averages.submitted, averages['claude-code'], averages.doubao, professional.score, complexity);
    const coverage = coverageSnapshot(item, professionalMode, runtimeMode, benchmark);
    const overallMode = summarizeModes(Object.values(coverage));
    await this.update(item, { averages, roast, coverage, overallMode, status: 'completed', progress: 100, stage: '锐评出炉', completedAt: now(), activeWork: null }, { level: 'success', source: 'VERDICT', phase: 'complete', text: roast.headline, detail: `tier=${roast.tier.label} · submitted=${averages.submitted} · claude=${averages['claude-code']} · doubao=${averages.doubao}`, mode: overallMode });
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
    await this.update(item, { status: 'failed', stage: '评测中断', error: error.message, activeWork: null }, { level: 'error', source: 'SYSTEM', phase: 'failed', text: '评测中断', detail: error.message, mode: item.mode });
  }
}

function professionalSnapshot(reviews) {
  const valid = reviews.filter((review) => review.score > 0);
  return { score: round(average(valid.map((review) => review.score)), 1), mode: summarizeModes(reviews.map((review) => review.error ? 'failed' : review.mode), 'failed'), reviews: [...reviews] };
}

function publicReviewPlan(reviewers) {
  return reviewers.map((reviewer) => ({ id: reviewer.id || reviewer.model || reviewer.name, name: reviewer.name, model: reviewer.model }));
}

function publicRuntimePlan() {
  return RUNTIMES.map((runtime) => ({ id: runtime.id, name: runtime.name, model: runtime.model }));
}

function resolveRetryStep(item, input = {}) {
  const type = String(input.type || '').trim();
  const key = String(input.key || '').trim();
  if (type === 'review') {
    const existing = item.professional?.reviews?.find((review) => [retryReviewResultKey(review), review.model, review.reviewer].includes(key));
    const reviewer = configuredReviewers().find((candidate) => [retryReviewerKey(candidate), candidate.model, candidate.name].includes(key) || (existing && candidate.name === existing.reviewer));
    if (!reviewer) throw badRetryRequest('评审模型不存在或当前未配置');
    return { type, key: retryReviewerKey(reviewer), reviewerName: reviewer.name, label: `重新审稿 · ${reviewer.model}`, shortLabel: reviewer.name };
  }
  if (type === 'build') {
    const runtime = RUNTIMES.find((candidate) => candidate.id === key);
    if (!runtime) throw badRetryRequest('Runtime 构建步骤不存在');
    return { type, key: runtime.id, label: `重新直出 · ${runtime.name}`, shortLabel: runtime.name };
  }
  if (type === 'benchmark') {
    const caseIndex = Number(input.caseIndex);
    const roundItem = item.benchmark?.[caseIndex];
    const allowed = new Set(['submitted', ...RUNTIMES.map((runtime) => runtime.id)]);
    if (!Number.isInteger(caseIndex) || !roundItem) throw badRetryRequest('对测用例不存在');
    if (!allowed.has(key)) throw badRetryRequest('对测选手不存在');
    const name = key === 'submitted'
      ? item.agentCard.name
      : item.builds?.find((build) => build.runtimeId === key)?.runtime || RUNTIMES.find((runtime) => runtime.id === key)?.name || key;
    return { type, key, caseIndex, label: `重新对测 · ${roundItem.case.name} / ${name}`, shortLabel: `${roundItem.case.name} / ${name}` };
  }
  throw badRetryRequest('不支持的重试类型；可选 review、build、benchmark');
}

function retryActivity(step) {
  const detail = step.type === 'review'
    ? '旧评语保持可见，新评语返回后替换并重算'
    : step.type === 'build'
      ? '重新直出 Skill，随后自动执行全部同 Prompt 对测'
      : '旧输出保持可见，新输出返回后替换并重算';
  return {
    type: step.type,
    key: step.key,
    ...(Number.isInteger(step.caseIndex) ? { caseIndex: step.caseIndex } : {}),
    label: step.label,
    target: step.shortLabel,
    detail,
    index: 1,
    total: 1,
    retry: true
  };
}

function benchmarkActivity(key, target, testCase, caseIndex, totalCases, retry) {
  return {
    type: 'benchmark',
    key,
    caseIndex,
    label: `${target} 正在执行同 Prompt 对测`,
    target,
    detail: `用例：${testCase?.name || `案例 ${caseIndex + 1}`}`,
    index: caseIndex + 1,
    total: totalCases,
    retry
  };
}

function badRetryRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function retryReviewerKey(reviewer) { return reviewer.id || reviewer.model || reviewer.name; }
function retryReviewResultKey(review) { return review.reviewerId || review.model || review.reviewer; }

function retryTargetSummary(item, step) {
  if (step.type === 'review') {
    const review = item.professional?.reviews?.find((candidate) => retryReviewResultKey(candidate) === step.key || candidate.model === step.key || candidate.reviewer === step.key || candidate.reviewer === step.reviewerName);
    return review ? { score: review.score, model: review.model, mode: review.mode, seed: review.seed, ...(review.error ? { error: review.error } : {}) } : { error: '暂无旧结果' };
  }
  if (step.type === 'build') {
    const build = item.builds?.find((candidate) => candidate.runtimeId === step.key);
    return build ? { model: build.model, mode: build.mode, seed: build.seed, skill: build.skill?.name, ...(build.error ? { error: build.error } : {}) } : { error: '暂无旧结果' };
  }
  const entry = item.benchmark?.[step.caseIndex]?.entries?.find((candidate) => candidate.id === step.key);
  return entry ? { score: entry.score, name: entry.name, mode: entry.mode, judgeSeed: entry.judgeSeed, ...(entry.mode === 'failed' ? { error: String(entry.output || '').slice(0, 300) } : {}) } : { error: '暂无旧结果' };
}

function appendRetryHistory(item, step, previous, result, durationMs) {
  const history = [...(item.retryHistory || []), {
    id: id('retry'), at: now(), type: step.type, key: step.key,
    ...(Number.isInteger(step.caseIndex) ? { caseIndex: step.caseIndex } : {}),
    label: step.label, previous, result, durationMs
  }];
  item.retryHistory = history.slice(-100);
}

function retryDeltaText(previous, result) {
  if (result.error) return result.error;
  if (Number.isFinite(previous?.score) && Number.isFinite(result?.score)) {
    const delta = round(result.score - previous.score, 1);
    return `score ${previous.score} → ${result.score}（${delta >= 0 ? '+' : ''}${delta}）`;
  }
  return previous?.error ? `旧结果失败；本次已恢复为 ${result.mode || '可用'} 模式` : '结果已替换并纳入综合评分';
}

function hasCompleteBenchmark(item) {
  const competitors = ['submitted', ...RUNTIMES.map((runtime) => runtime.id)];
  return item.cases?.length > 0
    && item.benchmark?.length === item.cases.length
    && item.benchmark.every((roundItem) => competitors.every((competitor) => roundItem.entries?.some((entry) => entry.id === competitor)));
}

function recalculateDerived(item) {
  const professional = professionalSnapshot(item.professional?.reviews || []);
  const runtimeMode = summarizeModes((item.builds || []).map((build) => build.error ? 'failed' : build.mode), 'failed');
  const coverage = coverageSnapshot(item, professional.mode, runtimeMode, item.benchmark || []);
  const derived = { professional, coverage, overallMode: summarizeModes(Object.values(coverage)) };
  if (!hasCompleteBenchmark(item)) return derived;
  const competitorIds = ['submitted', ...RUNTIMES.map((runtime) => runtime.id)];
  const averages = Object.fromEntries(competitorIds.map((competitor) => {
    const scores = item.benchmark.flatMap((roundItem) => roundItem.entries.filter((entry) => entry.id === competitor).map((entry) => entry.score));
    return [competitor, round(average(scores), 1)];
  }));
  return {
    ...derived,
    averages,
    roast: buildRoast(averages.submitted, averages['claude-code'], averages.doubao, professional.score, item.complexity)
  };
}

function isTerminal(status) { return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status); }

function redactUrl(rawUrl) {
  try { const url = new URL(rawUrl); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return 'invalid-url'; }
}

function summarizeModes(modes, fallback = 'mixed') {
  const unique = new Set(modes.filter(Boolean));
  if (!unique.size) return fallback;
  if (unique.size === 1) return [...unique][0];
  return 'mixed';
}

function coverageSnapshot(item, professionalMode, runtimeFallback, benchmark) {
  const submittedModes = benchmark.flatMap((roundItem) => (roundItem.entries || []).filter((entry) => entry.id === 'submitted').map((entry) => entry.mode));
  const runtimeIds = new Set(RUNTIMES.map((runtime) => runtime.id));
  const runtimeModes = benchmark.flatMap((roundItem) => (roundItem.entries || []).filter((entry) => runtimeIds.has(entry.id)).map((entry) => entry.mode));
  return {
    agent: summarizeModes(submittedModes, item.mode === 'live' ? 'live' : 'demo'),
    models: professionalMode,
    runtimes: summarizeModes(runtimeModes, runtimeFallback)
  };
}

function phaseSampling(item, scope) {
  return { seed: deriveSeed(item.seed, scope), temperature: normalizeTemperature(item.temperature, 0) };
}

function makeEntry(id, name, output, testCase, mode, seed) {
  const judged = judgeOutput(testCase.prompt, output, `${id}:${seed}`);
  if (mode === 'failed') judged.score = 0;
  return { id, name, output, mode, judgeSeed: seed, ...judged };
}

function mockSubmittedOutput(card, testCase) {
  const skillNames = (card.skills || []).map((skill) => skill.name).join('、');
  const quality = stableNumber(`${card.name}:${testCase.prompt}`, 0, 2);
  const detail = quality > 0 ? '\n4. 稳健性：检查基准、最大回撤、换手、手续费与滑点，并记录敏感性分析。' : '';
  return `已调用「${card.name}」处理该金融研究请求。\n1. 能力匹配：${skillNames}\n2. 数据口径：记录数据来源、样本区间、频率、复权方式与截至时点；未接入的数据不编造。\n3. 研究方法：按请求执行因子 IC / Rank IC、分组回测或风险归因，并区分事实、假设与推断。${detail}\n5. 风险提示：历史结果不代表未来收益，仅用于技术研究，不构成投资建议。`;
}
