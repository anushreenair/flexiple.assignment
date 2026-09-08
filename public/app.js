// Frontend logic — vanilla ES modules, no framework, no build step.
// Screens: search -> thinking -> workspace (results + chat + live spec) -> frozen.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  session: null,          // last serialized session from server
  pendingVerdicts: {},    // profile_id -> 'yes' | 'no' (not yet submitted)
  editingSpec: false,
  busy: false,
  thinkingTimer: null,
};

// ---------------- screen management ----------------
const SCREENS = ['screen-search', 'screen-thinking', 'screen-workspace', 'screen-frozen'];
function showScreen(id) {
  for (const s of SCREENS) $('#' + s).classList.toggle('hidden', s !== id);
}

// ---------------- thinking screen ----------------
const THINK_STEPS_SEARCH = [
  'Reading your requirement…',
  'Generating objective filters…',
  'Writing the fit rubric…',
  'Applying filters to the talent pool…',
  'Scoring matches against the rubric…',
  'Writing explanations…',
];
const THINK_STEPS_REFINE = [
  'Interpreting your feedback…',
  'Deciding what to change in the filters & rubric…',
  'Re-running the search…',
  'Re-scoring profiles…',
];

function startThinking(steps, title) {
  $('#thinking-title').textContent = title;
  const list = $('#thinking-steps');
  list.innerHTML = '';
  steps.forEach((s, i) => {
    const li = el('li', i === 0 ? 'active' : '');
    li.append(el('span', 'step-mark', i === 0 ? '▶' : '·'), el('span', null, s));
    list.append(li);
  });
  // Walk the steps on a timer for a sense of progress (server does the real work).
  let idx = 0;
  const secs = $('#thinking-seconds');
  let t = 0;
  secs.textContent = '0';
  clearInterval(state.thinkingTimer);
  state.thinkingTimer = setInterval(() => {
    t += 1;
    secs.textContent = String(t);
    if (t % 4 === 0 && idx < steps.length - 1) {
      idx += 1;
      [...list.children].forEach((li, i) => {
        li.className = i < idx ? 'done' : i === idx ? 'active' : '';
        li.querySelector('.step-mark').textContent = i < idx ? '✓' : i === idx ? '▶' : '·';
      });
    }
  }, 1000);
  showScreen('screen-thinking');
}
function stopThinking() { clearInterval(state.thinkingTimer); }

// ---------------- toast ----------------
let toastTimer = null;
function toast(msg, ms = 6000) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(el('span', null, msg));
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------------- API ----------------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.retryable = !!data.retryable;
    err.hint = data.hint;
    throw err;
  }
  return data;
}

// ---------------- rendering: spec panel ----------------
function specTag(text, soft = false) {
  return el('span', soft ? 'spec-tag soft' : 'spec-tag', text);
}

function renderFiltersView(container, filters) {
  container.innerHTML = '';
  if (!filters) {
    container.append(el('div', 'spec-none', 'No objective filters — the whole pool is scored on the rubric alone.'));
    return;
  }
  const group = (title, node) => {
    const g = el('div', 'spec-group');
    g.append(el('div', 'spec-group-title', title), node);
    container.append(g);
  };

  if (filters.skills) {
    const tags = el('div', 'spec-tags');
    (filters.skills.must_have || []).forEach((s) => tags.append(specTag(s)));
    (filters.skills.nice_to_have || []).forEach((s) => tags.append(specTag(s, true)));
    if (!tags.children.length) group('Skills', el('div', 'spec-none', '—'));
    else group('Skills (dashed = nice-to-have, scoring only)', tags);
  }
  if (filters.years_experience) {
    const { min, max } = filters.years_experience;
    const txt = min != null && max != null ? `${min} – ${max} years`
      : min != null ? `≥ ${min} years` : `≤ ${max} years`;
    group('Experience', el('div', 'spec-value', txt));
  }
  if (filters.locations) {
    const tags = el('div', 'spec-tags');
    (filters.locations.values || []).forEach((l) => tags.append(specTag(l)));
    if (filters.locations.allow_remote) tags.append(specTag('Remote OK', true));
    group('Location', tags);
  }
  if (filters.company_types && filters.company_types.values.length) {
    const scopeLabel = { any: 'any time', current: 'currently', past: 'previously' }[filters.company_types.scope || 'any'];
    const tags = el('div', 'spec-tags');
    filters.company_types.values.forEach((c) => tags.append(specTag(c)));
    group(`Company background · ${scopeLabel}`, tags);
  }
  if (filters.title_keywords?.length) {
    const tags = el('div', 'spec-tags');
    filters.title_keywords.forEach((k) => tags.append(specTag(k)));
    group('Title contains any of', tags);
  }
  if (filters.education_keywords?.length) {
    const tags = el('div', 'spec-tags');
    filters.education_keywords.forEach((k) => tags.append(specTag(k)));
    group('Education contains any of', tags);
  }
}

