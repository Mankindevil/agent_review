const state = { mode: 'demo', sourceType: 'direct', current: null, eventSource: null, resolvedCard: null, lastStage: null, completedRendered: null, stopping: false };
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

const exampleCatalog = {
  file: {
    card: { name:'文件收纳员', description:'根据文件名和扩展名生成分类、重命名与目录整理建议，不执行不可逆文件操作。', version:'1.0.0', supportedInterfaces:[{url:'http://127.0.0.1:4181/a2a/v1',protocolBinding:'HTTP+JSON',protocolVersion:'1.0'}], capabilities:{streaming:false,pushNotifications:false}, defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'organize-files',name:'整理文件',description:'按类型和日期对文件清单分类并生成重命名映射。',tags:['files','rename'],examples:['把下载目录里的文件按类型整理。']}] },
    cases: [{name:'下载目录整理',prompt:'请整理这些文件：会议记录.docx、报价单.xlsx、架构图.png。先给出移动映射，只预览，不实际修改。'}]
  },
  contract: {
    card: { ...sampleCard, supportedInterfaces:[{url:'http://127.0.0.1:4182/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0'}], version:'1.2.0' },
    cases: [
      {name:'高风险条款审查',prompt:'请审查这份 SaaS 采购合同，重点看数据出境、赔偿上限和自动续费；按高、中、低风险列出原文、依据和修改建议。'},
      {name:'信息不足场景',prompt:'只知道供应商要求使用其标准合同，请先判断还缺哪些信息，并给出下一步审查清单。'}
    ]
  },
  incident: {
    card: { name:'生产事故指挥官',description:'处理线上生产事故：整理时间线、判断影响、分派排障、维护状态并生成对内外通报。',version:'0.9.0',url:'http://127.0.0.1:4183/a2a',protocolVersion:'0.3',preferredTransport:'JSONRPC',capabilities:{streaming:false,pushNotifications:true},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'incident-response',name:'生产事故响应',description:'根据告警和变更记录规划多线排障，在新证据到达时更新假设、回滚方案、责任人和沟通节奏。',tags:['incident','workflow','state','retry','monitor'],examples:['支付成功率在发布后从 99.9% 降到 82%，组织 P1 响应。']}] },
    cases: [{name:'支付 P1',prompt:'10:05 发布 payment-api v2.8；10:08 支付成功率从 99.9% 降到 82%，华东错误最多。请组织 P1 响应，给出前 15 分钟行动、负责人、决策点、通报节奏和恢复验收条件。'}]
  }
};

init();

