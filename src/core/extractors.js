'use strict';
const fs = require('fs');
const path = require('path');
const { parse, encodeString, splice, pathToId } = require('./snbt');

/**
 * File types:
 *  ftb       – FTB Quests chapter/quest file with inline text (edited in place)
 *  ftb-lang  – FTB Quests lang file (lang/en_us.snbt) -> written to ru_ru.snbt
 *  bq        – Better Questing DefaultQuests json (edited in place)
 *  lang-json – Minecraft lang json (en_us.json)     -> ru_ru.json
 *  lang      – legacy lang file (en_US.lang)          -> ru_RU.lang
 */

const FTB_TEXT_KEYS = new Set(['title', 'subtitle', 'description', 'text']);
const BQ_TEXT_KEYS = new Set(['name', 'desc', 'description']);
const CYRILLIC = /[а-яё]/i;

function stripBqSuffix(k) {
  return typeof k === 'string' ? k.replace(/:\d+$/, '') : k;
}

function lastStringKey(p) {
  for (let i = p.length - 1; i >= 0; i--) if (typeof p[i] === 'string') return p[i];
  return null;
}

/** Strings that must not be translated. */
function isTranslatable(value) {
  if (!value || !value.trim()) return false;
  const v = value.trim();
  if (/^\{[^{}\s]+\}$/.test(v)) return false; // {lang.key} or {@pagebreak}
  if (/^[\[{]\s*["{\[]/.test(v)) return false; // raw JSON text component
  if (/^[a-z0-9_\-]+:[a-z0-9_\/.\-]+$/i.test(v)) return false; // resource id
  if (/^[a-z0-9_]+(\.[a-z0-9_\-]+)+$/i.test(v) && !/\s/.test(v)) return false; // lang key
  const stripped = v.replace(/(?:§[0-9a-fk-orx]|&[0-9a-fk-or])/gi, '').replace(/\{[^{}]*\}/g, '');
  if (!/\p{L}/u.test(stripped)) return false; // no letters at all
  return true;
}

function detectType(absPath) {
  const lower = absPath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(lower);
  if (base.endsWith('.lang')) return /en_us\.lang$/.test(base) ? 'lang' : null;
  if (base.endsWith('.snbt')) {
    if (/\/lang\/(en_us\.snbt$|en_us\/)/.test(lower)) return 'ftb-lang';
    if (/\/lang\//.test(lower)) return null; // other languages
    return 'ftb';
  }
  if (base.endsWith('.json')) {
    if (base === 'en_us.json') return 'lang-json';
    if (/\/lang\//.test(lower)) return null;
    if (lower.includes('betterquesting') || lower.includes('defaultquests') || lower.includes('questdatabase')) return 'bq';
    return 'bq';
  }
  return null;
}

/** Path where translated output goes (relative to the same base). */
function outputRel(rel, type, langCode) {
  const lc = langCode || 'ru_ru';
  if (type === 'ftb' || type === 'bq') return rel;
  if (type === 'lang') {
    return rel.replace(/en_us(\.lang)$/i, (m, ext) => {
      const upper = /en_US/.test(m);
      return (upper ? lc.replace(/_(\w+)$/, (x, r) => '_' + r.toUpperCase()) : lc) + ext;
    });
  }
  // lang-json / ftb-lang: replace the en_us path segment / file name
  return rel.replace(/en_us(?=\.json$|\.snbt$|[\\/])/i, lc);
}

/** Absolute path of the translated output for a source file. */
function outputAbs(absPath, type, langCode) {
  if (type === 'ftb' || type === 'bq') return absPath;
  const norm = absPath.replace(/\\/g, '/');
  const idx = norm.toLowerCase().lastIndexOf('/lang/');
  let res;
  if (idx >= 0) res = norm.slice(0, idx + 6) + outputRel(norm.slice(idx + 6), type, langCode);
  else res = path.posix.join(path.posix.dirname(norm), outputRel(path.posix.basename(norm), type, langCode));
  return path.normalize(res);
}

// ---------------------------------------------------------------- extraction

function groupLabelFtb(root, p) {
  // find nearest quest / chapter / task / reward container for a readable context
  const containers = ['quests', 'tasks', 'rewards', 'chapters', 'chapter_groups'];
  let node = root;
  let label = '';
  for (let k = 0; k < p.length - 1; k++) {
    const key = p[k];
    node = node && typeof node === 'object' ? node[key] : undefined;
    if (typeof p[k + 1] === 'number' && containers.includes(key)) {
      const item = node && node[p[k + 1]];
      const t = item && typeof item.title === 'string' ? item.title : null;
      const id = item && item.id && item.id.__bare ? item.id.__bare : item && typeof item.id === 'string' ? item.id : null;
      const name = { quests: 'Квест', tasks: 'Задача', rewards: 'Награда', chapters: 'Глава', chapter_groups: 'Группа' }[key];
      label = `${name} ${t ? '«' + t.slice(0, 40) + '»' : id ? '#' + id : p[k + 1] + 1}`;
    }
  }
  return label;
}

function extractStructured(text, type) {
  const { root, strings } = parse(text);
  const rows = [];
  for (const s of strings) {
    const key = lastStringKey(s.path);
    let ok = false;
    if (type === 'ftb') ok = FTB_TEXT_KEYS.has(key);
    else if (type === 'ftb-lang') ok = true;
    else if (type === 'bq') ok = BQ_TEXT_KEYS.has(stripBqSuffix(key));
    if (!ok || !isTranslatable(s.value)) continue;

    let group = '';
    if (type === 'ftb') group = groupLabelFtb(root, s.path);
    else if (type === 'ftb-lang') group = String(s.path[0] || '');
    else if (type === 'bq') group = groupLabelBq(root, s.path);

    rows.push({
      id: pathToId(s.path),
      field: type === 'bq' ? stripBqSuffix(key) : key + (typeof s.path[s.path.length - 1] === 'number' ? `[${s.path[s.path.length - 1]}]` : ''),
      group,
      original: s.value,
      _pos: { start: s.start, end: s.end, quote: s.quote },
    });
  }
  return rows;
}

function groupLabelBq(root, p) {
  // Walk to the entry that contains properties.betterquesting and use its name
  let node = root;
  for (let k = 0; k < p.length; k++) {
    if (stripBqSuffix(p[k]) === 'properties') {
      let entry = root;
      for (let j = 0; j < k; j++) entry = entry[p[j]];
      const props = entry[p[k]];
      const bqKey = props && Object.keys(props).find((x) => stripBqSuffix(x) === 'betterquesting');
      const bq = bqKey ? props[bqKey] : null;
      const nameKey = bq && Object.keys(bq).find((x) => stripBqSuffix(x) === 'name');
      const isLine = p.some((x) => typeof x === 'string' && /questlines?/i.test(x));
      const nm = nameKey && typeof bq[nameKey] === 'string' ? bq[nameKey] : '?';
      return `${isLine ? 'Линия' : 'Квест'} «${nm.slice(0, 40)}»`;
    }
    node = node && node[p[k]];
  }
  return '';
}

function parseLangFile(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (offset) lines[0] = lines[0].slice(1);
  lines.forEach((line, idx) => {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (m) rows.push({ key: m[1].trim(), value: m[2], line: idx });
  });
  return { rows, lines };
}

/** Read existing translations from the output file (for lang-type files). */
function loadExistingTranslations(outAbs, type) {
  const map = {};
  if (!fs.existsSync(outAbs)) return map;
  try {
    const text = fs.readFileSync(outAbs, 'utf8');
    if (type === 'lang-json') {
      const obj = JSON.parse(text.replace(/^\uFEFF/, ''));
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') map[k] = v;
    } else if (type === 'lang') {
      for (const r of parseLangFile(text).rows) map[r.key] = r.value;
    } else if (type === 'ftb-lang') {
      for (const s of parse(text).strings) map[pathToId(s.path)] = s.value;
    }
  } catch (e) { /* ignore broken target file */ }
  return map;
}

/**
 * Extract translatable rows from a file.
 * Returns { type, rows:[{id, field, group, original, translation}], error? }
 */
function extractFile(absPath, type, langCode) {
  const text = fs.readFileSync(absPath, 'utf8');
  let rows = [];
  if (type === 'lang-json') {
    const { strings } = parse(text);
    for (const s of strings) {
      if (s.path.length !== 1 || !isTranslatable(s.value)) continue;
      const key = String(s.path[0]);
      if (key.startsWith('_comment')) continue;
      rows.push({ id: key, field: key, group: key.split('.').slice(0, 2).join('.'), original: s.value });
    }
  } else if (type === 'lang') {
    for (const r of parseLangFile(text).rows) {
      if (!isTranslatable(r.value)) continue;
      rows.push({ id: r.key, field: r.key, group: r.key.split('.').slice(0, 2).join('.'), original: r.value });
    }
  } else {
    rows = extractStructured(text, type).map(({ _pos, ...r }) => r);
  }

  // pre-fill translations
  const existing = type === 'ftb' || type === 'bq' ? {} : loadExistingTranslations(outputAbs(absPath, type, langCode), type);
  for (const r of rows) {
    if (existing[r.id] !== undefined && existing[r.id] !== r.original) r.translation = existing[r.id];
    else if ((type === 'ftb' || type === 'bq') && CYRILLIC.test(r.original)) r.translation = r.original;
    else r.translation = '';
  }
  return rows;
}

// ---------------------------------------------------------------- writing

/**
 * Build the translated file contents.
 * translations: { rowId: translatedText }
 */
function buildOutput(absPath, type, translations, langCode) {
  const text = fs.readFileSync(absPath, 'utf8');
  const tr = (id) => {
    const v = translations[id];
    return typeof v === 'string' && v.length ? v : null;
  };

  if (type === 'lang-json') {
    const existing = loadExistingTranslations(outputAbs(absPath, type, langCode), 'lang-json');
    const src = JSON.parse(text.replace(/^\uFEFF/, ''));
    const out = {};
    for (const k of Object.keys(src)) {
      if (tr(k)) out[k] = tr(k);
      else if (existing[k] !== undefined) out[k] = existing[k];
    }
    for (const k of Object.keys(existing)) if (!(k in out)) out[k] = existing[k];
    return JSON.stringify(out, null, 2) + '\n';
  }

  if (type === 'lang') {
    const { lines } = parseLangFile(text);
    return lines
      .map((line) => {
        const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
        if (!m) return line;
        const t = tr(m[1].trim());
        return t ? `${m[1]}=${t.replace(/\r?\n/g, '\\n')}` : line;
      })
      .join('\n');
  }

  // structured: splice string literals
  const format = absPath.toLowerCase().endsWith('.json') ? 'json' : 'snbt';
  const { strings } = parse(text);
  const reps = [];
  for (const s of strings) {
    const t = tr(pathToId(s.path));
    if (t === null || t === s.value) continue;
    reps.push({ start: s.start, end: s.end, text: encodeString(t, s.quote, format) });
  }
  return splice(text, reps);
}

module.exports = { detectType, extractFile, buildOutput, outputRel, outputAbs, isTranslatable };
