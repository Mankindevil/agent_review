import { labelLeaf } from '/rubric-labels.js';

const queueStatus = document.querySelector('#queue-status');
const queueList = document.querySelector('#queue-list');
const cardTemplate = document.querySelector('#queue-card-template');
const leafTemplate = document.querySelector('#queue-leaf-template');
const replicaCardTemplate = document.querySelector('#queue-replica-card-template');
const replicaSourceTemplate = document.querySelector('#queue-replica-source-template');

loadQueue();

async function loadQueue() {
  queueStatus.textContent = '正在读取列表…';
  try {
    const response = await fetch('/api/review-queue');
    const items = await response.json();
    if (!response.ok) throw new Error(items.error || '无法读取待复核列表。');
    renderQueue(items);
  } catch (error) {
    queueStatus.textContent = error.message || '读取列表失败。';
  }
}

function renderQueue(items) {
  queueList.replaceChildren();
  const cards = items.flatMap((item) => {
    const nodes = [];
    if (item.governance?.phase === 'human_open') nodes.push(renderCard(item));
    if (item.replicaHumanReview?.trackPhase === 'open') nodes.push(renderReplicaCard(item));
    return nodes;
  });
  if (!cards.length) {
    queueStatus.textContent = '当前没有等待人工复核的评测。';
    return;
  }
  queueStatus.textContent = `共 ${cards.length} 项等待人工复核。`;
  for (const card of cards) queueList.append(card);
}

function renderCard(item) {
  const fragment = cardTemplate.content.cloneNode(true);
  const root = fragment.querySelector('.queue-card');
  fragment.querySelector('.queue-card-id').textContent = `EVAL / ${item.id}`;
  fragment.querySelector('.queue-card-view').href = `/#/evaluation/${encodeURIComponent(item.id)}`;
  fragment.querySelector('.queue-card-dimensions').replaceChildren(renderDimensions(item));
  const dossierMount = fragment.querySelector('[data-role="absolute-dossier"]');
  dossierMount.replaceChildren(renderAbsoluteDossier(item.reviewDossier?.absolute));
  const toggle = fragment.querySelector('[data-action="toggle-score"]');
  const skip = fragment.querySelector('[data-action="skip"]');
  const form = fragment.querySelector('[data-role="score-form"]');
  const leaves = applicableLeaves(item);
  form.querySelector('.queue-card-leaves').replaceChildren(...leaves.map((leafId) => renderLeaf(leafId)));
  toggle.addEventListener('click', () => {
    form.classList.toggle('hidden');
    toggle.textContent = form.classList.contains('hidden') ? '展开打分' : '收起打分';
  });
  skip.addEventListener('click', () => skipHumanReview(item.id, skip, root));
  form.addEventListener('submit', (event) => submitHumanReview(event, item, form, root));
  return fragment;
}

function renderDimensions(item) {
  const dimensions = item.absoluteReview?.modelPanel?.dimensions || {};
  const list = document.createElement('ul');
  list.className = 'queue-card-dimension-list';
  const labels = { scenarioValue: '任务价值', professionalism: '专业度', agentCapability: 'Agent 能力' };
  for (const [key, label] of Object.entries(labels)) {
    const score = dimensions[key]?.score;
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('b');
    strong.textContent = Number.isFinite(score) ? String(Math.round(score * 100) / 100) : '—';
    li.append(span, strong);
    list.append(li);
  }
  return list;
}

function applicableLeaves(item) {
  return (item.absoluteReview?.modelPanel?.primary?.[0]?.reviews || [])
    .map((review) => review.subcriterionId)
    .filter(Boolean);
}

function renderLeaf(leafId) {
  const fragment = leafTemplate.content.cloneNode(true);
  const root = fragment.querySelector('.leaf-form');
  root.dataset.leaf = leafId;
  fragment.querySelector('.leaf-name').textContent = labelLeaf(leafId);
  const disposition = fragment.querySelector('.leaf-disposition');
  const overrideLabel = fragment.querySelector('.leaf-override-label');
  disposition.addEventListener('change', () => {
    overrideLabel.classList.toggle('hidden', disposition.value !== 'overturn');
  });
  return fragment;
}

async function skipHumanReview(evaluationId, button, cardRoot) {
  if (button.disabled) return;
  button.disabled = true;
  const idle = button.textContent;
  button.textContent = '正在跳过…';
  try {
    const response = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/skip-human-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({})
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '跳过人工打分失败。');
    cardRoot.classList.add('queue-card-resolved');
    cardRoot.querySelector('.queue-card-actions').replaceChildren(document.createTextNode('已跳过人工打分，终审已锁定。'));
    setTimeout(loadQueue, 800);
  } catch (error) {
    button.disabled = false;
    button.textContent = idle;
    alert(error.message || '跳过人工打分失败。');
  }
}