async function init() {
  requestAnimationFrame(() => document.body.classList.add('ready'));
  addCase('高风险条款审查', '请审查这份 SaaS 采购合同，重点看数据出境、赔偿上限和自动续费；按高、中、低风险列出原文、依据和修改建议。');
  bindEvents();
  loadRuntimeHealth();
  await loadHistory();
  const route = location.hash.match(/^#\/evaluation\/(.+)$/);
  if (route) openEvaluation(route[1]);
}

function bindEvents() {
  $$('.mode-switch button').forEach((button) => button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    $$('.mode-switch button').forEach((item) => item.classList.toggle('selected', item === button));
  }));
  $$('.source-switch button').forEach((button) => button.addEventListener('click', () => setSourceType(button.dataset.source)));
  $('#add-case').addEventListener('click', () => addCase('', ''));
  $$('[data-example]').forEach((button) => button.addEventListener('click', () => loadSample(button.dataset.example)));
  $('#resolve-agent').addEventListener('click', resolveRemoteCard);
  $('#agent-url').addEventListener('input', () => {
    state.resolvedCard = null;
    $('#resolved-card').classList.add('hidden');
  });
  $('#start-evaluation').addEventListener('click', submitEvaluation);
  $('#stop-evaluation').addEventListener('click', stopEvaluation);
  $('#agent-file').addEventListener('change', (event) => readFile(event.target.files[0]));
  const drop = $('#drop-zone');
  ['dragenter','dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('dragging'); }));
  ['dragleave','drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('dragging'); }));
  drop.addEventListener('drop', (event) => readFile(event.dataTransfer.files[0]));
  document.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry-type]');
    if (retry) { retryStep(retry); return; }
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
function loadSample(id = 'contract') {
  const example = exampleCatalog[id];
  setSourceType('direct');
  $('#agent-card').value = JSON.stringify(example.card, null, 2);
  $('#file-name').textContent = `已载入：${example.card.name}.a2a.json`;
  $('#case-list').innerHTML = '';
  example.cases.forEach((testCase) => addCase(testCase.name, testCase.prompt));
}

function setSourceType(sourceType) {
  if (state.sourceType !== sourceType) {
    state.resolvedCard = null;
    $('#resolved-card').classList.add('hidden');
  }
  state.sourceType = sourceType;
  $$('.source-switch button').forEach((button) => button.classList.toggle('selected', button.dataset.source === sourceType));
  $('#direct-source').classList.toggle('hidden', sourceType !== 'direct');
  $('#url-source').classList.toggle('hidden', sourceType === 'direct');
  if (sourceType !== 'direct') {
    const service = sourceType === 'service-url';
    $('#agent-url-label').textContent = service ? 'A2A 服务根地址' : 'Agent Card 完整 URL';
    $('#agent-url').placeholder = service ? 'https://agent.example.com' : 'https://agent.example.com/.well-known/agent-card.json';
    $('#url-help').textContent = service ? '平台会按官方约定读取该域名的 /.well-known/agent-card.json。' : '直接读取指定的 Agent Card JSON 地址。';
  }
}

async function resolveRemoteCard() {
  showError('');
  const button = $('#resolve-agent');
  button.disabled = true; button.textContent = '读取中';
  try {
    const response = await fetch('/api/agent-cards/resolve', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceType:state.sourceType,url:$('#agent-url').value.trim()})});
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Agent Card 读取失败');
    state.resolvedCard = payload.card;
    $('#resolved-card').classList.remove('hidden');
    $('#resolved-card').innerHTML = `<b>✓ ${escapeHtml(payload.card.name)}</b>${escapeHtml(payload.resolvedUrl)} · A2A ${escapeHtml(payload.validation.version)}`;
    return payload.card;
  } catch (error) { state.resolvedCard = null; showError(error.message); throw error; }
  finally { button.disabled = false; button.textContent = '读取并校验'; }
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
  if (state.sourceType === 'direct') {
    try { agentCard = JSON.parse($('#agent-card').value); } catch { return showError('Agent Card 不是合法 JSON。'); }
  } else {
    try { agentCard = state.resolvedCard || await resolveRemoteCard(); } catch { return; }
  }
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
    if (!isTerminal(item.status)) subscribe(id);
  } catch (error) { showError(error.message); showLanding(); }
}

function subscribe(id) {
  state.eventSource = new EventSource(`/api/evaluations/${id}/events`);
  state.eventSource.onmessage = (event) => {
    const item = JSON.parse(event.data);
    showEvaluation(item);
    if (isTerminal(item.status)) { state.eventSource.close(); loadHistory(); }
  };
}

