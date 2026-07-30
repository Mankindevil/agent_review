import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pages = [
  'public/index.html',
  'public/methodology.html',
  'public/judge.html',
  'public/agent-check.html',
  'public/appeal.html',
  'public/evidence.html'
];

test('publishes local PandaAI brand assets with the official mark geometry', async () => {
  const [mark, logo, favicon] = await Promise.all([
    readFile(new URL('public/assets/pandaai-mark.svg', root), 'utf8'),
    readFile(new URL('public/assets/pandaai-logo.svg', root), 'utf8'),
    readFile(new URL('public/favicon.svg', root), 'utf8')
  ]);

  for (const asset of [mark, logo, favicon]) {
    assert.match(asset, /viewBox="0 0 195 206"|viewBox="0 0 148 27"/);
    assert.match(asset, /m96\.07,94\.87/);
    assert.match(asset, /m91\.21,4\.05/);
    assert.match(asset, /m100\.02,45\.14/);
  }
  assert.match(logo, />PandaAI</);
  assert.doesNotMatch(`${mark}\n${logo}\n${favicon}`, /(?:href|src)="https?:\/\//);
});

test('brands every primary page as Panda AI锐评局 with local assets', async () => {
  for (const page of pages) {
    const html = await readFile(new URL(page, root), 'utf8');
    assert.match(html, /<title>[^<]*Panda AI锐评局[^<]*<\/title>/, page);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, page);
    assert.match(html, /aria-label="Panda AI锐评局首页"/, page);
    assert.match(html, /src="\/assets\/pandaai-logo\.svg"/, page);
    assert.match(html, /srcset="\/assets\/pandaai-mark\.svg"/, page);
    assert.match(html, />锐评局</, page);
    assert.doesNotMatch(html, /class="brand-mark">锐</, page);
  }
});

test('uses the original electronic bonsai roast in the homepage hero', async () => {
  const home = await readFile(new URL('public/index.html', root), 'utf8');

  assert.match(home, /<h1>你的 Agent<br>到底是不是<br><em>电子盆栽？<\/em><\/h1>/);
});

test('offers the V1 scoring panel with a DeepSeek single-model default', async () => {
  const home = await readFile(new URL('public/index.html', root), 'utf8');

  assert.match(
    home,
    /<div id="legacy-intake" class="legacy-only">[\s\S]*?<fieldset class="scoring-config" id="v1-scoring-config">/
  );
  assert.match(home, /<button[^>]*data-scoring-mode="single"[^>]*>单模型<\/button>/);
  assert.match(home, /<button[^>]*class="selected"[^>]*data-scoring-mode="panel"[^>]*>四模型匿名盲评<\/button>/);
  assert.match(home, /<select id="single-scoring-reviewer">/);
  for (const reviewerId of ['gpt', 'claude', 'doubao']) {
    assert.match(home, new RegExp(`<option value="${reviewerId}">`));
  }
  assert.match(home, /<option value="deepseek" selected>DeepSeek<\/option>/);
});

