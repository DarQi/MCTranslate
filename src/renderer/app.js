'use strict';
/* global api */

const PAGE_SIZE = 100;
const TYPE_GROUP = {
  ftb: 'FTB Quests',
  'ftb-lang': 'FTB Quests (lang)',
  bq: 'Better Questing',
  'dialogue-lang': '💬 Диалоги (NPC)',
  'dialogue-json': '💬 Диалоги (Датапак)',
  puffish: '🌳 Деревья талантов',
  'lang-json': 'Предметы и тултипы',
  lang: 'Предметы и тултипы',
};
function fileTab(f) {
  if (f.type === 'dialogue-lang' || f.type === 'dialogue-json') return 'dialogues';
  if (f.type === 'ftb' || f.type === 'ftb-lang' || f.type === 'bq') return 'quests';
  return 'other';
}
const PRESETS = {
  deepseek: {
    llmBaseUrl: 'https://api.deepseek.com/v1',
    llmModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat — DeepSeek V3 (Рекомендуется)' },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner — DeepSeek R1 (DeepThink)' },
    ],
  },
  openai: {
    llmBaseUrl: 'https://api.openai.com/v1',
    llmModel: 'gpt-4.1-mini',
    models: [
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini (Рекомендуется — быстрый и точный)' },
      { id: 'gpt-4.1', label: 'gpt-4.1 (Флагманский)' },
      { id: 'gpt-4.1-nano', label: 'gpt-4.1-nano (Самый дешёвый)' },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
      { id: 'gpt-4o', label: 'gpt-4o' },
      { id: 'o4-mini', label: 'o4-mini (Reasoning)' },
      { id: 'o3-mini', label: 'o3-mini (Reasoning)' },
    ],
  },
  gemini: {
    llmBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    llmModel: 'gemini-3-flash-preview',
    models: [
      { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview (Рекомендуется — Gemini 3 Flash)' },
      { id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview (Gemini 3.1 Pro)' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash (Стабильная)' },
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro (Глубокая)' },
      { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
    ],
  },
  openrouter: {
    llmBaseUrl: 'https://openrouter.ai/api/v1',
    llmModel: 'deepseek/deepseek-chat-v3-0324:free',
    models: [
      { id: 'deepseek/deepseek-chat-v3-0324:free', label: 'DeepSeek V3 (Бесплатно на OpenRouter ★)' },
      { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 DeepThink (Бесплатно)' },
      { id: 'google/gemini-2.5-flash', label: 'Google Gemini 2.5 Flash' },
      { id: 'openai/gpt-4.1-mini', label: 'OpenAI GPT-4.1 Mini' },
      { id: 'anthropic/claude-3.7-sonnet', label: 'Anthropic Claude 3.7 Sonnet' },
    ],
  },
  ollama: {
    llmBaseUrl: 'http://localhost:11434/v1',
    llmModel: 'qwen2.5:7b',
    models: [
      { id: 'qwen2.5:7b', label: 'qwen2.5:7b (Рекомендуется для 8 ГБ VRAM)' },
      { id: 'qwen2.5:14b', label: 'qwen2.5:14b (Высокое качество)' },
      { id: 'llama3.1:8b', label: 'llama3.1:8b' },
      { id: 'gemma3:12b', label: 'gemma3:12b' },
      { id: 'deepseek-r1:8b', label: 'deepseek-r1:8b (DeepThink локально)' },
    ],
  },
};

const state = {
  files: [],
  current: null,
  page: 0,
  tab: 'all',
  mode: 'manual',
  settings: {},
  running: false,
  cancel: false,
  dirty: new Set(),
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ------------------------------------------------------------- helpers
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function normKey(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

function toast(msg, kind = '', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function confirmBox(title, html, yesText = 'OK') {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmBody').innerHTML = html;
    $('#confirmYes').textContent = yesText;
    $('#confirmModal').classList.remove('hidden');
    const done = (v) => {
      $('#confirmModal').classList.add('hidden');
      $('#confirmYes').onclick = $('#confirmNo').onclick = null;
      resolve(v);
    };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  $('#btnTheme').textContent = t === 'dark' ? '☀' : '🌙';
  $('#btnTheme').title = t === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
}

const MC_COLORS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};

/** Render Minecraft-formatted text (&a / §a codes, {placeholders}) to HTML. */
function mcToHtml(text) {
  const parts = String(text).split(/([§&][0-9a-fk-or])/gi);
  let style = {};
  let html = '';
  for (const part of parts) {
    const m = /^[§&]([0-9a-fk-or])$/i.exec(part);
    if (m) {
      const c = m[1].toLowerCase();
      if (MC_COLORS[c]) style = { color: MC_COLORS[c] };
      else if (c === 'r') style = {};
      else style = { ...style, [c]: true };
      continue;
    }
    if (!part) continue;
    let css = '';
    if (style.color) css += `color:${style.color};`;
    if (style.l) css += 'font-weight:700;';
    if (style.o) css += 'font-style:italic;';
    if (style.n || style.m) css += `text-decoration:${style.n ? 'underline ' : ''}${style.m ? 'line-through' : ''};`;
    const inner = esc(part).replace(/\{[^{}]*\}|%(?:\d+\$)?[sdf]|\\n/g, (ph) => `<span class="ph">${ph}</span>`);
    html += css || style.k ? `<span style="${css}"${style.k ? ' class="mc-k"' : ''}>${inner}</span>` : inner;
  }
  return html;
}

function rowStatus(r) {
  if (r.busy) return 'busy';
  if (!r.translation) return 'todo';
  return r.warn ? 'warn' : 'done';
}

function fileStats(f) {
  let done = 0;
  for (const r of f.rows) if (r.translation) done++;
  return { done, total: f.rows.length };
}

// ------------------------------------------------------------- progress & session persistence
let saveTimer = null;
function markDirty(file) {
  if (file) state.dirty.add(file);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushProgress, 250);
}

function collectDirtyPayload() {
  if (!state.dirty.size) return null;
  const data = {};
  for (const f of state.dirty) {
    const map = {};
    for (const r of f.rows) {
      if (r.translation) map[r.id] = r.translation;
    }
    data[f.abs] = map;
  }
  state.dirty.clear();
  return data;
}

async function flushProgress() {
  clearTimeout(saveTimer);
  const data = collectDirtyPayload();
  if (data) await api.saveProgress(data);
}

function flushProgressSync() {
  clearTimeout(saveTimer);
  const data = collectDirtyPayload();
  if (data) api.saveProgressSync(data);
}

let sessionTimer = null;
function saveSessionState(immediate = false) {
  const patch = {
    lastSelectedFile: state.current ? state.current.abs : state.settings.lastSelectedFile || '',
    lastPage: state.page || 0,
    lastMode: state.mode || 'manual',
    lastScope: document.querySelector('input[name="scope"]:checked')?.value || 'file',
    lastOnlyTodo: $('#onlyTodo').checked,
    lastOnlyWarn: $('#onlyWarn').checked,
    lastPreview: $('#previewToggle').checked,
  };
  Object.assign(state.settings, patch);
  clearTimeout(sessionTimer);
  if (immediate) {
    api.setSettingsSync(patch);
  } else {
    sessionTimer = setTimeout(() => api.setSettings(patch), 300);
  }
}

async function applyProgress(files) {
  const prog = await api.loadProgress();
  const byNorm = new Map();
  for (const [k, v] of Object.entries(prog)) {
    const nk = normKey(k);
    byNorm.set(nk, { ...(byNorm.get(nk) || {}), ...v });
  }
  for (const f of files) {
    const map = prog[f.abs] || byNorm.get(normKey(f.abs));
    if (!map) continue;
    for (const r of f.rows) {
      if (map[r.id] !== undefined && map[r.id] !== '') r.translation = map[r.id];
    }
  }
}

// ------------------------------------------------------------- loading
async function loadFiles(result, label, restoreSelection = false) {
  if (result.errors && result.errors.length) {
    toast('Не удалось прочитать некоторые файлы:\n' + result.errors.slice(0, 6).join('\n') + (result.errors.length > 6 ? `\n…и ещё ${result.errors.length - 6}` : ''), 'warn', 9000);
  }
  if (!result.files.length) {
    toast('Не найдено файлов с текстом для перевода.', 'err');
    return;
  }
  await applyProgress(result.files);
  state.files = result.files;

  if (restoreSelection && state.settings.lastSelectedFile) {
    const targetNorm = normKey(state.settings.lastSelectedFile);
    const found = result.files.find((f) => normKey(f.abs) === targetNorm || normKey(f.rel) === targetNorm);
    state.current = found || result.files[0];
    state.page = found ? Math.max(0, Number(state.settings.lastPage) || 0) : 0;
  } else {
    state.current = result.files[0];
    state.page = 0;
  }

  $('#instanceName').textContent = label.split(/[\\/]/).filter(Boolean).pop() || label;
  $('#instanceName').title = label;
  renderSidebar();
  renderRows();
  saveSessionState();

  const totalRows = result.files.reduce((a, f) => a + f.rows.length, 0);
  const doneRows = result.files.reduce((a, f) => a + fileStats(f).done, 0);
  toast(
    restoreSelection
      ? `Сессия восстановлена: ${doneRows} из ${totalRows} строк`
      : `Файлов: ${result.files.length}, строк: ${totalRows} (готово: ${doneRows})`,
    'ok'
  );
}

async function openInstance(dir, isRestore = false) {
  if (!dir) dir = await api.pickFolder('Выберите папку сборки (инстанса)');
  if (!dir) return;
  await flushProgress();
  $('#fileTitle').textContent = 'Сканирование…';
  try {
    const res = await api.scan(dir);
    if (!res.files || !res.files.length) {
      if (!isRestore) toast('В выбранной папке не найдено файлов для перевода.', 'err');
      else $('#fileTitle').textContent = 'Выберите сборку или файлы';
      return;
    }
    await loadFiles(res, res.root, isRestore);
  } catch (e) {
    if (!isRestore) toast('Ошибка сканирования: ' + e.message, 'err');
  }
}

async function openFiles(paths, isRestore = false) {
  if (!paths) paths = await api.pickFiles();
  if (!paths || !paths.length) return;
  await flushProgress();
  const res = await api.openFiles(paths);
  if (!res.files || !res.files.length) {
    if (!isRestore) toast('Не найдено строк для перевода.', 'err');
    return;
  }
  await loadFiles(res, paths.length === 1 ? paths[0] : `Файлов: ${paths.length}`, isRestore);
}

// ------------------------------------------------------------- sidebar
function fileLabel(f) {
  if (!f.rel.includes('/')) return f.rel;
  const parts = f.rel.split('/');
  const name = parts.pop();
  if (f.type === 'puffish') return `${parts[parts.length - 1] || ''} / ${name}`;
  if (f.type === 'lang-json' || f.type === 'lang') return parts[parts.length - 2] || name;
  return name;
}

function setTab(tab) {
  state.tab = tab || 'all';
  $$('#sideTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.current && state.tab !== 'all' && fileTab(state.current) !== state.tab) {
    const firstInTab = state.files.find((f) => fileTab(f) === state.tab);
    if (firstInTab) {
      state.current = firstInTab;
      state.page = 0;
      renderRows();
    }
  }
  renderSidebar();
}

function renderSidebar() {
  const q = $('#fileSearch').value.trim().toLowerCase();
  const list = $('#fileList');
  list.innerHTML = '';
  let lastGroup = null;
  let totalDone = 0;
  let total = 0;
  let dlgRows = 0;
  for (const f of state.files) {
    const st = fileStats(f);
    totalDone += st.done;
    total += st.total;
    if (fileTab(f) === 'dialogues') dlgRows += st.total;
    if (state.tab !== 'all' && fileTab(f) !== state.tab) continue;
    if (q && !f.rel.toLowerCase().includes(q)) continue;
    const g = TYPE_GROUP[f.type] || 'Прочее';
    if (g !== lastGroup) {
      const gh = document.createElement('div');
      gh.className = 'file-group';
      gh.textContent = g;
      list.appendChild(gh);
      lastGroup = g;
    }
    const label = fileLabel(f);
    const el = document.createElement('div');
    el.className = 'file-item' + (f === state.current ? ' active' : '') + (st.done === st.total && st.total > 0 ? ' complete' : '');
    el.title = f.rel;
    el.innerHTML = `
      <div class="top">
        <span class="name">${esc(label)}</span>
        <span class="cnt">${st.done}/${st.total}</span>
      </div>
      <div class="bar"><div class="fill" style="width:${st.total ? (st.done / st.total) * 100 : 0}%"></div></div>`;
    el.onclick = () => {
      state.current = f;
      state.page = 0;
      renderSidebar();
      renderRows();
      $('#rows').scrollTop = 0;
      saveSessionState();
    };
    f._el = el;
    list.appendChild(el);
  }
  if (!list.children.length && state.files.length) {
    list.innerHTML = '<div class="empty" style="padding:18px 8px;text-align:center"><p class="muted" style="font-size:12px">В этой вкладке нет файлов.</p></div>';
  }
  const badge = $('#dlgBadge');
  if (badge) {
    badge.textContent = dlgRows;
    badge.classList.toggle('hidden', dlgRows === 0);
  }
  $('#totalBar').style.width = total ? `${(totalDone / total) * 100}%` : '0';
  $('#totalText').textContent = `${totalDone} / ${total}`;
}

let sidebarTimer = null;
function refreshSidebarSoon() {
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(renderSidebar, 250);
}

// ------------------------------------------------------------- rows
function filteredRows() {
  const f = state.current;
  if (!f) return [];
  const q = $('#rowSearch').value.trim().toLowerCase();
  const onlyTodo = $('#onlyTodo').checked;
  const onlyWarn = $('#onlyWarn').checked;
  const out = [];
  f.rows.forEach((r, i) => {
    if (onlyTodo && r.translation) return;
    if (onlyWarn && !r.warn) return;
    if (q && !r.original.toLowerCase().includes(q) && !(r.translation || '').toLowerCase().includes(q) && !r.field.toLowerCase().includes(q)) return;
    out.push({ r, i });
  });
  return out;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

function renderRows() {
  const f = state.current;
  const box = $('#rows');
  if (!f) return;
  const st = fileStats(f);
  $('#fileTitle').textContent = `${f.rel}  ·  ${st.done} из ${st.total}`;
  $('#fileTitle').title = f.abs;

  const list = filteredRows();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.page >= pages) state.page = pages - 1;
  const slice = list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const preview = $('#previewToggle').checked;

  box.innerHTML = '';
  if (!slice.length) {
    box.innerHTML = '<div class="empty"><p class="muted">Нет строк, подходящих под фильтр.</p></div>';
  }
  const frag = document.createDocumentFragment();
  for (const { r, i } of slice) frag.appendChild(buildRow(r, i, preview));
  box.appendChild(frag);
  box.querySelectorAll('textarea').forEach(autosize);
  renderPager(pages);
}

function buildRow(r, i, preview) {
  const el = document.createElement('div');
  el.className = `row ${rowStatus(r)}`;
  const hasMcColor = /[§&][0-9a-fk-or]/i.test(r.original);
  const ctxParts = [];
  if (r.group) ctxParts.push(esc(r.group));
  if (r.field && r.field !== r.group) ctxParts.push(`<span class="field">${esc(r.field)}</span>`);

  el.innerHTML = `
    <div class="row-head">
      <div class="row-ctx"><span class="num">#${i + 1}</span>${ctxParts.join(' · ')}</div>
      <div class="row-act">
        <button title="Перевести строку" data-a="tr">⚡ Перевести</button>
        <button title="Скопировать оригинал" data-a="copy">Копировать</button>
        <button title="Очистить перевод" data-a="clear">✕</button>
      </div>
    </div>
    <div class="row-grid">
      <div class="c-orig${hasMcColor ? ' has-mc' : ''}">${mcToHtml(r.original)}</div>
      <div class="c-tr">
        <textarea rows="1" spellcheck="true" placeholder="Перевод…"></textarea>
        ${preview ? '<div class="preview"></div>' : ''}
        ${r.warn ? '<div class="warn-msg">⚠ Потеряны коды форматирования или плейсхолдеры</div>' : ''}
      </div>
    </div>`;
  const ta = el.querySelector('textarea');
  const pv = el.querySelector('.preview');
  ta.value = r.translation || '';
  if (pv) pv.innerHTML = mcToHtml(ta.value);
  r._el = el;

  ta.addEventListener('input', () => {
    r.translation = ta.value;
    r.warn = false;
    el.className = `row ${rowStatus(r)}`;
    const wm = el.querySelector('.warn-msg');
    if (wm) wm.remove();
    if (pv) pv.innerHTML = mcToHtml(ta.value);
    autosize(ta);
    markDirty(state.current);
    refreshSidebarSoon();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      const next = el.nextElementSibling && el.nextElementSibling.querySelector('textarea');
      if (next) { next.focus(); next.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  });
  el.querySelector('[data-a="tr"]').onclick = () => translateRows([r], state.current);
  el.querySelector('[data-a="copy"]').onclick = () => { ta.value = r.original; ta.dispatchEvent(new Event('input')); ta.focus(); };
  el.querySelector('[data-a="clear"]').onclick = () => { ta.value = ''; ta.dispatchEvent(new Event('input')); };
  return el;
}

function updateRowEl(r) {
  const el = r._el;
  if (!el || !el.isConnected) return;
  const ta = el.querySelector('textarea');
  ta.value = r.translation || '';
  autosize(ta);
  el.className = `row ${rowStatus(r)}`;
  const pv = el.querySelector('.preview');
  if (pv) pv.innerHTML = mcToHtml(ta.value);
  const wm = el.querySelector('.warn-msg');
  if (r.warn && !wm) el.querySelector('.c-tr').insertAdjacentHTML('beforeend', '<div class="warn-msg">⚠ Потеряны коды форматирования или плейсхолдеры</div>');
  if (!r.warn && wm) wm.remove();
}

function renderPager(pages) {
  const p = $('#pager');
  p.innerHTML = '';
  if (pages <= 1) return;
  const add = (label, page, disabled, active) => {
    const b = document.createElement('button');
    b.className = 'btn tiny' + (active ? ' active' : '');
    b.textContent = label;
    b.disabled = disabled;
    b.onclick = () => {
      state.page = page;
      renderRows();
      $('#rows').scrollTop = 0;
      saveSessionState();
    };
    p.appendChild(b);
  };
  add('‹', state.page - 1, state.page === 0);
  for (let k = 0; k < pages; k++) {
    if (pages > 12 && Math.abs(k - state.page) > 3 && k !== 0 && k !== pages - 1) {
      if (p.lastChild && p.lastChild.textContent !== '…') { const s = document.createElement('span'); s.textContent = '…'; s.className = 'muted'; p.appendChild(s); }
      continue;
    }
    add(String(k + 1), k, false, k === state.page);
  }
  add('›', state.page + 1, state.page === pages - 1);
}

// ------------------------------------------------------------- translation
function getEngineBatchSize() {
  const eng = state.settings.engine;
  if (eng === 'llm') {
    if ((state.settings.llmParamMode || 'auto') === 'auto') {
      return state.settings.llmDeepThink ? 15 : 25;
    }
    return Math.max(1, Number(state.settings.llmBatchSize) || 25);
  }
  if (eng === 'deepl') return 20;
  if (eng === 'mymemory') return 5;
  return 35;
}

async function translateRows(items, singleFile, onProgress) {
  const entries = singleFile ? items.map((r) => ({ r, f: singleFile })) : items;
  if (!entries.length) return { done: 0 };
  const groups = new Map();
  for (const e of entries) {
    const key = e.r.original;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const uniq = Array.from(groups.keys());
  const batch = getEngineBatchSize();
  let done = 0;
  let warns = 0;
  for (const e of entries) { e.r.busy = true; updateRowEl(e.r); }
  try {
    for (let k = 0; k < uniq.length; k += batch) {
      if (state.cancel) break;
      const chunk = uniq.slice(k, k + batch);
      const res = await api.translate(chunk);
      if (!res.ok) throw new Error(res.error);
      res.results.forEach((t, idx) => {
        for (const e of groups.get(chunk[idx])) {
          e.r.translation = t.text;
          e.r.warn = !t.ok;
          e.r.busy = false;
          if (!t.ok) warns++;
          updateRowEl(e.r);
          state.dirty.add(e.f);
        }
      });
      await flushProgress();
      done += chunk.length;
      if (onProgress) onProgress(done, uniq.length);
      refreshSidebarSoon();
    }
  } finally {
    for (const e of entries) if (e.r.busy) { e.r.busy = false; updateRowEl(e.r); }
    await flushProgress();
    refreshSidebarSoon();
    if (state.current) $('#fileTitle').textContent = `${state.current.rel}  ·  ${fileStats(state.current).done} из ${fileStats(state.current).total}`;
  }
  return { done, total: uniq.length, warns };
}

async function runAuto() {
  if (state.running) return;
  if (!state.files.length) return toast('Сначала откройте сборку или файлы.', 'warn');
  if (state.settings.engine === 'llm' && !state.settings.llmApiKey && !/localhost|127\.0\.0\.1/.test(state.settings.llmBaseUrl)) {
    return toast('Укажите API ключ нейросети в настройках.', 'warn');
  }
  const scope = document.querySelector('input[name="scope"]:checked').value;
  const onlyTodo = $('#autoOnlyTodo').checked;
  let files;
  if (scope === 'all') files = state.files;
  else if (scope === 'tab') files = state.tab === 'all' ? state.files : state.files.filter((f) => fileTab(f) === state.tab);
  else files = state.current ? [state.current] : [];
  const items = [];
  for (const f of files) for (const r of f.rows) if (!onlyTodo || !r.translation) items.push({ r, f });
  if (!items.length) return toast('Всё уже переведено.', 'ok');

  state.running = true;
  state.cancel = false;
  $('#btnAutoStart').disabled = true;
  $('#btnAutoStop').disabled = false;
  $('#autoBar').style.width = '0';
  const totalUniq = new Set(items.map((x) => x.r.original)).size;
  $('#autoText').textContent = `0 / ${totalUniq}`;
  try {
    const res = await translateRows(items, null, (d, t) => {
      $('#autoBar').style.width = `${(d / t) * 100}%`;
      $('#autoText').textContent = `${d} / ${t}`;
    });
    const msg = state.cancel ? `Остановлено: ${res.done} / ${res.total}` : `Готово: ${res.done} строк`;
    $('#autoText').textContent = msg;
    toast(msg + (res.warns ? ` (ошибок форматирования: ${res.warns})` : ''), res.warns ? 'warn' : 'ok', 6000);
  } catch (e) {
    $('#autoText').textContent = 'Пауза (сохранено)';
    toast('Пауза (весь переведённый прогресс сохранён):\n' + e.message, 'err', 9000);
  } finally {
    state.running = false;
    $('#btnAutoStart').disabled = false;
    $('#btnAutoStop').disabled = true;
    await flushProgress();
  }
}

// ------------------------------------------------------------- writing
function buildJobs() {
  const jobs = [];
  for (const f of state.files) {
    const translations = {};
    let n = 0;
    for (const r of f.rows) if (r.translation && r.translation !== r.original) { translations[r.id] = r.translation; n++; }
    if (n) jobs.push({ abs: f.abs, base: f.base, type: f.type, translations });
  }
  return jobs;
}

async function applyToPack() {
  const jobs = buildJobs();
  if (!jobs.length) return toast('Нет переведённых строк для сохранения.', 'warn');
  const inPlace = jobs.filter((j) => j.type === 'ftb' || j.type === 'bq' || j.type === 'puffish').length;
  const hasDlgOrMod = jobs.some((j) => j.type === 'dialogue-lang' || j.type === 'dialogue-json' || j.abs.includes('.mctranslate'));
  const ok = await confirmBox(
    'Применить перевод в сборку',
    `<p>Будет записано файлов: <b>${jobs.length}</b>.</p>
     ${inPlace ? `<p>⚠ <b>${inPlace}</b> файл(ов) квестов/талантов будут изменены напрямую (оригиналы сохранятся в <code>.mctranslate/backups</code>).</p>` : ''}
     ${hasDlgOrMod ? `<p>💬 Диалоги и строки модов будут автоматически упакованы в ресурспак <code>MCTranslate_RU</code> (и датапак <code>MCTranslate_RU_Data</code>).</p>` : ''}
     <p>Для языковых файлов будет создан/обновлён файл <code>${esc(state.settings.targetLang)}</code>.</p>`,
    'Применить'
  );
  if (!ok) return;
  await flushProgress();
  const res = await api.write({ jobs, mode: 'apply' });
  reportWrite(res);
}

async function exportToFolder() {
  const jobs = buildJobs();
  if (!jobs.length) return toast('Нет переведённых строк для сохранения.', 'warn');
  const dir = await api.pickFolder('Куда сохранить переведённые файлы');
  if (!dir) return;
  await flushProgress();
  const res = await api.write({ jobs, mode: 'export', targetDir: dir });
  reportWrite(res, dir);
}

function reportWrite(res, dir) {
  if (res.errors.length) toast('Ошибки при записи:\n' + res.errors.join('\n'), 'err', 10000);
  if (res.written.length) {
    let msg = `Записано файлов: ${res.written.length}`;
    if (res.backupDir) msg += `\nБэкап: ${res.backupDir}`;
    if (dir) msg += `\nПапка: ${dir}`;
    toast(msg, 'ok', 8000);
    if (dir) api.openPath(dir);
  }
}

// ------------------------------------------------------------- settings
let currentLlmParamMode = 'auto';

function detectPresetKey(baseUrl) {
  const norm = String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.llmBaseUrl.replace(/\/+$/, '').toLowerCase() === norm) return key;
  }
  return null;
}

function populateModelSelect(baseUrl, currentModel, extraModels = []) {
  const presetKey = detectPresetKey(baseUrl);
  $$('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === presetKey));

  const presetModels = presetKey ? PRESETS[presetKey].models : [];
  const seen = new Set();
  const options = [];

  for (const m of presetModels) {
    seen.add(m.id);
    options.push({ id: m.id, label: m.label });
  }
  for (const id of extraModels) {
    if (!seen.has(id)) {
      seen.add(id);
      options.push({ id, label: id });
    }
  }
  if (currentModel && !seen.has(currentModel)) {
    seen.add(currentModel);
    options.unshift({ id: currentModel, label: `${currentModel} (текущая)` });
  }

  const sel = $('#sLlmModelSelect');
  sel.innerHTML = '';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '✏ Ввести название модели вручную…';
  sel.appendChild(customOpt);

  if (currentModel && seen.has(currentModel)) {
    sel.value = currentModel;
    $('#sLlmModel').value = currentModel;
    $('#sLlmModel').classList.add('hidden');
  } else {
    sel.value = '__custom__';
    $('#sLlmModel').value = currentModel || '';
    $('#sLlmModel').classList.remove('hidden');
  }
}

function getSelectedModelId() {
  const sel = $('#sLlmModelSelect').value;
  return sel === '__custom__' ? $('#sLlmModel').value.trim() : sel;
}

function setLlmParamMode(pmode) {
  currentLlmParamMode = pmode === 'custom' ? 'custom' : 'auto';
  $$('#llmParamSeg button').forEach((b) => b.classList.toggle('active', b.dataset.pmode === currentLlmParamMode));
  $('#llmAutoHint').classList.toggle('hidden', currentLlmParamMode === 'custom');
  $('#llmCustomParams').classList.toggle('hidden', currentLlmParamMode !== 'custom');
}

function fillSettingsForm() {
  const s = state.settings;
  $('#sSourceLang').value = s.sourceLang;
  $('#sTargetLang').value = s.targetLang;
  $('#sDeeplApiKey').value = s.deeplApiKey || '';
  $('#sDeeplApiUrl').value = s.deeplApiUrl || '';
  $('#sRequestDelayMs').value = s.requestDelayMs ?? 300;
  $('#sMymemoryEmail').value = s.mymemoryEmail || '';
  const baseUrl = s.llmBaseUrl || 'https://api.deepseek.com/v1';
  const model = s.llmModel || 'deepseek-chat';
  $('#sLlmBaseUrl').value = baseUrl;
  populateModelSelect(baseUrl, model);
  $('#sLlmApiKey').value = s.llmApiKey || '';
  $('#sLlmDeepThink').checked = Boolean(s.llmDeepThink);
  $('#sLlmStyle').value = s.llmStyle || 'balanced';
  $('#sLlmKeepOriginalNames').value = s.llmKeepOriginalNames || 'mods';
  setLlmParamMode(s.llmParamMode || 'auto');
  $('#sLlmTemperature').value = s.llmTemperature ?? 0.2;
  $('#sLlmTopP').value = s.llmTopP ?? 0.95;
  $('#sLlmMaxTokens').value = s.llmMaxTokens ?? 4096;
  $('#sLlmReasoningEffort').value = s.llmReasoningEffort || 'auto';
  $('#sLlmBatchSize').value = s.llmBatchSize ?? 25;
  $('#sLlmExtraPrompt').value = s.llmExtraPrompt || '';
  $('#sGlossary').value = s.glossary;
}

async function saveSettingsForm() {
  const prevTarget = state.settings.targetLang;
  state.settings = await api.setSettings({
    sourceLang: $('#sSourceLang').value,
    targetLang: $('#sTargetLang').value,
    deeplApiKey: $('#sDeeplApiKey').value.trim(),
    deeplApiUrl: $('#sDeeplApiUrl').value.trim(),
    requestDelayMs: Math.max(0, Number($('#sRequestDelayMs').value) || 0),
    mymemoryEmail: $('#sMymemoryEmail').value.trim(),
    llmBaseUrl: $('#sLlmBaseUrl').value.trim(),
    llmModel: getSelectedModelId() || 'deepseek-chat',
    llmApiKey: $('#sLlmApiKey').value.trim(),
    llmDeepThink: $('#sLlmDeepThink').checked,
    llmStyle: $('#sLlmStyle').value,
    llmKeepOriginalNames: $('#sLlmKeepOriginalNames').value,
    llmParamMode: currentLlmParamMode,
    llmTemperature: Math.max(0, Math.min(1.5, Number($('#sLlmTemperature').value ?? 0.2))),
    llmTopP: Math.max(0.1, Math.min(1, Number($('#sLlmTopP').value ?? 0.95))),
    llmMaxTokens: Math.max(256, Number($('#sLlmMaxTokens').value) || 4096),
    llmReasoningEffort: $('#sLlmReasoningEffort').value,
    llmBatchSize: Math.max(1, Number($('#sLlmBatchSize').value) || 25),
    llmExtraPrompt: $('#sLlmExtraPrompt').value.trim(),
    glossary: $('#sGlossary').value,
  });
  $('#settingsModal').classList.add('hidden');
  toast('Настройки сохранены', 'ok', 2000);
  if (prevTarget !== state.settings.targetLang && state.files.length) {
    toast('Язык перевода изменён — пересканируйте сборку.', 'warn', 6000);
  }
}

// ------------------------------------------------------------- init
function setMode(mode, persist = true) {
  state.mode = mode;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#autoPanel').classList.toggle('hidden', mode !== 'auto');
  if (persist) saveSessionState();
}

async function init() {
  state.settings = await api.getSettings();
  applyTheme(state.settings.theme || 'dark');
  $('#engineSelect').value = state.settings.engine || 'google';

  if (state.settings.lastMode) setMode(state.settings.lastMode, false);
  if (state.settings.lastScope) {
    const rad = document.querySelector(`input[name="scope"][value="${state.settings.lastScope}"]`);
    if (rad) rad.checked = true;
  }
  $('#onlyTodo').checked = Boolean(state.settings.lastOnlyTodo);
  $('#onlyWarn').checked = Boolean(state.settings.lastOnlyWarn);
  $('#previewToggle').checked = Boolean(state.settings.lastPreview);

  $('#btnTheme').onclick = async () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    state.settings = await api.setSettings({ theme: next });
  };

  $('#btnOpenInstance').onclick = () => openInstance();
  $('#btnOpenFiles').onclick = () => openFiles();
  $('#btnApply').onclick = applyToPack;
  $('#btnExport').onclick = exportToFolder;
  $('#btnSettings').onclick = () => { fillSettingsForm(); $('#settingsModal').classList.remove('hidden'); };
  $('#btnSaveSettings').onclick = saveSettingsForm;
  $$('[data-close]').forEach((b) => (b.onclick = () => b.closest('.modal').classList.add('hidden')));
  $$('[data-preset]').forEach((b) => (b.onclick = () => {
    const p = PRESETS[b.dataset.preset];
    $('#sLlmBaseUrl').value = p.llmBaseUrl;
    const defModel = (b.dataset.preset === 'deepseek' && $('#sLlmDeepThink').checked) ? 'deepseek-reasoner' : p.llmModel;
    populateModelSelect(p.llmBaseUrl, defModel);
  }));
  $('#sLlmBaseUrl').oninput = () => {
    populateModelSelect($('#sLlmBaseUrl').value, getSelectedModelId());
  };
  $('#sLlmModelSelect').onchange = (e) => {
    if (e.target.value === '__custom__') {
      $('#sLlmModel').classList.remove('hidden');
      $('#sLlmModel').focus();
    } else {
      $('#sLlmModel').value = e.target.value;
      $('#sLlmModel').classList.add('hidden');
    }
  };
  $('#btnFetchModels').onclick = async () => {
    const btn = $('#btnFetchModels');
    btn.disabled = true;
    btn.textContent = 'Загрузка…';
    try {
      const res = await api.fetchLlmModels({
        baseUrl: $('#sLlmBaseUrl').value.trim(),
        apiKey: $('#sLlmApiKey').value.trim(),
      });
      if (!res.ok) throw new Error(res.error);
      if (!res.models.length) throw new Error('Сервер вернул пустой список моделей');
      populateModelSelect($('#sLlmBaseUrl').value.trim(), getSelectedModelId() || res.models[0], res.models);
      toast(`Загружено моделей с сервера: ${res.models.length}`, 'ok', 3000);
    } catch (err) {
      toast('Не удалось получить список моделей: ' + err.message, 'err', 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ С сервера';
    }
  };
  $$('#llmParamSeg button').forEach((b) => (b.onclick = () => setLlmParamMode(b.dataset.pmode)));
  $('#sLlmDeepThink').onchange = (e) => {
    const m = getSelectedModelId();
    if (e.target.checked && m === 'deepseek-chat') populateModelSelect($('#sLlmBaseUrl').value, 'deepseek-reasoner');
    if (!e.target.checked && m === 'deepseek-reasoner') populateModelSelect($('#sLlmBaseUrl').value, 'deepseek-chat');
  };

  // Floating tooltip for (i) badges so they are never clipped by modal scroll/borders
  const tipEl = document.createElement('div');
  tipEl.className = 'floating-tip';
  document.body.appendChild(tipEl);
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.info-tip');
    if (!t || !t.dataset.tip) {
      tipEl.classList.remove('visible');
      return;
    }
    tipEl.textContent = t.dataset.tip;
    tipEl.classList.add('visible');
    const r = t.getBoundingClientRect();
    const tw = tipEl.offsetWidth || 310;
    const th = tipEl.offsetHeight || 60;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(12, Math.min(window.innerWidth - tw - 12, left));
    let top = r.top - th - 8;
    if (top < 12) top = r.bottom + 8;
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(top)}px`;
  });
  $('#engineSelect').onchange = async (e) => {
    state.settings = await api.setSettings({ engine: e.target.value });
    if (e.target.value === 'llm' && !state.settings.llmApiKey) {
      toast('Укажите адрес API, модель и ключ в настройках.', 'warn');
      fillSettingsForm();
      $('#settingsModal').classList.remove('hidden');
    }
  };
  $$('#modeSeg button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $$('#sideTabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $$('input[name="scope"]').forEach((r) => (r.onchange = () => saveSessionState()));
  $('#btnAutoStart').onclick = runAuto;
  $('#btnAutoStop').onclick = () => { state.cancel = true; $('#autoText').textContent = 'Остановка…'; };

  let searchTimer;
  $('#rowSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 0; renderRows(); }, 200); };
  $('#onlyTodo').onchange = $('#onlyWarn').onchange = () => { state.page = 0; renderRows(); saveSessionState(); };
  $('#previewToggle').onchange = () => { renderRows(); saveSessionState(); };
  $('#fileSearch').oninput = renderSidebar;

  document.addEventListener('keydown', async (e) => {
    if (e.key === 's' && e.ctrlKey) { e.preventDefault(); await flushProgress(); saveSessionState(true); toast('Прогресс сохранён', 'ok', 1500); }
    if (e.key === 'Escape') {
      if (!$('#confirmModal').classList.contains('hidden')) $('#confirmNo').click();
      $$('.modal').forEach((m) => m.classList.add('hidden'));
    }
  });
  window.addEventListener('beforeunload', () => {
    flushProgressSync();
    saveSessionState(true);
  });

  if (state.settings.lastSourceType === 'files' && Array.isArray(state.settings.lastFiles) && state.settings.lastFiles.length) {
    await openFiles(state.settings.lastFiles, true);
  } else if (state.settings.lastInstance) {
    await openInstance(state.settings.lastInstance, true);
  }
}

init();