async function stopEvaluation() {
  const item = state.current;
  if (!item || isTerminal(item.status) || state.stopping) return;
  const button = $('#stop-evaluation');
  state.stopping = true;
  button.disabled = true;
  $('span', button).textContent = '正在停止';
  try {
    const response = await fetch(`/api/evaluations/${item.id}/cancel`, { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '停止评测失败');
    state.eventSource?.close();
    showEvaluation(payload);
    loadHistory();
  } catch (error) {
    $('span', button).textContent = error.message;
    setTimeout(() => { if (!isTerminal(state.current?.status)) $('span', button).textContent = '停止本次评测'; }, 2200);
  } finally {
    state.stopping = false;
    button.disabled = false;
  }
}

async function retryStep(button) {
  const item = state.current;
  if (!item || !isTerminal(item.status) || button.disabled) return;
  const original = button.innerHTML;
  $$('[data-retry-type]').forEach((control) => { control.disabled = true; });
  button.innerHTML = '<i>↻</i> 正在派发';
  try {
    const body = { type: button.dataset.retryType, key: button.dataset.retryKey };
    if (button.dataset.caseIndex !== undefined) body.caseIndex = Number(button.dataset.caseIndex);
    const response = await fetch(`/api/evaluations/${item.id}/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '单步重试失败');
    state.eventSource?.close();
    showEvaluation(payload);
    subscribe(item.id);
  } catch (error) {
    button.innerHTML = escapeHtml(error.message);
    setTimeout(() => {
      button.innerHTML = original;
      $$('[data-retry-type]').forEach((control) => { control.disabled = false; });
    }, 2200);
  }
}

function showEvaluation(item) {
  const changedEvaluation = state.current?.id !== item.id;
  const changedStage = state.lastStage !== item.stage;
  state.current = item;
  state.lastStage = item.stage;
  if (location.hash !== `#/evaluation/${item.id}`) history.replaceState(null, '', `#/evaluation/${item.id}`);
  $('#landing-view').classList.add('hidden'); $('#evaluation-view').classList.remove('hidden');
  $('#run-id').textContent = `RUN / ${item.id.toUpperCase()}`;
  $('#agent-name').textContent = item.agentCard.name;
  $('#agent-description').textContent = item.agentCard.description;
  $('#run-mode').textContent = item.overallMode === 'live' ? 'LIVE / 全链路真实' : item.mode === 'live' ? 'MIXED / Agent 实调' : 'DEMO / 演示模拟';
  $('#current-stage').textContent = item.stage;
  $('#latest-log').textContent = item.logs?.at(-1)?.text || '等待评测信号';
  $('#progress-number').textContent = item.progress;
  $('#pulse-progress').style.height = `${item.progress}%`;
  $('#pulse-dot').style.top = `calc(${Math.min(item.progress, 96)}% - 2px)`;
  $('#live-deck').classList.toggle('running', ['running','retrying'].includes(item.status));
  const stopButton = $('#stop-evaluation');
  stopButton.classList.toggle('hidden', !['queued','running','retrying'].includes(item.status));
  stopButton.disabled = state.stopping;
  if (!state.stopping) $('span', stopButton).textContent = '停止本次评测';
  if (changedStage) {
    $('.stage-copy').classList.remove('flash');
    requestAnimationFrame(() => $('.stage-copy').classList.add('flash'));
  }
  $$('.stage-list li').forEach((li) => li.classList.toggle('done', item.progress >= Number(li.dataset.threshold)));
  renderLogs(item.logs || []);
  renderResult(item);
  if (changedEvaluation) scrollTo({ top: 0, behavior: 'smooth' });
}

function renderResult(item) {
  const root = $('#result-content');
  if (item.status !== 'completed') {
    state.completedRendered = null;
    root.classList.remove('reveal');
    root.classList.add('streaming');
    root.innerHTML = renderPartialResults(item);
    return;
  }
  if (state.completedRendered === item.id) return;
  state.completedRendered = item.id;
  root.classList.remove('streaming');
  const complexity = item.complexity;
  const tier = normalizeTier(item.roast.tier);
  const sealText = tier.stamp || tier.label;
  const tierCode = String(tier.code || 'NPC').toLowerCase();
  root.innerHTML = `
    <section class="verdict-hero">
      <div class="verdict-seal verdict-seal--${escapeHtml(tierCode)}" role="img" aria-label="最终评级：${escapeHtml(tier.label)}">
        <div class="verdict-seal__plate">
          <span class="verdict-seal__eyebrow">AGENT RANK</span>
          <strong data-length="${sealText.length}">${escapeHtml(sealText)}</strong>
          <span class="verdict-seal__caption">锐评局 · 终审</span>
        </div>
        <i class="verdict-seal__impact" aria-hidden="true"></i>
      </div>
      <div class="verdict-copy"><small>FINAL VERDICT / ${escapeHtml(tier.label)}</small><h3>${escapeHtml(item.roast.headline)}</h3><p>提交 Agent 实战均分 <b>${item.averages.submitted}</b>，对 Claude Code ${signed(item.roast.deltaClaude)}，对豆包 ${signed(item.roast.deltaDoubao)}。</p>${renderRecalculationNote(item)}</div>
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
  root.classList.add('reveal');
  animateCounters(root);
}

function renderPartialResults(item) {
  const reviews = item.professional?.reviews || [];
  const builds = item.builds || [];
  const rounds = (item.benchmark || []).filter((round) => round.entries?.length);
  const terminal = terminalNotice(item);
  const sections = [
    item.complexity ? renderComplexity(item.complexity) : '',
    reviews.length ? renderReviews(reviews) : '',
    builds.length ? renderBuilds(builds) : '',
    rounds.length ? renderBattle(rounds) : ''
  ].filter(Boolean).join('');
  const unlocked = Number(Boolean(item.complexity)) + Number(reviews.length > 0) + Number(builds.length > 0) + Number(rounds.length > 0);
  const waiting = isTerminal(item.status) ? '' : `<div class="artifact-wait"><i></i><div><b>${escapeHtml(item.stage)}</b><span>新产物完成后会直接插入下方，不必等整场结束。</span></div><strong>${item.progress}%</strong></div>`;
  const retryCount = item.retryHistory?.length ? ` · ${item.retryHistory.length} 次复核` : '';
  return `${terminal}<section class="artifact-console"><header><div><small>LIVE ARTIFACTS / 阶段产物</small><h3>${item.status === 'retrying' ? '单步复核中，旧结果继续可见' : '跑完一项，解锁一项'}</h3></div><span>${unlocked} / 4 组已出${retryCount}</span></header><div class="artifact-meter"><i style="--progress:${item.progress}%"></i></div>${waiting}</section>${sections || '<div class="artifact-empty"><b>评测舱已接单</b><span>首个阶段产物正在生成。</span></div>'}`;
}

function terminalNotice(item) {
  if (item.status === 'cancelled') return '<div class="failed-box stopped"><b>评测已停止</b><p>停止前已经完成的阶段产物保留在下方，可以继续查看。</p></div>';
  if (item.status === 'interrupted') return `<div class="failed-box interrupted"><b>检测到遗留的假运行状态</b><p>${escapeHtml(item.error || '服务重启后，旧执行任务已经不存在。')}</p></div>`;
  if (item.status === 'failed') return `<div class="failed-box"><b>评测中断</b><p>${escapeHtml(item.error || '未知错误')}</p></div>`;
  return '';
}

function scoreCard(kicker, score, title, body, highlight) {
  return `<article class="score-card ${highlight ? 'highlight' : ''}"><header><span>${kicker}</span><span>/100</span></header><div class="score"><b data-count="${score}">${score}</b><span>分</span></div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(body)}</p></article>`;
}

function renderComplexity(value) {
  const labels = { stepDepth:'步骤深度',toolDependency:'工具依赖',stateAndBranching:'状态与分支',uncertainty:'不确定性',repeatValue:'复用价值' };
  return `<div class="section-title"><h3>为什么需要（或不需要）Agent</h3><span>AGENT NECESSITY</span></div><div class="review-grid">${Object.entries(value.dimensions).map(([key,score])=>`<article class="review-card"><div class="reviewer"><b>${labels[key]}</b><span>${score}/100</span></div><div class="review-score">${score}<small> SIGNAL</small></div><div class="mini-bars"><div><span>强度</span><i style="--value:${score}%"></i><b>${score}</b></div></div></article>`).join('')}</div>`;
}

function renderReviews(reviews) {
  const labels = { domainDepth:'领域深度', workflowQuality:'流程设计', failureHandling:'异常处理', outputContract:'输出契约', evaluability:'可评测性' };
  return `<div class="section-title"><h3>四方会审</h3><span>MULTI-MODEL BLIND REVIEW</span></div><div class="review-grid model-review-grid">${reviews.map(review=>`<article class="review-card"><div class="reviewer"><b>${escapeHtml(review.reviewer)}</b><span>${escapeHtml(review.model)} · ${review.mode?.toUpperCase()}</span></div><div class="review-score">${review.score}<small> / 100</small></div>${review.error?`<p class="risk">${escapeHtml(review.error)}</p>`:`<div class="mini-bars">${Object.entries(review.dimensions||{}).map(([key,score])=>`<div><span>${labels[key]||key}</span><i style="--value:${score}%"></i><b>${score}</b></div>`).join('')}</div><p>${escapeHtml(review.comment)}</p><div class="risk">⚠ ${escapeHtml(review.risk)}</div>`}<div class="review-actions">${retryButton('review', review.reviewerId || review.model, '重跑该模型')}</div></article>`).join('')}</div>`;
}

function renderBuilds(builds) {
  return `<div class="section-title"><h3>现场复刻记录</h3><span>RUNTIME SKILL BUILD</span></div><div class="build-list">${builds.map(build=>`<div class="build-row"><b>${escapeHtml(build.runtime)}</b><span>${escapeHtml(build.model||'—')}</span><code>${escapeHtml(build.skill?.name||build.error||'构建失败')}</code><span class="${build.error?'':'ok'}">${build.error?'失败':`✓ ${build.mode.toUpperCase()}`}</span>${retryButton('build', build.runtimeId, '重建并回放')}</div>`).join('')}</div>`;
}

function renderBattle(rounds) {
  return `<div class="section-title"><h3>同 Prompt 对打</h3><span>SAME INPUT · VISIBLE OUTPUT ONLY</span></div>${rounds.map((round,index)=>{ const max=Math.max(...round.entries.map(e=>e.score)); return `<article class="battle-round"><div class="battle-prompt"><span>CASE ${String(index+1).padStart(2,'0')}<br>${escapeHtml(round.case.name)}</span><p>${escapeHtml(round.case.prompt)}</p></div><div class="battle-grid">${round.entries.map(entry=>`<div class="battle-entry"><header><h4>${escapeHtml(entry.name)}</h4><strong class="${entry.score===max?'winner':''}">${entry.score}</strong></header><div class="battle-actions"><span class="mode">${entry.mode.toUpperCase()}</span>${retryButton('benchmark', entry.id, '重跑这一局', index)}</div><details><summary>查看完整输出</summary><pre>${escapeHtml(entry.output)}</pre></details></div>`).join('')}</div></article>`; }).join('')}`;
}

function retryButton(type, key, label, caseIndex) {
  if (!isTerminal(state.current?.status) || !key) return '';
  const caseAttribute = Number.isInteger(caseIndex) ? ` data-case-index="${caseIndex}"` : '';
  return `<button class="retry-step" type="button" data-retry-type="${escapeHtml(type)}" data-retry-key="${escapeHtml(key)}"${caseAttribute} aria-label="${escapeHtml(label)}"><i aria-hidden="true">↻</i>${escapeHtml(label)}</button>`;
}

function renderRecalculationNote(item) {
  const count = item.retryHistory?.length || 0;
  if (!count) return '';
  const latest = item.retryHistory.at(-1);
  return `<div class="recalc-note"><i>↻</i><span>已基于 <b>${count}</b> 次单步复核重新计分<br><small>最近：${escapeHtml(latest.label)} · ${formatTime(latest.at)}</small></span></div>`;
}

function renderLogs(logs) {
  $('#log-count').textContent = `${logs.length} EVENTS`;
  const stream = $('#log-stream');
  if (!logs.length) { stream.innerHTML = '<p class="log-empty">等待第一条评测信号……</p>'; return; }
  const wasNearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
  stream.innerHTML = logs.slice(-80).map((log) => {
    const time = new Date(log.at).toLocaleTimeString('zh-CN', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const mode = log.mode || 'system';
    return `<div class="log-line ${escapeHtml(log.level || 'info')} ${escapeHtml(mode)}"><span class="log-time">${time}</span><span class="log-source">${escapeHtml(log.source || 'SYSTEM')}</span><span class="log-phase">${escapeHtml(log.phase || 'pipeline')}</span><span class="log-message"><strong>${escapeHtml(log.text)}</strong>${log.detail ? `<small>${escapeHtml(log.detail)}</small>` : ''}</span><span class="log-mode">${escapeHtml(mode)}${Number.isFinite(log.durationMs) ? ` · ${log.durationMs}ms` : ''}</span></div>`;
  }).join('');
  if (wasNearBottom) stream.scrollTop = stream.scrollHeight;
}

async function loadRuntimeHealth() {
  const root = $('#runtime-health');
  try {
    const response = await fetch('/api/runtimes');
    const runtimes = await response.json();
    root.innerHTML = `<span>RUNTIME PROBE</span>${runtimes.map((runtime) => `<span class="runtime-chip ${runtime.installed ? 'installed' : ''} ${runtime.runtimeReady ? 'ready' : ''}" title="${escapeHtml(runtime.note)}">${escapeHtml(runtime.name)} · ${runtime.runtimeReady ? 'READY' : !runtime.installed ? '缺失' : !runtime.authenticated ? '未登录' : '未启用'}</span>`).join('')}`;
  } catch {
    root.innerHTML = '<span>RUNTIME PROBE</span><i>探测失败</i>';
  }
}

function animateCounters(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $$('[data-count]', root).forEach((element) => {
    const target = Number(element.dataset.count);
    const decimals = String(target).includes('.') ? 1 : 0;
    const startedAt = performance.now();
    const tick = (time) => {
      const progress = Math.min(1, (time - startedAt) / 650);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = (target * eased).toFixed(decimals);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function loadHistory() {
  try {
    const items = await (await fetch('/api/evaluations')).json();
    $('#history-count').textContent = items.length;
    $('#history-list').innerHTML = items.length ? items.map(item=>{ const tier = item.tier ? normalizeTier(item.tier) : null; return `<button class="history-item" data-evaluation-id="${item.id}"><header><span>${formatTime(item.createdAt)}</span><span>${item.progress}%</span></header><h3>${escapeHtml(item.name)}</h3><p>${tier?`最终锐评：<span class="history-tier">${escapeHtml(tier.label)}</span> · 实战 ${item.score} 分`:escapeHtml(item.status)}</p></button>`; }).join('') : '<p>还没有战绩。第一个被公开处刑的 Agent 会是谁？</p>';
  } catch { $('#history-list').innerHTML = '<p>历史记录暂时读取失败。</p>'; }
}

function showLanding() { if(state.eventSource)state.eventSource.close(); state.current=null; history.replaceState(null,'',location.pathname); $('#evaluation-view').classList.add('hidden'); $('#landing-view').classList.remove('hidden'); scrollTo({top:0,behavior:'smooth'}); }
function openHistory() { $('#history-drawer').classList.add('open'); $('#drawer-backdrop').classList.add('open'); $('#history-drawer').setAttribute('aria-hidden','false'); loadHistory(); }
function closeHistory() { $('#history-drawer').classList.remove('open'); $('#drawer-backdrop').classList.remove('open'); $('#history-drawer').setAttribute('aria-hidden','true'); }
function showError(text) { $('#form-error').textContent = text; }
function isTerminal(status) { return ['completed','failed','cancelled','interrupted'].includes(status); }
function normalizeTier(tier = {}) {
  if (tier.code === 'OVERKILL' || tier.code === 'FLOP' || tier.label === '大炮打蚊子' || tier.label === '拉完了') return { ...tier, code: 'FLOP', label: '拉', stamp: '拉' };
  if (tier.code === 'MID' || tier.label === '有点东西，但不多') return { ...tier, code: 'NPC', label: 'NPC', stamp: 'NPC' };
  return tier;
}
function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, char=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
function signed(value) { return `${value>=0?'+':''}${value} 分`; }
function formatTime(value) { return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)); }
