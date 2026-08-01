import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildEvaluationCreateRequest } from '../public/evaluation-version-ui.js';

const root = new URL('../', import.meta.url);

async function appSource() {
  return readFile(new URL('public/app.js', root), 'utf8');
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing production source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing production source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function rendererHarness(source) {
  const escapeRenderer = sourceBetween(source, 'function escapeHtml', 'function escapeAttr');
  const modelEraRenderer = sourceBetween(
    source,
    'function isV1ModelScoredRound',
    'function renderV1Judging'
  );
  const judgingRenderer = sourceBetween(
    source,
    'function renderV1Judging',
    'function renderV1JudgeReviews'
  );
  const battleRenderer = sourceBetween(
    source,
    'function renderBattle',
    'function renderDataEvidence'
  );
  const renderV1Judging = Function(
    `${escapeRenderer}\n${modelEraRenderer}\n${judgingRenderer}\nreturn renderV1Judging;`
  )();
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
    renderV1Judging,
    () => ''
  );
  return { renderV1Judging, renderBattle };
}

test('uses round judging metadata for model-scored historical retries', async () => {
  const { renderV1Judging } = rendererHarness(await appSource());
  const markup = renderV1Judging({
    judging: {
      version: 'v1-model-arena/v1',
      mode: 'single',
      reviewerId: 'deepseek',
      status: 'scored',
      successfulSeats: 1,
      seats: [{
        reviewerId: 'deepseek',
        reviewerName: 'DeepSeek',
        model: 'DeepSeek',
        status: 'scored'
      }]
    }
  }, {});

  assert.match(markup, /单模型 · DeepSeek/);
  assert.doesNotMatch(markup, /历史规则评分/);
});

test('excludes execution failures from model-era winner ties', async () => {
  const { renderBattle } = rendererHarness(await appSource());
  const modelJudging = {
    version: 'v1-model-arena/v1',
    mode: 'panel',
    status: 'scored',
    successfulSeats: 0,
    seats: []
  };
  const allFailed = renderBattle([{
    case: { name: 'All failed', prompt: 'Prompt' },
    judging: modelJudging,
    entries: [
      { id: 'a', name: 'Failed A', score: 0, scoreStatus: 'execution-failed', mode: 'failed', output: '' },
      { id: 'b', name: 'Failed B', score: 0, scoreStatus: 'execution-failed', mode: 'failed', output: '' }
    ]
  }], {});
  assert.doesNotMatch(allFailed, /class="winner"/);

  const tiedAtZero = renderBattle([{
    case: { name: 'Zero tie', prompt: 'Prompt' },
    judging: modelJudging,
    entries: [
      { id: 'scored', name: 'Scored zero', score: 0, scoreStatus: 'scored', mode: 'live', output: '' },
      { id: 'failed', name: 'Failed zero', score: 0, scoreStatus: 'execution-failed', mode: 'failed', output: '' }
    ]
  }], {});
  assert.match(tiedAtZero, /<h4>Scored zero<\/h4><strong class="winner">0<\/strong>/);
  assert.doesNotMatch(tiedAtZero, /<h4>Failed zero<\/h4><strong class="winner">/);
});

test('excludes failed historical entries from all-failed and tied-zero winners', async () => {
  const { renderBattle } = rendererHarness(await appSource());
  const allFailed = renderBattle([{
    case: { name: 'Historical all failed', prompt: 'Prompt' },
    entries: [
      { id: 'a', name: 'Failed A', score: 0, mode: 'failed', output: '' },
      {
        id: 'b',
        name: 'Failed B',
        score: 0,
        scoreStatus: 'execution-failed',
        mode: 'demo',
        output: ''
      }
    ]
  }], {});
  assert.doesNotMatch(allFailed, /class="winner"/);

  const tiedAtZero = renderBattle([{
    case: { name: 'Historical zero tie', prompt: 'Prompt' },
    entries: [
      { id: 'scored', name: 'Historical zero', score: 0, mode: 'demo', output: '' },
      { id: 'failed', name: 'Failed zero', score: 0, mode: 'failed', output: '' }
    ]
  }], {});
  assert.match(tiedAtZero, /<h4>Historical zero<\/h4><strong class="winner">0<\/strong>/);
  assert.doesNotMatch(tiedAtZero, /<h4>Failed zero<\/h4><strong class="winner">/);
});

