import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing production source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing production source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function v1ArenaRendererHarness(source) {
  const escape = sourceBetween(source, 'function escapeHtml', 'function escapeAttr');
  const modelEra = sourceBetween(source, 'function isV1ModelScoredRound', 'function renderV1Judging');
  const arenaV2 = sourceBetween(source, 'function isV1ArenaV2Round', 'function renderV1Judging');
  const judging = sourceBetween(source, 'function renderV1Judging', 'function renderV1JudgeReviews');
  const audit = sourceBetween(source, 'function renderV1JudgeReviews', 'function formatExecutionDuration');
  const duration = sourceBetween(source, 'function formatExecutionDuration', 'function renderV1ArenaV2Scenario');
  const scenario = sourceBetween(source, 'function renderV1ArenaV2Scenario', 'function renderV1ArenaV2Totals');
  const totals = sourceBetween(source, 'function renderV1ArenaV2Totals', 'function renderBattle');
  const battle = sourceBetween(source, 'function renderBattle', 'function renderDataEvidence');
  return Function(
    'activityOfType', 'competitorPlanFor', 'renderDataVerificationBadge', 'retryButton',
    'renderDataChecks', 'renderWorkLoader', 'activityMatches', 'renderQueuedWork',
    'renderDataEvidence',
    `${escape}\n${modelEra}\n${arenaV2}\n${judging}\n${audit}\n${duration}\n${scenario}\n${totals}\n${battle}\nreturn renderBattle;`
  )(
    () => null, () => [], () => '', () => '', () => '', () => '', () => false, () => '', () => ''
  );
}

function cardReviewRendererHarness(source) {
  const escape = sourceBetween(source, 'function escapeHtml', 'function escapeAttr');
  const structuredText = sourceBetween(source, 'function renderStructuredText', 'async function loadHistory');
  const review = sourceBetween(source, 'function renderReviews', 'function renderBuilds');
  return Function(
    'activityOfType', 'reviewPlanFor', 'activityMatches', 'renderQueuedWork', 'retryButton', 'renderWorkLoader',
    `${escape}\n${structuredText}\n${review}\nreturn renderReviews;`
  )(
    () => null, () => [], () => false, () => '', () => '', () => ''
  );
}

function v2HistoryRendererHarness(source) {
  const escape = sourceBetween(source, 'function escapeHtml', 'function escapeAttr');
  const history = sourceBetween(source, 'function renderV2HistoryItem', 'async function deleteEvaluation');
  const projection = sourceBetween(source, 'function statusOf', 'function shouldSubscribe');
  return Function(
    'canDeleteEvaluation', 'formatTime',
    `${escape}\n${history}\n${projection}\nreturn { statusOf, stageOf, progressOf, renderV2HistoryItem };`
  )(
    (item) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(item?.execution?.status),
    () => '08/02 12:34'
  );
}

test('renders retained shared V2 history without restoring a public V2 intake', async () => {
  const [app, html] = await Promise.all([
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('public/index.html', root), 'utf8')
  ]);
  const { statusOf, stageOf, progressOf, renderV2HistoryItem } = v2HistoryRendererHarness(app);
  const running = {
    id: 'eval_v2_history',
    schemaVersion: 2,
    createdAt: '2026-08-02T03:34:00.000Z',
    execution: { status: 'running', stage: 'replica-human', progress: 137 },
    evidenceManifest: { items: [{ id: 'evidence-1' }, { id: 'evidence-2' }] }
  };

  assert.equal(statusOf(running), 'running');
  assert.equal(stageOf(running), 'replica-human');
  assert.equal(progressOf(running), 100);
  assert.equal(progressOf({ ...running, execution: { ...running.execution, progress: -5 } }), 0);
  assert.equal(progressOf({ ...running, execution: { ...running.execution, progress: Number.NaN } }), 0);

  const runningMarkup = renderV2HistoryItem(running);
  assert.match(runningMarkup, /history-item-v2/);
  assert.match(runningMarkup, /data-evaluation-id="eval_v2_history"/);
  assert.match(runningMarkup, />100%<\/span>/);
  assert.match(runningMarkup, /running · replica-human · 2 evidence/);
  assert.match(runningMarkup, /data-record-kind="v2"/);
  assert.match(runningMarkup, /title="请先停止本次评测" disabled/);

  const completedMarkup = renderV2HistoryItem({
    ...running,
    execution: { status: 'completed', progress: 62 }
  });
  assert.match(completedMarkup, />62%<\/span>/);
  assert.match(completedMarkup, /completed · qualification · 2 evidence/);
  assert.match(completedMarkup, /title="删除这条卷宗"/);
  assert.doesNotMatch(completedMarkup, / disabled/);

  assert.doesNotMatch(html, /id="v2-intake"|data-evaluation-version="v2"|href="\/judge\.html"|href="\/appeal\.html"/);
});

