const $ = (selector) => document.querySelector(selector);
const state = { evaluationId: location.hash.slice(1), resultVersions: [] };

$('#appeal-form').addEventListener('submit', submitAppeal);
$('#load-appeals').addEventListener('click', loadAppeals);
$('#evaluation-id').addEventListener('change', async (event) => {
  state.evaluationId = event.target.value.trim();
  await loadConcreteTargets();
});
if (state.evaluationId) $('#evaluation-id').value = state.evaluationId;

async function submitAppeal(event) {
  event.preventDefault();
  const evaluationId = $('#evaluation-id').value.trim();
  const target = parseTarget();
  const payload = {
    target,
    grounds: $('#grounds').value,
    statement: $('#statement').value,
    evidenceIds: $('#evidence-ids').value.split(',').map((value) => value.trim()).filter(Boolean)
  };
  try {
    const response = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/appeals`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '申诉未能提交');
    $('#status').textContent = `申诉已记录：${result.appealId}`;
    await loadAppeals();
  } catch (error) {
    $('#status').textContent = error.message;
  }
}

function parseTarget() {
  const [kind, id, ...path] = $('#target').value.split(':');
  if (!kind || !id || !path.length) throw new Error('请选择具体测试、证据或分数路径');
  return { kind, id, path: path.join(':') };
}

async function loadAppeals() {
  const evaluationId = $('#evaluation-id').value.trim();
  if (!evaluationId) return;
  try {
    const response = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/appeals`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法读取申诉');
    $('#timeline').innerHTML = result.appeals.length
      ? result.appeals.map(renderAppeal).join('')
      : '<p>尚无申诉记录。</p>';
  } catch (error) {
    $('#timeline').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

async function loadConcreteTargets() {
  const evaluationId = $('#evaluation-id').value.trim();
  if (!evaluationId) return;
  const response = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}`);
  const item = await response.json();
  if (!response.ok) throw new Error(item.error || '无法读取评测目标');
  const targets = item.appealTargets || {};
  state.resultVersions = item.resultV2?.resultVersions || [];
  const tests = targets.tests || [];
  const evidence = targets.evidence || [];
  const options = [
    '<option value="">选择具体路径</option>',
    ...tests.map((item) => option('test', item.id, item.path, `测试：${item.id}`)),
    ...evidence.map((item) => option('evidence', item.id, item.path, `证据：${item.id}`)),
    targets.score ? option('score', targets.score.id, targets.score.path, '绝对分') : ''
  ];
  $('#target').innerHTML = options.join('');
}

function option(kind, id, path, label) {
  if (!id) return '';
  return `<option value="${escapeHtml(`${kind}:${id}:${path}`)}">${escapeHtml(label)}</option>`;
}

function renderAppeal(appeal) {
  const events = (appeal.events || []).map((event) =>
    `<li><b>${escapeHtml(event.type)}</b><time>${escapeHtml(event.at)}</time></li>`
  ).join('');
  const before = appeal.originalSnapshot?.resultHash || '—';
  const version = appeal.resultVersion ||
    state.resultVersions.find((item) => item.reason === `appeal:${appeal.appealId}`);
  const after = version?.afterResultHash || version?.resultHash || '—';
  return `<article><header><small>APPEAL ${escapeHtml(appeal.appealId)}</small><b>${escapeHtml(appeal.status)}</b></header>
    <p>${escapeHtml(appeal.statement)}</p>
    <p class="comparison">原锁定结果：${escapeHtml(version?.beforeResultHash || before)}<br>申诉后版本：${escapeHtml(after)}<br>后续版本仅会在受控重算完成后追加，原始运行不覆盖。</p>
    <ol>${events}</ol></article>`;
}

function headers() {
  return {
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID()
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

if (state.evaluationId) loadConcreteTargets().catch(() => {});
