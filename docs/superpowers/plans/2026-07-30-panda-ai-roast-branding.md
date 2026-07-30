# Panda AI锐评局 Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing “锐” brand blocks with a faithful PandaAI Logo + “锐评局” lockup across the public UI without changing the product’s existing layout, color system, interactions, or evaluation behavior.

**Architecture:** Keep branding static and local: three SVG assets under `public/assets/` feed page-level brand links, titles, favicon declarations, and responsive CSS. Existing page styles remain in their current CSS files; a Node static-contract test enforces consistent markup and the Agent Check standalone allowlist carries the same assets.

**Tech Stack:** Static HTML, CSS, SVG, Node.js `node:test`, existing standalone bundle builder.

## Global Constraints

- Public product name is exactly `Panda AI锐评局`.
- Desktop brand structure is `[complete PandaAI Logo] | 锐评局`.
- Mobile brand structure is `[PandaAI mark] 锐评局`; the English subtitle is hidden.
- Keep the main site header at `76px`; do not alter Hero, cards, buttons, animations, business copy, APIs, or evaluation behavior.
- Use the reference page’s original three-path PandaAI geometry and original proportions; do not redraw, rotate, shadow, outline, stretch, or place it in the old red square.
- Brand assets must be served locally; production pages must not depend on `pandaaiquant.com`.
- Preserve all user changes already present in the dirty worktree and stage only files from this feature.

---

### Task 1: Lock the brand contract and add local assets

**Files:**
- Create: `test/branding-ui.test.js`
- Create: `public/assets/pandaai-mark.svg`
- Create: `public/assets/pandaai-logo.svg`
- Create: `public/favicon.svg`

**Interfaces:**
- Consumes: PandaAI mark `viewBox="0 0 195 206"` and the three original path definitions observed at `https://www.pandaaiquant.com/about`.
- Produces: `/assets/pandaai-mark.svg`, `/assets/pandaai-logo.svg`, and `/favicon.svg`; later page tasks reference these exact URLs.

- [ ] **Step 1: Write the failing asset contract test**

Create `test/branding-ui.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
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
  assert.doesNotMatch(`${mark}\n${logo}\n${favicon}`, /https?:\/\//);
});
```

- [ ] **Step 2: Run the contract test and confirm it fails**

Run:

```bash
node --test test/branding-ui.test.js
```

Expected: FAIL with `ENOENT` for `public/assets/pandaai-mark.svg`.

- [ ] **Step 3: Add the original PandaAI mark and favicon SVGs**

Create `public/assets/pandaai-mark.svg` and `public/favicon.svg` with:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 195 206" role="img" aria-labelledby="title">
  <title id="title">PandaAI</title>
  <path d="m96.07,94.87c0,0 -1.07,4.12 -1.07,4.12c0,0 -5.41,18.32 -5.41,18.32c0,0 -14.01,42.6 -14.01,42.6c0,0 -8.34,26.55 -8.34,26.55c0,0 14.6,8.35 14.6,8.35c1.09,0.62 15.78,8.19 15.89,8.19c0.1,0 15.91,-8.04 16.9,-8.59l15.33,-8.58l-1.35,-2.67c0,0 -14.98,-43.2 -14.98,-43.2c-0.18,-0.56 -13.63,-42.6 -13.63,-42.63c0,-0.59 -1.03,-2.94 -1.43,-3.27c-1.14,-0.95 -1.65,-0.79 -2.5,0.81z"/>
  <path d="m91.21,4.05c0,0 -19.5,4.55 -19.5,4.55c-10.31,2.18 -17.89,4.29 -18.9,5.27c-0.26,0.26 -21.96,42.99 -25.83,50.87l-24.15,49.25l4.76,8.75c0,0 14.21,25.26 14.21,25.26c0,0 11.82,19.67 11.82,19.67c1.58,2.13 6.81,5.48 16.02,10.26c0,0 13.97,6.79 13.97,6.79c0,0 -3.67,-11.26 -3.67,-11.26c0,0 -10.52,-30.78 -10.52,-30.78c-2.51,-7.61 -6.35,-21.1 -6.23,-21.9c0.23,-1.56 6.83,-5.79 26.56,-17.02l26.25,-14.95l0,-42.9c0,-33.7 -0.27,-42.9 -1.25,-42.85c0,0 -3.54,0.99 -3.54,0.99z"/>
  <path d="m100.02,45.14c0,16.37 0.46,43.01 0.75,43.43c0,0 6.73,4.4 6.73,4.4c0,0 25.75,14.76 25.75,14.76c16.67,9.64 19.75,11.78 19.75,13.73c0,0.2 -5.83,19.54 -6.38,21.17c0,0 -10.58,30.21 -10.58,30.21c0,0 -3.87,11.61 -3.87,11.61c0,0 14.71,-6.84 14.71,-6.84l14.38,-7.11l12.88,-22c0,0 16.01,-28.01 16.01,-28.01l3.13,-6.02l-14.38,-29.48c0,0 -24.88,-50.49 -24.88,-50.49c-10.45,-20.85 -10.55,-21.01 -14.52,-22.16c0,0 -20.38,-4.83 -20.38,-4.83c0,0 -17.75,-4.2 -17.75,-4.2c-1.15,-0.44 -1.37,6.3 -1.35,41.83z"/>
