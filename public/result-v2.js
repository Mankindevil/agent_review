export function renderV2Result(item, { escapeHtml = String } = {}) {
  const absolute = item.resultV2?.absolute || {};
  const replica = item.resultV2?.replica || {};
  const rating = item.resultV2?.rating || {};
  const dimensions = absolute.dimensions || {};
  const testSummary = absolute.testSummary || {};
  const coverage = dimensions.agentCapability?.objectiveCoverage;
  const released = replica.status === 'released';
  const pendingReplica = replica.status === 'unavailable' || rating.code === 'PENDING_REPLICA';
  const stableCopy = replica.differenceStable === false ? '差异未稳定' : '差异稳定';
  const dimensionRows = [
    ['任务价值', dimensions.scenarioValue],
    ['专业度', dimensions.professionalism],
    ['Agent 能力', dimensions.agentCapability]
  ].map(([label, dimension]) => `<li><span>${label}</span><b>${value(dimension?.score)}</b><small>置信 ${value(dimension?.confidence)}</small></li>`).join('');
  const variants = testSummary.variantCounts || {};

  return `
    <article class="v2-result-report" data-result-section="absolute-total">
      <header class="v2-result-report__head">
        <div><small>LOCKED / ABSOLUTE RESULT</small><h3>三维绝对分：Agent 本身做得怎么样</h3></div>
        <strong>${value(absolute.total)}<small>/100</small></strong>
      </header>
      <p>总置信度 ${value(absolute.confidence)}。该分数由服务端锁定；Replica results never enter the absolute total.</p>
      <ul class="v2-result-dimensions">${dimensionRows}</ul>
    </article>
    <article class="v2-rating-strip" data-result-section="rating-status">
      <span>FINAL RATING</span><b>${escapeHtml(rating.label || (absolute.status === 'locked' ? '待定' : '进行中'))}</b>
      <small>${escapeHtml(item.evaluationTrack || item.qualification?.selectedInterface?.binding || 'same-track only')}</small>
    </article>
    <article class="v2-result-report" data-result-section="replica-advantage">
      <header><div><small>SEALED THEN RELEASED / REPLICA</small><h3>复刻优势：是否胜过五分钟临时 Skill</h3></div><b>${released ? signed(replica.conservativeDelta) : pendingReplica ? '待复刻' : '密封中'}</b></header>
      ${released
        ? `<p>提交 Agent ${value(replica.submittedMedian)}；最佳有效复刻 ${value(replica.bestBaseline?.median)}（${escapeHtml(replica.bestBaseline?.runtimeId || '—')}）。Δc ${signed(replica.conservativeDelta)}，95% CI ${value(replica.ci95?.low)} → ${value(replica.ci95?.high)}，${stableCopy}。</p>`
        : '<p>绝对分单独成立；没有有效 Replica 时不把“待复刻”解释为胜出。</p>'}
    </article>
    <article class="v2-result-report" data-result-section="capability-declared-observed">
      <header><div><small>DECLARED × OBSERVED</small><h3>声明能力与观测能力</h3></div><b>${coverage === undefined ? '—' : `${Math.round(coverage * 100)}%`}</b></header>
      <p>客观覆盖率 ${coverage === undefined ? '待计算' : value(coverage)}${dimensions.agentCapability?.provisional ? ' · 暂定' : ''}。声明来自 Agent Card；观测仅来自已提交且可复查的测试证据。</p>
    </article>
    <article class="v2-result-report" data-result-section="test-matrix">
      <header><div><small>TEST MATRIX</small><h3>原始、等价、边界、多轮与稳定性</h3></div><b>${value(testSummary.completedCells)} / ${value(testSummary.plannedCells)}</b></header>
      <p>原始 ${value(variants.original)} · 等价 ${value(variants.equivalent)} · 边界 ${value(variants.boundary)} · 多轮 ${value(variants.multiTurn)} · 协议恢复/稳定性 ${value(variants.protocolRecovery)}</p>
    </article>
    <article class="v2-result-report" data-result-section="findings-and-humor">
      <header><div><small>LOCKED FINDINGS</small><h3>严肃结论与一句锐评</h3></div></header>
      <p>结论、引用与幽默改写均以锁定结果为准；幽默不新增事实、不改动分数。</p>
    </article>
    <article class="v2-result-report" data-result-section="human-opinions">
      <header><div><small>HUMAN FINAL OPINIONS</small><h3>人工最终意见与调整</h3></div></header>
      <p>两名独立评委完成适用叶子评分；超过 15 分的分歧进入仲裁。最终权重仅由服务端计算。</p>
    </article>
    <article class="v2-result-report v2-result-report--gaps" data-result-section="evidence-gaps">
      <header><div><small>UNCERTAINTY REGISTER</small><h3>不可验证声明与证据缺口</h3></div></header>
      <p>${absolute.evidenceGaps?.length ? escapeHtml(absolute.evidenceGaps.join(' · ')) : '当前没有已记录的证据缺口。'}</p>
      <a href="/evidence.html#${encodeURIComponent(item.id)}">打开脱敏证据回放</a>
    </article>`;
}

function value(item) {
  return Number.isFinite(item) ? String(Math.round(item * 100) / 100) : '—';
}

function signed(item) {
  return Number.isFinite(item) ? `${item >= 0 ? '+' : ''}${Math.round(item * 100) / 100}` : '—';
}
