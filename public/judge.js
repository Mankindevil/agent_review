const accessForm = document.querySelector('#judge-access-form');
const tokenInput = document.querySelector('#judge-token');
const accessStatus = document.querySelector('#access-status');
const assignmentList = document.querySelector('#assignment-list');
const testFilter = document.querySelector('#test-filter');
const submissionPanel = document.querySelector('#submission-panel');
const timeline = document.querySelector('#evidence-timeline');
const modelOpinions = document.querySelector('#model-opinions');
const disagreementSummary = document.querySelector('#disagreement-summary');
const scoreForm = document.querySelector('#human-score-form');
const scoreLeaves = document.querySelector('#score-leaves');
const replicaSealNotice = document.querySelector('#replica-seal-notice');
const draftStatus = document.querySelector('#draft-status');
const formError = document.querySelector('#form-error');
const submitButton = document.querySelector('#submit-review');
const recuseButton = document.querySelector('#recuse-review');

let judgeToken = '';
let assignments = [];
let current = null;
let draftTimer = null;

window.addEventListener('pagehide', clearSensitiveState);
window.addEventListener('pageshow', clearSensitiveState);
accessForm.addEventListener('submit', loadAssignments);
assignmentList.addEventListener('change', loadAssignment);
testFilter.addEventListener('change', renderEvidence);
scoreForm.addEventListener('input', scheduleDraft);
scoreForm.addEventListener('submit', submitReview);
recuseButton.addEventListener('click', recuseReview);

function clearSensitiveState() {
  judgeToken = '';
  tokenInput.value = '';
  assignments = [];
  current = null;
  assignmentList.replaceChildren(option('', '先验证身份'));
  assignmentList.disabled = true;
  testFilter.replaceChildren(option('', '全部已见证据'));
  testFilter.disabled = true;
  submissionPanel.replaceChildren(text('p', 'empty-copy', '选择委派后查看 Agent Card、使用示例与测试范围。'));
  timeline.replaceChildren();
  modelOpinions.replaceChildren();
  scoreLeaves.replaceChildren();
  submitButton.disabled = true;
  recuseButton.disabled = true;
}

async function loadAssignments(event) {
  event.preventDefault();
  judgeToken = tokenInput.value.trim();
  if (!judgeToken) return setAccessState('请填写评委 Bearer token。', true);
  setAccessState('正在核验身份并读取委派…');
  try {
    const response = await api('/api/review-assignments');
    assignments = await response.json();
    if (!response.ok) throw new Error(assignments.error || '无法读取评审委派。');
    assignmentList.replaceChildren(option('', assignments.length ? '选择一项委派' : '暂无待办委派'));
    for (const assignment of assignments) {
      assignmentList.append(option(
        assignment.assignmentId,
        `${assignment.evaluationId} · ${assignment.role === 'arbitrator' ? '仲裁' : '主评'} · ${assignment.status}`
      ));
    }
    assignmentList.disabled = assignments.length === 0;
    setAccessState(assignments.length ? '身份已核验。选择一项委派开始复核。' : '当前没有可处理的评审委派。');
  } catch (error) {
    clearSensitiveState();
    setAccessState(error.message || '身份核验失败。', true);
  }
}

async function loadAssignment() {
  const assignment = assignments.find((item) => item.assignmentId === assignmentList.value);
  if (!assignment) return;
  setAccessState('正在装载提交证据和模型意见…');
  formError.textContent = '';
  try {
    const [detailResponse, evaluationResponse] = await Promise.all([
      api(`/api/review-assignments/${encodeURIComponent(assignment.evaluationId)}`),
      api(`/api/evaluations/${encodeURIComponent(assignment.evaluationId)}`)
    ]);
    const [detail, evaluation] = await Promise.all([detailResponse.json(), evaluationResponse.json()]);
    if (!detailResponse.ok) throw new Error(detail.error || '无法读取委派详情。');
    if (!evaluationResponse.ok) throw new Error(evaluation.error || '无法读取评审投影。');
    current = { assignment: detail, evaluation, etag: detailResponse.headers.get('etag') || '', submitted: detail.status === 'submitted' };
    renderAssignment();
    setAccessState(current.submitted ? '该评审已提交，内容已只读。' : '证据已就位。草稿会自动保存到服务端。');
  } catch (error) {
    setAccessState(error.message || '装载评审席失败。', true);
  }
}

