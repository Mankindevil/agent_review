import { labelLeaf, labelDimension, dimensionOfLeaf } from './rubric-labels.js';

const SEAT_NAME_HINTS = Object.freeze({
  gpt: { name: 'OpenAI 评审', model: 'GPT-5' },
  claude: { name: 'Anthropic 评审', model: 'Claude Sonnet' },
  doubao: { name: '豆包评审', model: 'Doubao Seed' },
  deepseek: { name: 'DeepSeek 评审', model: 'DeepSeek' }
});

export function renderV2Result(item, { escapeHtml = String } = {}) {
  const absolute = item.resultV2?.absolute || {};
  const replica = item.resultV2?.replica || {};
  const rating = item.resultV2?.rating || {};
  const trackStatus = item.trackStatus || {};
  const dimensions = absolute.dimensions || {};
  const testSummary = absolute.testSummary || {};
  const coverage = dimensions.agentCapability?.objectiveCoverage;
  const released = replica.status === 'released';
  const pendingReplica = replica.status === 'unavailable' ||
    replica.status === 'disabled' ||
    rating.code === 'PENDING_REPLICA';
  const stableCopy = replica.differenceStable === false ? '差异未稳定' : '差异稳定';
  const dimensionRows = [
    ['scenarioValue', dimensions.scenarioValue],
    ['professionalism', dimensions.professionalism],
    ['agentCapability', dimensions.agentCapability]
  ].map(([id, dimension]) =>
    `<li><span>${labelDimension(id)}</span><b>${value(dimension?.score)}</b><small>置信 ${value(dimension?.confidence)}</small></li>`
  ).join('');
  const variants = testSummary.variantCounts || {};
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
  const modelLocked = item.absoluteReview?.modelPanel?.status === 'model-locked' ||
    Boolean(item.governance?.modelLockedAt) ||
    item.governance?.phase === 'human_open' ||
    absolute.status === 'model-provisional' ||
    absolute.status === 'locked';
  const absoluteReady = Number.isFinite(absolute.total);
  const stillCollecting = !modelLocked && !absoluteReady;
  const progressPanel = stillCollecting ? renderV2ProgressPanel(item, escapeHtml) : '';
  const seats = buildSeatViews(item.absoluteReview?.modelPanel, item.resultV2?.humor);
  const modelPanel = renderModelPanel(seats, modelLocked, escapeHtml);
  const leafContrast = renderLeafContrast(seats, item.absoluteReview?.modelPanel, escapeHtml);
  const replicaDetail = released ? renderReplicaReleasedDetail(replica, item.id, escapeHtml) : '';

  if (stillCollecting) {
    return `
    ${progressPanel}
    <article class="v2-result-report" data-result-section="verdict-hero">
      <header class="v2-result-report__head">
        <div><small>FINAL VERDICT</small><h3>结果尚未锁定</h3></div>
        <strong>…</strong>
      </header>
      <p>绝对分将在模型评审锁定后写入；当前仍在黑盒证据采集阶段，不会显示旧版四组产物进度。</p>
    </article>
    <article class="v2-rating-strip" data-result-section="rating-status">
      <span>FINAL RATING</span><b>进行中</b>
      <small>${escapeHtml(trackStatus.subStatusLabel || stageLabel(item))}</small>
    </article>`;
  }

  const replicaBadge = released
    ? signed(replica.conservativeDelta)
    : pendingReplica
      ? '待复刻'
      : '密封中';
  const headline = verdictHeadline(item, ratingLabel, absoluteReady, pendingReplica, escapeHtml);
  const summaryLine = [
    `绝对分 ${absoluteReady ? value(absolute.total) : '—'}`,
    `置信 ${absoluteReady ? value(absolute.confidence) : '—'}`,
    `Replica ${released ? `Δc ${signed(replica.conservativeDelta)}` : replicaBadge}`,
    modelLocked ? '四席已锁定' : '四席未锁定'
  ].join(' · ');

  return `
    ${progressPanel}
    ${skipPanel}
    ${finalizePanel}
    <article class="v2-result-report v2-verdict-hero" data-result-section="verdict-hero">
      <header class="v2-verdict-hero__head">
        <div class="v2-verdict-seal">
          <small>FINAL RATING</small>
          <strong>${escapeHtml(ratingLabel)}</strong>
          <span>锐评局 · 终审</span>
        </div>
        <div>
          <small>01 / VERDICT</small>
          <h3>${headline}</h3>
          <p>${escapeHtml(summaryLine)}</p>
          <small>${escapeHtml(ratingSub)}</small>
        </div>
      </header>
    </article>
    <article class="v2-result-report" data-result-section="absolute-total">
      <header class="v2-result-report__head">
        <div><small>LOCKED / ABSOLUTE RESULT</small><h3>三维绝对分：Agent 本身做得怎么样</h3></div>
        <strong>${value(absolute.total)}<small>/100</small></strong>
      </header>
      <p>${absoluteReady
        ? `总置信度 ${value(absolute.confidence)}。该分数由服务端锁定；Replica results never enter the absolute total.`
        : '模型四席已锁定；绝对分将在人工终审（或跳过人工）后写入。当前不会显示 Claude Code / Cursor 等复刻进度，除非 Phase 3 Replica 已接入。'}</p>
      <ul class="v2-result-dimensions">${dimensionRows}</ul>
    </article>
    <article class="v2-rating-strip" data-result-section="rating-status">
      <span>FINAL RATING</span><b>${escapeHtml(ratingLabel)}</b>
      <small>${escapeHtml(ratingSub)}</small>
    </article>
    <article class="v2-result-report" data-result-section="replica-advantage">
      <header><div><small>SEALED THEN RELEASED / REPLICA</small><h3>复刻优势：是否胜过五分钟临时 Skill</h3></div><b>${replicaBadge}</b></header>
      ${released
        ? `<p>提交 Agent 中位数 ${value(replica.submittedMedian)}；最佳有效复刻 ${value(replica.bestBaseline?.median)}（${escapeHtml(replica.bestBaseline?.runtimeId || '—')}）。Δc ${signed(replica.conservativeDelta)}，95% CI ${value(replica.ci95?.low)} → ${value(replica.ci95?.high)}，${stableCopy}。</p>${renderRuntimeRows(replica, escapeHtml)}${replicaDetail}`
        : `<p>${replicaTrackCopy(item, pendingReplica)}</p>`}
    </article>
    ${modelPanel}
    ${leafContrast}
    <article class="v2-result-report" data-result-section="capability-declared-observed">
      <header><div><small>DECLARED × OBSERVED</small><h3>声明能力与观测能力</h3></div><b>${coverage === undefined ? '—' : `${Math.round(coverage * 100)}%`}</b></header>
      <p>客观覆盖率 ${coverage === undefined ? '待计算' : value(coverage)}${dimensions.agentCapability?.provisional ? ' · 暂定' : ''}。声明来自 Agent Card；观测仅来自已提交且可复查的测试证据。</p>
    </article>
    <article class="v2-result-report" data-result-section="test-matrix">
      <header><div><small>TEST MATRIX</small><h3>原始、等价、边界、多轮与稳定性</h3></div><b>${value(testSummary.completedCells)} / ${value(testSummary.plannedCells)}</b></header>
      <p>原始 ${value(variants.original)} · 等价 ${value(variants.equivalent)} · 边界 ${value(variants.boundary)} · 多轮 ${value(variants.multiTurn)} · 协议恢复/稳定性 ${value(variants.protocolRecovery)}</p>
    </article>
    <article class="v2-result-report" data-result-section="humor-list">
      <header><div><small>ONE-LINE ROAST</small><h3>一句锐评清单</h3></div></header>
      <p>幽默改写以锁定结论为准；不新增事实、不改动分数。</p>
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
      <p class="v2-private-control-note">证据回放属于私有管理功能，公开入口不提供操作控件。</p>
    </article>`;
}