function renderRubricView(container, rubric) {
  container.innerHTML = '';
  if (!rubric) return;
  container.append(el('div', 'rubric-ideal', `“${rubric.ideal_profile}”`));
  for (const c of rubric.criteria || []) {
    const crit = el('div', 'criterion');
    const head = el('div', 'criterion-head');
    head.append(el('span', 'criterion-name', c.name));
    const dots = el('span', 'weight-dots');
    for (let i = 1; i <= 5; i++) dots.append(el('span', i <= c.weight ? 'weight-dot on' : 'weight-dot'));
    head.append(dots);
    crit.append(head, el('div', 'criterion-desc', c.description));
    container.append(crit);
  }
}

function renderSpecPanel() {
  const view = $('#spec-view');
  view.innerHTML = '';
  const spec = state.session?.spec;
  const fg = el('div');
  const rg = el('div');
  view.append(fg);
  fg.append(el('div', 'spec-group-title', 'OBJECTIVE FILTERS'));
  const fbox = el('div');
  fg.append(fbox);
  renderFiltersView(fbox, spec?.filters);
  rg.append(el('div', 'spec-group-title', 'FIT RUBRIC'));
  const rbox = el('div');
  rg.append(rbox);
  renderRubricView(rbox, spec?.rubric);
  view.append(rg);
  $('#btn-edit-spec').disabled = state.session?.status === 'frozen';
}