</svg>
```

Use the same geometry in both files. Keep `fill` unset so the black default fill is preserved.

- [ ] **Step 4: Add the complete horizontal Logo SVG**

Create `public/assets/pandaai-logo.svg` with `viewBox="0 0 148 27"`. Scale the exact three paths into a `26 × 27` mark and place `PandaAI` at `x="34"` with a `20px`, `700`-weight Dream-style fallback stack:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 148 27" role="img" aria-labelledby="title">
  <title id="title">PandaAI</title>
  <g transform="scale(.13333 .13107)">
    <path d="m96.07,94.87c0,0 -1.07,4.12 -1.07,4.12c0,0 -5.41,18.32 -5.41,18.32c0,0 -14.01,42.6 -14.01,42.6c0,0 -8.34,26.55 -8.34,26.55c0,0 14.6,8.35 14.6,8.35c1.09,0.62 15.78,8.19 15.89,8.19c0.1,0 15.91,-8.04 16.9,-8.59l15.33,-8.58l-1.35,-2.67c0,0 -14.98,-43.2 -14.98,-43.2c-0.18,-0.56 -13.63,-42.6 -13.63,-42.63c0,-0.59 -1.03,-2.94 -1.43,-3.27c-1.14,-0.95 -1.65,-0.79 -2.5,0.81z"/>
    <path d="m91.21,4.05c0,0 -19.5,4.55 -19.5,4.55c-10.31,2.18 -17.89,4.29 -18.9,5.27c-0.26,0.26 -21.96,42.99 -25.83,50.87l-24.15,49.25l4.76,8.75c0,0 14.21,25.26 14.21,25.26c0,0 11.82,19.67 11.82,19.67c1.58,2.13 6.81,5.48 16.02,10.26c0,0 13.97,6.79 13.97,6.79c0,0 -3.67,-11.26 -3.67,-11.26c0,0 -10.52,-30.78 -10.52,-30.78c-2.51,-7.61 -6.35,-21.1 -6.23,-21.9c0.23,-1.56 6.83,-5.79 26.56,-17.02l26.25,-14.95l0,-42.9c0,-33.7 -0.27,-42.9 -1.25,-42.85c0,0 -3.54,0.99 -3.54,0.99z"/>
    <path d="m100.02,45.14c0,16.37 0.46,43.01 0.75,43.43c0,0 6.73,4.4 6.73,4.4c0,0 25.75,14.76 25.75,14.76c16.67,9.64 19.75,11.78 19.75,13.73c0,0.2 -5.83,19.54 -6.38,21.17c0,0 -10.58,30.21 -10.58,30.21c0,0 -3.87,11.61 -3.87,11.61c0,0 14.71,-6.84 14.71,-6.84l14.38,-7.11l12.88,-22c0,0 16.01,-28.01 16.01,-28.01l3.13,-6.02l-14.38,-29.48c0,0 -24.88,-50.49 -24.88,-50.49c-10.45,-20.85 -10.55,-21.01 -14.52,-22.16c0,0 -20.38,-4.83 -20.38,-4.83c0,0 -17.75,-4.2 -17.75,-4.2c-1.15,-0.44 -1.37,6.3 -1.35,41.83z"/>
  </g>
  <text x="34" y="21" font-family="Arial Narrow, Arial, sans-serif" font-size="20" font-weight="700" letter-spacing=".5">PandaAI</text>
</svg>
```

- [ ] **Step 5: Re-run the contract test**

Run:

```bash
node --test test/branding-ui.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the asset contract**

```bash
git add test/branding-ui.test.js public/assets/pandaai-mark.svg public/assets/pandaai-logo.svg public/favicon.svg
git commit -m "test: define Panda AI branding contract"
```

### Task 2: Replace the existing header brands without changing page layout

**Files:**
- Modify: `public/index.html`
- Modify: `public/methodology.html`
- Modify: `public/judge.html`
- Modify: `public/agent-check.html`
- Modify: `public/styles.css`
- Modify: `public/judge.css`
- Modify: `public/agent-check.css`

**Interfaces:**
- Consumes: `/assets/pandaai-logo.svg`, `/assets/pandaai-mark.svg`, `/favicon.svg` from Task 1.
- Produces: a common `.brand-logo`, `.brand-divider`, and `.brand-copy` HTML shape implemented inside each page’s existing stylesheet.

- [ ] **Step 1: Extend the contract test with the failing page assertions**

Add to `test/branding-ui.test.js`:

```js
const pages = [
  'public/index.html',
  'public/methodology.html',
  'public/judge.html',
  'public/agent-check.html'
];