test('renders V1 model scores and judge audit text safely', async () => {
  const [script, styles] = await Promise.all([
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('public/styles.css', root), 'utf8')
  ]);
  const escapeRenderer = script.slice(
    script.indexOf('function escapeHtml'),
    script.indexOf('function escapeAttr')
  );
  const modelEraRenderer = script.slice(
    script.indexOf('function isV1ModelScoredRound'),
    script.indexOf('function renderV1Judging')
  );
  const battleRenderer = script.slice(
    script.indexOf('function renderBattle'),
    script.indexOf('function renderDataEvidence')
  );
  const judgingRenderer = script.slice(
    script.indexOf('function renderV1Judging'),
    script.indexOf('function renderV1JudgeReviews')
  );
  const reviewRenderer = script.slice(
    script.indexOf('function renderV1JudgeReviews'),
    script.indexOf('function renderBattle')
  );

  const renderBattle = Function(
    'activityOfType',
    'competitorPlanFor',
    'renderDataVerificationBadge',
    'retryButton',
    'renderDataChecks',
    'renderV1JudgeReviews',
    'renderWorkLoader',
    'activityMatches',
    'renderQueuedWork',
    'renderV1Judging',
    'renderDataEvidence',
    `${escapeRenderer}\n${modelEraRenderer}\n${battleRenderer}\nreturn renderBattle;`
  )(
    () => null,
    () => [],
    () => '',
    () => '',
    () => '',
    () => '',
    () => '',
    () => false,
    () => '',
    () => '',
    () => ''
  );
  const battle = renderBattle([{
    case: { name: 'Case', prompt: 'Prompt' },
    entries: [
      { id: 'pending', name: 'Pending', score: null, mode: 'live', output: '' },
      { id: 'winner', name: 'Winner', score: 70, mode: 'live', output: '' },
      { id: 'lower', name: 'Lower', score: 50, mode: 'live', output: '' }
    ]
  }], {});
  assert.match(battle, /<h4>Pending<\/h4><strong class="">—<\/strong>/);
  assert.match(battle, /<h4>Winner<\/h4><strong class="winner">70<\/strong>/);
  assert.doesNotMatch(battle, /<h4>Pending<\/h4><strong class="winner">/);

  const renderers = Function(
    `${escapeRenderer}\n${modelEraRenderer}\n${judgingRenderer}\n${reviewRenderer}\nreturn { renderV1Judging, renderV1JudgeReviews };`
  )();
  assert.match(renderers.renderV1Judging({}, {}), /历史规则评分/);
  const panelAudit = renderers.renderV1Judging({
    judging: {
      status: 'failed',
      successfulSeats: 1,
      seats: [{
        reviewerName: 'Unsafe <seat>',
        failure: '<img src=x onerror=alert(1)>'
      }]
    }
  }, { scoringConfig: { mode: 'panel' } });
  assert.match(panelAudit, /四模型匿名盲评 · 1\/4/);
  assert.match(panelAudit, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(panelAudit, /<img src=x/);
  const reviewAudit = renderers.renderV1JudgeReviews({
    scoreStatus: 'scored',
    dimensions: { taskConstraint: 80 },
    judgeReviews: [{
      reviewerName: 'Judge',
      model: 'Model',
      mode: 'live',
      rationale: '<script>alert(1)</script>',
      uncertainties: ['<svg onload=alert(2)>']
    }]
  });
  assert.match(reviewAudit, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(reviewAudit, /&lt;svg onload=alert\(2\)&gt;/);
  assert.doesNotMatch(reviewAudit, /<script>|<svg onload/);

  assert.match(battleRenderer, /filter\(winnerEligible\)/);
  assert.doesNotMatch(battleRenderer, /Math\.max\(\.\.\.entries\.map/);
  assert.match(battleRenderer, /Number\.isFinite\(entry\.score\)\s*\?\s*entry\.score\s*:\s*'—'/);
  for (const selector of [
    'scoring-config',
    'scoring-mode-switch',
    'single-reviewer',
    'v1-judging-summary',
    'v1-judge-audit'
  ]) {
    assert.match(styles, new RegExp(`\\.${selector}\\s*\\{`));
  }
  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.v1-judging-summary,\.v1-judge-failures,\.v1-judge-failure \{[^}]*grid-template-columns:1fr;/
  );
});

test('reserves separate mobile header rows for the brand and navigation', async () => {
  const styles = await readFile(new URL('public/styles.css', root), 'utf8');

  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.site-header \{[^}]*gap:0;[^}]*display:grid;[^}]*grid-template-rows:38px 38px;/
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.site-header nav \{[^}]*grid-column:1\/-1;[^}]*grid-row:2;/
  );
});

test('uses the compact brand before the desktop header becomes crowded', async () => {
  const styles = await readFile(new URL('public/styles.css', root), 'utf8');
  const home = await readFile(new URL('public/index.html', root), 'utf8');

  for (const page of pages) {
    const html = await readFile(new URL(page, root), 'utf8');
    assert.match(
      html,
      /<source media="\(max-width: 1000px\)" srcset="\/assets\/pandaai-mark\.svg">/,
      page
    );
  }
  assert.match(home, /href="\/styles\.css\?v=20260730-header2"/);

  assert.match(
    styles,
    /@media \(max-width: 1000px\)[\s\S]*?\.brand-logo,\.brand-logo img \{[^}]*width:26px;[^}]*height:27px;/
  );
  assert.match(
    styles,
    /@media \(max-width: 1000px\)[\s\S]*?\.brand small,\.system-state span \{[^}]*display:none;/
  );
});