// ---------------- rendering: spec editor ----------------
function openSpecEditor() {
  const spec = state.session.spec;
  const ed = $('#spec-editor');
  ed.innerHTML = '';
  state.editingSpec = true;
  $('#spec-view').classList.add('hidden');
  ed.classList.remove('hidden');

  const f = spec.filters || {};
  const field = (label, value, attrs = {}) => {
    const g = el('div', 'spec-editor-group');
    g.append(el('label', null, label));
    const inp = el('input', null);
    inp.type = 'text';
    inp.value = value ?? '';
    Object.assign(inp, attrs);
    g.append(inp);
    return { node: g, input: inp };
  };

  const mustSkills = field('Must-have skills (comma-separated)', (f.skills?.must_have || []).join(', '));
  const niceSkills = field('Nice-to-have skills', (f.skills?.nice_to_have || []).join(', '));
  const yMin = field('Min years', f.years_experience?.min ?? '');
  const yMax = field('Max years', f.years_experience?.max ?? '');
  const locs = field('Locations (comma-separated)', (f.locations?.values || []).join(', '));
  const remote = el('div', 'spec-editor-group');
  const remoteLabel = el('label', null, 'Options');
  const remoteChk = el('input'); remoteChk.type = 'checkbox'; remoteChk.checked = !!f.locations?.allow_remote;
  remote.append(remoteLabel);
  const remoteWrap = el('label', null); remoteWrap.style.cssText = 'font-size:13px;text-transform:none;font-weight:400;letter-spacing:0;display:flex;gap:6px;align-items:center;color:var(--ink)';
  remoteWrap.append(remoteChk, el('span', null, 'Allow remote'));
  remote.append(remoteWrap);
  const cTypes = field('Company types (startup, scaleup, enterprise, agency)', (f.company_types?.values || []).join(', '));
  const cScope = el('div', 'spec-editor-group');
  cScope.append(el('label', null, 'Company type scope'));
  const scopeSel = el('select');
  for (const [v, l] of [['any', 'any time (current or past)'], ['current', 'currently at'], ['past', 'previously at']]) {
    const o = el('option', null, l); o.value = v; scopeSel.append(o);
  }
  scopeSel.value = f.company_types?.scope || 'any';
  scopeSel.style.cssText = 'width:100%;font:inherit;font-size:13px;padding:6px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card)';
  cScope.append(scopeSel);
  const titleKw = field('Title keywords', (f.title_keywords || []).join(', '));
  const eduKw = field('Education keywords', (f.education_keywords || []).join(', '));

  const ideal = el('div', 'spec-editor-group');
  ideal.append(el('label', null, 'Rubric · ideal profile'));
  const idealTa = el('textarea'); idealTa.value = spec.rubric?.ideal_profile || '';
  ideal.append(idealTa);

  const critTa = el('div', 'spec-editor-group');
  critTa.append(el('label', null, 'Rubric · criteria (one per line: name | description | weight 1-5)'));
  const critInput = el('textarea');
  critInput.style.minHeight = '120px';
  critInput.value = (spec.rubric?.criteria || []).map((c) => `${c.name} | ${c.description} | ${c.weight}`).join('\n');
  critTa.append(critInput);

  const errP = el('p', 'editor-error hidden');
  const actions = el('div', 'spec-editor-actions');
  const cancelBtn = el('button', 'btn btn-ghost', 'Cancel');
  const saveBtn = el('button', 'btn btn-primary', 'Save & re-run');
  actions.append(cancelBtn, saveBtn);

  const yearsRow = el('div', 'spec-row');
  yearsRow.append(yMin.node, yMax.node);

  ed.append(
    mustSkills.node, niceSkills.node, yearsRow, locs.node, remote,
    cTypes.node, cScope, titleKw.node, eduKw.node,
    ideal, critTa, errP, actions,
  );

  cancelBtn.onclick = closeSpecEditor;
  saveBtn.onclick = async () => {
    const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
    const intOrNull = (s) => (String(s).trim() === '' ? null : Number(s));
    const criteria = [];
    for (const line of critInput.value.split('\n')) {
      if (!line.trim()) continue;
      const [name, description, w] = line.split('|').map((x) => (x || '').trim());
      if (!name || !description) {
        errP.textContent = 'Each criterion line needs: name | description | weight';
        errP.classList.remove('hidden');
        return;
      }
      criteria.push({ name, description, weight: Math.min(5, Math.max(1, intOrNull(w) ?? 3)) });
    }
    if (!criteria.length) {
      errP.textContent = 'The rubric needs at least one criterion.';
      errP.classList.remove('hidden');
      return;
    }
    const newSpec = {
      filters: {
        skills: { must_have: csv(mustSkills.input.value), nice_to_have: csv(niceSkills.input.value) },
        years_experience: { min: intOrNull(yMin.input.value), max: intOrNull(yMax.input.value) },
        locations: { values: csv(locs.input.value), allow_remote: remoteChk.checked },
        company_types: { values: csv(cTypes.input.value).map((v) => v.toLowerCase()), scope: scopeSel.value },
        title_keywords: csv(titleKw.input.value),
        education_keywords: csv(eduKw.input.value),
      },
      rubric: { ideal_profile: idealTa.value.trim(), criteria },
    };
    saveBtn.disabled = true;
    try {
      const { session } = await api('PUT', `/api/session/${state.session.id}/spec`, { spec: newSpec });
      closeSpecEditor();
      onSessionUpdate(session, 'Re-running with your edits…');
    } catch (err) {
      errP.textContent = err.message;
      errP.classList.remove('hidden');
      saveBtn.disabled = false;
    }
  };
}

function closeSpecEditor() {
  state.editingSpec = false;
  $('#spec-editor').classList.add('hidden');
  $('#spec-editor').innerHTML = '';
  $('#spec-view').classList.remove('hidden');
}

