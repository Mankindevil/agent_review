import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildEvaluationCreateRequest,
  evaluationVersionUiState,
  homepageHistoryUrl,
  restoreLandingStartButton,
  selectedSubmissionVersion
} from '../public/evaluation-version-ui.js';
import { resolveEvaluationVersion } from '../public/a2a-ui-helpers.js';

const root = new URL('../', import.meta.url);

test('offers shareable V1 and V2 homepage links with accessible copy', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('public/index.html', root), 'utf8'),
    readFile(new URL('public/styles.css', root), 'utf8')
  ]);
  assert.match(html, /<nav[^>]*class="evaluation-version-switch"[^>]*aria-label="评测版本"/);
  assert.match(html, /href="\/\?version=v1"[^>]*data-evaluation-version="v1"/);
  assert.match(html, /href="\/\?version=v2"[^>]*data-evaluation-version="v2"/);
  assert.match(html, />V1 经典评测</);
  assert.match(html, />V2 证据评测</);
  assert.match(css, /\.evaluation-version-switch\s*\{/);
  assert.match(css, /\.evaluation-version-switch a\[aria-current="page"\]/);
  assert.match(css, /@media \(max-width: 700px\)/);
});

test('dispatches and renders from selected version instead of capability alone', async () => {
  const script = await readFile(new URL('public/app.js', root), 'utf8');
  assert.match(script, /requestedEvaluationVersion\(location\.search\)/);
  assert.match(script, /resolveEvaluationVersion\(requestedVersion,\s*mode\.enabled\)/);
  assert.match(script, /selectedSubmissionVersion\(state\)/);
  assert.match(script, /if \(version === 'v2'\) return submitV2Evaluation/);
  assert.match(script, /data-evaluation-version/);
  assert.match(script, /setAttribute\('aria-current', 'page'\)/);
  assert.match(script, /restoreLandingStartButton/);
  assert.match(script, /homepageHistoryUrl/);
  assert.doesNotMatch(script, /if \(state\.blackBoxEnabled\) return submitV2Evaluation/);
});

test('resolves explicit and default versions independently of V2 capability', () => {
  const cases = [
    { name: 'explicit V1 when V2 is available', requestedVersion: 'v1', v2Available: true, expected: { selectedVersion: 'v1', usable: true, label: '送进研究终审台', message: '' } },
    { name: 'explicit V2 when V2 is available', requestedVersion: 'v2', v2Available: true, expected: { selectedVersion: 'v2', usable: true, label: '启动 A2A 证据评测', message: '' } },
    { name: 'explicit V1 when V2 is unavailable', requestedVersion: 'v1', v2Available: false, expected: { selectedVersion: 'v1', usable: true, label: '送进研究终审台', message: '' } },
    { name: 'explicit V2 when V2 is unavailable', requestedVersion: 'v2', v2Available: false, expected: { selectedVersion: 'v2', usable: false, label: '启动 A2A 证据评测', message: 'V2 证据评测当前未启用，请切换到 V1 经典评测。' } },
    { name: 'default V2 when V2 is available', requestedVersion: null, v2Available: true, expected: { selectedVersion: 'v2', usable: true, label: '启动 A2A 证据评测', message: '' } },
    { name: 'default V1 when V2 is unavailable', requestedVersion: null, v2Available: false, expected: { selectedVersion: 'v1', usable: true, label: '送进研究终审台', message: '' } }
  ];

  for (const { name, requestedVersion, v2Available, expected } of cases) {
    const state = { healthResolved: true, v2Available, ...resolveEvaluationVersion(requestedVersion, v2Available) };
    assert.deepEqual(evaluationVersionUiState(state), expected, name);
  }
});

test('keeps an unavailable V2 disabled after returning to the landing page', () => {
  const label = { textContent: '正在建立证据链' };
  const button = { disabled: false, querySelector: (selector) => selector === 'span' ? label : null };
  const state = { healthResolved: true, selectedVersion: 'v2', v2Available: false };

  const rendered = restoreLandingStartButton(button, state);

  assert.equal(rendered.usable, false);
  assert.equal(button.disabled, true);
  assert.equal(label.textContent, '启动 A2A 证据评测');
  assert.equal(rendered.message, 'V2 证据评测当前未启用，请切换到 V1 经典评测。');
});

test('selects only usable version builders and blocks unresolved or unavailable submission', () => {
  const input = {
    agentCard: { name: '验证 Agent' },
    agentExamples: [{ id: 'example-1' }],
    mode: 'demo',
    scoringConfig: { mode: 'panel' },
    seed: 20260731,
    agentAuthorization: 'Bearer test',
    skipHumanReview: true
  };

  const v1 = selectedSubmissionVersion({ healthResolved: true, selectedVersion: 'v1', v2Available: false });
  assert.equal(v1, 'v1');
  assert.deepEqual(buildEvaluationCreateRequest(v1, input), {
    agentCard: input.agentCard,
    agentExamples: input.agentExamples,
    mode: 'demo',
    scoringConfig: { mode: 'panel' },
    seed: 20260731,
    agentAuthorization: 'Bearer test'
  });

  const v2 = selectedSubmissionVersion({ healthResolved: true, selectedVersion: 'v2', v2Available: true });
  assert.equal(v2, 'v2');
  assert.deepEqual(buildEvaluationCreateRequest(v2, input), {
    schemaVersion: 2,
    agentCard: input.agentCard,
    agentExamples: input.agentExamples,
    agentAuthorization: 'Bearer test',
    skipHumanReview: true
  });

  assert.equal(selectedSubmissionVersion({ healthResolved: false, selectedVersion: 'v1', v2Available: true }), null);
  assert.equal(selectedSubmissionVersion({ healthResolved: true, selectedVersion: 'v2', v2Available: false }), null);
});

test('preserves the version query while clearing evaluation hashes on landing return', () => {
  assert.equal(homepageHistoryUrl('/', '?version=v1'), '/?version=v1');
  assert.equal(homepageHistoryUrl('/dashboard', '?version=v2&source=share'), '/dashboard?version=v2&source=share');
  assert.equal(homepageHistoryUrl('/', ''), '/');
});

test('uses normal-text contrast of at least 4.5:1 for unselected version navigation', async () => {
  const css = await readFile(new URL('public/styles.css', root), 'utf8');
  const rule = css.match(/\.evaluation-version-switch a\s*\{([^}]*)\}/);
  assert.ok(rule, 'version navigation rule exists');
  const color = rule[1].match(/color:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(color, 'unselected navigation color is an explicit hex value');
  const contrast = contrastRatio(color[1], '#dfe3e4');
  assert.ok(contrast >= 4.5, `expected >= 4.5:1, received ${contrast.toFixed(2)}:1`);
});

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((channel) => Number.parseInt(channel, 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}
