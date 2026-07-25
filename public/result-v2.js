export function renderV2Result(item, { escapeHtml = String } = {}) {
  const absolute = item.resultV2?.absolute || {};
  const replica = item.resultV2?.replica || {};
  const rating = item.resultV2?.rating || {};
  const trackStatus = item.trackStatus || {};
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
  const runtimeRows = released ? renderRuntimeRows(replica, escapeHtml) : '';
  const findings = renderModelFindings(item.absoluteReview?.modelPanel, escapeHtml);
  const humor = renderHumor(item.resultV2?.humor, escapeHtml);
  const humanOpinions = renderHumanOpinions(
    item.humanReviewAggregate,
    item.humanReviews,
    escapeHtml
  );
  const skipPanel = renderSkipHumanReviewPanel(item, escapeHtml);
  const finalizePanel = renderFinalizePanel(item, trackStatus, escapeHtml);
  const ratingLabel = trackStatus.overall === 'final' ? (rating.label || '待定') : '进行中';
  const ratingSub = trackStatus.overall === 'final'
    ? (item.evaluationTrack || item.qualification?.selectedInterface?.binding || 'same-track only')
    : (trackStatus.subStatusLabel || 'same-track only');
  const absoluteReady = Number.isFinite(absolute.total);
  const progressPanel = absoluteReady ? '' : renderV2ProgressPanel(item, escapeHtml);

  if (!absoluteReady) {
    return `
    ${progressPanel}
    <article class="v2-result-report" data-result-section="absolute-total">
      <header class="v2-result-report__head">
        <div><small>LOCKED / ABSOLUTE RESULT</small><h3>三维绝对分：Agent 本身做得怎么样</h3></div>
        <strong>—<small>/100</small></strong>
      </header>
      <p>绝对分将在模型评审锁定后写入；当前仍在黑盒证据采集阶段，不会显示旧版四组产物进度。</p>
    </article>
    <article class="v2-rating-strip" data-result-section="rating-status">
      <span>FINAL RATING</span><b>进行中</b>
      <small>${escapeHtml(trackStatus.subStatusLabel || stageLabel(item))}</small>
    </article>`;
  }

  return `
    ${progressPanel}
    ${skipPanel}
    ${finalizePanel}
    <article class="v2-result-report" data-result-section="absolute-total">
      <header class="v2-result-report__head">
        <div><small>LOCKED / ABSOLUTE RESULT</small><h3>三维绝对分：Agent 本身做得怎么样</h3></div>
        <strong>${value(absolute.total)}<small>/100</small></strong>
      </header>
      <p>总置信度 ${value(absolute.confidence)}。该分数由服务端锁定；Replica results never enter the absolute total.</p>
      <ul class="v2-result-dimensions">${dimensionRows}</ul>
    </article>
    <article class="v2-rating-strip" data-result-section="rating-status">
      <span>FINAL RATING</span><b>${escapeHtml(ratingLabel)}</b>
      <small>${escapeHtml(ratingSub)}</small>
    </article>
    <article class="v2-result-report" data-result-section="replica-advantage">
      <header><div><small>SEALED THEN RELEASED / REPLICA</small><h3>复刻优势：是否胜过五分钟临时 Skill</h3></div><b>${released ? signed(replica.conservativeDelta) : pendingReplica ? '待复刻' : '密封中'}</b></header>
      ${released
        ? `<p>提交 Agent 中位数 ${value(replica.submittedMedian)}；最佳有效复刻 ${value(replica.bestBaseline?.median)}（${escapeHtml(replica.bestBaseline?.runtimeId || '—')}）。Δc ${signed(replica.conservativeDelta)}，95% CI ${value(replica.ci95?.low)} → ${value(replica.ci95?.high)}，${stableCopy}。</p>${runtimeRows}`
        : `<p>${replicaTrackCopy(item, pendingReplica)}</p>`}
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
      ${findings || '<p>锁定模型结论尚未公开。</p>'}
      ${humor || '<p>幽默锐评尚未生成。</p>'}
    </article>
    <article class="v2-result-report" data-result-section="human-opinions">
      <header><div><small>HUMAN FINAL OPINIONS</small><h3>人工最终意见与调整</h3></div></header>
      <p>两名独立评委完成适用叶子评分；超过 15 分的分歧进入仲裁。最终权重仅由服务端计算。</p>
      ${humanOpinions || '<p>人工最终意见尚未锁定。</p>'}
    </article>
    <article class="v2-result-report v2-result-report--gaps" data-result-section="evidence-gaps">
      <header><div><small>UNCERTAINTY REGISTER</small><h3>不可验证声明与证据缺口</h3></div></header>
      <p>${absolute.evidenceGaps?.length ? escapeHtml(absolute.evidenceGaps.join(' · ')) : '当前没有已记录的证据缺口。'}</p>
      <a href="/evidence.html#${encodeURIComponent(item.id)}">打开脱敏证据回放</a>
    </article>`;
}

function renderV2ProgressPanel(item, escapeHtml) {
  const stage = stageLabel(item);
  const progress = Number.isFinite(item.execution?.progress)
    ? Math.max(0, Math.min(100, item.execution.progress))
    : 0;
  const work = item.activeWork;
  const workLine = work?.label
    ? escapeHtml(work.detail ? `${work.label} · ${work.detail}` : work.label)
    : escapeHtml(stage);
  const evidenceCount = item.evidenceManifest?.items?.length || 0;
  return `
    <section class="v2-live-console" data-result-section="v2-live-progress">
      <header>
        <div><small>LIVE / BLACK-BOX PIPELINE</small><h3>证据链采集进行中</h3></div>
        <span>${progress}%</span>
      </header>
      <div class="v2-live-meter"><i style="--progress:${progress}%"></i></div>
      <p>${workLine}</p>
      <small>阶段 ${escapeHtml(stage)} · 已记录证据 ${evidenceCount} 条。完整明细在服务端 data/runlogs/</small>
    </section>`;
}