function renderReplicaCard(item) {
  const fragment = replicaCardTemplate.content.cloneNode(true);
  const root = fragment.querySelector('.queue-card-replica');
  fragment.querySelector('.queue-card-id').textContent = `EVAL / ${item.id}`;
  fragment.querySelector('.queue-card-view').href = `/#/evaluation/${encodeURIComponent(item.id)}`;
  const dossierMount = fragment.querySelector('[data-role="replica-dossier"]');
  dossierMount.replaceChildren(renderReplicaDossier(item.reviewDossier?.replica));
  const form = fragment.querySelector('[data-role="replica-score-form"]');
  const sources = item.replicaHumanReview?.requiredSources || [];
  form.querySelector('.replica-source-list').replaceChildren(...sources.map((sourceId) => renderReplicaSource(sourceId)));
  form.addEventListener('submit', (event) => submitReplicaReview(event, item, form, root));
  return fragment;
}

function renderAbsoluteDossier(absolute) {
  const section = document.createElement('section');
  section.className = 'review-dossier-block';
  const heading = document.createElement('h3');
  heading.textContent = '模型对照';
  section.append(heading);
  if (!absolute?.leaves?.length) {
    const empty = document.createElement('p');
    empty.className = 'review-dossier-empty';
    empty.textContent = '暂无已锁定的模型叶子意见。';
    section.append(empty);
    return section;
  }
  for (const leaf of absolute.leaves) {
    const details = document.createElement('details');
    details.className = 'review-dossier-leaf';
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = labelLeaf(leaf.subcriterionId);
    details.append(summary);
    const seats = document.createElement('div');
    seats.className = 'review-dossier-seats';
    for (const seat of leaf.seats || []) {
      const card = document.createElement('article');
      card.className = 'review-dossier-seat';
      const title = document.createElement('b');
      title.textContent = seat.name || seat.seatId || '席位';
      const score = document.createElement('span');
      score.textContent = Number.isFinite(seat.score) ? String(Math.round(seat.score)) : '—';
      const finding = document.createElement('p');
      finding.textContent = seat.finding || '（无评语）';
      card.append(title, score, finding);
      seats.append(card);
    }
    details.append(seats);
    section.append(details);
  }
  return section;
}

function renderReplicaDossier(replica) {
  const wrap = document.createElement('details');
  wrap.className = 'review-dossier-block review-dossier-collapsible';
  const heading = document.createElement('summary');
  heading.textContent = '同题对照（点击展开材料）';
  wrap.append(heading);
  if (replica?.error) {
    const error = document.createElement('p');
    error.className = 'review-dossier-error';
    error.textContent = `材料不可用：${replica.error}`;
    wrap.append(error);
    return wrap;
  }
  if (!replica?.cases?.length) {
    const empty = document.createElement('p');
    empty.className = 'review-dossier-empty';
    empty.textContent = '暂无同题输出材料。';
    wrap.append(empty);
    return wrap;
  }
  const count = document.createElement('p');
  count.className = 'review-dossier-empty';
  count.textContent = `共 ${replica.cases.length} 道同题，展开后可对照匿名输出再打分。`;
  wrap.append(count);
  for (const item of replica.cases) {
    const caseBlock = document.createElement('article');
    caseBlock.className = 'review-dossier-case';
    const title = document.createElement('h4');
    title.textContent = item.title || item.testId || '题目';
    const prompt = document.createElement('p');
    prompt.className = 'review-dossier-prompt';
    prompt.textContent = item.prompt || '（无题干）';
    caseBlock.append(title, prompt);
    for (const source of item.sources || []) {
      const details = document.createElement('details');
      details.className = 'review-dossier-source';
      const summary = document.createElement('summary');
      const label = source.label
        || (source.sourceId === 'submitted' ? '提交 Agent' : source.sourceId);
      summary.textContent = source.truncated ? `${label}（已截断）` : label;
      const pre = document.createElement('pre');
      pre.textContent = source.text || '（空输出）';
      details.append(summary, pre);
      caseBlock.append(details);
    }
    wrap.append(caseBlock);
  }
  return wrap;
}

