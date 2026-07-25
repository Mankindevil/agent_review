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

function renderReplicaCard(item) {
  const fragment = replicaCardTemplate.content.cloneNode(true);
  const root = fragment.querySelector('.queue-card-replica');
  fragment.querySelector('.queue-card-id').textContent = `EVAL / ${item.id}`;
  fragment.querySelector('.queue-card-view').href = `/#/evaluation/${encodeURIComponent(item.id)}`;
  const form = fragment.querySelector('[data-role="replica-score-form"]');
  const sources = item.replicaHumanReview?.requiredSources || [];
  form.querySelector('.replica-source-list').replaceChildren(...sources.map((sourceId) => renderReplicaSource(sourceId)));
  form.addEventListener('submit', (event) => submitReplicaReview(event, item, form, root));
  return fragment;
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
    await tryLockReplicaHumanReview(item.id);
    cardRoot.classList.add('queue-card-resolved');
    form.classList.add('hidden');
    cardRoot.querySelector('.queue-card-replica-hint').replaceChildren(
      document.createTextNode('复刻人工打分已提交，达到所需人数后自动锁定该轨道。')
    );
    setTimeout(loadQueue, 800);
  } catch (error) {
    errorBox.textContent = error.message || '提交失败。';
  } finally {
    submitButton.disabled = false;
  }
}

// Open-review desk: with the default `requiredPrimaries: 1` a single
// submission already satisfies the replica-human gate, so the desk tries to
// lock right after every submit. This is a best-effort call — the server
// rejects it harmlessly when more primaries (or arbitration) are still
// required, and the queue simply keeps the card open for the next reviewer.
async function tryLockReplicaHumanReview(evaluationId) {
  try {
    await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/replica-human-reviews/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({})
    });
  } catch {
    // Ignored — see comment above.
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
