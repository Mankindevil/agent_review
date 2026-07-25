import {
  evaluationModeFromHealth,
  nextAvailableEditorId,
  recordActionCopy,
  recordActionFailure
} from './a2a-ui-helpers.js?v=20260725-a2a1';
import {
  canArchiveEvaluation,
  canStopEvaluation,
  participantActionOptions,
  resolveParticipantToken,
  restoreV2StartButton
} from './evaluation-actions.js?v=20260725-hardening1';
import {
  parseExampleMarkdown,
  skillExamplesFromCard
} from './example-import.js?v=20260725-examples1';

const state = { mode: 'demo', sourceType: 'direct', blackBoxEnabled: false, healthResolved: false, current: null, eventSource: null, resolvedCard: null, lastStage: null, completedRendered: null, stopping: false, verdictRevealToken: 0, openEvaluationToken: 0, historyLoadToken: 0, skillBundles: new Map(), participantTokens: new Map(), pendingEvaluationId: null, skillRequestToken: 0, activeWorkTimer: null, activeWorkKey: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const DEFAULT_REVIEW_PLAN = [
  { id:'gpt', name:'OpenAI 评审', model:'GPT-5' },
  { id:'claude', name:'Anthropic 评审', model:'Claude Sonnet' },
  { id:'doubao', name:'豆包评审', model:'Doubao Seed' },
  { id:'deepseek', name:'DeepSeek 评审', model:'DeepSeek' }
];
const DEFAULT_RUNTIME_PLAN = [
  { id:'claude-code', name:'Claude Code', model:'Claude Sonnet' },
  { id:'cursor', name:'Cursor Agent', model:'Auto' },
  { id:'doubao', name:'Doubao Agent', model:'Seed' }
];

const sampleCard = {
  name: '因子显微镜',
  description: '面向量化研究者的因子研究 Agent：调用授权行情与财务数据 Skills，完成时点对齐、清洗、中性化、IC/Rank IC、分组回测和稳定性解释，并记录数据口径与风险提示。',
  protocolVersion: '1.0',
  supportedInterfaces: [{ url: 'https://agent.example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain', 'application/pdf'],
  defaultOutputModes: ['application/json', 'text/markdown'],
  skills: [{
    id: 'factor-research', name: '因子研究',
    description: '按指定股票池、样本期与调仓频率构造因子，处理极值、缺失和行业市值暴露，输出 IC、分组收益、换手与稳健性结论。',
    tags: ['factor', 'point-in-time', 'IC', 'backtest', 'risk'],
    examples: ['在沪深 300 成分股内检验经营现金流收益率因子，使用月频调仓并报告 Rank IC 和五分组回测。']
  }]
};

const exampleCatalog = {
  factor: {
    card: { ...sampleCard, supportedInterfaces:[{url:'http://127.0.0.1:4181/a2a/v1',protocolBinding:'HTTP+JSON',protocolVersion:'1.0'}], version:'1.0.0' },
    cases: [{name:'现金流因子检验',prompt:'在沪深 300 成分股内检验经营现金流收益率因子。样本期 2019-01-01 至 2024-12-31，月频调仓。请报告期末沪深 300 收盘点位作为数据锚点，说明数据时点和清洗口径，输出 Rank IC、五分组回测、换手、最大回撤及风险提示。',dataQueries:[{id:'csi300-close-anchor',label:'沪深 300 期末行情',method:'get_index_daily',params:{symbol:['000300.SH'],start_date:'20241220',end_date:'20241231',fields:[]},requiredFields:['date','symbol','close'],facts:[{label:'沪深 300 期末收盘',field:'close',where:'last',aliases:['沪深 300 收盘','沪深300收盘','基准收盘','期末收盘'],tolerance:0.01,required:true}]}]}]
  },
  backtest: {
    card: { name:'策略验钞机', description:'把自然语言策略转成可审计回测：锁定股票池、样本区间、信号与成交时点，调用行情和回测 Skills，计入手续费、滑点与不可交易约束，输出收益、回撤、换手和风险暴露。', version:'1.2.0', supportedInterfaces:[{url:'http://127.0.0.1:4182/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0'}], capabilities:{streaming:false,pushNotifications:false}, defaultInputModes:['text/plain'],defaultOutputModes:['text/markdown'],skills:[{id:'strategy-backtest',name:'策略回测',description:'解析自然语言策略并执行防未来函数的基准回测与敏感性检验。',tags:['backtest','transaction-cost','benchmark','risk'],examples:['回测沪深 300 月度动量策略，计入双边成本并和指数比较。']}] },
    cases: [
      {name:'月度动量回测',prompt:'回测沪深 300 股票池内 12-1 月动量策略，2018-01-01 至 2024-12-31，月末产生信号、下一交易日开盘成交。双边手续费 8bp、滑点 5bp。请对比沪深 300，报告年化收益、最大回撤、夏普、换手和风险暴露。'},
      {name:'防泄漏审计',prompt:'请先审计这条策略是否存在未来函数、幸存者偏差或财务数据发布日期错配；数据不足时不要编造收益，列出缺口和可复现配置。'}
    ]
  },
  portfolio: {
    card: { name:'组合风控台',description:'面向组合经理的持仓分析 Agent：调用持仓、行情、行业与风险 Skills，按时点计算集中度、风格和行业暴露，执行压力测试并生成可解释的再平衡研究方案。',version:'0.9.0',url:'http://127.0.0.1:4183/a2a',protocolVersion:'0.3',preferredTransport:'JSONRPC',capabilities:{streaming:false,pushNotifications:true},defaultInputModes:['text/plain'],defaultOutputModes:['text/markdown'],skills:[{id:'portfolio-risk',name:'组合风险分析',description:'基于指定持仓快照完成集中度、风险暴露、情景压力测试和再平衡约束检查。',tags:['portfolio','risk-exposure','stress-test','rebalance','audit'],examples:['分析组合行业集中度，并模拟科技板块下跌 10% 的冲击。']}] },
    cases: [{name:'组合压力测试',prompt:'截至 2026-06-30，组合中科技 42%、金融 18%、消费 15%、医药 10%、现金 15%。请分析集中度与风险暴露，模拟科技板块下跌 10% 的一阶冲击，并在单行业不超过 30%、换手不超过 15% 的约束下给出研究性再平衡方案。'}]
  }
};

init();

async function init() {
  requestAnimationFrame(() => document.body.classList.add('ready'));
  const initialCase = exampleCatalog.factor.cases[0];
  addCase(initialCase.name, initialCase.prompt, initialCase.dataQueries);
  addV2Example();
  bindEvents();
  loadEvaluationDefaults();
  loadDataSourceHealth();
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
  $('#add-v2-example').addEventListener('click', () => addV2Example());
  $('#fill-examples-from-card').addEventListener('click', fillExamplesFromAgentCard);
  $('#apply-example-paste').addEventListener('click', applyExamplePaste);
  $('#copy-participant-token').addEventListener('click', copyParticipantToken);
  $('#dismiss-participant-token').addEventListener('click', dismissParticipantTokenReceipt);
  $('#resume-evaluation').addEventListener('click', resumeEvaluation);
  $$('[data-example]').forEach((button) => button.addEventListener('click', () => loadSample(button.dataset.example)));
  $('#resolve-agent').addEventListener('click', resolveRemoteCard);
  $('#agent-url').addEventListener('input', () => {
    state.resolvedCard = null;
    $('#resolved-card').classList.add('hidden');
  });
  $('#start-evaluation').addEventListener('click', submitEvaluation);
  $('#stop-evaluation').addEventListener('click', stopEvaluation);
  $('#evaluation-seed').addEventListener('input', (event) => { event.currentTarget.dataset.edited = 'true'; });
  $('#agent-file').addEventListener('change', (event) => readFile(event.target.files[0]));
  const drop = $('#drop-zone');
  ['dragenter','dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('dragging'); }));
  ['dragleave','drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('dragging'); }));
  drop.addEventListener('drop', (event) => readFile(event.dataTransfer.files[0]));
  document.addEventListener('click', (event) => {
    const a2aAction = event.target.closest('[data-a2a-action]');
    if (a2aAction) { handleA2AEditorAction(a2aAction); return; }
    const retry = event.target.closest('[data-retry-type]');
    if (retry) { retryStep(retry); return; }
    const deleteControl = event.target.closest('[data-delete-evaluation]');
    if (deleteControl) { deleteEvaluation(deleteControl); return; }
    const skillDetail = event.target.closest('[data-skill-detail]');
    if (skillDetail) { toggleSkillDetail(skillDetail); return; }
    const skillFile = event.target.closest('[data-skill-file]');
    if (skillFile) { selectSkillFile(skillFile); return; }
    const copySkill = event.target.closest('[data-copy-skill]');
    if (copySkill) { copySkillFile(copySkill); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'home') showLanding();
    if (action === 'history') openHistory();
    if (action === 'close-history') closeHistory();
    const historyItem = event.target.closest('[data-evaluation-id]');
    if (historyItem) { closeHistory(); openEvaluation(historyItem.dataset.evaluationId); }
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('.a2a-part-type')) updatePartEditor(event.target.closest('[data-a2a-part]'));
    if (event.target.matches('.a2a-criterion-type')) updateCriterionEditor(event.target.closest('[data-a2a-criterion]'));
  });
  window.addEventListener('hashchange', () => {
    const match = location.hash.match(/^#\/evaluation\/(.+)$/);
    if (match && match[1] !== state.current?.id) openEvaluation(match[1]);
  });
}

function addCase(name, prompt, dataQueries) {
  if ($$('.case-row').length >= 5) return;
  const fragment = $('#case-template').content.cloneNode(true);
  $('.case-name', fragment).value = name;
  $('.case-prompt', fragment).value = prompt;
  const row = $('.case-row', fragment);
  if (dataQueries?.length) {
    row.dataset.dataQueries = JSON.stringify(dataQueries);
    $('.case-data-tag', fragment).classList.remove('hidden');
  }
  $('.remove-case', fragment).addEventListener('click', (event) => { event.currentTarget.closest('.case-row').remove(); updateCaseNumbers(); });
  $('#case-list').append(fragment);
  updateCaseNumbers();
}

function updateCaseNumbers() { $$('.case-row').forEach((row, index) => $('.case-index', row).textContent = String(index + 1).padStart(2, '0')); }

function addV2Example(draft = null) {
  const root = $('#v2-example-list');
  const nextId = draft?.id || nextAvailableEditorId(
    $$('.a2a-example-id', root).map((input) => input.value.trim()),
    'example'
  );
  const exampleName = draft?.name || `公开研究任务 ${root.children.length + 1}`;
  const example = document.createElement('article');
  example.className = 'a2a-custody-rail a2a-example';
  example.dataset.a2aExample = '';
  example.innerHTML = `
    <header class="a2a-node-head">
      <span class="a2a-rail-index">E01</span>
      <div><small>EXAMPLE / PUBLIC CONTRACT</small><b>公开使用示例</b></div>
      <button type="button" data-a2a-action="remove-example" aria-label="删除 Example">×</button>
    </header>
    <div class="a2a-node-fields a2a-example-fields">
      <label>Example ID<input class="a2a-example-id" value="${escapeAttr(nextId)}" autocomplete="off"></label>
      <label>Example 名称<input class="a2a-example-name" value="${escapeAttr(exampleName)}" autocomplete="off"></label>
      <label class="a2a-field-wide">可选约束（每行一项）<textarea class="a2a-example-constraints" placeholder="例如：不得编造缺失数据">${escapeHtml(Array.isArray(draft?.constraints) ? draft.constraints.join('\n') : '')}</textarea></label>
    </div>
    <div class="a2a-turn-list"></div>
    <button class="text-button a2a-nested-add" type="button" data-a2a-action="add-turn">＋ 添加 Turn</button>`;
  root.append(example);
  const turns = Array.isArray(draft?.turns) && draft.turns.length ? draft.turns : [null];
  for (const turnDraft of turns) addV2Turn(example, turnDraft);
  updateA2AEditorNumbers();
}

function addV2Turn(example, draft = null) {
  const list = $('.a2a-turn-list', example);
  const turn = document.createElement('section');
  turn.className = 'a2a-turn';
  turn.dataset.a2aTurn = '';
  turn.innerHTML = `
    <header class="a2a-node-head">
      <span class="a2a-rail-index">T01</span>
      <div><small>TURN / ORDERED REQUEST</small><b>对话轮次</b></div>
      <button type="button" data-a2a-action="remove-turn" aria-label="删除 Turn">×</button>
    </header>
    <div class="a2a-node-fields">
      <label class="a2a-field-wide">可选预期交付物<input class="a2a-expected-deliverable" placeholder="例如：结构化研究结论与风险提示" value="${escapeAttr(draft?.expectedDeliverable || '')}"></label>
    </div>
    <div class="a2a-subhead"><span>PARTS / 输入组成</span><button type="button" data-a2a-action="add-part">＋ Part</button></div>
    <div class="a2a-part-list"></div>
    <div class="a2a-subhead"><span>CRITERIA / 可选验收</span><button type="button" data-a2a-action="add-criterion">＋ Criterion</button></div>
    <div class="a2a-criterion-list"></div>`;
  list.append(turn);
  const parts = Array.isArray(draft?.parts) && draft.parts.length ? draft.parts : [null];
  for (const partDraft of parts) addV2Part(turn, partDraft);
  for (const criterionDraft of Array.isArray(draft?.criteria) ? draft.criteria : []) {
    addV2Criterion(turn, criterionDraft);
  }
  updateA2AEditorNumbers();
}

function addV2Part(turn, draft = null) {
  const list = $('.a2a-part-list', turn);
  const part = document.createElement('div');
  part.className = 'a2a-part';
  part.dataset.a2aPart = '';
  const type = draft?.type || 'text';
  part.innerHTML = `
    <span class="a2a-rail-index">P01</span>
    <label>Part 类型<select class="a2a-part-type">
      <option value="text">text</option>
      <option value="data">data</option>
      <option value="raw">raw</option>
      <option value="url">url</option>
    </select></label>
    <label class="a2a-part-value-field">文本<textarea class="a2a-part-value" placeholder="输入发送给 Agent 的文本">${escapeHtml(draft?.text || '')}</textarea></label>
    <label>可选 media type<input class="a2a-part-media-type" placeholder="text/plain" value="${escapeAttr(draft?.mediaType || '')}"></label>
    <label>可选 filename<input class="a2a-part-filename" placeholder="brief.txt" value="${escapeAttr(draft?.filename || '')}"></label>
    <button type="button" data-a2a-action="remove-part" aria-label="删除 Part">×</button>`;
  list.append(part);
  $('.a2a-part-type', part).value = type;
  updatePartEditor(part);
  updateA2AEditorNumbers();
}

function addV2Criterion(turn, draft = null) {
  const list = $('.a2a-criterion-list', turn);
  const nextId = draft?.id || nextAvailableEditorId(
    $$('.a2a-criterion-id', list).map((input) => input.value.trim()),
    'criterion'
  );
  const criterion = document.createElement('div');
  criterion.className = 'a2a-criterion';
  criterion.dataset.a2aCriterion = '';
  const expectedText = Array.isArray(draft?.expected)
    ? draft.expected.join('\n')
    : (draft?.expected == null ? '' : String(draft.expected));
  criterion.innerHTML = `
    <span class="a2a-rail-index">C01</span>
    <label>Criterion ID<input class="a2a-criterion-id" value="${escapeAttr(nextId)}"></label>
    <label>类型<select class="a2a-criterion-type">
      <option value="contains">contains</option>
      <option value="exact">exact</option>
      <option value="json-schema">json-schema</option>
      <option value="numeric">numeric</option>
      <option value="model">model</option>
    </select></label>
    <label class="a2a-field-wide">说明<input class="a2a-criterion-description" value="${escapeAttr(draft?.description || '验证公开交付物')}"></label>
    <label class="a2a-criterion-expected-field a2a-field-wide">预期值<textarea class="a2a-criterion-expected" placeholder="contains 每行一项；其余类型按字段提示">${escapeHtml(expectedText)}</textarea></label>
    <label class="a2a-criterion-path-field hidden">JSON path<input class="a2a-criterion-path" placeholder="$.score"></label>
    <label class="a2a-criterion-tolerance-field hidden">容差<input class="a2a-criterion-tolerance" type="number" min="0" step="any" value="0"></label>
    <label class="a2a-check"><input class="a2a-criterion-required" type="checkbox"${draft?.required === false ? '' : ' checked'}> 必须满足</label>
    <label class="a2a-check a2a-criterion-case-field"><input class="a2a-criterion-case-sensitive" type="checkbox"${draft?.caseSensitive ? ' checked' : ''}> 区分大小写</label>
    <button type="button" data-a2a-action="remove-criterion" aria-label="删除 Criterion">×</button>`;
  list.append(criterion);
  if (draft?.type) $('.a2a-criterion-type', criterion).value = draft.type;
  updateCriterionEditor(criterion);
  updateA2AEditorNumbers();
}

function replaceV2ExamplesWithDrafts(drafts, statusMessage) {
  const root = $('#v2-example-list');
  root.replaceChildren();
  for (const draft of drafts) addV2Example(draft);
  if (!root.children.length) addV2Example();
  setExampleImportStatus(statusMessage, 'ok');
}

function currentAgentCardForImport() {
  if (state.sourceType !== 'direct' && state.resolvedCard) return state.resolvedCard;
  try {
    return JSON.parse($('#agent-card').value);
  } catch {
    return null;
  }
}

function fillExamplesFromAgentCard() {
  const card = currentAgentCardForImport();
  if (!card) {
    setExampleImportStatus('请先提供合法的 Agent Card JSON，或完成远程 Card 解析。', 'error');
    return;
  }
  const drafts = skillExamplesFromCard(card);
  if (!drafts.length) {
    setExampleImportStatus('当前 Agent Card 的 skills[].examples 为空，没有可填充示例。', 'error');
    return;
  }
  replaceV2ExamplesWithDrafts(
    drafts,
    `已从 Agent Card 填充 ${drafts.length} 个示例；可再粘贴完整说明补充验收要点。`
  );
}

function applyExamplePaste() {
  const { drafts, errors } = parseExampleMarkdown($('#example-paste').value);
  if (!drafts.length) {
    setExampleImportStatus(errors.join('；') || '未能解析出示例。', 'error');
    return;
  }
  replaceV2ExamplesWithDrafts(
    drafts,
    errors.length
      ? `已填充 ${drafts.length} 个示例；部分段落未解析：${errors.join('；')}`
      : `已从粘贴文本填充 ${drafts.length} 个示例（含输入与预期要点）。`
  );
}

function setExampleImportStatus(message, tone = '') {
  const status = $('#example-import-status');
  status.textContent = message || '';
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

function handleA2AEditorAction(control) {
  const action = control.dataset.a2aAction;
  const example = control.closest('[data-a2a-example]');
  const turn = control.closest('[data-a2a-turn]');
  if (action === 'add-turn') addV2Turn(example);
  if (action === 'add-part') addV2Part(turn);
  if (action === 'add-criterion') addV2Criterion(turn);
  if (action === 'remove-example' && $$('#v2-example-list > [data-a2a-example]').length > 1) example.remove();
  if (action === 'remove-turn' && $$('[data-a2a-turn]', example).length > 1) turn.remove();
  if (action === 'remove-part' && $$('[data-a2a-part]', turn).length > 1) control.closest('[data-a2a-part]').remove();
  if (action === 'remove-criterion') control.closest('[data-a2a-criterion]').remove();
  updateA2AEditorNumbers();
}

function updateA2AEditorNumbers() {
  $$('#v2-example-list > [data-a2a-example]').forEach((example, exampleIndex) => {
    $('.a2a-node-head > .a2a-rail-index', example).textContent = `E${String(exampleIndex + 1).padStart(2, '0')}`;
    $$('[data-a2a-turn]', example).forEach((turn, turnIndex) => {
      $('.a2a-node-head > .a2a-rail-index', turn).textContent = `T${String(turnIndex + 1).padStart(2, '0')}`;
      $$('[data-a2a-part]', turn).forEach((part, partIndex) => {
        $('.a2a-rail-index', part).textContent = `P${String(partIndex + 1).padStart(2, '0')}`;
      });
      $$('[data-a2a-criterion]', turn).forEach((criterion, criterionIndex) => {
        $('.a2a-rail-index', criterion).textContent = `C${String(criterionIndex + 1).padStart(2, '0')}`;
      });
    });
  });
}

function updatePartEditor(part) {
  const type = $('.a2a-part-type', part).value;
  const label = $('.a2a-part-value-field', part);
  const input = $('.a2a-part-value', part);
  const copy = {
    text: ['文本', '输入发送给 Agent 的文本'],
    data: ['JSON data', '{"symbol":"000300.SH"}'],
    raw: ['Base64 raw', 'SGVsbG8='],
    url: ['HTTPS URL', 'https://example.com/research.pdf']
  }[type];
  label.childNodes[0].textContent = copy[0];
  input.placeholder = copy[1];
  $('.a2a-part-media-type', part).placeholder = type === 'raw' ? '必填，例如 application/pdf' : '可选';
}

function updateCriterionEditor(criterion) {
  const type = $('.a2a-criterion-type', criterion).value;
  $('.a2a-criterion-expected-field', criterion).classList.toggle('hidden', type === 'model');
  $('.a2a-criterion-path-field', criterion).classList.toggle('hidden', type !== 'numeric');
  $('.a2a-criterion-tolerance-field', criterion).classList.toggle('hidden', type !== 'numeric');
  $('.a2a-criterion-case-field', criterion).classList.toggle('hidden', type !== 'contains');
  const expected = $('.a2a-criterion-expected', criterion);
  expected.placeholder = type === 'contains'
    ? '每行一个必须包含的文本'
    : type === 'json-schema'
      ? '{"type":"object","required":["answer"]}'
      : type === 'numeric'
        ? '预期数值'
        : '预期完整文本';
}

function collectAgentExamples() {
  return $$('#v2-example-list > [data-a2a-example]').map((example, exampleIndex) => {
    const id = $('.a2a-example-id', example).value.trim();
    const name = $('.a2a-example-name', example).value.trim();
    if (!id || !name) throw new Error(`Example ${exampleIndex + 1} 需要 ID 和名称。`);
    const constraints = linesOf($('.a2a-example-constraints', example).value);
    const turns = $$('[data-a2a-turn]', example).map((turn, turnIndex) => {
      const parts = $$('[data-a2a-part]', turn).map((part, partIndex) =>
        collectA2APart(part, exampleIndex, turnIndex, partIndex));
      const acceptanceCriteria = $$('[data-a2a-criterion]', turn).map((criterion, criterionIndex) =>
        collectA2ACriterion(criterion, exampleIndex, turnIndex, criterionIndex));
      const expectedDeliverable = $('.a2a-expected-deliverable', turn).value.trim();
      return {
        input: { parts },
        ...(expectedDeliverable ? { expectedDeliverable } : {}),
        ...(acceptanceCriteria.length ? { acceptanceCriteria } : {})
      };
    });
    return { id, name, turns, ...(constraints.length ? { constraints } : {}) };
  });
}

function collectA2APart(part, exampleIndex, turnIndex, partIndex) {
  const path = `Example ${exampleIndex + 1} / Turn ${turnIndex + 1} / Part ${partIndex + 1}`;
  const type = $('.a2a-part-type', part).value;
  const value = $('.a2a-part-value', part).value.trim();
  if (!value) throw new Error(`${path} 不能为空。`);
  const result = { type };
  if (type === 'text') result.text = value;
  if (type === 'data') result.data = parseEditorJson(value, `${path} 的 data`);
  if (type === 'raw') result.raw = value;
  if (type === 'url') result.url = value;
  const mediaType = $('.a2a-part-media-type', part).value.trim();
  const filename = $('.a2a-part-filename', part).value.trim();
  if (type === 'raw' && !mediaType) throw new Error(`${path} 的 raw Part 需要 media type。`);
  if (mediaType) result.mediaType = mediaType;
  if (filename) result.filename = filename;
  return result;
}

function collectA2ACriterion(criterion, exampleIndex, turnIndex, criterionIndex) {
  const path = `Example ${exampleIndex + 1} / Turn ${turnIndex + 1} / Criterion ${criterionIndex + 1}`;
  const type = $('.a2a-criterion-type', criterion).value;
  const id = $('.a2a-criterion-id', criterion).value.trim();
  const description = $('.a2a-criterion-description', criterion).value.trim();
  if (!id || !description) throw new Error(`${path} 需要 ID 和说明。`);
  const result = { id, type, description, required: $('.a2a-criterion-required', criterion).checked };
  const expected = $('.a2a-criterion-expected', criterion).value.trim();
  if (type === 'contains') {
    result.expected = linesOf(expected);
    if (!result.expected.length) throw new Error(`${path} 至少需要一个预期文本。`);
    if ($('.a2a-criterion-case-sensitive', criterion).checked) result.caseSensitive = true;
  }
  if (type === 'exact') {
    if (!expected) throw new Error(`${path} 需要预期文本。`);
    result.expected = expected;
  }
  if (type === 'json-schema') result.schema = parseEditorJson(expected, `${path} 的 JSON Schema`);
  if (type === 'numeric') {
    const numeric = Number(expected);
    const tolerance = Number($('.a2a-criterion-tolerance', criterion).value);
    const numericPath = $('.a2a-criterion-path', criterion).value.trim();
    if (!numericPath || !Number.isFinite(numeric) || !Number.isFinite(tolerance) || tolerance < 0) {
      throw new Error(`${path} 需要 path、有限预期数值和非负容差。`);
    }
    result.path = numericPath;
    result.expected = numeric;
    result.tolerance = tolerance;
  }
  return result;
}

function linesOf(value) {
  return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseEditorJson(value, label) {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} 不是合法 JSON。`); }
}

function loadSample(id = 'contract') {
  const example = exampleCatalog[id];
  setSourceType('direct');
  $('#agent-card').value = JSON.stringify(example.card, null, 2);
  $('#file-name').textContent = `已载入：${example.card.name}.a2a.json`;
  $('#case-list').innerHTML = '';
  example.cases.forEach((testCase) => addCase(testCase.name, testCase.prompt, testCase.dataQueries));
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
  if (state.blackBoxEnabled) return submitV2Evaluation(agentCard);
  const cases = $$('.case-row').map((row, index) => ({
    name: $('.case-name', row).value.trim() || `案例 ${index + 1}`,
    prompt: $('.case-prompt', row).value.trim(),
    ...(row.dataset.dataQueries ? { dataQueries: JSON.parse(row.dataset.dataQueries) } : {})
  })).filter((item) => item.prompt);
  if (!cases.length) return showError('至少填写一个测试 prompt。');
  const seedValue = $('#evaluation-seed').value.trim();
  const seed = seedValue === '' ? undefined : Number(seedValue);
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_646)) return showError('Seed 必须是 0–2147483646 的整数。');
  const button = $('#start-evaluation');
  button.disabled = true; $('span', button).textContent = '正在封舱';
  try {
    const response = await fetch('/api/evaluations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCard, cases, mode: state.mode, seed }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '创建评测失败');
    await loadHistory();
    openEvaluation(payload.id);
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; $('span', button).textContent = '送进评测舱'; }
}

async function submitV2Evaluation(agentCard) {
  let agentExamples;
  try { agentExamples = collectAgentExamples(); }
  catch (error) { return showError(error.message); }
  const authorizationInput = $('#agent-authorization');
  const agentAuthorization = authorizationInput.value.trim();
  const request = {
    schemaVersion: 2, agentCard, agentExamples,
    ...(agentAuthorization ? { agentAuthorization } : {})
  };
  const requestBody = JSON.stringify(request);
  $('#agent-authorization').value = '';
  const button = $('#start-evaluation');
  button.disabled = true;
  $('span', button).textContent = '正在建立证据链';
  let created = false;
  try {
    const response = await fetch('/api/evaluations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '创建 V2 评测失败');
    if (!payload.participantAccessToken) throw new Error('创建响应缺少 participant access token');
    created = true;
    state.participantTokens.set(payload.id, payload.participantAccessToken);
    state.pendingEvaluationId = payload.id;
    $('#participant-token-output').textContent = payload.participantAccessToken;
    $('#participant-token-receipt').classList.remove('hidden');
    $('span', button).textContent = '评测已创建 · 先保存 token';
    await loadHistory();
  } catch (error) {
    showError(error.message);
  } finally {
    if (!created) {
      button.disabled = false;
      $('span', button).textContent = '启动 A2A 证据评测';
    }
  }
}

async function copyParticipantToken() {
  const id = state.pendingEvaluationId;
  const token = id ? state.participantTokens.get(id) : undefined;
  const button = $('#copy-participant-token');
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败，请手动选择';
  }
}

function dismissParticipantTokenReceipt() {
  const id = state.pendingEvaluationId;
  $('#participant-token-output').textContent = '';
  $('#participant-token-receipt').classList.add('hidden');
  $('#copy-participant-token').textContent = '复制 token';
  state.pendingEvaluationId = null;
  restoreV2StartButton($('#start-evaluation'));
  if (id) openEvaluation(id);
}

function participantTokenForAction(evaluationId) {
  const input = $('#resume-participant-token');
  const remembered = state.participantTokens.get(evaluationId);
  const manualValue = remembered
    ? ''
    : input.value.trim() || globalThis.prompt?.(
        '请输入创建评测时保存的 Participant access token'
      ) || '';
  const token = resolveParticipantToken(
    evaluationId,
    state.participantTokens,
    manualValue
  );
  input.value = '';
  return token;
}

async function openEvaluation(id) {
  const token = ++state.openEvaluationToken;
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  try {
    const response = await fetch(`/api/evaluations/${id}`);
    if (!response.ok) throw new Error('评测不存在');
    const item = await response.json();
    if (token !== state.openEvaluationToken) return;
    showEvaluation(item);
    if (shouldSubscribe(item)) subscribe(id);
  } catch (error) {
    if (token !== state.openEvaluationToken) return;
    showError(error.message);
    showLanding();
  }
}

function subscribe(id) {
  const source = new EventSource(`/api/evaluations/${id}/events`);
  state.eventSource = source;
  source.onmessage = (event) => {
    if (state.current?.id !== id) return;
    const item = JSON.parse(event.data);
    showEvaluation(item);
    if (!shouldSubscribe(item)) {
      source.close();
      if (state.eventSource === source) state.eventSource = null;
      loadHistory();
    }
  };
}

async function stopEvaluation() {
  const item = state.current;
  if (!canStopEvaluation(item) || state.stopping) return;
  const button = $('#stop-evaluation');
  let requestOptions = { method: 'POST' };
  try {
    if (item.schemaVersion === 2) {
      requestOptions = participantActionOptions(
        'POST',
        participantTokenForAction(item.id)
      );
    }
  } catch (error) {
    $('span', button).textContent = error.message;
    setTimeout(() => {
      if (canStopEvaluation(state.current)) {
        $('span', button).textContent = '停止本次评测';
      }
    }, 2200);
    return;
  }
  state.stopping = true;
  button.disabled = true;
  $('span', button).textContent = '正在停止';
  try {
    const response = await fetch(
      `/api/evaluations/${item.id}/cancel`,
      requestOptions
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '停止评测失败');
    state.eventSource?.close();
    showEvaluation(payload);
    loadHistory();
  } catch (error) {
    $('span', button).textContent = error.message;
    setTimeout(() => {
      if (canStopEvaluation(state.current)) {
        $('span', button).textContent = '停止本次评测';
      }
    }, 2200);
  } finally {
    state.stopping = false;
    button.disabled = false;
  }
}

async function retryStep(button) {
  const item = state.current;
  if (!item || item.schemaVersion === 2 || !isTerminal(item.status) || button.disabled) return;
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
  const stage = stageOf(item);
  const status = statusOf(item);
  const progress = progressOf(item);
  const isV2 = item.schemaVersion === 2;
  const changedStage = state.lastStage !== stage;
  state.current = item;
  state.lastStage = stage;
  if (location.hash !== `#/evaluation/${item.id}`) history.replaceState(null, '', `#/evaluation/${item.id}`);
  $('#landing-view').classList.add('hidden'); $('#evaluation-view').classList.remove('hidden');
  $('#run-id').textContent = `RUN / ${item.id.toUpperCase()}`;
  $('#agent-name').textContent = isV2 ? 'A2A 证据链评测' : item.agentCard.name;
  $('#agent-description').textContent = isV2
    ? `公开黑盒能力基础 · ${item.archivedAt ? '已归档，证据仍可查阅' : '仅展示可公开投影'}`
    : item.agentCard.description;
  const modeLabel = isV2 ? 'V2 / BLACK-BOX' : item.overallMode === 'live' ? 'LIVE / 全链路真实' : item.mode === 'live' ? 'MIXED / Agent 实调' : 'DEMO / 演示模拟';
  $('#run-mode').textContent = isV2 ? modeLabel : `${modeLabel} · SEED ${item.seed ?? 'LEGACY'}`;
  $('#current-stage').textContent = stage || status || '等待评测舱';
  $('#latest-log').textContent = isV2
    ? latestV2LogLine(item)
    : item.logs?.at(-1)?.text || '等待评测信号';
  $('#progress-number').textContent = progress;
  $('#pulse-progress').style.height = `${progress}%`;
  $('#pulse-dot').style.top = `calc(${Math.min(progress, 96)}% - 2px)`;
  $('#live-deck').classList.toggle('running', ['running','retrying'].includes(status));
  const stopButton = $('#stop-evaluation');
  stopButton.classList.toggle('hidden', !canStopEvaluation(item));
  stopButton.disabled = state.stopping;
  if (!state.stopping) $('span', stopButton).textContent = '停止本次评测';
  if (changedStage) {
    $('.stage-copy').classList.remove('flash');
    requestAnimationFrame(() => $('.stage-copy').classList.add('flash'));
  }
  $('.stage-list').classList.toggle('hidden', isV2);
  $('.telemetry-panel').classList.remove('hidden');
  $$('.stage-list li').forEach((li) => li.classList.toggle('done', progress >= Number(li.dataset.threshold)));
  renderLogs(isV2 ? (item.runLog || []) : (item.logs || []));
  syncActiveWorkTimer(item);
  renderResumePanel(item);
  const revealingVerdict = renderResult(item);
  if (changedEvaluation && !revealingVerdict) scrollTo({ top: 0, behavior: 'smooth' });
}

function renderResult(item) {
  if (item.schemaVersion === 2) return renderV2Result(item);
  const root = $('#result-content');
  if (item.status !== 'completed') {
    state.verdictRevealToken += 1;
    state.completedRendered = null;
    root.classList.remove('reveal');
    root.classList.remove('verdict-pending');
    root.classList.add('streaming');
    root.innerHTML = renderPartialResults(item);
    return false;
  }
  if (state.completedRendered === item.id) return false;
  state.completedRendered = item.id;
  root.classList.remove('streaming');
  root.classList.remove('reveal');
  root.classList.add('verdict-pending');
  const complexity = item.complexity;
  const tier = normalizeTier(item.roast.tier);
  const sealText = tier.stamp || tier.label;
  const tierCode = String(tier.code || 'NPC').toLowerCase();
  root.innerHTML = `
    <section class="verdict-hero" id="final-verdict">
      <div class="verdict-seal verdict-seal--${escapeHtml(tierCode)}" role="img" aria-label="最终评级：${escapeHtml(tier.label)}">
        <div class="verdict-seal__plate">
          <span class="verdict-seal__eyebrow">AGENT RANK</span>
          <strong data-length="${sealText.length}">${escapeHtml(sealText)}</strong>
          <span class="verdict-seal__caption">锐评局 · 终审</span>
        </div>
        <i class="verdict-seal__impact" aria-hidden="true"></i>
      </div>
      <div class="verdict-copy"><small>FINAL VERDICT / ${escapeHtml(tier.label)}</small><h3>${renderHeadline(item.roast.headline)}</h3><p>提交 Agent 实战均分 <b>${item.averages.submitted}</b>，对 Claude Code ${signed(item.roast.deltaClaude)}，对豆包 ${signed(item.roast.deltaDoubao)}。</p>${renderRecalculationNote(item)}</div>
    </section>
    <div class="score-triad">
      ${scoreCard('01 / 必要性', complexity.score, complexity.verdict, complexity.reason, complexity.score >= 60)}
      ${scoreCard('02 / 金融专业度', item.professional.score, '四模型独立审稿', `${item.professional.reviews.filter(r=>r.score>0).length} 位评审从五个金融硬指标独立打分。`, false)}
      ${scoreCard('03 / 实战力', item.averages.submitted, '提交 Agent 同题均分', `Claude ${item.averages['claude-code']} · Cursor ${item.averages.cursor} · 豆包 ${item.averages.doubao}`, true)}
    </div>
    ${renderComplexity(complexity)}
    ${renderReviews(item.professional.reviews, item)}
    ${renderBuilds(item.builds, item)}
    ${renderBattle(item.benchmark, item)}
  `;
  revealVerdictInView(root, item.id);
  return true;
}

function renderV2Result(item) {
  const root = $('#result-content');
  const qualification = item.qualification || {};
  const objective = item.objectiveCapability || {};
  const absolute = item.resultV2?.absolute || {};
  const testSummary = absolute.testSummary || {};
  const variants = testSummary.variantCounts || {};
  const modelSummary = absolute.modelReviewSummary || {};
  const status = statusOf(item);
  const evidenceCount = item.evidenceManifest?.items?.length || 0;
  const objectiveReady = Number.isFinite(objective.score);
  const humanOpen = item.governance?.phase === 'human_open';
  const waitingModel = status === 'completed' &&
    qualification.status === 'eligible' &&
    !humanOpen;
  const ineligible = status === 'completed' && qualification.status === 'ineligible';
  const hasPhase2Summary = Number.isFinite(testSummary.totalTests);
  root.classList.remove('streaming', 'reveal', 'verdict-pending');
  root.innerHTML = `
    <section class="v2-docket-result">
      <header>
        <div><small>CHAIN OF CUSTODY / PUBLIC PROJECTION</small><h3>${item.archivedAt ? '证据卷宗已归档' : '黑盒证据卷宗'}</h3></div>
        <span>${escapeHtml(status || 'queued')}</span>
      </header>
      <dl class="v2-docket-grid">
        <div><dt>Evaluation ID</dt><dd>${escapeHtml(item.id)}</dd></div>
        <div><dt>Qualification</dt><dd>${escapeHtml(qualification.status || 'pending')}</dd><small>${escapeHtml(qualification.reason || '等待可调用性证明')}</small></div>
        <div><dt>Execution</dt><dd>${escapeHtml(stageOf(item) || status || 'queued')}</dd><small>${progressOf(item)}% committed</small></div>
        <div><dt>Evidence manifest</dt><dd>${evidenceCount}</dd><small>仅公开承诺与脱敏摘要</small></div>
        ${objectiveReady ? `<div><dt>Objective capability</dt><dd>${escapeHtml(objective.score)}</dd><small>coverage ${escapeHtml(objective.coverage ?? '—')} · ${objective.provisional ? 'provisional' : 'committed'}</small></div>` : ''}
      </dl>
      ${hasPhase2Summary ? `
        <div class="v2-review-relay" aria-label="V2 评审交接状态">
          <article>
            <small>01 / DYNAMIC MATRIX</small>
            <strong>${escapeHtml(testSummary.completedCells ?? 0)} / ${escapeHtml(testSummary.plannedCells ?? 0)}</strong>
            <p>原始 ${escapeHtml(variants.original ?? 0)} · 等价 ${escapeHtml(variants.equivalent ?? 0)} · 边界 ${escapeHtml(variants.boundary ?? 0)} · 多轮 ${escapeHtml(variants.multiTurn ?? 0)} · 协议恢复 ${escapeHtml(variants.protocolRecovery ?? 0)}</p>
          </article>
          <article>
            <small>02 / MODEL PANEL</small>
            <strong>${escapeHtml(modelSummary.primarySeatsLocked ?? 0)} / 4</strong>
            <p>四席独立评审已锁定 · 仲裁 ${escapeHtml(modelSummary.arbitrationStatus || 'pending')}</p>
          </article>
          <article class="${humanOpen ? 'is-open' : ''}">
            <small>03 / HUMAN REVIEW</small>
            <strong>${humanOpen ? 'OPEN' : 'WAIT'}</strong>
            <p>${humanOpen ? '非盲人工复核已开放：先看模型意见，再独立打分并说明调整。' : '模型结果锁定后开放人工复核。'}</p>
          </article>
        </div>` : ''}
      ${waitingModel ? '<p class="v2-state-notice waiting">动态测试已提交，等待四席模型评审锁定。</p>' : ''}
      ${humanOpen ? '<p class="v2-state-notice human-open">模型初评已锁定 · 等待非盲人工复核；当前分数仍为 provisional，不产生夯拉评级。</p>' : ''}
      ${ineligible ? `<p class="v2-state-notice ineligible">不具备正式评测资格 · ${escapeHtml(qualification.reason || 'endpoint-not-callable')}</p>` : ''}
      ${['credentials-required','interrupted'].includes(status) ? '<p class="v2-state-notice paused">证据采集已暂停，请使用 participant access token 恢复。</p>' : ''}
      ${status === 'cancelled' ? '<p class="v2-state-notice cancelled">本次证据采集已取消；已提交的证据承诺保持不变。</p>' : ''}
    </section>`;
  return false;
}

function v2StatusCopy(item) {
  const status = statusOf(item);
  if (item.archivedAt) return '卷宗已软归档；已提交的证据清单仍可查阅。';
  if (status === 'credentials-required') return '进程恢复需要新的 Agent connection authorization。';
  if (status === 'interrupted') return '公开端点采集已中断，可由 participant 恢复。';
  if (status === 'cancelled') return '证据采集已取消。';
  if (item.qualification?.status === 'ineligible') return `资格检查未通过：${item.qualification.reason || 'endpoint-not-callable'}`;
  if (item.governance?.phase === 'human_open') return '四席模型初评已锁定，等待非盲人工复核。';
  if (status === 'completed') return '动态测试已完成，等待四席模型评审锁定。';
  return '正在提交可验证的 A2A 证据与清单承诺。';
}

function latestV2LogLine(item) {
  const work = item?.activeWork;
  if (work?.label) {
    const elapsed = formatElapsedSince(work.startedAt);
    return elapsed ? `${work.label} · 已过 ${elapsed}` : work.label;
  }
  const last = item?.runLog?.at(-1);
  if (last?.text) {
    return last.detail ? `${last.text} · ${last.detail}` : last.text;
  }
  return v2StatusCopy(item);
}

function formatElapsedSince(startedAt) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

function syncActiveWorkTimer(item) {
  const work = item?.schemaVersion === 2 ? item.activeWork : null;
  const key = work?.key || null;
  if (!work || !['queued', 'running'].includes(statusOf(item))) {
    if (state.activeWorkTimer) {
      clearInterval(state.activeWorkTimer);
      state.activeWorkTimer = null;
    }
    state.activeWorkKey = null;
    return;
  }
  if (state.activeWorkKey === key && state.activeWorkTimer) return;
  if (state.activeWorkTimer) clearInterval(state.activeWorkTimer);
  state.activeWorkKey = key;
  state.activeWorkTimer = setInterval(() => {
    if (state.current?.id !== item.id || !state.current?.activeWork) {
      clearInterval(state.activeWorkTimer);
      state.activeWorkTimer = null;
      state.activeWorkKey = null;
      return;
    }
    $('#latest-log').textContent = latestV2LogLine(state.current);
  }, 1000);
}

function renderResumePanel(item) {
  const panel = $('#v2-resume-panel');
  const resumable = item.schemaVersion === 2 && ['credentials-required','interrupted'].includes(statusOf(item)) && !item.archivedAt;
  panel.classList.toggle('hidden', !resumable);
  if (!resumable) {
    $('#resume-participant-token').value = '';
    $('#resume-agent-authorization').value = '';
    $('#resume-error').textContent = '';
  }
}

async function resumeEvaluation() {
  const item = state.current;
  if (!item || item.schemaVersion !== 2 || !['credentials-required','interrupted'].includes(statusOf(item))) return;
  const participantInput = $('#resume-participant-token');
  const authorizationInput = $('#resume-agent-authorization');
  const participantToken = state.participantTokens.get(item.id) || participantInput.value.trim();
  const agentAuthorization = authorizationInput.value.trim();
  if (!participantToken) {
    $('#resume-error').textContent = '请输入保存的 participant access token。';
    return;
  }
  const body = agentAuthorization ? { agentAuthorization } : {};
  participantInput.value = '';
  authorizationInput.value = '';
  const button = $('#resume-evaluation');
  button.disabled = true;
  $('#resume-error').textContent = '';
  try {
    const response = await fetch(`/api/evaluations/${item.id}/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${participantToken}`,
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '恢复评测失败');
    state.participantTokens.set(item.id, participantToken);
    await openEvaluation(item.id);
  } catch (error) {
    $('#resume-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderPartialResults(item) {
  const activity = activeActivity(item);
  const reviews = item.professional?.reviews || [];
  const builds = item.builds || [];
  const rounds = (item.benchmark || []).filter((round, index) => round.entries?.length || (activity?.type === 'benchmark' && activity.caseIndex === index));
  const terminal = terminalNotice(item);
  const sections = [
    item.complexity ? renderComplexity(item.complexity) : '',
    reviews.length || activity?.type === 'review' ? renderReviews(reviews, item) : '',
    builds.length || activity?.type === 'build' ? renderBuilds(builds, item) : '',
    rounds.length || activity?.type === 'benchmark' ? renderBattle(rounds, item) : ''
  ].filter(Boolean).join('');
  const unlocked = Number(Boolean(item.complexity)) + Number(reviews.length > 0) + Number(builds.length > 0) + Number(rounds.length > 0);
  const waiting = isTerminal(item.status) ? '' : renderWorkLoader(activity, 'console', true);
  const retryCount = item.retryHistory?.length ? ` · ${item.retryHistory.length} 次复核` : '';
  return `${terminal}<section class="artifact-console"><header><div><small>LIVE ARTIFACTS / 阶段产物</small><h3>${item.status === 'retrying' ? '单步复核中，旧结果继续可见' : '跑完一项，解锁一项'}</h3></div><span>${unlocked} / 4 组已出${retryCount}</span></header><div class="artifact-meter"><i style="--progress:${item.progress}%"></i></div>${waiting}</section>${sections}`;
}

function terminalNotice(item) {
  if (item.status === 'cancelled') return '<div class="failed-box stopped"><b>评测已停止</b><p>停止前已经完成的阶段产物保留在下方，可以继续查看。</p></div>';
  if (item.status === 'interrupted') return `<div class="failed-box interrupted"><b>检测到遗留的假运行状态</b><p>${escapeHtml(item.error || '服务重启后，旧执行任务已经不存在。')}</p></div>`;
  if (item.status === 'failed') return `<div class="failed-box"><b>评测中断</b><p>${escapeHtml(item.error || '未知错误')}</p></div>`;
  return '';
}

function scoreCard(kicker, score, title, body, highlight) {
  return `<article class="score-card ${highlight ? 'highlight' : ''}"><header><span>${kicker}</span><span>/100</span></header><div class="score"><b data-count="${score}">${score}</b><span>分</span></div><h4>${escapeHtml(title)}</h4><p>${renderLineBreaks(body)}</p></article>`;
}

function renderComplexity(value) {
  const labels = { researchDepth:'研究链路',dataDependency:'数据依赖',temporalState:'时点与状态',decisionUncertainty:'决策不确定性',workflowReuse:'工作流复用' };
  return `<div class="section-title"><h3>这项投研工作为什么需要（或不需要）Agent</h3><span>RESEARCH AGENT NECESSITY</span></div><div class="review-grid">${Object.entries(value.dimensions).map(([key,score])=>`<article class="review-card"><div class="reviewer"><b>${labels[key]||key}</b><span>${score}/100</span></div><div class="review-score">${score}<small> SIGNAL</small></div><div class="mini-bars"><div><span>强度</span><i style="--value:${score}%"></i><b>${score}</b></div></div></article>`).join('')}</div>`;
}

function renderReviews(reviews, item) {
  const labels = { researchRigor:'研究严谨性', dataDiscipline:'数据纪律', backtestIntegrity:'回测可信度', riskCompliance:'风险合规', reproducibility:'可复现性' };
  const activity = activityOfType(item, 'review');
  const plan = activity ? reviewPlanFor(item, reviews) : [];
  const cards = reviews.map((review) => {
    const key = review.reviewerId || review.model;
    const working = activityMatches(activity, key);
    return `<article class="review-card${working ? ' work-active' : ''}"><div class="reviewer"><b>${escapeHtml(review.reviewer)}</b><span>${escapeHtml(review.model)} · ${review.mode?.toUpperCase()}</span></div><div class="review-score">${review.score}<small> / 100</small></div>${review.error?`<div class="risk"><b>执行失败</b>${renderStructuredText(review.error)}</div>`:`<div class="mini-bars">${Object.entries(review.dimensions||{}).map(([dimension,score])=>`<div><span>${labels[dimension]||dimension}</span><i style="--value:${score}%"></i><b>${score}</b></div>`).join('')}</div>${renderStructuredText(review.comment, 'review-comment')}<div class="risk"><b>⚠ 首要风险</b>${renderStructuredText(review.risk)}</div>`}<div class="review-actions">${retryButton('review', key, '重跑该模型')}</div>${working ? renderWorkLoader(activity, 'card') : ''}</article>`;
  });
  if (activity && !reviews.some((review) => activityMatches(activity, review.reviewerId || review.model))) cards.push(`<article class="review-card review-card-loading work-active">${renderWorkLoader(activity, 'card')}</article>`);
  plan.forEach((reviewer, index) => {
    const completed = reviews.some((review) => reviewMatchesPlan(review, reviewer));
    const active = activityMatches(activity, reviewer.id);
    if (!completed && !active) cards.push(`<article class="review-card review-card-queued">${renderQueuedWork(reviewer.name, reviewer.model, index + 1, plan.length)}</article>`);
  });
  return `<div class="section-title"><h3>四方研究审稿</h3><span>MULTI-MODEL FINANCE REVIEW</span></div><div class="review-grid model-review-grid">${cards.join('')}</div>`;
}

function renderBuilds(builds, item) {
  const activity = activityOfType(item, 'build');
  const plan = activity ? runtimePlanFor(item) : [];
  const cards = builds.map((build) => {
    const working = activityMatches(activity, build.runtimeId);
    return `<article class="build-card${working ? ' work-active' : ''}" data-skill-runtime="${escapeHtml(build.runtimeId || '')}"><div class="build-row"><b>${escapeHtml(build.runtime)}</b><span>${escapeHtml(build.model||'—')}</span><code>${escapeHtml(build.skill?.name||build.error||'构建失败')}</code><span class="${build.error?'':'ok'}">${build.error?'失败':`✓ ${build.mode.toUpperCase()}`}</span>${build.error || !build.skill ? '' : `<button class="skill-detail-toggle" type="button" data-skill-detail="${escapeHtml(build.runtimeId)}" aria-expanded="false"><i aria-hidden="true">⌁</i><span>查看 Skill</span></button>`}${retryButton('build', build.runtimeId, '重新直出并对测')}${working ? renderWorkLoader(activity, 'row') : ''}</div><div class="skill-inspector hidden" data-skill-inspector><div class="skill-inspector-loading"><i></i><span>正在装载目录快照…</span></div></div></article>`;
  });
  if (activity && !builds.some((build) => activityMatches(activity, build.runtimeId))) {
    cards.push(`<article class="build-card build-card-loading work-active" data-skill-runtime="${escapeHtml(activity.key || '')}"><div class="build-row"><b>${escapeHtml(activity.target || 'Runtime')}</b><span>${activityPosition(activity)}</span><code>description-only 输入已封舱</code><span class="work-status">生成中</span>${renderWorkLoader(activity, 'row')}</div></article>`);
  }
  plan.forEach((runtime, index) => {
    if (!builds.some((build) => build.runtimeId === runtime.id) && !activityMatches(activity, runtime.id)) {
      cards.push(`<article class="build-card build-card-queued"><div class="build-row"><b>${escapeHtml(runtime.name)}</b><span>${escapeHtml(runtime.model || '—')}</span><code>等待前序 Runtime 完成</code><span class="queued-status">排队中 · ${index + 1}/${plan.length}</span></div></article>`);
    }
  });
  return `<div class="section-title"><h3>Description 直出记录</h3><span>DESCRIPTION-ONLY SKILL BUILD</span></div><div class="build-list">${cards.join('')}</div>`;
}

async function toggleSkillDetail(button) {
  const card = button.closest('.build-card');
  const inspector = $('[data-skill-inspector]', card);
  const opening = inspector.classList.contains('hidden');
  inspector.classList.toggle('hidden', !opening);
  button.setAttribute('aria-expanded', String(opening));
  $('span', button).textContent = opening ? '收起 Skill' : '查看 Skill';
  if (!opening || inspector.dataset.loaded === 'true') return;
  const evaluationId = state.current?.id;
  const runtimeId = button.dataset.skillDetail;
  if (!evaluationId || !runtimeId) return renderSkillError(inspector, '无法定位这条复刻记录');
  const cacheKey = skillCacheKey(evaluationId, runtimeId);
  const cached = state.skillBundles.get(cacheKey);
  if (cached) return renderSkillInspector(inspector, cached);
  const token = ++state.skillRequestToken;
  inspector.dataset.requestToken = String(token);
  try {
    const response = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/builds/${encodeURIComponent(runtimeId)}/skill`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Skill 详情读取失败');
    if (inspector.dataset.requestToken !== String(token) || state.current?.id !== evaluationId || !inspector.isConnected) return;
    state.skillBundles.set(cacheKey, payload);
    renderSkillInspector(inspector, payload);
  } catch (error) {
    if (inspector.dataset.requestToken === String(token) && state.current?.id === evaluationId && inspector.isConnected) renderSkillError(inspector, error.message);
  }
}

function renderSkillInspector(inspector, bundle) {
  const files = Array.isArray(bundle.files) ? bundle.files : [];
  if (!files.length) return renderSkillError(inspector, '这个 Skill 快照中没有文件');
  inspector.dataset.loaded = 'true';
  const policyNote = bundle.legacyBaseline
    ? '警告：这是信息防火墙上线前的历史产物，构建时可能使用过完整 Agent Card；请“重建并对测”后再把它视为公平基线。'
    : '公平基线：复刻 Runtime 只收到顶层 description 原文，不会收到 Agent Card、skills、examples、capabilities、接口地址或提交 Agent 输出。';
  inspector.innerHTML = `<header class="skill-inspector-head"><div><small>NORMALIZED SKILL SNAPSHOT</small><b>${escapeHtml(bundle.root)}/</b></div><span>${files.length} FILES · READ ONLY</span></header><div class="skill-browser"><nav class="skill-tree" aria-label="Skill 文件列表"><b><i>▾</i>${escapeHtml(bundle.root)}/</b>${files.map((file, index) => skillFileButton(file, index === 0)).join('')}</nav><section class="skill-preview">${skillPreviewMarkup(files[0])}</section></div><p class="skill-snapshot-note${bundle.legacyBaseline ? ' warning' : ''}">${escapeHtml(policyNote)}</p>`;
}

function skillFileButton(file, active) {
  const parts = String(file.path || '').split('/');
  const label = parts.pop() || 'untitled';
  const directory = parts.length ? `${parts.join('/')}/` : '';
  const icon = file.language === 'markdown' ? 'M↓' : file.language === 'json' ? '{ }' : 'TXT';
  return `<button type="button" class="skill-file${active ? ' active' : ''}" data-skill-file="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}"><i aria-hidden="true">${icon}</i><span>${directory ? `<small>${escapeHtml(directory)}</small>` : ''}${escapeHtml(label)}</span></button>`;
}

function skillPreviewMarkup(file) {
  const content = String(file?.content || '');
  const lines = content.split('\n');
  return `<header><div><small>${escapeHtml(file?.language || 'text')}</small><b>${escapeHtml(file?.path || '—')}</b></div><button type="button" data-copy-skill="${escapeHtml(file?.path || '')}">复制内容</button></header><pre class="skill-source" tabindex="0">${lines.map((line, index) => `<span><i>${index + 1}</i><code>${escapeHtml(line) || '&nbsp;'}</code></span>`).join('')}</pre>`;
}

function selectSkillFile(button) {
  const card = button.closest('.build-card');
  const runtimeId = card?.dataset.skillRuntime;
  const bundle = state.skillBundles.get(skillCacheKey(state.current?.id, runtimeId));
  const file = bundle?.files?.find((candidate) => candidate.path === button.dataset.skillFile);
  if (!file) return;
  $$('.skill-file', card).forEach((item) => item.classList.toggle('active', item === button));
  $('.skill-preview', card).innerHTML = skillPreviewMarkup(file);
}

async function copySkillFile(button) {
  const card = button.closest('.build-card');
  const runtimeId = card?.dataset.skillRuntime;
  const bundle = state.skillBundles.get(skillCacheKey(state.current?.id, runtimeId));
  const file = bundle?.files?.find((candidate) => candidate.path === button.dataset.copySkill);
  if (!file) return;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(file.content);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1500);
}

function renderSkillError(inspector, message) {
  inspector.dataset.loaded = 'true';
  inspector.innerHTML = `<div class="skill-inspector-error"><b>Skill 快照不可用</b><span>${escapeHtml(message)}</span></div>`;
}

function skillCacheKey(evaluationId, runtimeId) {
  const build = state.current?.builds?.find((candidate) => candidate.runtimeId === runtimeId);
  const input = JSON.stringify([build?.skill, build?.model, build?.mode, build?.adapterKind, build?.baselineInput, build?.seed]);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  return `${evaluationId}:${runtimeId}:${(hash >>> 0).toString(36)}`;
}

function renderBattle(rounds, item) {
  const activity = activityOfType(item, 'benchmark');
  const competitorPlan = activity ? competitorPlanFor(item) : [];
  return `<div class="section-title"><h3>同 Prompt 对打</h3><span>SAME INPUT · VISIBLE OUTPUT ONLY</span></div>${rounds.map((round,index)=>{
    const entries = round.entries || [];
    const max = entries.length ? Math.max(...entries.map((entry) => entry.score)) : null;
    const cards = entries.map((entry) => {
      const working = activity?.caseIndex === index && activityMatches(activity, entry.id);
      return `<div class="battle-entry${working ? ' work-active' : ''}"><header><h4>${escapeHtml(entry.name)}</h4><strong class="${entry.score===max?'winner':''}">${entry.score}</strong></header><div class="battle-actions"><span class="mode">${entry.mode.toUpperCase()}</span>${renderDataVerificationBadge(entry.dataVerification)}${retryButton('benchmark', entry.id, '重跑这一局', index)}</div><details><summary>查看完整输出</summary><pre>${escapeHtml(entry.output)}</pre></details>${renderDataChecks(entry.dataVerification)}${working ? renderWorkLoader(activity, 'card') : ''}</div>`;
    });
    if (activity?.caseIndex === index && !entries.some((entry) => activityMatches(activity, entry.id))) {
      cards.push(`<div class="battle-entry battle-entry-loading work-active"><header><h4>${escapeHtml(activity.target || '对测选手')}</h4><strong>···</strong></header>${renderWorkLoader(activity, 'card')}</div>`);
    }
    if (activity?.caseIndex === index) competitorPlan.forEach((competitor, competitorIndex) => {
      if (!entries.some((entry) => entry.id === competitor.id) && !activityMatches(activity, competitor.id)) {
        cards.push(`<div class="battle-entry battle-entry-queued">${renderQueuedWork(competitor.name, '等待同 Prompt 执行', competitorIndex + 1, competitorPlan.length)}</div>`);
      }
    });
    return `<article class="battle-round"><div class="battle-prompt"><span>CASE ${String(index+1).padStart(2,'0')}<br>${escapeHtml(round.case.name)}</span><p>${escapeHtml(round.case.prompt)}</p></div>${renderDataEvidence(round.dataEvidence)}<div class="battle-grid">${cards.join('')}</div></article>`;
  }).join('')}`;
}

function renderDataEvidence(evidence) {
  if (!evidence || evidence.status === 'not-configured') return '';
  const labels = { ready:'已锁定', partial:'部分可用', failed:'查询失败', disabled:'未启用' };
  const queries = (evidence.queries || []).map((query) => {
    const facts = (query.facts || []).filter((fact) => fact.status === 'available').map((fact) => `<span>${escapeHtml(fact.label)} = <b>${escapeHtml(formatEvidenceValue(fact.value, fact.unit))}</b>${fact.sourceDate ? ` · ${escapeHtml(String(fact.sourceDate))}` : ''}</span>`).join('');
    return `<div class="data-evidence-query"><div><b>${escapeHtml(query.label || query.method)}</b><code>${escapeHtml(query.method || '')}</code><i class="data-state ${escapeHtml(query.status || '')}">${escapeHtml(query.status || 'unknown')}</i></div><p>${query.rowCount === undefined ? escapeHtml(query.error || '未执行') : `${query.rowCount} 行 · ${escapeHtml((query.fields || []).join(', '))}`}${query.fingerprint ? ` · SHA256 ${escapeHtml(query.fingerprint.slice(0, 12))}` : ''}</p>${facts ? `<div class="data-facts">${facts}</div>` : ''}</div>`;
  }).join('');
  return `<details class="data-evidence" ${evidence.status === 'failed' ? 'open' : ''}><summary><span>PANDAAI REFERENCE</span><b>${escapeHtml(labels[evidence.status] || evidence.status)}</b><i>${evidence.queries?.length || 0} 个查询 · 同局共用快照</i></summary><div>${queries}</div></details>`;
}

function renderDataVerificationBadge(verification) {
  if (!verification || verification.status === 'unavailable') return '<span class="verify-badge unavailable">未验真</span>';
  const labels = { verified:'数据吻合', partial:'部分吻合', contradicted:'数据冲突', missing:'缺少必填事实', 'not-claimed':'未声明锚点' };
  return `<span class="verify-badge ${escapeHtml(verification.status)}">${escapeHtml(labels[verification.status] || verification.status)}</span>`;
}

function renderDataChecks(verification) {
  if (!verification?.checks?.length) return '';
  return `<details class="verification-checks"><summary>数据验真 ${verification.matched}/${verification.total}</summary>${verification.checks.map((check) => `<div class="check-${escapeHtml(check.status)}"><b>${escapeHtml(check.label)}</b><span>${escapeHtml(check.status)} · 参考 ${escapeHtml(formatEvidenceValue(check.expected, check.unit))}${check.observed === undefined ? '' : ` · 输出 ${escapeHtml(formatEvidenceValue(check.observed, check.unit))}`}</span></div>`).join('')}</details>`;
}

function formatEvidenceValue(value, unit = '') {
  const formatted = typeof value === 'number' ? Number(value.toFixed(6)).toLocaleString('zh-CN') : String(value ?? '—');
  return `${formatted}${unit || ''}`;
}

function activeActivity(item) {
  if (item?.activeWork) return item.activeWork;
  if (item?.retrying) return { ...item.retrying, target: item.retrying.shortLabel, detail: '旧结果保留至新结果返回', retry: true, index: 1, total: 1 };
  if (item && !isTerminal(item.status)) {
    const reviews = item.professional?.reviews || [];
    const reviewPlan = reviewPlanFor(item, reviews);
    const nextReviewer = reviewPlan.find((reviewer) => !reviews.some((review) => reviewMatchesPlan(review, reviewer)));
    if (nextReviewer && (/盲审|审稿/.test(item.stage || '') || (item.progress >= 22 && item.progress <= 52 && !(item.builds?.length)))) {
      return { type:'review', key:nextReviewer.id, label:`${nextReviewer.name} 正在审稿`, target:nextReviewer.model, detail:'正在等待研究严谨性、数据纪律、回测可信度、风险合规与可复现性评分', retry:false, index:reviews.length + 1, total:reviewPlan.length };
    }
    const builds = item.builds || [];
    const runtimePlan = runtimePlanFor(item);
    const nextRuntime = runtimePlan.find((runtime) => !builds.some((build) => build.runtimeId === runtime.id));
    if (nextRuntime && (/直出|复刻/.test(item.stage || '') || (item.progress >= 52 && item.progress <= 66))) {
      return { type:'build', key:nextRuntime.id, label:`${nextRuntime.name} 正在直出 Skill`, target:nextRuntime.name, detail:'唯一输入：Agent 顶层 description 原文', retry:false, index:builds.length + 1, total:runtimePlan.length };
    }
    if (/对测|竞技场/.test(item.stage || '') || item.progress >= 66) {
      const competitorPlan = competitorPlanFor(item);
      const rounds = item.benchmark || [];
      const caseIndex = Math.max(0, rounds.findIndex((round) => (round.entries?.length || 0) < competitorPlan.length));
      const round = rounds[caseIndex] || { case:item.cases?.[caseIndex], entries:[] };
      const nextCompetitor = competitorPlan.find((competitor) => !(round.entries || []).some((entry) => entry.id === competitor.id));
      if (nextCompetitor) return { type:'benchmark', key:nextCompetitor.id, caseIndex, label:`${nextCompetitor.name} 正在执行同 Prompt 对测`, target:nextCompetitor.name, detail:`用例：${round.case?.name || `案例 ${caseIndex + 1}`}`, retry:false, index:caseIndex + 1, total:item.cases?.length || 1 };
    }
  }
  return { type:'system', key:'pipeline', label:item?.stage || '正在启动评测', target:'评测舱', detail:'首个阶段产物完成后会立即显示', retry:false, index:1, total:1 };
}

function reviewPlanFor(item, reviews = item?.professional?.reviews || []) {
  if (Array.isArray(item?.reviewPlan) && item.reviewPlan.length) return item.reviewPlan;
  return DEFAULT_REVIEW_PLAN.map((reviewer, index) => {
    const existing = reviews.find((review) => review.reviewerId === reviewer.id) || reviews[index];
    return existing ? { id:existing.reviewerId || reviewer.id, name:existing.reviewer || reviewer.name, model:existing.model || reviewer.model } : reviewer;
  });
}

function runtimePlanFor(item) {
  return Array.isArray(item?.runtimePlan) && item.runtimePlan.length ? item.runtimePlan : DEFAULT_RUNTIME_PLAN;
}

function competitorPlanFor(item) {
  return [{ id:'submitted', name:item?.agentCard?.name || '提交 Agent' }, ...runtimePlanFor(item).map((runtime) => ({ id:runtime.id, name:runtime.name }))];
}

function reviewMatchesPlan(review, reviewer) {
  return [review.reviewerId, review.reviewer, review.model].filter(Boolean).some((value) => [reviewer.id, reviewer.name, reviewer.model].includes(value));
}

function activityOfType(item, type) {
  const activity = activeActivity(item);
  return activity?.type === type ? activity : null;
}

function activityMatches(activity, key) {
  return Boolean(activity && key && String(activity.key) === String(key));
}

function activityPosition(activity) {
  const index = Number.isInteger(activity?.index) ? activity.index : 1;
  const total = Number.isInteger(activity?.total) ? activity.total : 1;
  return `${index}/${total}`;
}

function renderWorkLoader(activity, variant = 'card', announce = false) {
  const safeVariant = ['console','card','row'].includes(variant) ? variant : 'card';
  const statusAttributes = announce ? ' role="status" aria-live="polite"' : '';
  const mode = activity?.retry ? 'RETRY / 重新计算' : 'LIVE / 正在处理';
  return `<div class="work-loader work-loader-${safeVariant}${activity?.retry ? ' is-retry' : ''}"${statusAttributes}><div class="work-signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="work-copy"><small>${mode}</small><b>${escapeHtml(activity?.label || '正在生成阶段产物')}</b><span>${escapeHtml(activity?.detail || '完成后会自动更新当前区域')}</span></div><strong class="work-position">${activityPosition(activity)}</strong></div>`;
}

function renderQueuedWork(name, detail, index, total) {
  return `<div class="queued-work"><small>QUEUED / 等待中</small><b>${escapeHtml(name)}</b><span>${escapeHtml(detail)}</span><strong>${index}/${total}</strong><i aria-hidden="true"></i></div>`;
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

async function loadDataSourceHealth() {
  const root = $('#data-source-health');
  try {
    const response = await fetch('/api/data-source?probe=1');
    const source = await response.json();
    if (!response.ok) throw new Error(source.error || '数据源状态读取失败');
    const stateLabel = source.ready ? 'READY' : source.enabled && source.configured && source.installed === false ? 'SDK 缺失' : source.enabled ? '账号未配置' : '未启用';
    root.innerHTML = `<span>DATA SOURCE</span><span class="runtime-chip ${source.configured ? 'installed' : ''} ${source.ready ? 'ready' : ''}" title="PandaAI Quant 官方 panda_data SDK">PandaAI Quant · ${stateLabel}</span><i>${source.ready ? `${source.allowedMethods.length} 个只读方法 · ${source.autoVerify ? '自动验真 ON' : '自动验真 OFF'}` : '在 .env 配置 PANDA_DATA_*'}</i>`;
  } catch {
    root.innerHTML = '<span>DATA SOURCE</span><i>PandaAI Quant 状态读取失败</i>';
  }
}

async function loadEvaluationDefaults() {
  try {
    const response = await fetch('/api/health');
    const payload = await response.json();
    if (!response.ok) throw new Error('health unavailable');
    const mode = evaluationModeFromHealth(payload);
    if (!mode.resolved) throw new Error('health capability unavailable');
    const input = $('#evaluation-seed');
    if (!input.dataset.edited && Number.isInteger(payload.evaluationSeed)) input.value = payload.evaluationSeed;
    input.title = `服务默认 seed：${payload.evaluationSeed} · temperature：${payload.modelTemperature}`;
    setBlackBoxMode(mode.enabled);
  } catch {
    $('#evaluation-seed').placeholder = '20260720';
    setBlackBoxModeUnavailable();
  }
}

function setBlackBoxMode(enabled) {
  state.blackBoxEnabled = enabled;
  state.healthResolved = true;
  $$('.legacy-only').forEach((element) => element.classList.toggle('hidden', enabled));
  $('#v2-card-heading').classList.toggle('hidden', !enabled);
  $('#v2-intake').classList.toggle('hidden', !enabled);
  const button = $('#start-evaluation');
  button.disabled = false;
  $('span', button).textContent = enabled ? '启动 A2A 证据评测' : '送进研究终审台';
}

function setBlackBoxModeUnavailable() {
  state.healthResolved = false;
  const button = $('#start-evaluation');
  button.disabled = true;
  $('span', button).textContent = '无法确认评测模式';
  showError('无法从服务确认评测模式，请稍后刷新重试。');
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

function revealVerdictInView(root, evaluationId) {
  const token = ++state.verdictRevealToken;
  requestAnimationFrame(() => {
    const verdict = $('#final-verdict', root);
    if (!verdict || state.current?.id !== evaluationId || token !== state.verdictRevealToken) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const targetTop = Math.max(0, scrollY + verdict.getBoundingClientRect().top - 92);
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      window.removeEventListener('scrollend', reveal);
      if (state.current?.id !== evaluationId || token !== state.verdictRevealToken) return;
      root.classList.remove('verdict-pending');
      root.classList.add('reveal');
      animateCounters(root);
    };
    scrollTo({ top: targetTop, behavior: reducedMotion ? 'auto' : 'smooth' });
    if (reducedMotion) requestAnimationFrame(reveal);
    else {
      window.addEventListener('scrollend', reveal, { once: true });
      setTimeout(reveal, 720);
    }
  });
}

function renderLineBreaks(value = '') {
  return escapeHtml(value).replace(/\r\n?|\n/g, '<br>');
}

function renderHeadline(value = '') {
  return escapeHtml(String(value).replace(/\s*[\r\n]+\s*/g, ' ').trim());
}

function renderStructuredText(value = '', className = 'review-prose') {
  const lines = String(value).replace(/\r\n?/g, '\n').trim().split('\n');
  const output = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(escapeHtml).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    output.push(`<${listType}>${listItems.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</${listType}>`);
    listItems = [];
    listType = null;
  };
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)、]\s*(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const nextType = numbered ? 'ol' : 'ul';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((bullet || numbered)[1]);
    } else if (!line) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  });
  flushParagraph();
  flushList();
  return `<div class="${className}">${output.join('') || '<p>—</p>'}</div>`;
}

async function loadHistory() {
  const token = ++state.historyLoadToken;
  try {
    const response = await fetch('/api/evaluations');
    const items = await response.json();
    if (!response.ok) throw new Error(items.error || '历史记录读取失败');
    if (token !== state.historyLoadToken) return;
    $('#history-count').textContent = items.length;
    $('#history-list').innerHTML = items.length
      ? items.map((item) => item.schemaVersion === 2 ? renderV2HistoryItem(item) : renderLegacyHistoryItem(item)).join('')
      : '<p class="history-empty">还没有战绩。第一个被公开处刑的 Agent 会是谁？</p>';
  } catch { if (token === state.historyLoadToken) $('#history-list').innerHTML = '<p>历史记录暂时读取失败。</p>'; }
}

function renderLegacyHistoryItem(item) {
  const tier = item.tier ? normalizeTier(item.tier) : null;
  const canDelete = isTerminal(item.status);
  return `<article class="history-item"><button class="history-open" type="button" data-evaluation-id="${item.id}"><header><span>${formatTime(item.createdAt)}</span><span>${item.progress}%</span></header><h3>${escapeHtml(item.name)}</h3><p>${tier?`最终锐评：<span class="history-tier">${escapeHtml(tier.label)}</span> · 实战 ${item.score} 分`:escapeHtml(item.status)}</p></button><button class="history-delete" type="button" data-delete-evaluation="${item.id}" aria-label="${canDelete ? '删除' : '运行中，暂不可删除'} ${escapeHtml(item.name)} 的评测记录" title="${canDelete ? '删除这条战绩' : '请先停止本次评测'}"${canDelete ? '' : ' disabled'}><i aria-hidden="true">×</i><span>删除</span></button></article>`;
}

function renderV2HistoryItem(item) {
  const archived = Boolean(item.archivedAt);
  const canArchive = canArchiveEvaluation(item);
  const label = archived ? '已归档' : statusOf(item);
  const archiveTitle = archived
    ? '卷宗已归档'
    : canArchive
      ? '软归档；证据仍可查阅'
      : '运行中的卷宗暂不可归档';
  return `<article class="history-item history-item-v2"><button class="history-open" type="button" data-evaluation-id="${item.id}"><header><span>${formatTime(item.createdAt)}</span><span>${progressOf(item)}%</span></header><h3>A2A 证据卷宗</h3><p>${escapeHtml(label)} · ${escapeHtml(stageOf(item) || 'qualification')} · ${item.evidenceManifest?.items?.length || 0} evidence</p></button><button class="history-delete" type="button" data-delete-evaluation="${item.id}" data-record-kind="v2" aria-label="归档 ${escapeHtml(item.id)} 的评测记录" title="${archiveTitle}"${canArchive ? '' : ' disabled'}><i aria-hidden="true">×</i><span>归档</span></button></article>`;
}

async function deleteEvaluation(button) {
  const id = button.dataset.deleteEvaluation;
  if (!id || button.disabled) return;
  const isV2 = button.dataset.recordKind === 'v2';
  const copy = recordActionCopy(isV2);
  if (button.dataset.confirm !== 'true') {
    button.dataset.confirm = 'true';
    button.classList.add('confirming');
    $('span', button).textContent = copy.confirm;
    setTimeout(() => {
      if (!button.isConnected || button.disabled) return;
      delete button.dataset.confirm;
      button.classList.remove('confirming');
      $('span', button).textContent = copy.idle;
    }, 3500);
    return;
  }
  button.disabled = true;
  button.classList.add('deleting');
  $('span', button).textContent = copy.pending;
  try {
    const requestOptions = isV2
      ? participantActionOptions(
          'DELETE',
          participantTokenForAction(id)
        )
      : { method: 'DELETE' };
    const response = await fetch(`/api/evaluations/${id}`, requestOptions);
    const payload = await response.json();
    if (!response.ok) throw new Error(recordActionFailure(isV2, payload.error));
    if (state.current?.id === id) {
      closeHistory();
      if (state.current.schemaVersion === 2) await openEvaluation(id);
      else showLanding();
    }
    await loadHistory();
  } catch (error) {
    button.disabled = false;
    button.classList.remove('deleting');
    button.classList.remove('confirming');
    delete button.dataset.confirm;
    $('span', button).textContent = recordActionFailure(isV2, error.message);
    setTimeout(() => { if (button.isConnected) $('span', button).textContent = copy.idle; }, 2400);
  }
}

function showLanding() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
  state.openEvaluationToken += 1;
  state.current = null;
  state.lastStage = null;
  state.completedRendered = null;
  state.verdictRevealToken += 1;
  history.replaceState(null, '', location.pathname);
  $('#evaluation-view').classList.add('hidden');
  $('#landing-view').classList.remove('hidden');
  if (state.blackBoxEnabled) restoreV2StartButton($('#start-evaluation'));
  scrollTo({ top: 0, behavior: 'smooth' });
}
function openHistory() { $('#history-drawer').classList.add('open'); $('#drawer-backdrop').classList.add('open'); $('#history-drawer').setAttribute('aria-hidden','false'); loadHistory(); }
function closeHistory() { $('#history-drawer').classList.remove('open'); $('#drawer-backdrop').classList.remove('open'); $('#history-drawer').setAttribute('aria-hidden','true'); }
function showError(text) { $('#form-error').textContent = text; }
function statusOf(item) { return item?.schemaVersion === 2 ? item.execution?.status : item?.status; }
function stageOf(item) { return item?.schemaVersion === 2 ? item.execution?.stage : item?.stage; }
function progressOf(item) {
  const progress = item?.schemaVersion === 2 ? item.execution?.progress : item?.progress;
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
}
function shouldSubscribe(item) {
  return item?.schemaVersion === 2 ? ['queued','running'].includes(statusOf(item)) : !isTerminal(statusOf(item));
}
function isTerminal(status) { return ['completed','failed','cancelled','interrupted'].includes(status); }
function normalizeTier(tier = {}) {
  if (tier.code === 'OVERKILL' || tier.code === 'FLOP' || tier.label === '大炮打蚊子' || tier.label === '拉完了') return { ...tier, code: 'FLOP', label: '拉', stamp: '拉' };
  if (tier.code === 'MID' || tier.label === '有点东西，但不多') return { ...tier, code: 'NPC', label: 'NPC', stamp: 'NPC' };
  return tier;
}
function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, char=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
function escapeAttr(value='') { return escapeHtml(value); }
function signed(value) { return `${value>=0?'+':''}${value} 分`; }
function formatTime(value) { return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)); }