test('brands every public page as Panda AI锐评局 with local assets', async () => {
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
```

Run:

```bash
node --test test/branding-ui.test.js
```

Expected: FAIL on `public/index.html` because its title does not yet contain `Panda AI锐评局`.

- [ ] **Step 2: Replace each header brand with the approved lockup**

Use this structure in the four header-bearing pages, preserving each page’s existing subtitle:

```html
<a class="brand" href="/" aria-label="Panda AI锐评局首页">
  <picture class="brand-logo">
    <source media="(max-width: 700px)" srcset="/assets/pandaai-mark.svg">
    <img src="/assets/pandaai-logo.svg" alt="" aria-hidden="true">
  </picture>
  <span class="brand-divider" aria-hidden="true"></span>
  <span class="brand-copy"><b>锐评局</b><small>FINANCE AGENT VERDICT</small></span>
</a>
```

For `judge.html`, keep `HUMAN REVIEW DESK` as the subtitle. For `agent-check.html`, keep `A2A READINESS TRACE`.

- [ ] **Step 3: Update titles, descriptions, and favicon declarations**

Set exact titles:

```text
Panda AI锐评局 · 金融 Agent 研究终审台
Panda AI锐评局 · 金融评测规则说明书
Panda AI锐评局 · 公开评审席
Panda AI锐评局 · Agent Card 技术预检台
```

Add to each `<head>`:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
```

Prefix the existing page descriptions with `Panda AI锐评局：` without changing their remaining product claims.

- [ ] **Step 4: Replace old brand-block CSS with non-invasive Logo CSS**

In each existing stylesheet, delete the old `.brand-mark` square rules and define:

```css
.brand { display:flex; align-items:center; gap:10px; min-width:0; color:inherit; text-decoration:none; }
.brand-logo { display:block; flex:0 0 auto; height:28px; }
.brand-logo img { display:block; width:auto; height:28px; }
.brand-divider { flex:0 0 1px; width:1px; height:30px; background:var(--line); }
.brand-copy { min-width:0; }
```

Keep each stylesheet’s existing `.brand b` and `.brand small` typography, removing only selectors tied to `.brand-mark`.

- [ ] **Step 5: Add narrow-screen rules**

At each page’s existing narrow breakpoint:

```css
.brand-logo,
.brand-logo img { width:26px; height:27px; }
.brand-divider { height:26px; }
.brand small { display:none; }
```

For the main site, also cap `.brand-copy b` to one line and preserve the current navigation-hiding behavior. Do not hide or reorder any additional navigation item.

- [ ] **Step 6: Run the brand and existing UI tests**

Run:

```bash
node --test test/branding-ui.test.js test/judge-ui.test.js test/result-ui.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the header-bearing pages**

```bash
git add test/branding-ui.test.js public/index.html public/methodology.html public/judge.html public/agent-check.html public/styles.css public/judge.css public/agent-check.css
git commit -m "feat: add Panda AI branding to primary headers"
```

### Task 3: Brand compact pages and carry assets into the Agent Check bundle

**Files:**
- Modify: `public/appeal.html`
- Modify: `public/evidence.html`
- Modify: `public/appeal.css`
- Modify: `public/evidence.css`
- Modify: `scripts/build-agent-check-bundles.js`
- Modify: `test/agent-check-bundle.test.js`

**Interfaces:**
- Consumes: the same brand asset URLs and HTML classes from Tasks 1–2.
- Produces: compact brand rows on pages without global navigation and a self-contained Agent Check distribution with all referenced brand assets.

- [ ] **Step 1: Extend the page contract to Appeal and Evidence**

Append these paths to the existing `pages` array in `test/branding-ui.test.js`:

```js
'public/appeal.html',
'public/evidence.html'
```

Run:

```bash
node --test test/branding-ui.test.js
```

Expected: FAIL because `public/appeal.html` does not yet contain the branded title and Logo markup.

- [ ] **Step 2: Add compact brand rows to Appeal and Evidence**

Insert before each existing back link:

```html
<a class="brand compact-brand" href="/" aria-label="Panda AI锐评局首页">
  <picture class="brand-logo">
    <source media="(max-width: 700px)" srcset="/assets/pandaai-mark.svg">
    <img src="/assets/pandaai-logo.svg" alt="" aria-hidden="true">
  </picture>
  <span class="brand-divider" aria-hidden="true"></span>
  <span class="brand-copy"><b>锐评局</b><small>FINANCE AGENT VERDICT</small></span>
</a>
```

Keep the existing back links immediately below the compact brand. Do not add a new full-width topbar.

- [ ] **Step 3: Add compact-page metadata**

Set:

```text
Panda AI锐评局 · 提交评测申诉
Panda AI锐评局 · 证据回放
```

Add the shared favicon declaration and a concise branded meta description to both pages.

- [ ] **Step 4: Add compact brand CSS**

Add the Task 2 brand rules locally to `appeal.css` and `evidence.css`, plus:

```css
.compact-brand { width:max-content; margin-bottom:14px; }
.compact-brand + a { display:inline-block; margin-bottom:18px; }
.brand b { display:block; font-size:15px; letter-spacing:.08em; }
.brand small { display:block; margin-top:3px; color:#667875; font:8px/1.3 ui-monospace,Consolas,monospace; letter-spacing:.12em; }
```

Use the existing `600px` and `700px` media queries to switch the picture to the mark and hide the subtitle.

- [ ] **Step 5: Confirm the compact-page contract passes**

Run:

```bash
node --test test/branding-ui.test.js
```

Expected: PASS.

- [ ] **Step 6: Write the failing standalone bundle assertions**

Extend `EXPECTED_APP_FILES` in `test/agent-check-bundle.test.js` with:

```js
'public/assets/pandaai-logo.svg',
'public/assets/pandaai-mark.svg',
'public/favicon.svg',
```

Also assert the built `agent-check.html` contains only local `/assets/` and `/favicon.svg` brand URLs.

- [ ] **Step 7: Run the standalone bundle test and confirm it fails**

Run:

```bash
node --test test/agent-check-bundle.test.js
```

Expected: FAIL because `APP_FILES` does not yet include the three brand assets.

- [ ] **Step 8: Add the assets to the standalone allowlist**

Add the same three paths to `APP_FILES` in `scripts/build-agent-check-bundles.js`. Keep the exact allowlist approach and do not add a directory-wide copy.

- [ ] **Step 9: Run all focused branding tests**

Run:

```bash
node --test test/branding-ui.test.js test/agent-check-bundle.test.js test/judge-ui.test.js test/result-ui.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit compact pages and standalone packaging**

```bash
git add test/branding-ui.test.js public/appeal.html public/evidence.html public/appeal.css public/evidence.css scripts/build-agent-check-bundles.js test/agent-check-bundle.test.js
git commit -m "feat: complete Panda AI branding coverage"
```

### Task 4: Verify static behavior and visual fidelity

**Files:**
- Modify only if verification finds a branding regression in files already listed above.

**Interfaces:**
- Consumes: completed brand assets, HTML, CSS, and bundle allowlist.
- Produces: evidence that functionality and layout remain intact at desktop and mobile widths.

- [ ] **Step 1: Run syntax checks**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 2: Run the complete Node test suite**

Run:

```bash
npm run test:node
```

Expected: PASS with no new failures.

- [ ] **Step 3: Run the complete project test suite**

Run:

```bash
npm test
```

Expected: Node tests and market-worker tests both PASS.

- [ ] **Step 4: Verify desktop layout in the browser**

At the normal browser viewport, inspect:

```text
/
/methodology.html
/judge.html
/appeal.html
/agent-check
/evidence.html
```

For each page confirm:

- PandaAI Logo is black, proportional, and unmodified.
- “锐评局” remains visible.
- No brand, navigation, or system-state overlap occurs.
- No horizontal scrollbar appears.
- Existing page content starts in the same region except for the small compact brand row on Appeal and Evidence.
- Browser console shows no new `404`, SVG, or font errors.

- [ ] **Step 5: Verify mobile layout**

Set a `390 × 844` viewport and reload each page. Confirm the PandaAI mark replaces the full wordmark, “锐评局” remains visible, subtitles hide, and navigation remains usable without horizontal overflow.

- [ ] **Step 6: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; unrelated pre-existing user changes remain unstaged.

- [ ] **Step 7: Commit any verification-only corrections**

If verification required CSS/HTML corrections, commit only those files:

```bash
git add public/index.html public/methodology.html public/judge.html public/appeal.html public/agent-check.html public/evidence.html public/styles.css public/judge.css public/appeal.css public/agent-check.css public/evidence.css
git commit -m "fix: polish Panda AI branding responsiveness"
```

If no correction was required, do not create an empty commit.