test('reviewer changes keep the public V1 create payload live', async () => {
  const source = await appSource();
  const controlsSource = sourceBetween(
    source,
    'function bindV1ScoringControls',
    'function bindEvents'
  );
  const requestSource = sourceBetween(
    source,
    'function selectedV1ScoringConfig',
    'async function submitV1Evaluation'
  );
  const state = {
    mode: 'live',
    scoringMode: 'panel',
    scoringReviewerId: 'deepseek'
  };
  const makeClassList = (...initial) => {
    const values = new Set(initial);
    return {
      contains: (value) => values.has(value),
      toggle(value, enabled) {
        if (enabled) values.add(value);
        else values.delete(value);
      }
    };
  };
  const makeControl = (dataset = {}) => ({
    dataset,
    classList: makeClassList(dataset.scoringMode === 'panel' ? 'selected' : ''),
    handlers: {},
    attributes: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }
  });
  const single = makeControl({ scoringMode: 'single' });
  const panel = makeControl({ scoringMode: 'panel' });
  const reviewer = makeControl();
  reviewer.value = 'deepseek';
  const singleReviewer = { classList: makeClassList('hidden') };
  const $ = (selector) => ({
    '#single-scoring-reviewer': reviewer,
    '.single-reviewer': singleReviewer
  })[selector];
  const $$ = (selector) => selector === '.scoring-mode-switch button'
    ? [single, panel]
    : [];
  const bindV1ScoringControls = Function(
    'state',
    '$',
    '$$',
    `${controlsSource}\nreturn bindV1ScoringControls;`
  )(state, $, $$);
  bindV1ScoringControls();

  const builders = Function(
    'state',
    'buildEvaluationCreateRequest',
    `${requestSource}\nreturn { buildV1CreateRequest, buildV2CreateRequest };`
  )(state, buildEvaluationCreateRequest);
  const input = {
    agentCard: { name: 'Agent' },
    agentExamples: [{ id: 'example' }],
    seed: 7,
    agentAuthorization: 'Bearer secret',
    skipHumanReview: true
  };
  assert.deepEqual(
    builders.buildV1CreateRequest(input).scoringConfig,
    { mode: 'panel' }
  );

  single.handlers.click();
  assert.equal(state.scoringMode, 'single');
  assert.equal(single.classList.contains('selected'), true);
  assert.equal(panel.classList.contains('selected'), false);
  assert.equal(singleReviewer.classList.contains('hidden'), false);
  assert.equal(single.attributes['aria-pressed'], 'true');

  reviewer.value = 'claude';
  reviewer.handlers.change({ currentTarget: reviewer });
  assert.equal(state.scoringReviewerId, 'claude');

  const v1 = builders.buildV1CreateRequest(input);
  assert.deepEqual(v1.scoringConfig, { mode: 'single', reviewerId: 'claude' });
  assert.equal(v1.mode, 'live');
  assert.equal(v1.seed, 7);
  assert.equal(v1.agentAuthorization, 'Bearer secret');

  panel.handlers.click();
  assert.equal(state.scoringMode, 'panel');
  assert.equal(singleReviewer.classList.contains('hidden'), true);
  assert.deepEqual(
    builders.buildV1CreateRequest(input).scoringConfig,
    { mode: 'panel' }
  );

  const v2 = builders.buildV2CreateRequest(input);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.skipHumanReview, true);
  assert.equal(Object.hasOwn(v2, 'scoringConfig'), false);
});