test('publishes the ordered evidence-led dual-track result surface', async () => {
  const [renderer, evidencePage, evidenceScript, evidenceStyle, app] = await Promise.all([
    readFile(new URL('public/result-v2.js', root), 'utf8'),
    readFile(new URL('public/evidence.html', root), 'utf8'),
    readFile(new URL('public/evidence.js', root), 'utf8'),
    readFile(new URL('public/evidence.css', root), 'utf8'),
    readFile(new URL('public/app.js', root), 'utf8')
  ]);

  for (const section of [
    'verdict-hero',
    'absolute-total',
    'rating-status',
    'replica-advantage',
    'model-panel',
    'leaf-contrast',
    'capability-declared-observed',
    'test-matrix',
    'humor-list',
    'human-opinions',
    'evidence-gaps',
    'replica-skills',
    'replica-battle'
  ]) {
    assert.match(renderer, new RegExp(`data-result-section="${section}"`), section);
  }
  assert.match(renderer, /三维绝对分：Agent 本身做得怎么样/);
  assert.match(renderer, /复刻优势：是否胜过五分钟临时 Skill/);
  assert.match(renderer, /四方模型审稿/);
  assert.match(renderer, /叶子对照/);
  assert.match(renderer, /席位评审/);
  assert.match(renderer, /labelLeaf/);
  assert.match(renderer, /Replica results never enter the absolute total/);
  assert.match(renderer, /差异未稳定/);
  assert.match(renderer, /待复刻/);
  assert.match(renderer, /same-track only/);
  assert.match(renderer, /data-skill-api="replica"/);
  assert.match(renderer, /同题复现对打/);
  assert.doesNotMatch(renderer, /v2-result-findings/);
  assert.match(app, /function renderResult\(item\)/);
  assert.match(app, /item\.schemaVersion === 2/);
  assert.match(
    app,
    /#result-content[\s\S]*?innerHTML\s*=\s*renderV2ResultView\(item,\s*\{\s*escapeHtml\s*\}\)/
  );
  assert.match(app, /renderLegacyResult\(item\)/);
  assert.match(app, /replica\/runtimes/);
  assert.match(app, /loadReplicaOutputDetail/);
  assert.doesNotMatch(app, /function renderV2Result\(item\)/);
  assert.doesNotMatch(app, /if \(!item\.resultV2\) return renderLegacyResult/);
  assert.match(renderer, /data-result-section="v2-live-progress"/);
  assert.match(renderer, /证据链采集进行中/);
  assert.doesNotMatch(renderer, /0 \/ 4 组已出/);
  assert.match(renderer, /absoluteReview\?\.modelPanel/);
  assert.match(renderer, /item\.resultV2\?\.humor/);
  assert.match(renderer, /item\.humanReviewAggregate/);
  assert.match(renderer, /replica\.runtimes/);
  assert.match(renderer, /Δc/);

  const labels = await readFile(new URL('public/rubric-labels.js', root), 'utf8');
  assert.match(labels, /Agent 必要性/);
  assert.match(labels, /证据推理/);
  assert.match(labels, /export function labelLeaf/);

  for (const id of [
    'evidence-filter-test-type',
    'evidence-filter-test-id',
    'evidence-filter-repeat',
    'evidence-filter-turn',
    'evidence-filter-grade',
    'evidence-filter-kind',
    'evidence-list',
    'evidence-detail'
  ]) {
    assert.match(evidencePage, new RegExp(`id="${id}"`), id);
  }
  assert.match(evidenceScript, /evidence-manifest/);
  assert.match(evidenceScript, /URLSearchParams/);
  assert.match(evidenceScript, /authorization/);
  assert.match(evidenceScript, /textContent/);
  assert.doesNotMatch(evidenceScript, /innerHTML/);
  assert.match(evidenceStyle, /prefers-reduced-motion/);
});