function renderReplicaSource(sourceId) {
  const fragment = replicaSourceTemplate.content.cloneNode(true);
  const root = fragment.querySelector('.replica-source-form');
  root.dataset.source = sourceId;
  fragment.querySelector('.leaf-name').textContent = sourceId === 'submitted' ? '提交 Agent' : sourceId;
  return fragment;
}

async function submitReplicaReview(event, item, form, cardRoot) {
  event.preventDefault();
  const errorBox = form.querySelector('.queue-card-error');
  errorBox.textContent = '';
  const missing = [...form.querySelectorAll('.replica-dim')].filter((input) => {
    const value = Number(input.value);
    return input.value === '' || !Number.isFinite(value) || value < 0 || value > 100;
  });
  if (missing.length) {
    errorBox.textContent = `请先填齐全部 ${missing.length} 个分数（0–100）再提交。`;
    missing[0].focus();
    return;
  }
  const scores = {};
  for (const sourceForm of form.querySelectorAll('.replica-source-form')) {
    const sourceId = sourceForm.dataset.source;
    const dimensions = {};
    for (const input of sourceForm.querySelectorAll('.replica-dim')) {
      dimensions[input.dataset.dim] = Number(input.value);
    }
    scores[sourceId] = dimensions;
  }
  const rationale = form.querySelector('.replica-rationale').value.trim();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await fetch(`/api/evaluations/${encodeURIComponent(item.id)}/replica-human-reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scores, ...(rationale ? { rationale } : {}) })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '提交失败。');
    const lock = await tryLockReplicaHumanReview(item.id);
    cardRoot.classList.add('queue-card-resolved');
    form.classList.add('hidden');
    let hint = '复刻人工打分已提交。';
    if (!lock.ok) {
      hint = `复刻人工打分已提交，但锁定失败：${lock.error || '未知错误'}。请刷新后重试。`;
    } else if (lock.finalizePending) {
      hint = `复刻人工轨道已锁定；终审结算暂未完成（${lock.finalizeError || '可稍后在详情页重试结算'}）。`;
    } else {
      hint = '复刻人工打分已提交并锁定该轨道。';
    }
    cardRoot.querySelector('.queue-card-replica-hint').replaceChildren(
      document.createTextNode(hint)
    );
    if (lock.ok) setTimeout(loadQueue, 800);
  } catch (error) {
    errorBox.textContent = error.message || '提交失败。';
  } finally {
    submitButton.disabled = false;
  }
}

// Open-review desk: with the default `requiredPrimaries: 1` a single
// submission already satisfies the replica-human gate, so the desk tries to
// lock right after every submit.
async function tryLockReplicaHumanReview(evaluationId) {
  try {
    const response = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/replica-human-reviews/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: payload.error || `HTTP ${response.status}` };
    }
    return {
      ok: true,
      finalizePending: Boolean(payload.finalizePending),
      finalizeError: payload.finalizeError || null
    };
  } catch (error) {
    return { ok: false, error: error.message || '锁定请求失败' };
  }
}

async function submitHumanReview(event, item, form, cardRoot) {
  event.preventDefault();
  const errorBox = form.querySelector('.queue-card-error');
  errorBox.textContent = '';
  const scores = {};
  for (const leaf of form.querySelectorAll('.leaf-form')) {
    const leafId = leaf.dataset.leaf;
    const modelReview = item.absoluteReview?.modelPanel?.primary?.[0]?.reviews
      ?.find((review) => review.subcriterionId === leafId);
    const evidenceIds = leaf.querySelector('.leaf-evidence').value
      .split(',').map((value) => value.trim()).filter(Boolean);
    const modelDisposition = leaf.querySelector('.leaf-disposition').value;
    scores[leafId] = {
      score: Number(leaf.querySelector('.leaf-score').value),
      evidenceIds,
      checkEvidence: (modelReview?.checkEvidence || []).map((check) => ({
        checkId: check.checkId,
        evidenceIds: []
      })),
      rationale: leaf.querySelector('.leaf-rationale').value.trim(),
      modelDisposition,
      overrideReason: leaf.querySelector('.leaf-override').value.trim()
    };
  }
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await fetch(`/api/evaluations/${encodeURIComponent(item.id)}/human-reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scores })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '提交失败。');
    cardRoot.classList.add('queue-card-resolved');
    form.classList.add('hidden');
    cardRoot.querySelector('.queue-card-actions').replaceChildren(document.createTextNode('人工打分已提交，终审已锁定。'));
    setTimeout(loadQueue, 800);
  } catch (error) {
    errorBox.textContent = error.message || '提交失败。';
  } finally {
    submitButton.disabled = false;
  }
}