function renderAssignment() {
  replicaSealNotice.hidden = Boolean(current.evaluation.governance?.absoluteLockedAt);
  renderSubmission();
  renderFilters();
  renderEvidence();
  renderModelOpinions();
  renderScoreForm();
  const active = !current.submitted;
  submitButton.disabled = !active;
  recuseButton.disabled = !active;
}

function renderSubmission() {
  const submission = current.evaluation.submission || {};
  const card = submission.agentCard?.value || {};
  const examples = submission.agentExamples?.value || [];
  const heading = text('h3', '', card.name || '已提交 Agent');
  const description = text('p', '', card.description || '未提供公开描述。');
  const facts = text('p', '', `使用示例 ${examples.length} 个 · 委派叶项 ${current.assignment.criterionScope.length} 个`);
  submissionPanel.replaceChildren(heading, description, facts);
}

function renderFilters() {
  const items = current.evaluation.evidenceManifest?.items || [];
  const keys = [...new Set(items.map((item) => `${item.testId || '未分类'} / ${item.repeatIndex ?? 0}`))];
  testFilter.replaceChildren(option('', '全部已见证据'));
  for (const key of keys) testFilter.append(option(key, key));
  testFilter.disabled = keys.length === 0;
}

function renderEvidence() {
  timeline.replaceChildren();
  const items = current.evaluation.evidenceManifest?.items || [];
  const matching = items.filter((item) => !testFilter.value ||
    `${item.testId || '未分类'} / ${item.repeatIndex ?? 0}` === testFilter.value);
  if (!matching.length) {
    timeline.append(text('p', 'empty-copy', '当前筛选没有可见证据。'));
    return;
  }
  for (const item of matching) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'evidence-item';
    const mark = document.createElement('i');
    const copy = document.createElement('span');
    copy.append(text('strong', '', `${item.grade || '—'} · ${item.kind || 'evidence'}`));
    copy.append(text('small', '', `${item.testId || '未分类'} · 第 ${(item.repeatIndex ?? 0) + 1} 次 · ${item.summary || item.evidenceId}`));
    button.append(mark, copy);
    button.addEventListener('click', () => loadEvidence(item, button));
    timeline.append(button);
  }
}