function stageLabel(item) {
  return item.execution?.stage || item.governance?.phase || item.execution?.status || 'queued';
}

function renderSkipHumanReviewPanel(item, escapeHtml) {
  if (item.governance?.phase !== 'human_open') return '';
  return `
    <article class="v2-result-report v2-skip-panel" data-result-section="human-review-skip">
      <header><div><small>HUMAN REVIEW OPEN</small><h3>人工复核开放中</h3></div></header>
      <p>模型四席评审已锁定；任何人都可以提交一次人工打分，或直接跳过并以模型中位数结算终审。</p>
      <button type="button" class="text-button" data-skip-human-review="${escapeHtml(item.id)}">跳过人工打分</button>
    </article>`;
}

// Dual-track finalize is opportunistic on every state-changing endpoint (see
// docs/superpowers/specs/2026-07-26-parallel-replica-human-review-design.md),
// so this manual button only ever appears for the rare race where both
// tracks are ready but nothing has triggered `finalize-dual-track` yet.
function renderFinalizePanel(item, trackStatus, escapeHtml) {
  if (!trackStatus.canFinalize || trackStatus.overall === 'final') return '';
  return `
    <article class="v2-result-report v2-finalize-panel" data-result-section="dual-track-finalize">
      <header><div><small>DUAL TRACK READY</small><h3>双轨均已就绪，可以结算终审</h3></div></header>
      <p>绝对分与复刻人工评审均已锁定；点击结算生成最终 Δc 与评级。</p>
      <button type="button" class="text-button" data-finalize-dual-track="${escapeHtml(item.id)}">结算双轨终审</button>
    </article>`;
}

function replicaTrackCopy(item, pendingReplica) {
  if (pendingReplica) return '绝对分单独成立；没有有效 Replica 时不把“待复刻”解释为胜出。';
  const trackPhase = item.replicaHumanReview?.trackPhase;
  if (trackPhase === 'open') {
    return '模型 Arena 已密封评分，复刻人工评审进行中；<a href="/judge.html">前往复刻人工评审台 ↗</a>。';
  }
  if (trackPhase === 'locked') {
    return '复刻人工评审已锁定；等待绝对分一起结算终审。';
  }
  return '复刻结果仍密封；密封解除前不展示对战优势。';
}

function value(item) {
  return Number.isFinite(item) ? String(Math.round(item * 100) / 100) : '—';
}

function signed(item) {
  return Number.isFinite(item) ? `${item >= 0 ? '+' : ''}${Math.round(item * 100) / 100}` : '—';
}

function renderRuntimeRows(replica, escapeHtml) {
  const runtimes = Array.isArray(replica.runtimes)
    ? replica.runtimes.filter((runtime) => runtime?.valid)
    : [];
  if (!runtimes.length) return '<p>没有有效 Replica runtime 中位数可公开。</p>';
  return `<ul class="v2-result-runtimes">${runtimes.map((runtime) =>
    `<li><span>${escapeHtml(runtime.runtimeId || 'unknown')}</span><b>提交 ${value(replica.submittedMedian)} vs Replica ${value(runtime.median)}</b><small>Δc ${signed(replica.conservativeDelta)} · 95% CI ${value(replica.ci95?.low)} → ${value(replica.ci95?.high)}</small></li>`
  ).join('')}</ul>`;
}

function renderModelFindings(panel, escapeHtml) {
  const seen = new Set();
  const findings = (panel?.primary || []).flatMap((run) => run?.reviews || [])
    .flatMap((review) => (review?.findings || []).map((finding) => ({
      subcriterionId: review.subcriterionId,
      findingId: finding?.findingId,
      text: finding?.text
    })))
    .filter((finding) => typeof finding.text === 'string' && finding.text.trim())
    .filter((finding) => {
      const key = `${finding.subcriterionId}:${finding.findingId}:${finding.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return findings.length
    ? `<ul class="v2-result-findings">${findings.map((finding) =>
      `<li><small>${escapeHtml(finding.subcriterionId || '模型结论')}</small>${escapeHtml(finding.text)}</li>`
    ).join('')}</ul>`
    : '';
}

function renderHumor(humor, escapeHtml) {
  const items = Array.isArray(humor?.items) ? humor.items : [];
  return items.length
    ? `<ul class="v2-result-humor">${items.map((item) =>
      `<li><small>${escapeHtml(item.subcriterionId || '锐评')}</small>${escapeHtml(item.line || '—')}</li>`
    ).join('')}</ul>`
    : '';
}

function renderHumanOpinions(aggregate, reviews, escapeHtml) {
  const leaves = Object.entries(aggregate?.leaves || {}).filter(([, leaf]) => leaf?.status === 'resolved');
  const opinions = (reviews || []).flatMap((review) => Object.entries(review?.scores || {}).map(
    ([subcriterionId, score]) => ({ subcriterionId, ...score })
  ));
  if (!leaves.length && !opinions.length) return '';
  return `<ul class="v2-result-human">${leaves.map(([subcriterionId, leaf]) =>
    `<li><b>${escapeHtml(subcriterionId)}</b><span>最终 ${value(leaf.score)} · 分歧 ${value(leaf.spread)}</span></li>`
  ).join('')}${opinions.map((opinion) =>
    `<li><b>${escapeHtml(opinion.subcriterionId)}</b><span>${escapeHtml(opinion.modelDisposition || 'affirm')}：${escapeHtml(opinion.rationale || opinion.overrideReason || '未提供说明')}</span></li>`
  ).join('')}</ul>`;
}