function verdictHeadline(item, ratingLabel, absoluteReady, pendingReplica, escapeHtml) {
  const humorLine = item.resultV2?.humor?.items?.find((entry) => entry?.line)?.line;
  if (typeof humorLine === 'string' && humorLine.trim()) return escapeHtml(humorLine.trim());
  if (!absoluteReady) return '四席已锁定，绝对分结算中。';
  if (pendingReplica) return '绝对分已立，复刻未解锁——先别把「待复刻」当成赢了。';
  return escapeHtml(`${ratingLabel}：按锁定证据阅读下方四席与叶子对照。`);
}

function renderModelPanel(seats, modelLocked, escapeHtml) {
  if (!modelLocked || !seats.length) {
    return `
    <article class="v2-result-report" data-result-section="model-panel">
      <header><div><small>MULTI-MODEL PANEL</small><h3>四方模型审稿</h3></div></header>
      <p>锁定模型结论尚未公开。</p>
    </article>`;
  }
  const cards = seats.map((seat) => `
    <article class="v2-seat-card">
      <header>
        <div>
          <b>${escapeHtml(seat.name)}</b>
          <small>${escapeHtml(seat.model)}</small>
        </div>
        <span class="v2-seat-locked">LOCKED</span>
      </header>
      <div class="v2-seat-score">${value(seat.mean)}<small>/100</small></div>
      <ul class="v2-seat-dims">
        ${['scenarioValue', 'professionalism', 'agentCapability'].map((dim) =>
          `<li><span>${labelDimension(dim)}</span><b>${value(seat.dimensionMeans[dim])}</b></li>`
        ).join('')}
      </ul>
      <div class="v2-seat-review">
        <small>席位评审</small>
        <p>${escapeHtml(seat.blurb)}</p>
        <span>依据叶子：${escapeHtml(labelLeaf(seat.representativeLeafId))}${seat.repair ? ` · 修复：${escapeHtml(seat.repair)}` : ''}</span>
      </div>
      <footer>适用叶子 ${seat.leafCount} · 分歧叶 ${seat.disputeCount} · 均置信 ${value(seat.meanConfidence)}</footer>
    </article>`).join('');
  return `
    <article class="v2-result-report" data-result-section="model-panel">
      <header><div><small>MULTI-MODEL PANEL</small><h3>四方模型审稿</h3></div><b>${seats.length} 席</b></header>
      <p>四席独立打分；评语优先展示代表性叶子的幽默改写，脚注标明依据。</p>
      <div class="v2-seat-grid">${cards}</div>
    </article>`;
}