async function loadEvidence(item, button) {
  const oldPreview = timeline.querySelector('.evidence-preview');
  oldPreview?.remove();
  try {
    const response = await api(`/api/evaluations/${encodeURIComponent(current.assignment.evaluationId)}/evidence/${encodeURIComponent(item.evidenceId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '证据快照不可用。');
    const preview = text('pre', 'evidence-preview', JSON.stringify(payload.item, null, 2));
    button.after(preview);
  } catch (error) {
    button.after(text('p', 'evidence-preview', error.message || '读取证据失败。'));
  }
}

function renderModelOpinions() {
  modelOpinions.replaceChildren();
  const panel = current.evaluation.absoluteReview?.modelPanel || {};
  const scope = new Set(current.assignment.criterionScope);
  const primary = panel.primary || [];
  const disputed = (panel.disputedSubcriterionIds || []).filter((id) => scope.has(id));
  disagreementSummary.textContent = disputed.length
    ? `本委派有 ${disputed.length} 个模型分歧叶项；人工结论必须回到可见证据。`
    : '四模型意见已锁定。本委派范围内没有第五模型触发的分歧叶项。';
  for (const leafId of current.assignment.criterionScope) {
    const reviews = primary.map((run) => (run.reviews || []).find((review) => review.subcriterionId === leafId)).filter(Boolean);
    const card = document.createElement('article');
    card.className = 'model-card';
    const header = document.createElement('header');
    header.append(text('b', '', leafId), text('strong', '', reviews.length ? `${median(reviews.map((review) => review.score))} 分` : '无模型分'));
    card.append(header);
    const findings = reviews.flatMap((review) => review.findings || []);
    card.append(text('p', '', findings.length ? `共识/异议：${findings.map((finding) => finding.text).join('；')}` : '模型没有提供可展示的文字意见。'));
    const uncertainties = reviews.flatMap((review) => review.uncertainties || []);
    if (uncertainties.length) card.append(text('p', '', `不确定性：${uncertainties.join('；')}`));
    const suggestion = reviews.find((review) => review.repairSuggestion)?.repairSuggestion;
    if (suggestion) card.append(text('p', '', `修复建议：${suggestion}`));
    modelOpinions.append(card);
  }
}

function renderScoreForm() {
  scoreLeaves.replaceChildren();
  const draft = current.assignment.draft?.scores || {};
  const items = current.evaluation.evidenceManifest?.items || [];
  for (const leafId of current.assignment.criterionScope) {
    const block = document.createElement('fieldset');
    block.className = 'leaf-form';
    block.dataset.leaf = leafId;
    block.append(text('h3', '', leafId));
    const score = labeledInput('评分（0–100）', 'number', `score-${leafId}`);
    score.input.min = '0'; score.input.max = '100'; score.input.value = draft[leafId]?.score ?? '';
    block.append(score.label);
    const evidence = document.createElement('div');
    evidence.className = 'evidence-checks';
    evidence.append(text('label', '', '引用可见证据'));
    for (const item of items) {
      const choice = document.createElement('label');
      choice.className = 'check-label';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.value = item.evidenceId;
      checkbox.checked = (draft[leafId]?.evidenceIds || []).includes(item.evidenceId);
      choice.append(checkbox, text('span', '', `${item.grade || '—'} · ${item.kind || 'evidence'} · ${item.summary || item.evidenceId}`));
      evidence.append(choice);
    }
    block.append(evidence);
    const rationale = labeledTextarea('评审理由', `rationale-${leafId}`, draft[leafId]?.rationale || '');
    block.append(rationale.label);
    const disposition = labeledSelect('相对模型结论', `disposition-${leafId}`, [
      ['accept', '接受'], ['modify', '调整'], ['overturn', '推翻']
    ], draft[leafId]?.modelDisposition || 'modify');
    block.append(disposition.label);
    const override = labeledTextarea('推翻理由（仅推翻时必填）', `override-${leafId}`, draft[leafId]?.overrideReason || '');
    block.append(override.label);
    if (current.submitted) disableInputs(block);
    scoreLeaves.append(block);
  }
  draftStatus.textContent = current.submitted ? '已提交：评审记录不可修改。' : '草稿未保存。';
}

function scheduleDraft() {
  if (!current || current.submitted) return;
  draftStatus.textContent = '编辑中；将在停笔后保存草稿。';
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 700);
}

async function saveDraft() {
  if (!current || current.submitted) return;
  try {
    const response = await api(`/api/review-assignments/${encodeURIComponent(current.assignment.evaluationId)}/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'If-Match': current.etag },
      body: JSON.stringify(reviewPayload())
    });
    const payload = await response.json();
    if (response.status === 409) {
      draftStatus.textContent = '草稿版本冲突：请重新载入，系统不会覆盖另一处修改。';
      return;
    }
    if (!response.ok) throw new Error(payload.error || '草稿保存失败。');
    current.assignment = { ...current.assignment, ...payload };
    current.etag = response.headers.get('etag') || current.etag;
    draftStatus.textContent = '草稿已保存到服务端。';
  } catch (error) {
    draftStatus.textContent = error.message || '草稿保存失败。';
  }
}

