const state = { mode: 'demo', current: null, eventSource: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const sampleCard = {
  name: '合同风险猎手',
  description: '面向企业法务的合同审查 Agent：读取合同与制度文件，识别冲突条款，按风险等级给出证据、修改建议，并在信息不足时请求人工确认。',
  protocolVersion: '1.0',
  supportedInterfaces: [{ url: 'https://agent.example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain', 'application/pdf'],
  defaultOutputModes: ['application/json', 'text/markdown'],
  skills: [{
    id: 'contract-review', name: '合同风险审查',
    description: '根据合同类型、公司制度和适用法域执行多步审查，定位风险并生成可追溯的修订建议。',
    tags: ['legal', 'risk', 'workflow', 'human-in-the-loop'],
    examples: ['审查这份 SaaS 采购合同，重点关注数据出境、赔偿上限和自动续费。']
  }]
};

init();

async function init() {
  addCase('高风险条款审查', '请审查这份 SaaS 采购合同，重点看数据出境、赔偿上限和自动续费；按高、中、低风险列出原文、依据和修改建议。');
  bindEvents();
  await loadHistory();
  const route = location.hash.match(/^#\/evaluation\/(.+)$/);
  if (route) openEvaluation(route[1]);
}

function bindEvents() {
  $$('.mode-switch button').forEach((button) => button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    $$('.mode-switch button').forEach((item) => item.classList.toggle('selected', item === button));
  }));
  $('#add-case').addEventListener('click', () => addCase('', ''));
  $('#load-sample').addEventListener('click', loadSample);
  $('#start-evaluation').addEventListener('click', submitEvaluation);
  $('#agent-file').addEventListener('change', (event) => readFile(event.target.files[0]));
  const drop = $('#drop-zone');
  ['dragenter','dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('dragging'); }));
  ['dragleave','drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('dragging'); }));
  drop.addEventListener('drop', (event) => readFile(event.dataTransfer.files[0]));
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'home') showLanding();
    if (action === 'history') openHistory();
    if (action === 'close-history') closeHistory();
    const historyItem = event.target.closest('[data-evaluation-id]');
    if (historyItem) { closeHistory(); openEvaluation(historyItem.dataset.evaluationId); }
  });
  window.addEventListener('hashchange', () => {
    const match = location.hash.match(/^#\/evaluation\/(.+)$/);
    if (match && match[1] !== state.current?.id) openEvaluation(match[1]);
  });
}

function addCase(name, prompt) {
  if ($$('.case-row').length >= 5) return;
  const fragment = $('#case-template').content.cloneNode(true);
  $('.case-name', fragment).value = name;
  $('.case-prompt', fragment).value = prompt;
  $('.remove-case', fragment).addEventListener('click', (event) => { event.currentTarget.closest('.case-row').remove(); updateCaseNumbers(); });
  $('#case-list').append(fragment);
  updateCaseNumbers();
}

function updateCaseNumbers() { $$('.case-row').forEach((row, index) => $('.case-index', row).textContent = String(index + 1).padStart(2, '0')); }
function loadSample() {
  $('#agent-card').value = JSON.stringify(sampleCard, null, 2);
  $('#file-name').textContent = '已载入：合同风险猎手.a2a.json';
  $('#case-list').innerHTML = '';
  addCase('高风险条款审查', '请审查这份 SaaS 采购合同，重点看数据出境、赔偿上限和自动续费；按高、中、低风险列出原文、依据和修改建议。');
  addCase('信息不足场景', '只知道供应商要求使用其标准合同，请先判断还缺哪些信息，并给出下一步审查清单。');
}

async function readFile(file) {
  if (!file) return;
  if (file.size > 1_000_000) return showError('文件超过 1 MB。');
  try { $('#agent-card').value = await file.text(); $('#file-name').textContent = `已选择：${file.name}`; showError(''); }
  catch { showError('文件读取失败。'); }
}

async function submitEvaluation() {
  showError('');
  let agentCard;
  try { agentCard = JSON.parse($('#agent-card').value); } catch { return showError('Agent Card 不是合法 JSON。'); }
  const cases = $$('.case-row').map((row, index) => ({ name: $('.case-name', row).value.trim() || `案例 ${index + 1}`, prompt: $('.case-prompt', row).value.trim() })).filter((item) => item.prompt);
  if (!cases.length) return showError('至少填写一个测试 prompt。');
  const button = $('#start-evaluation');
  button.disabled = true; $('span', button).textContent = '正在封舱';
  try {
    const response = await fetch('/api/evaluations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard, cases, mode: state.mode }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '创建评测失败');
    await loadHistory();
    openEvaluation(payload.id);
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; $('span', button).textContent = '送进评测舱'; }
}

async function openEvaluation(id) {
  if (state.eventSource) state.eventSource.close();
  try {
    const response = await fetch(`/api/evaluations/${id}`);
    if (!response.ok) throw new Error('评测不存在');
    const item = await response.json();
    showEvaluation(item);
    if (!['completed','failed'].includes(item.status)) subscribe(id);
  } catch (error) { showError(error.message); showLanding(); }
}

function subscribe(id) {
  state.eventSource = new EventSource(`/api/evaluations/${id}/events`);
  state.eventSource.onmessage = (event) => {
    const item = JSON.parse(event.data);
    showEvaluation(item);
    if (['completed','failed'].includes(item.status)) { state.eventSource.close(); loadHistory(); }
  };
}

function showEvaluation(item) {
  state.current = item;
  if (location.hash !== `#/evaluation/${item.id}`) history.replaceState(null, '', `#/evaluation/${item.id}`);
  $('#landing-view').classList.add('hidden'); $('#evaluation-view').classList.remove('hidden');
  $('#run-id').textContent = `RUN / ${item.id.toUpperCase()}`;
  $('#agent-name').textContent = item.agentCard.name;
  $('#agent-description').textContent = item.agentCard.description;
  $('#run-mode').textContent = item.mode === 'live' ? 'LIVE / 真实调用' : 'DEMO / 演示模拟';
  $('#current-stage').textContent = item.stage;
  $('#latest-log').textContent = item.logs?.at(-1)?.text || '等待评测信号';
  $('#progress-number').textContent = item.progress;
  $('#pulse-progress').style.height = `${item.progress}%`;
  $('#pulse-dot').style.top = `calc(${Math.min(item.progress, 96)}% - 2px)`;
  $$('.stage-list li').forEach((li) => li.classList.toggle('done', item.progress >= Number(li.dataset.threshold)));
  renderResult(item);
  scrollTo({ top: 0, behavior: 'smooth' });
}

function renderResult(item) {
  const root = $('#result-content');
  if (item.status === 'failed') { root.innerHTML = `<div class="failed-box"><b>评测中断</b><p>${escapeHtml(item.error)}</p></div>`; return; }
  if (item.status !== 'completed') { root.innerHTML = '<div class="skeleton-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>'; return; }
  const complexity = item.complexity;
  root.innerHTML = `
    <section class="verdict-hero">
      <div class="verdict-stamp">${escapeHtml(item.roast.tier.stamp)}</div>
      <div><small>FINAL VERDICT / ${escapeHtml(item.roast.tier.label)}</small><h3>${escapeHtml(item.roast.headline)}</h3><p>提交 Agent 实战均分 <b>${item.averages.submitted}</b>，对 Claude Code ${signed(item.roast.deltaClaude)}，对豆包 ${signed(item.roast.deltaDoubao)}。</p></div>
    </section>
    <div class="score-triad">
      ${scoreCard('01 / 必要性', complexity.score, complexity.verdict, complexity.reason, complexity.score >= 60)}
      ${scoreCard('02 / 专业度', item.professional.score, '多模型交叉盲审', `${item.professional.reviews.filter(r=>r.score>0).length} 位评审从五个维度独立打分。`, false)}
      ${scoreCard('03 / 实战力', item.averages.submitted, '提交 Agent 同题均分', `Claude ${item.averages['claude-code']} · Cursor ${item.averages.cursor} · 豆包 ${item.averages.doubao}`, true)}
    </div>
    ${renderComplexity(complexity)}
    ${renderReviews(item.professional.reviews)}
    ${renderBuilds(item.builds)}
    ${renderBattle(item.benchmark)}
  `;
}

function scoreCard(kicker, score, title, body, highlight) {
  return `<article class="score-card ${highlight ? 'highlight' : ''}"><header><span>${kicker}</span><span>/100</span></header><div class="score"><b>${score}</b><span>分</span></div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(body)}</p></article>`;
}

function renderComplexity(value) {
  const labels = { stepDepth:'步骤深度',toolDependency:'工具依赖',stateAndBranching:'状态与分支',uncertainty:'不确定性',repeatValue:'复用价值' };
  return `<div class="section-title"><h3>为什么需要（或不需要）Agent</h3><span>AGENT NECESSITY</span></div><div class="review-grid">${Object.entries(value.dimensions).map(([key,score])=>`<article class="review-card"><div class="reviewer"><b>${labels[key]}</b><span>${score}/100</span></div><div class="review-score">${score}<small> SIGNAL</small></div><div class="mini-bars"><div><span>强度</span><i style="--value:${score}%"></i><b>${score}</b></div></div></article>`).join('')}</div>`;
}

function renderReviews(reviews) {
  const labels = { domainDepth:'领域深度', workflowQuality:'流程设计', failureHandling:'异常处理', outputContract:'输出契约', evaluability:'可评测性' };
  return `<div class="section-title"><h3>三堂会审</h3><span>MULTI-MODEL BLIND REVIEW</span></div><div class="review-grid">${reviews.map(review=>`<article class="review-card"><div class="reviewer"><b>${escapeHtml(review.reviewer)}</b><span>${escapeHtml(review.model)} · ${review.mode?.toUpperCase()}</span></div><div class="review-score">${review.score}<small> / 100</small></div>${review.error?`<p class="risk">${escapeHtml(review.error)}</p>`:`<div class="mini-bars">${Object.entries(review.dimensions||{}).map(([key,score])=>`<div><span>${labels[key]||key}</span><i style="--value:${score}%"></i><b>${score}</b></div>`).join('')}</div><p>${escapeHtml(review.comment)}</p><div class="risk">⚠ ${escapeHtml(review.risk)}</div>`}</article>`).join('')}</div>`;
}

function renderBuilds(builds) {
  return `<div class="section-title"><h3>现场复刻记录</h3><span>RUNTIME SKILL BUILD</span></div><div class="build-list">${builds.map(build=>`<div class="build-row"><b>${escapeHtml(build.runtime)}</b><span>${escapeHtml(build.model||'—')}</span><code>${escapeHtml(build.skill?.name||build.error||'构建失败')}</code><span class="${build.error?'':'ok'}">${build.error?'失败':`✓ ${build.mode.toUpperCase()}`}</span></div>`).join('')}</div>`;
}

function renderBattle(rounds) {
  return `<div class="section-title"><h3>同 Prompt 对打</h3><span>SAME INPUT · VISIBLE OUTPUT ONLY</span></div>${rounds.map((round,index)=>{ const max=Math.max(...round.entries.map(e=>e.score)); return `<article class="battle-round"><div class="battle-prompt"><span>CASE ${String(index+1).padStart(2,'0')}<br>${escapeHtml(round.case.name)}</span><p>${escapeHtml(round.case.prompt)}</p></div><div class="battle-grid">${round.entries.map(entry=>`<div class="battle-entry"><header><h4>${escapeHtml(entry.name)}</h4><strong class="${entry.score===max?'winner':''}">${entry.score}</strong></header><span class="mode">${entry.mode.toUpperCase()}</span><details><summary>查看完整输出</summary><pre>${escapeHtml(entry.output)}</pre></details></div>`).join('')}</div></article>`; }).join('')}`;
}

async function loadHistory() {
  try {
    const items = await (await fetch('/api/evaluations')).json();
    $('#history-count').textContent = items.length;
    $('#history-list').innerHTML = items.length ? items.map(item=>`<button class="history-item" data-evaluation-id="${item.id}"><header><span>${formatTime(item.createdAt)}</span><span>${item.progress}%</span></header><h3>${escapeHtml(item.name)}</h3><p>${item.tier?`最终锐评：<span class="history-tier">${escapeHtml(item.tier.label)}</span> · 实战 ${item.score} 分`:escapeHtml(item.status)}</p></button>`).join('') : '<p>还没有战绩。第一个被公开处刑的 Agent 会是谁？</p>';
  } catch { $('#history-list').innerHTML = '<p>历史记录暂时读取失败。</p>'; }
}

function showLanding() { if(state.eventSource)state.eventSource.close(); state.current=null; history.replaceState(null,'',location.pathname); $('#evaluation-view').classList.add('hidden'); $('#landing-view').classList.remove('hidden'); scrollTo({top:0,behavior:'smooth'}); }
function openHistory() { $('#history-drawer').classList.add('open'); $('#drawer-backdrop').classList.add('open'); $('#history-drawer').setAttribute('aria-hidden','false'); loadHistory(); }
function closeHistory() { $('#history-drawer').classList.remove('open'); $('#drawer-backdrop').classList.remove('open'); $('#history-drawer').setAttribute('aria-hidden','true'); }
function showError(text) { $('#form-error').textContent = text; }
function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, char=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
function signed(value) { return `${value>=0?'+':''}${value} 分`; }
function formatTime(value) { return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)); }