function renderLeafContrast(seats, panel, escapeHtml) {
  const leaves = collectLeafRows(seats, panel);
  if (!leaves.length) {
    return `
    <article class="v2-result-report" data-result-section="leaf-contrast">
      <header><div><small>LEAF CONTRAST</small><h3>叶子对照</h3></div></header>
      <p>叶子级对照尚未公开。</p>
    </article>`;
  }
  const rows = leaves.map((leaf) => {
    const dispute = leaf.spread >= 15;
    const cards = leaf.seats.map((entry) => `
      <article class="v2-leaf-seat-card">
        <header><b>${escapeHtml(entry.name)}</b><strong>${value(entry.score)}</strong></header>
        <small>置信 ${value(entry.confidence)}</small>
        <p>${escapeHtml(entry.comment || '—')}</p>
        ${entry.repair ? `<footer>修复：${escapeHtml(entry.repair)}</footer>` : ''}
      </article>`).join('');
    return `
      <details class="v2-leaf-row${dispute ? ' is-disputed' : ''}">
        <summary>
          <span>
            <b>${escapeHtml(labelLeaf(leaf.subcriterionId))}${dispute ? ' <i class="v2-dispute-tag">分歧</i>' : ''}</b>
            <small>${escapeHtml(leaf.subcriterionId)}</small>
          </span>
          <em>中位 ${value(leaf.median)} · 分歧 ${value(leaf.spread)}</em>
        </summary>
        <div class="v2-leaf-seat-grid">${cards}</div>
      </details>`;
  }).join('');
  return `
    <article class="v2-result-report" data-result-section="leaf-contrast">
      <header><div><small>LEAF CONTRAST</small><h3>叶子对照</h3></div><b>${leaves.length}</b></header>
      <p>默认折叠；展开后并排四席分数、评语与修复建议。</p>
      <div class="v2-leaf-list">${rows}</div>
    </article>`;
}

