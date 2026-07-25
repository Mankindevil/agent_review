const queueStatus = document.querySelector('#queue-status');
const queueList = document.querySelector('#queue-list');
const cardTemplate = document.querySelector('#queue-card-template');
const leafTemplate = document.querySelector('#queue-leaf-template');

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
  if (!items.length) {
    queueStatus.textContent = '当前没有等待人工复核的评测。';
    return;
  }
  queueStatus.textContent = `共 ${items.length} 项等待人工复核。`;
  for (const item of items) queueList.append(renderCard(item));
}

function renderCard(item) {
  const fragment = cardTemplate.content.cloneNode(true);
  const root = fragment.querySelector('.queue-card');
  fragment.querySelector('.queue-card-id').textContent = `EVAL / ${item.id}`;
  fragment.querySelector('.queue-card-view').href = `/#/evaluation/${encodeURIComponent(item.id)}`;
  fragment.querySelector('.queue-card-dimensions').replaceChildren(renderDimensions(item));
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
  fragment.querySelector('.leaf-name').textContent = leafId;
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
