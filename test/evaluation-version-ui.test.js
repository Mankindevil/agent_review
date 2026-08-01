import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildEvaluationCreateRequest,
  evaluationVersionUiState,
  homepageHistoryUrl,
  publicEvaluationVersion,
  restoreLandingStartButton,
  selectedSubmissionVersion
} from '../public/evaluation-version-ui.js';

const root = new URL('../', import.meta.url);

function homepageDestinations(html) {
  const attributes = /\b(?:href|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;
  return [...html.matchAll(attributes)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function assertNoReviewConsoleDestinations(html) {
  const blocked = homepageDestinations(html).filter((destination) => {
    try {
      const pathname = new URL(destination, 'https://public.example/').pathname;
      return /(?:^|\/)(?:judge|appeal)(?:\.html)?\/?$/iu.test(pathname);
    } catch {
      return false;
    }
  });
  assert.deepEqual(blocked, []);
}

test('exposes only the live V1 intake on the public homepage', async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL('public/index.html', root), 'utf8'),
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('public/styles.css', root), 'utf8')
  ]);
  assert.doesNotMatch(html, /data-evaluation-version=/);
  assert.doesNotMatch(html, />演示评测</);
  assert.doesNotMatch(html, /id="v2-intake"/);
  assert.doesNotMatch(html, /id="skip-human-review"/);
  assert.doesNotMatch(css, /\.evaluation-version-switch\s*\{/);
  assert.match(html, /app\.js\?v=20260802-v1-pdf-release1/);
  assert.match(script, /mode: 'live'/);
  assert.match(script, /selectedVersion: 'v1'/);
  assert.doesNotMatch(script, /requestedEvaluationVersion\(location\.search\)/);
  assert.doesNotMatch(script, /resolveEvaluationVersion\(requestedVersion/);
  assert.match(html, /Agent Card 设计质量/);
  assert.match(html, /定位、Skills、协议、输入输出与能力边界/);
  assert.doesNotMatch(html, /数据纪律、回测可信度、风险合规与可复现性/);
});

test('homepage excludes judge and appeal destinations across common URL and attribute forms', async () => {
  const html = await readFile(new URL('public/index.html', root), 'utf8');

  assertNoReviewConsoleDestinations(html);
  for (const navigation of [
    '<a href="/judge.html">judge</a>',
    "<a href='judge?queue=open'>judge</a>",
    '<form action=./appeal.html#open></form>',
    '<button formaction="https://ops.example/review/judge?queue=open">judge</button>',
    "<a href='//ops.example/appeal?case=1'>appeal</a>"
  ]) {
    assert.throws(
      () => assertNoReviewConsoleDestinations(`${html}\n${navigation}`),
      /Expected values to be strictly deep-equal/u,
      navigation
    );
  }

  assert.doesNotThrow(() => assertNoReviewConsoleDestinations(`${html}
    <p>The judge and appeal consoles are unavailable; do not navigate to judge.html or appeal?case=1.</p>
    <a href="/methodology.html?topic=appeal">Read the appeal policy</a>`));
  assert.doesNotMatch(html, /\bid\s*=\s*(?:"v2-intake"|'v2-intake'|v2-intake(?=\s|>))/iu);
  assert.doesNotMatch(html, /\bdata-evaluation-version\s*=\s*(?:"v2"|'v2'|v2(?=\s|>))/iu);
});

test('pins every public homepage query to usable V1 without probing V2 capability', () => {
  for (const search of ['', '?version=v2', '?version=v1', '?version=v2&source=share', '?version=unknown']) {
    assert.equal(publicEvaluationVersion(search), 'v1', search);
  }
  const state = { healthResolved: false, selectedVersion: publicEvaluationVersion('?version=v2'), v2Available: false };
  assert.deepEqual(evaluationVersionUiState(state), {
    selectedVersion: 'v1',
    usable: true,
    label: '送进研究终审台',
    message: ''
  });
  assert.equal(selectedSubmissionVersion(state), 'v1');
});

test('keeps direct V2 request construction while forcing public V1 requests live', () => {
  const input = {
    agentCard: { name: '验证 Agent' },
    agentExamples: [{ id: 'example-1' }],
    mode: 'demo',
    scoringConfig: { mode: 'panel' },
    seed: 20260731,
    agentAuthorization: 'Bearer test',
    skipHumanReview: true
  };

  assert.deepEqual(buildEvaluationCreateRequest('v1', input), {
    agentCard: input.agentCard,
    agentExamples: input.agentExamples,
    mode: 'live',
    scoringConfig: { mode: 'panel' },
    seed: 20260731,
    agentAuthorization: 'Bearer test'
  });

  assert.deepEqual(buildEvaluationCreateRequest('v2', input), {
    schemaVersion: 2,
    agentCard: input.agentCard,
    agentExamples: input.agentExamples,
    agentAuthorization: 'Bearer test',
    skipHumanReview: true
  });
});

test('keeps historical direct V2 state callable without restoring a public V2 entry', () => {
  const state = { healthResolved: true, selectedVersion: 'v2', v2Available: true };
  assert.deepEqual(evaluationVersionUiState(state), {
    selectedVersion: 'v2',
    usable: true,
    label: '启动 A2A 证据评测',
    message: ''
  });
  assert.equal(selectedSubmissionVersion(state), 'v2');
});

test('keeps the V1 landing control usable when health metadata is unavailable', () => {
  const label = { textContent: '正在确认评测模式' };
  const button = { disabled: true, querySelector: (selector) => selector === 'span' ? label : null };
  const state = { healthResolved: false, selectedVersion: 'v1', v2Available: null };

  const rendered = restoreLandingStartButton(button, state);

  assert.equal(rendered.usable, true);
  assert.equal(button.disabled, false);
  assert.equal(label.textContent, '送进研究终审台');
  assert.equal(rendered.message, '');
});

test('preserves historical URL helpers and rejects unknown direct builders', () => {
  assert.equal(homepageHistoryUrl('/', '?version=v1'), '/?version=v1');
  assert.equal(homepageHistoryUrl('/dashboard', '?version=v2&source=share'), '/dashboard?version=v2&source=share');
  assert.equal(homepageHistoryUrl('/', ''), '/');
  assert.throws(() => buildEvaluationCreateRequest('unknown', {}), /评测版本不可用/u);
});