async function submitReview(event) {
  event.preventDefault();
  formError.textContent = '';
  const payload = reviewPayload();
  const problems = validatePayload(payload);
  if (problems.length) {
    formError.textContent = problems.join('；');
    return;
  }
  if (!window.confirm('提交后评审不可修改。确认提交吗？')) return;
  try {
    const response = await api(`/api/review-assignments/${encodeURIComponent(current.assignment.evaluationId)}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '提交失败。');
    current.submitted = true;
    current.assignment.status = 'submitted';
    renderAssignment();
    setAccessState('评审已提交并锁定。');
  } catch (error) {
    formError.textContent = error.message || '提交失败。';
  }
}

async function recuseReview() {
  if (!window.confirm('确认申请回避？这会释放当前评审席。')) return;
  try {
    const response = await api(`/api/review-assignments/${encodeURIComponent(current.assignment.evaluationId)}/recuse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignmentId: current.assignment.assignmentId })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '回避申请失败。');
    current.assignment = { ...current.assignment, ...result };
    current.submitted = true;
    renderAssignment();
    setAccessState('已回避该委派。');
  } catch (error) {
    formError.textContent = error.message || '回避申请失败。';
  }
}

function reviewPayload() {
  const scores = {};
  for (const block of scoreLeaves.querySelectorAll('.leaf-form')) {
    const leafId = block.dataset.leaf;
    const evidenceIds = [...block.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    const modelReview = current.evaluation.absoluteReview?.modelPanel?.primary?.[0]?.reviews?.find((review) => review.subcriterionId === leafId);
    scores[leafId] = {
      score: Number(block.querySelector(`[id="score-${CSS.escape(leafId)}"]`).value),
      evidenceIds,
      checkEvidence: (modelReview?.checkEvidence || []).map((check) => ({ checkId: check.checkId, evidenceIds })),
      rationale: block.querySelector(`[id="rationale-${CSS.escape(leafId)}"]`).value.trim(),
      modelDisposition: block.querySelector(`[id="disposition-${CSS.escape(leafId)}"]`).value,
      overrideReason: block.querySelector(`[id="override-${CSS.escape(leafId)}"]`).value.trim()
    };
  }
  return { assignmentId: current.assignment.assignmentId, scores };
}

function validatePayload(payload) {
  const problems = [];
  for (const [leafId, score] of Object.entries(payload.scores)) {
    if (!Number.isInteger(score.score) || score.score < 0 || score.score > 100) problems.push(`${leafId} 需要 0–100 的整数评分`);
    if (!score.evidenceIds.length) problems.push(`${leafId} 至少引用一条证据`);
    if (!score.rationale) problems.push(`${leafId} 缺少评审理由`);
    if (score.modelDisposition === 'overturn' && !score.overrideReason) problems.push(`${leafId} 推翻模型结论时需说明原因`);
  }
  return problems;
}

function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${judgeToken}`);
  return fetch(path, { ...options, headers });
}
function option(value, label) { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; }
function text(tag, className, value) { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; }
function labeledInput(labelText, type, id) { const label = text('label', '', labelText); const input = document.createElement('input'); input.id = id; input.type = type; label.append(input); return { label, input }; }
function labeledTextarea(labelText, id, value) { const label = text('label', '', labelText); const input = document.createElement('textarea'); input.id = id; input.value = value; label.append(input); return { label, input }; }
function labeledSelect(labelText, id, choices, selected) { const label = text('label', '', labelText); const input = document.createElement('select'); input.id = id; for (const [value, name] of choices) { const choice = option(value, name); choice.selected = value === selected; input.append(choice); } label.append(input); return { label, input }; }
function disableInputs(root) { for (const input of root.querySelectorAll('input, select, textarea')) input.disabled = true; }
function setAccessState(message, isError = false) { accessStatus.textContent = message; accessStatus.style.color = isError ? '#a81b15' : ''; }
function median(values) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return '—'; return sorted[Math.floor(sorted.length / 2)]; }