// ---------------- rendering: chat feed ----------------
function isCriteriaArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every((c) => c && typeof c === 'object' && typeof c.name === 'string' && Number.isFinite(c.weight));
}
function criteriaDiff(before, after) {
  const b = new Map((before || []).map((c) => [c.name, c.weight]));
  const a = new Map((after || []).map((c) => [c.name, c.weight]));
  const parts = [];
  for (const [name, w] of a) if (!b.has(name)) parts.push(`+ ${name} (w${w})`);
  for (const [name] of b) if (!a.has(name)) parts.push(`− ${name}`);
  for (const [name, w] of a) if (b.has(name) && b.get(name) !== w) parts.push(`${name}: w${b.get(name)}→w${w}`);
  if (!parts.length) parts.push('criteria rebalanced');
  return parts;
}
function renderFeed() {
  const feed = $('#feed');
  feed.innerHTML = '';
  const chat = state.session.chat || [];
  // Show at most the last 8 messages to keep the workspace tight; the important
  // state (spec + results) is always visible elsewhere.
  for (const m of chat.slice(-8)) {
    const node = el('div', `msg msg-${m.role}${m.kind === 'error' ? ' msg-error' : ''}`);
    if (m.role === 'app') {
      const kindLabel = {
        spec_created: 'Spec ready',
        results: `Round ${state.session.round >= 1 ? 'results' : ''}`,
        manual_edit: 'Spec updated',
        refined: 'Refined',
        frozen: 'Search frozen',
        error: 'Something went wrong',
      }[m.kind] || 'Update';
      const kindNode = el('div', `msg-kind${m.kind === 'frozen' ? ' frozen' : ''}${m.kind === 'error' ? ' error' : ''}`, kindLabel);
      node.append(kindNode);
    }
    node.append(el('div', 'msg-text', m.text));
    if (m.changes?.length) {
      const box = el('div', 'msg-changes');
      for (const c of m.changes) {
        const row = el('div', 'change');
        row.append(el('span', 'change-field', c.field));
        if (isCriteriaArray(c.before) && isCriteriaArray(c.after)) {
          const delta = el('div', 'change-delta');
          for (const part of criteriaDiff(c.before, c.after)) delta.append(el('div', 'after', part));
          row.append(delta);
        } else {
          const delta = el('div', 'change-delta');
          if (c.before != null) delta.append(el('span', 'before', fmtVal(c.before)));
          delta.append(el('span', 'after', fmtVal(c.after)));
          row.append(delta);
        }
        row.append(el('div', 'change-why', c.why));
        box.append(row);
      }
      node.append(box);
    }
    feed.append(node);
  }
}
function fmtVal(v) {
  if (v == null) return '—';
  if (Array.isArray(v)) {
    if (isCriteriaArray(v)) return v.map((c) => `${c.name} (w${c.weight})`).join(', ');
    return JSON.stringify(v);
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------- rendering: results ----------------
function scoreClass(verdict, score) {
  if (verdict === 'strong' || score >= 70) return 'score-strong';
  if (verdict === 'partial' || score >= 40) return 'score-partial';
  return 'score-weak';
}

function renderProfileCard(r, { interactive = true } = {}) {
  const p = r.profile;
  const card = el('div', 'profile-card');
  card.dataset.pid = p.id;
  const verdict = state.pendingVerdicts[p.id] || (state.session.verdicts || {})[p.id];
  if (verdict === 'yes') card.classList.add('verdict-yes');
  if (verdict === 'no') card.classList.add('verdict-no');

  card.append(el('div', 'pc-rank', `#${r.rank}`));

  const main = el('div', 'pc-main');
  const nameLine = el('div', 'pc-name-line');
  nameLine.append(el('span', 'pc-name', p.name), el('span', 'pc-title', p.current_title));
  const facts = el('div', 'pc-facts');
  const fact = (label, val) => { const f = el('span', 'fact'); f.append(el('b', null, label + ' '), document.createTextNode(val)); return f; };
  facts.append(
    fact(`${p.years_experience}y`, 'exp'),
    fact('', p.location),
    fact('', `${p.current_company_type} · ${p.current_company}`),
  );
  const skills = el('div', 'pc-skills');
  p.skills.forEach((s) => skills.append(el('span', 'skill', s)));
  const explain = el('div', 'pc-explain');
  explain.append(el('span', 'explain-label', 'Why it matched'), el('span', null, r.explanation));
  main.append(nameLine, facts, skills, explain);
  if (r.citations?.length) {
    const cites = el('div', 'pc-cites');
    for (const c of r.citations) {
      const cite = el('span', 'cite verified');
      cite.append(el('span', 'cite-field', c.field), document.createTextNode(c.value));
      cite.title = 'Verified against the profile data';
      cites.append(cite);
    }
    main.append(cites);
  }
  card.append(main);

  const scoreBox = el('div', 'pc-score');
  const badge = el('div', `score-badge ${scoreClass(r.verdict, r.score)}`);
  badge.append(document.createTextNode(String(r.score)), el('small', null, '/100'));
  scoreBox.append(badge, el('span', 'verdict-label', r.verdict + ' fit'));
  card.append(scoreBox);

  if (interactive) {
    const vBox = el('div', 'pc-verdicts');
    const yesBtn = el('button', 'vbtn' + (verdict === 'yes' ? ' on-yes' : ''), '✓');
    const noBtn = el('button', 'vbtn' + (verdict === 'no' ? ' on-no' : ''), '✗');
    yesBtn.title = 'This matches'; noBtn.title = 'This does not match';
    yesBtn.onclick = () => setVerdict(p.id, verdict === 'yes' ? null : 'yes');
    noBtn.onclick = () => setVerdict(p.id, verdict === 'no' ? null : 'no');
    vBox.append(yesBtn, noBtn);
    card.append(vBox);
  }
  return card;
}

function setVerdict(pid, v) {
  if (v == null) delete state.pendingVerdicts[pid];
  else state.pendingVerdicts[pid] = v;
  renderResults();
  renderComposerVerdicts();
}

function renderComposerVerdicts() {
  const box = $('#composer-verdicts');
  box.innerHTML = '';
  const entries = Object.entries(state.pendingVerdicts);
  if (!entries.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  for (const [pid, v] of entries) {
    const r = (state.session.results || []).find((x) => x.profile_id === pid);
    const name = r ? r.profile.name : pid;
    box.append(el('span', `verdict-pill ${v}`, `${v === 'yes' ? '✓' : '✗'} ${name}`));
  }
}

function renderResults() {
  const s = state.session;
  const list = $('#results-list');
  const empty = $('#results-empty');
  list.innerHTML = '';
  const shown = (s.results || []).slice(0, 5);

  $('#results-title').textContent = s.status === 'frozen' ? 'Ranked shortlist (frozen)' : `Top matches · round ${s.round}`;
  $('#results-meta').textContent = `${s.filteredCount} of ${s.total} passed filters${shown.length ? ` · showing ${shown.length}` : ''}`;

  if (!shown.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = '';
    empty.append(el('h3', null, 'No profiles passed those filters'));
    empty.append(el('p', null, 'The objective filters cut everyone. Loosen them — or tell me in chat what to relax, e.g. “drop the location requirement” or “5+ years is fine”.'));
    const sug = el('div', 'empty-suggestions');
    for (const txt of ['Drop the location filter', 'Widen the experience range', 'Remove one must-have skill']) {
      const b = el('button', 'chip', txt);
      b.onclick = () => { $('#feedback-input').value = txt + ', everything else stays'; $('#feedback-input').focus(); };
      sug.append(b);
    }
    empty.append(sug);
    return;
  }
  empty.classList.add('hidden');
  for (const r of shown) list.append(renderProfileCard(r, { interactive: s.status !== 'frozen' }));
}

function renderResultsSkeleton(n = 3) {
  const list = $('#results-list');
  list.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const sk = el('div', 'skeleton-card');
    sk.append(el('div', 'sk-line w40'), el('div', 'sk-line w90'), el('div', 'sk-line w70'));
    list.append(sk);
  }
}

// ---------------- workspace header ----------------
function renderHeader() {
  const s = state.session;
  $('#ws-round').textContent = `round ${s.round}`;
  const st = $('#ws-status');
  if (s.status === 'frozen') { st.textContent = 'frozen'; st.classList.add('frozen'); $('#btn-freeze').disabled = true; }
  else { st.textContent = 'refining'; st.classList.remove('frozen'); $('#btn-freeze').disabled = false; }
}

function onSessionUpdate(session, thinkingTitle) {
  state.session = session;
  state.pendingVerdicts = {};
  sessionStorage.setItem('srl_session_id', session.id);
  stopThinking();
  showScreen('screen-workspace');
  renderHeader();
  renderFeed();
  renderSpecPanel();
  renderResults();
  renderComposerVerdicts();
  const composer = $('#composer');
  composer.classList.toggle('frozen-state', session.status === 'frozen');
  $('#feedback-input').disabled = session.status === 'frozen';
  $('#feedback-submit').disabled = session.status === 'frozen';
  if (session.status === 'frozen') {
    $('#feedback-input').placeholder = 'Search is frozen — start a new search to explore again.';
  }
  const feed = $('#feed');
  if (feed.lastChild) feed.lastChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------- actions ----------------
async function doSearch(freeText) {
  state.busy = true;
  $('#search-submit').disabled = true;
  startThinking(THINK_STEPS_SEARCH, 'Turning your words into a search…');
  try {
    const { session } = await api('POST', '/api/session', { freeText });
    onSessionUpdate(session);
  } catch (err) {
    stopThinking();
    showScreen('screen-search');
    $('#health-banner').textContent = `Search failed: ${err.message}${err.hint ? ' — ' + err.hint : ''}`;
    $('#health-banner').classList.remove('hidden');
  } finally {
    state.busy = false;
    $('#search-submit').disabled = false;
  }
}

async function doFeedback() {
  const input = $('#feedback-input');
  const message = input.value.trim();
  const verdicts = state.pendingVerdicts;
  if (!message && !Object.keys(verdicts).length) {
    input.placeholder = 'Type something first — or mark profiles ✓/✗ — then hit Refine';
    input.focus();
    return;
  }
  state.busy = true;
  $('#feedback-submit').disabled = true;
  input.value = '';
  renderResultsSkeleton();
  startThinking(THINK_STEPS_REFINE, 'Refining from your feedback…');
  try {
    const { session } = await api('POST', `/api/session/${state.session.id}/feedback`, { message, verdicts });
    onSessionUpdate(session);
  } catch (err) {
    stopThinking();
    showScreen('screen-workspace');
    renderResults();
    toast(`${err.message}${err.retryable ? ' (transient — just hit Refine again, your verdicts are kept)' : ''}`, 8000);
    // restore what the user typed so nothing is lost
    if (message) input.value = message;
    // re-apply pending verdicts UI (server may have recorded some)
    renderComposerVerdicts();
  } finally {
    state.busy = false;
    $('#feedback-submit').disabled = state.session?.status === 'frozen';
  }
}

async function doFreeze() {
  if (state.busy) return;
  state.busy = true;
  $('#btn-freeze').disabled = true;
  try {
    const { session } = await api('POST', `/api/session/${state.session.id}/freeze`);
    onSessionUpdate(session);
    renderFrozen(session);
    showScreen('screen-frozen');
  } catch (err) {
    toast(`Could not freeze: ${err.message}`);
    $('#btn-freeze').disabled = false;
  } finally {
    state.busy = false;
  }
}

// ---------------- frozen screen ----------------
function renderFrozen(s) {
  const fz = s.frozen;
  if (!fz) return;
  $('#frozen-sub').textContent = `“${fz.freeText}” · ${fz.rounds} refinement round${fz.rounds === 1 ? '' : 's'} · ${fz.filteredCount} of ${fz.total} profiles passed the final filters`;
  renderFiltersView($('#frozen-filters'), fz.spec.filters);
  renderRubricView($('#frozen-rubric'), fz.spec.rubric);
  $('#frozen-results-title').textContent = `Ranked shortlist · ${fz.results.length} profiles`;
  const list = $('#frozen-results-list');
  list.innerHTML = '';
  for (const r of fz.results) list.append(renderProfileCard(r, { interactive: false }));
}

// ---------------- wiring ----------------
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#search-input').value.trim();
  if (!text || state.busy) return;
  doSearch(text);
});
$('#search-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('#search-form').requestSubmit();
});
document.querySelectorAll('.chip[data-example]').forEach((chip) => {
  chip.addEventListener('click', () => {
    $('#search-input').value = chip.dataset.example;
    $('#search-input').focus();
  });
});
$('#feedback-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.busy) doFeedback();
});
$('#feedback-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('#feedback-form').requestSubmit();
});
$('#btn-freeze').addEventListener('click', doFreeze);
$('#btn-edit-spec').addEventListener('click', () => {
  if (state.editingSpec) closeSpecEditor();
  else openSpecEditor();
});
$('#btn-new-search').addEventListener('click', () => { sessionStorage.removeItem('srl_session_id'); location.reload(); });
$('#btn-frozen-new').addEventListener('click', () => { sessionStorage.removeItem('srl_session_id'); location.reload(); });
$('#btn-frozen-back').addEventListener('click', () => showScreen('screen-workspace'));

// health check + pool count on load
(async () => {
  try {
    const h = await api('GET', '/api/health');
    if (!h.ok) {
      $('#health-banner').textContent = `LLM not configured: ${h.error}`;
      $('#health-banner').classList.remove('hidden');
    } else if (h.poolSize) {
      $('#pool-count').textContent = `${h.poolSize} profiles`;
    }
  } catch {
    $('#health-banner').textContent = 'Cannot reach the server health endpoint.';
    $('#health-banner').classList.remove('hidden');
  }
})();

// restore an in-progress session after an accidental refresh (or via ?session= link)
(async () => {
  const sid = new URLSearchParams(location.search).get('session') || sessionStorage.getItem('srl_session_id');
  if (!sid) return;
  try {
    const { session } = await api('GET', `/api/session/${sid}`);
    if (session) {
      onSessionUpdate(session);
      if (session.status === 'frozen') { renderFrozen(session); showScreen('screen-frozen'); }
    }
  } catch { /* session gone (server restarted) — start fresh */ sessionStorage.removeItem('srl_session_id'); }
})();

showScreen('screen-search');
$('#search-input').focus();