test('surfaces dual-track progress, replica-human hand-off, and finalize control', async () => {
  const [renderer, app, indexHtml, styles, projection] = await Promise.all([
    readFile(new URL('public/result-v2.js', root), 'utf8'),
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('public/index.html', root), 'utf8'),
    readFile(new URL('public/styles.css', root), 'utf8'),
    readFile(new URL('src/evaluation-projection.js', root), 'utf8')
  ]);

  assert.match(renderer, /trackStatus\.subStatusLabel/);
  assert.match(renderer, /进行中/);
  assert.match(projection, /等双轨/);
  assert.match(projection, /等绝对分/);
  assert.match(projection, /等复刻人工/);
  assert.match(renderer, /function renderFinalizePanel/);
  assert.match(renderer, /data-finalize-dual-track="/);
  assert.match(renderer, /trackStatus\.canFinalize/);
  assert.match(renderer, /function replicaTrackCopy/);
  assert.match(renderer, /replicaHumanReview\?\.trackPhase/);
  assert.match(renderer, /前往复刻人工评审台/);

  assert.match(app, /data-finalize-dual-track/);
  assert.match(app, /finalize-dual-track/);
  assert.match(app, /function collectReplicaReviewPolicy/);
  assert.match(app, /function applyReplicaReviewPolicy/);
  assert.match(app, /replica-review-policy/);
  assert.match(app, /skip-human-review/);
  assert.match(app, /skipHumanReview/);
  assert.match(app, /formatV2CreateError/);
  assert.match(app, /REPLICA_RUNTIME_NOT_READY/);

  assert.doesNotMatch(indexHtml, /id="skip-human-review"/);
  assert.doesNotMatch(indexHtml, /id="replica-policy-visibility"/);
  assert.doesNotMatch(indexHtml, /id="replica-policy-required-primaries"/);
  assert.doesNotMatch(indexHtml, /id="replica-policy-force-separate-judges"/);
  assert.match(app, /function submitV2Evaluation/);
  assert.match(app, /renderV2ResultView\(item/);
  assert.match(styles, /\.v2-resume-panel/);
});

test('keeps Card design review labels distinct from the V1 Arena v2 audit stack', async () => {
  const app = await readFile(new URL('public/app.js', root), 'utf8');

  for (const label of [
    '定位清晰度',
    'Skill 设计',
    '协议一致性',
    '输入输出示例质量',
    '边界与风险披露',
    'AGENT CARD DESIGN REVIEW'
  ]) assert.match(app, new RegExp(label));

  for (const label of [
    '场景价值',
    '专业度',
    'Agent 能力',
    '任务完成度',
    '方法专业度',
    '证据与数据质量',
    '风险与不确定性',
    '产物可用性',
    '端到端耗时',
    '包含网络及协议开销',
    '未观测 Agent 内部工具调用'
  ]) assert.match(app, new RegExp(label));

  assert.match(app, /v1-model-arena\/v2/);
  assert.match(app, /任务约束/);
  assert.match(app, /专业质量/);
  assert.match(app, /证据风险/);
  assert.match(app, /产物可用性/);
});

test('renders V1 Arena v2 in audit order while preserving legacy v1 names', async () => {
  const app = await readFile(new URL('public/app.js', root), 'utf8');
  const renderBattle = v1ArenaRendererHarness(app);
  const v2Markup = renderBattle([{
    case: { name: '因子研究', prompt: '在沪深 300 验证现金流因子。' },
    judging: {
      version: 'v1-model-arena/v2', mode: 'panel', status: 'scored', successfulSeats: 2,
      scenario: {
        score: 82,
        dimensions: { problemComplexity: 84, agentSuitability: 80 },
        reviews: [{ reviewerName: 'OpenAI 评审', model: 'GPT-5', mode: 'live', rationale: '涉及多阶段数据与研究判断。' }]
      }
    },
    entries: [{
      id: 'submitted', name: '提交 Agent', mode: 'live', score: 87, scoreStatus: 'scored', output: '完整研究报告',
      dimensions: { scenarioValue: 82, professionalQuality: 89, agentCapability: 85 },
      detail: {
        professionalism: { dimensions: { taskCompletion: 95, methodProfessionalism: 90, evidenceDataQuality: 85, riskUncertainty: 80, artifactUsability: 88 } },
        capability: { durationMs: 123456, toolObservation: 'unavailable' }
      },
      judgeReviews: [{ reviewerName: 'OpenAI 评审', model: 'GPT-5', mode: 'live', rationale: '方法完整，边界清楚。', uncertainties: ['未取得内部工具轨迹。'] }]
    }]
  }], { scoringConfig: { version: 'v1-model-arena/v2', mode: 'panel' } });

  for (const label of [
    '场景价值', '问题复杂度', 'Agent 适配度', '专业度', 'Agent 能力',
    '任务完成度', '方法专业度', '证据与数据质量', '风险与不确定性', '产物可用性',
    '端到端耗时', '包含网络及协议开销', '未观测 Agent 内部工具调用', 'OpenAI 评审'
  ]) assert.match(v2Markup, new RegExp(label));
  assert.match(v2Markup, /123\.5 s/);
  assert.ok(v2Markup.indexOf('场景价值') < v2Markup.indexOf('任务完成度'));
  assert.ok(v2Markup.indexOf('任务完成度') < v2Markup.indexOf('端到端耗时'));

  const legacyMarkup = renderBattle([{
    case: { name: '旧记录', prompt: '旧 Prompt' },
    judging: { version: 'v1-model-arena/v1', mode: 'single', reviewerId: 'deepseek', status: 'scored', successfulSeats: 1, seats: [] },
    entries: [{
      id: 'submitted', name: '旧 Agent', mode: 'live', score: 70, scoreStatus: 'scored', output: '旧报告',
      dimensions: { taskConstraint: 70, professionalQuality: 70, evidenceRisk: 70, artifactUsability: 70 }, judgeReviews: []
    }]
  }], { scoringConfig: { version: 'v1-model-arena/v1', mode: 'single', reviewerId: 'deepseek' } });
  for (const label of ['任务约束', '专业质量', '证据风险', '产物可用性']) assert.match(legacyMarkup, new RegExp(label));
  assert.doesNotMatch(legacyMarkup, /端到端耗时/);
});

test('renders Card review labels from its version and safely handles missing or unsafe fields', async () => {
  const app = await readFile(new URL('public/app.js', root), 'utf8');
  const renderReviews = cardReviewRendererHarness(app);
  const markup = renderReviews([{
    version: 'v1-card-review/v2',
    reviewer: '<img src=x onerror=alert(1)>',
    model: 'GPT <unsafe>',
    mode: 'live',
    score: 0,
    dimensions: {
      positioningClarity: 0,
      skillDesign: 0,
      protocolCoherence: 0,
      ioExampleQuality: 0,
      boundaryRiskDisclosure: 0,
      '<script>dimension</script>': 42
    },
    comment: '<script>comment</script>',
    risk: '<img src=x>'
  }, {
    version: 'v1-card-review/v2',
    reviewer: '缺字段评审',
    model: 'GPT-5',
    mode: 'live',
    score: 0,
    dimensions: null,
    comment: '',
    risk: ''
  }], { professional: { version: 'v1-card-review/v2' } });

  for (const label of [
    'AGENT CARD DESIGN REVIEW', '定位清晰度', 'Skill 设计', '协议一致性', '输入输出示例质量', '边界与风险披露'
  ]) assert.match(markup, new RegExp(label));
  assert.match(markup, /<div class="review-score">0<small> \/ 100<\/small><\/div>/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markup, /&lt;script&gt;comment&lt;\/script&gt;/);
  assert.match(markup, /&lt;script&gt;dimension&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>comment<\/script>/);
  assert.doesNotMatch(markup, /<img src=x onerror/);

  const legacy = renderReviews([{
    reviewer: '旧评审', model: '旧模型', mode: 'demo', score: 0,
    dimensions: { researchRigor: 0 }, comment: '', risk: ''
  }], { professional: {} });
  assert.match(legacy, /MULTI-MODEL FINANCE REVIEW/);
  assert.match(legacy, /研究严谨性/);
  assert.doesNotMatch(legacy, /AGENT CARD DESIGN REVIEW/);
});

test('escapes malformed V1 Arena v2 scenario dimension keys and renders zero metrics', async () => {
  const app = await readFile(new URL('public/app.js', root), 'utf8');
  const renderBattle = v1ArenaRendererHarness(app);
  const markup = renderBattle([{
    case: { name: '边界', prompt: '边界 Prompt' },
    judging: {
      version: 'v1-model-arena/v2', mode: 'single', status: 'scored', successfulSeats: 1,
      scenario: { score: 0, dimensions: { '<img src=x onerror=alert(1)>': 0 }, reviews: [] }
    },
    entries: [{
      id: 'submitted', name: '<script>Agent</script>', mode: 'live', score: 0, scoreStatus: 'scored', output: '<unsafe>',
      dimensions: { scenarioValue: 0, professionalQuality: 0, agentCapability: 0 },
      detail: { professionalism: { dimensions: null }, capability: { durationMs: 0, toolObservation: 'unavailable' } },
      judgeReviews: []
    }]
  }], { scoringConfig: { version: 'v1-model-arena/v2', mode: 'single' } });

  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup, /<img src=x onerror/);
  assert.match(markup, /0\.00 s/);
  assert.match(markup, /<strong class="winner">0<\/strong>/);
  assert.match(markup, /&lt;script&gt;Agent&lt;\/script&gt;/);
});

test('exposes the final-report download only for completed V1 evaluations', async () => {
  const [app, page] = await Promise.all([
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('public/index.html', root), 'utf8')
  ]);

  assert.match(page, /id="download-v1-report"/);
  assert.match(app, /function syncV1ReportDownload\(item\)/);
  assert.match(app, /item\.schemaVersion === 1/);
  assert.match(app, /item\.status === 'completed'/);
  assert.match(app, /\/api\/evaluations\/\$\{encodeURIComponent\(item\.id\)\}\/report\.pdf/);
});
