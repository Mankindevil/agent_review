const $ = (selector) => document.querySelector(selector);
const filters = ['test-type', 'test-id', 'repeat', 'turn', 'grade', 'kind'];
const query = new URLSearchParams(location.search);
const state = {
  evaluationId: decodeURIComponent(location.hash.slice(1)),
  items: [],
  accessToken: query.get('access') || ''
};

init();

async function init() {
  if (!state.evaluationId) return setStatus('缺少评测 ID。请从结果页打开证据回放。');
  try {
    const response = await fetch(`/api/evaluations/${encodeURIComponent(state.evaluationId)}/evidence-manifest`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '证据清单读取失败');
    state.items = Array.isArray(payload.items) ? payload.items : [];
    populateFilters();
    renderList();
  } catch (error) {
    setStatus(error.message);
  }
}

function populateFilters() {
  const fields = {
    'test-type': (item) => testType(item),
    'test-id': (item) => item.testId,
    repeat: (item) => item.repeatIndex,
    turn: (item) => item.turnIndex,
    grade: (item) => item.grade,
    kind: (item) => item.kind
  };
  for (const name of filters) {
    const select = $(`#evidence-filter-${name}`);
    const values = [...new Set(state.items.map(fields[name]).filter((value) => value !== null && value !== undefined))];
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      select.append(option);
    }
    select.addEventListener('change', renderList);
  }
}

function renderList() {
  const items = state.items.filter((item) => filters.every((name) => {
    const selected = $(`#evidence-filter-${name}`).value;
    if (!selected) return true;
    const value = ({
      'test-type': testType(item),
      'test-id': item.testId,
      repeat: item.repeatIndex,
      turn: item.turnIndex,
      grade: item.grade,
      kind: item.kind
    })[name];
    return String(value) === selected;
  }));
  const list = $('#evidence-list');
  list.replaceChildren();
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'evidence-item';
    button.textContent = `${item.grade} · ${item.kind} · ${item.testId} · R${item.repeatIndex ?? '—'} / T${item.turnIndex ?? '—'} · ${item.summary || '无摘要'}`;
    button.addEventListener('click', () => loadDetail(item));
    list.append(button);
  }
  setStatus(`显示 ${items.length} / ${state.items.length} 条脱敏证据。`);
}

async function loadDetail(item) {
  setStatus('正在读取并再次脱敏证据内容…');
  try {
    const response = await fetch(
      `/api/evaluations/${encodeURIComponent(state.evaluationId)}/evidence/${encodeURIComponent(item.evidenceId)}`,
      requestOptions()
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '证据内容读取失败');
    $('#evidence-detail').textContent = JSON.stringify(payload.item, null, 2);
    setStatus(`已加载 ${item.evidenceId}。`);
  } catch (error) {
    setStatus(error.message);
  }
}

function requestOptions() {
  return state.accessToken
    ? { headers: { authorization: `Bearer ${state.accessToken}` } }
    : {};
}

function testType(item) {
  return String(item.kind || '').split('-')[0] || 'unknown';
}

function setStatus(value) {
  $('#evidence-status').textContent = value;
}