function renderReplicaReleasedDetail(replica, evaluationId, escapeHtml) {
  const skills = Array.isArray(replica.skills) ? replica.skills : [];
  const cases = Array.isArray(replica.cases) ? replica.cases : [];
  const skillRows = skills.length
    ? skills.map((skill) => `
      <article class="build-card" data-skill-runtime="${escapeHtml(skill.runtimeId || '')}">
        <div class="build-row">
          <b>${escapeHtml(skill.runtimeName || skill.runtimeId || 'runtime')}</b>
          <span>—</span>
          <code>${escapeHtml(skill.skillName || 'replica-skill')}</code>
          <span class="ok">✓ RELEASED</span>
          <span class="v2-private-control-note">私有管理入口可查</span>
        </div>
      </article>`).join('')
    : '<p>释放后未附带 Skill 元数据。</p>';
  const caseBlocks = cases.length
    ? cases.map((entry, index) => {
      const scores = entry.scores || {};
      const sources = Object.entries(scores).map(([sourceId, score]) => {
        const label = sourceId === 'submitted'
          ? '提交 Agent'
          : sourceId.startsWith('replica:')
            ? sourceId.slice('replica:'.length)
            : sourceId;
        return `
          <div class="battle-entry">
            <header><h4>${escapeHtml(label)}</h4><strong>${value(score)}</strong></header>
            <small class="v2-private-control-note">原始输出仅在私有管理入口可查</small>
          </div>`;
      }).join('');
      return `
        <article class="battle-round" data-result-section="replica-battle-case">
          <div class="battle-prompt">
            <span>CASE ${String(index + 1).padStart(2, '0')}<br>${escapeHtml(entry.title || entry.testId || '用例')}</span>
            <p>${escapeHtml(entry.prompt || '—')}</p>
          </div>
          <div class="battle-grid">${sources}</div>
        </article>`;
    }).join('')
    : '<p>释放后未附带同题复现用例。</p>';
  return `
    <section class="v2-replica-detail" data-result-section="replica-skills">
      <div class="section-title"><h3>复刻直出 Skill</h3><span>DESCRIPTION-ONLY SKILL BUILD</span></div>
      <p class="v2-private-control-note">完整 Skill 与原始输出仅在私有管理入口可查。</p>
      <div class="build-list">${skillRows}</div>
    </section>
    <section class="v2-replica-detail" data-result-section="replica-battle">
      <div class="section-title"><h3>同题复现对打</h3><span>SAME INPUT · VISIBLE OUTPUT</span></div>
      ${caseBlocks}
    </section>`;
}

function buildSeatViews(panel, humor) {
  const primary = Array.isArray(panel?.primary) ? panel.primary : [];
  const disputed = new Set(panel?.disputedSubcriterionIds || []);
  const humorByLeaf = Object.fromEntries(
    (Array.isArray(humor?.items) ? humor.items : [])
      .filter((item) => item?.subcriterionId && item?.line)
      .map((item) => [item.subcriterionId, item.line])
  );
  const leafScores = new Map();
  for (const run of primary) {
    for (const review of run?.reviews || []) {
      if (!review?.subcriterionId || !Number.isFinite(review.score)) continue;
      if (!leafScores.has(review.subcriterionId)) leafScores.set(review.subcriterionId, []);
      leafScores.get(review.subcriterionId).push(review.score);
    }
  }
  const leafMedians = new Map([...leafScores].map(([id, scores]) => [id, median(scores)]));

  return primary.map((run, index) => {
    const identity = seatIdentity(run?.reviewRunId, index);
    const reviews = (run?.reviews || []).filter((review) => Number.isFinite(review?.score));
    const mean = average(reviews.map((review) => review.score));
    const meanConfidence = average(reviews.map((review) => review.confidence).filter(Number.isFinite));
    const dimensionMeans = {
      scenarioValue: average(reviews.filter((r) => dimensionOfLeaf(r.subcriterionId) === 'scenarioValue').map((r) => r.score)),
      professionalism: average(reviews.filter((r) => dimensionOfLeaf(r.subcriterionId) === 'professionalism').map((r) => r.score)),
      agentCapability: average(reviews.filter((r) => dimensionOfLeaf(r.subcriterionId) === 'agentCapability').map((r) => r.score))
    };
    const representative = pickRepresentativeLeaf(reviews, leafMedians, disputed);
    const findingText = representative?.findings?.[0]?.text || '该席未提供可展示结论。';
    const blurb = (representative && humorByLeaf[representative.subcriterionId]) || findingText;
    const disputeCount = reviews.filter((review) => {
      const med = leafMedians.get(review.subcriterionId);
      return Number.isFinite(med) && Math.abs(review.score - med) >= 15;
    }).length;
    return {
      reviewRunId: run?.reviewRunId || `primary_${index}`,
      name: identity.name,
      model: identity.model,
      mean,
      meanConfidence,
      dimensionMeans,
      leafCount: reviews.length,
      disputeCount,
      blurb,
      repair: representative?.repairSuggestion || '',
      representativeLeafId: representative?.subcriterionId || '',
      reviews
    };
  });
}

