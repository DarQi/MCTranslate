'use strict';
const fs = require('fs');
const path = require('path');
const { detectType, extractFile } = require('./extractors');

const SKIP_DIRS = new Set(['.mctranslate', 'backup', 'backups', 'node_modules', '.git']);

function walk(dir, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(p, out, depth + 1);
    } else out.push(p);
  }
}

/** Locations inside a modpack instance where quests / lang files live. */
const ROOTS = [
  { dir: 'config/ftbquests', accept: (t) => t === 'ftb' || t === 'ftb-lang' },
  { dir: 'config/betterquesting', accept: (t) => t === 'bq', filter: (rel) => /defaultquests/i.test(rel) },
  { dir: 'kubejs/assets', accept: (t) => t === 'lang-json' },
  { dir: 'resources', accept: (t) => t === 'lang-json' || t === 'lang' },
  { dir: 'config/openloader', accept: (t) => t === 'lang-json' || t === 'lang' },
  { dir: 'global_packs', accept: (t) => t === 'lang-json' || t === 'lang' },
  { dir: 'config/paxi', accept: (t) => t === 'lang-json' || t === 'lang' },
];

/** If user picked e.g. ".minecraft" parent or the instance root, find the real root. */
function resolveInstanceRoot(dir) {
  const cands = [dir, path.join(dir, '.minecraft'), path.join(dir, 'minecraft')];
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'config')) || fs.existsSync(path.join(c, 'kubejs'))) return c;
  }
  return dir;
}

function scanInstance(dirIn, langCode) {
  const root = resolveInstanceRoot(dirIn);
  const files = [];
  const errors = [];
  const seen = new Set();
  for (const r of ROOTS) {
    const base = path.join(root, r.dir);
    if (!fs.existsSync(base)) continue;
    const all = [];
    walk(base, all);
    for (const abs of all) {
      if (seen.has(abs)) continue;
      const type = detectType(abs);
      if (!type || !r.accept(type)) continue;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (r.filter && !r.filter(rel)) continue;
      seen.add(abs);
      try {
        const rows = extractFile(abs, type, langCode);
        if (rows.length) files.push({ id: rel, rel, abs, base: root, type, rows });
      } catch (e) {
        errors.push(`${rel}: ${e.message}`);
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
  return { root, files, errors };
}

function openSingleFile(abs, langCode) {
  const type = detectType(abs) || (abs.toLowerCase().endsWith('.snbt') ? 'ftb' : null);
  if (!type) throw new Error('Неподдерживаемый тип файла');
  const base = path.dirname(abs);
  const rel = path.basename(abs);
  const rows = extractFile(abs, type, langCode);
  return { id: abs.replace(/\\/g, '/'), rel, abs, base, type, rows };
}

module.exports = { scanInstance, openSingleFile };