function collectLeafRows(seats, panel) {
  const disputed = new Set(panel?.disputedSubcriterionIds || []);
  const byLeaf = new Map();
  for (const seat of seats) {
    for (const review of seat.reviews || []) {
      if (!review?.subcriterionId) continue;
      if (!byLeaf.has(review.subcriterionId)) {
        byLeaf.set(review.subcriterionId, { subcriterionId: review.subcriterionId, seats: [], scores: [] });
      }
      const row = byLeaf.get(review.subcriterionId);
      row.scores.push(review.score);
      row.seats.push({
        name: seat.name,
        score: review.score,
        confidence: review.confidence,
        comment: review.findings?.[0]?.text || '',
        repair: review.repairSuggestion || ''
      });
    }
  }
  return [...byLeaf.values()].map((row) => {
    const med = median(row.scores);
    const spread = row.scores.length
      ? Math.max(...row.scores) - Math.min(...row.scores)
      : 0;
    return {
      ...row,
      median: med,
      spread,
      disputed: disputed.has(row.subcriterionId) || spread >= 15
    };
  }).sort((left, right) => left.subcriterionId.localeCompare(right.subcriterionId));
}

function pickRepresentativeLeaf(reviews, leafMedians, disputed) {
  if (!reviews.length) return null;
  const disputedReviews = reviews.filter((review) => disputed.has(review.subcriterionId));
  const pool = disputedReviews.length ? disputedReviews : reviews;
  return [...pool].sort((left, right) => {
    const leftDev = Math.abs(left.score - (leafMedians.get(left.subcriterionId) ?? left.score));
    const rightDev = Math.abs(right.score - (leafMedians.get(right.subcriterionId) ?? right.score));
    if (rightDev !== leftDev) return rightDev - leftDev;
    return left.score - right.score;
  })[0];
}

function seatIdentity(reviewRunId, index) {
  const raw = String(reviewRunId || '');
  const match = raw.match(/^primary_\d+_([a-z0-9-]+)$/i);
  const hintKey = match?.[1]?.toLowerCase();
  const hint = hintKey ? SEAT_NAME_HINTS[hintKey] : null;
  if (hint) return hint;
  return {
    name: hintKey ? `${hintKey} 评审` : `评审席 ${index + 1}`,
    model: hintKey || raw || 'model'
  };
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
  if (pendingReplica) {
    const status = item.resultV2?.replica?.status;
    if (status === 'disabled') {
      return '本场未启用 Replica（资格淘汰或非黑盒路径）。正式 V2 创建时至少需要 1 个就绪 Runtime；启用后详情页会显示复刻构建/执行进度。';
    }
    return '绝对分单独成立；没有有效 Replica 时不把“待复刻”解释为胜出。';
  }
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

function average(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, item) => sum + item, 0) / nums.length;
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
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

function renderHumor(humor, escapeHtml) {
  const items = Array.isArray(humor?.items) ? humor.items : [];
  return items.length
    ? `<ul class="v2-result-humor">${items.map((item) =>
      `<li><b>${escapeHtml(labelLeaf(item.subcriterionId))}</b><small>${escapeHtml(item.subcriterionId || '')}</small><span>${escapeHtml(item.line || '—')}</span></li>`
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
    `<li><b>${escapeHtml(labelLeaf(subcriterionId))}</b><small>${escapeHtml(subcriterionId)}</small><span>最终 ${value(leaf.score)} · 分歧 ${value(leaf.spread)}</span></li>`
  ).join('')}${opinions.map((opinion) =>
    `<li><b>${escapeHtml(labelLeaf(opinion.subcriterionId))}</b><span>${escapeHtml(opinion.modelDisposition || 'affirm')}：${escapeHtml(opinion.rationale || opinion.overrideReason || '未提供说明')}</span></li>`
  ).join('')}</ul>`;
}
