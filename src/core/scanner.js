'use strict';
const fs = require('fs');
const path = require('path');
const { detectType, extractFile, isDialogueLangKey } = require('./extractors');
const { openZipFile, openZipBuffer } = require('./zip');

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

/** Locations inside a modpack instance where quests / dialogues / lang files live. */
const ROOTS = [
  { dir: 'config/ftbquests', accept: (t) => t === 'ftb' || t === 'ftb-lang' },
  { dir: 'config/betterquesting', accept: (t) => t === 'bq', filter: (rel) => /defaultquests/i.test(rel) },
  { dir: 'config/puffish_skills/categories', accept: (t) => t === 'puffish' },
  { dir: 'kubejs/assets', accept: (t) => t === 'lang-json' || t === 'dialogue-lang' },
  { dir: 'kubejs/data', accept: (t) => t === 'dialogue-json' },
  { dir: 'resources', accept: (t) => t === 'lang-json' || t === 'lang' },
  { dir: 'config/openloader', accept: (t) => t === 'lang-json' || t === 'lang' || t === 'dialogue-json' },
  { dir: 'global_packs', accept: (t) => t === 'lang-json' || t === 'lang' || t === 'dialogue-json' },
  { dir: 'config/paxi', accept: (t) => t === 'lang-json' || t === 'lang' || t === 'dialogue-json' },
];

/** If user picked e.g. ".minecraft" parent or the instance root, find the real root. */
function resolveInstanceRoot(dir) {
  const cands = [dir, path.join(dir, '.minecraft'), path.join(dir, 'minecraft')];
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'config')) || fs.existsSync(path.join(c, 'kubejs')) || fs.existsSync(path.join(c, 'mods'))) return c;
  }
  return dir;
}

const MODPACK_CORE_JAR_RE = /^(?:prominent|eldritch_end|blabber|easy_npc|taterzens|customnpcs|dialog|quest)/i;

function writeExtractedJson(targetAbs, obj) {
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Inspect a ZIP/JAR (and any nested META-INF/jars/*.jar inside core modpack jars)
 * for dialogue keys (`dialogue.*`), dialogue JSON definitions (`data/.../dialogue/*.json`),
 * and custom modpack lang files (`en_us.json`).
 */
function scanArchiveForDialoguesAndLang(zip, root, isFullLangAllowed, archiveLabel, mergedLangByNs, mergedDlgByNs, datapackFiles) {
  for (const entry of zip.entries) {
    const name = entry.name;

    // 1. Nested JARs inside META-INF/jars/ (e.g. prominentbase-4.1.5.jar inside Prominent-GLOBAL.jar)
    if (isFullLangAllowed && /^META-INF\/jars\/[^/]+\.jar$/i.test(name)) {
      try {
        const subBuf = zip.readBuffer(name);
        if (subBuf) {
          const subZip = openZipBuffer(subBuf);
          scanArchiveForDialoguesAndLang(subZip, root, true, path.basename(name), mergedLangByNs, mergedDlgByNs, datapackFiles);
        }
      } catch {}
      continue;
    }

    // 2. Structured dialogue JSON files in data/<ns>/.../dialogue(s)/*.json
    if (/^data\/[^/]+\/(?:[^/]+\/)*dialogues?\/[^/]+\.json$/i.test(name)) {
      try {
        const txt = zip.readText(name);
        if (txt) {
          const destAbs = path.join(root, '.mctranslate', 'extracted', 'datapack', name);
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.writeFileSync(destAbs, txt, 'utf8');
          datapackFiles.push({ abs: destAbs, rel: `Диалоги (${archiveLabel}): ${path.basename(name)}` });
        }
      } catch {}
      continue;
    }

    // 3. Lang files: assets/<ns>/lang/en_us.json
    const langMatch = /^assets\/([^/]+)\/lang\/en_us\.json$/i.exec(name);
    if (langMatch) {
      const ns = langMatch[1];
      if (ns === 'creativecore') continue; // GUI config button labels, not NPC dialogues
      try {
        const raw = zip.readText(name);
        if (!raw) continue;
        // Quick check before parsing if we only care about dialogues for non-core mods
        if (!isFullLangAllowed && !/"dialogue\.|"dialog\.|\.dialogue\./i.test(raw)) continue;
        const obj = JSON.parse(raw.replace(/^\uFEFF/, ''));
        let existingTarget = {};
        try {
          const targetRaw = zip.readText(`assets/${ns}/lang/ru_ru.json`);
          if (targetRaw) existingTarget = JSON.parse(targetRaw.replace(/^\uFEFF/, ''));
        } catch {}

        for (const [k, v] of Object.entries(obj)) {
          if (typeof v !== 'string') continue;
          if (k.startsWith('#comment') || k.startsWith('_comment')) continue;
          if (existingTarget[k] && existingTarget[k] !== v) continue; // Already localized inside the mod jar
          if (isDialogueLangKey(k)) {
            if (!mergedDlgByNs.has(ns)) mergedDlgByNs.set(ns, {});
            mergedDlgByNs.get(ns)[k] = v;
          } else if (isFullLangAllowed) {
            if (!mergedLangByNs.has(ns)) mergedLangByNs.set(ns, {});
            mergedLangByNs.get(ns)[k] = v;
          }
        }
      } catch {}
    }
  }
}

function extractArchives(root, files, seen, langCode) {
  const mergedLangByNs = new Map();
  const mergedDlgByNs = new Map();
  const datapackFiles = [];

  // 1. Paxi resourcepacks and datapacks (.zip)
  for (const sub of ['config/paxi/resourcepacks', 'config/paxi/datapacks']) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.zip')) continue;
      // Skip existing translation resourcepacks (e.g. Spanish / PT-BR)
      if (/-(?:spanish|pt-br|ko-kr|zh-cn|ru-ru)/i.test(f)) continue;
      try {
        const z = openZipFile(path.join(dir, f));
        // Skip if pack already has ru_ru.json for the same namespace
        scanArchiveForDialoguesAndLang(z, root, true, f.replace(/\.zip$/i, ''), mergedLangByNs, mergedDlgByNs, datapackFiles);
      } catch {}
    }
  }

  // 2. Mods folder (.jar): scan all mods for dialogue.* keys, and core modpack mods for full lang
  const modsDir = path.join(root, 'mods');
  if (fs.existsSync(modsDir)) {
    for (const f of fs.readdirSync(modsDir)) {
      if (!f.toLowerCase().endsWith('.jar')) continue;
      const isCore = MODPACK_CORE_JAR_RE.test(f);
      try {
        const z = openZipFile(path.join(modsDir, f));
        scanArchiveForDialoguesAndLang(z, root, isCore, f.replace(/\.jar$/i, ''), mergedLangByNs, mergedDlgByNs, datapackFiles);
      } catch {}
    }
  }

  // Materialize extracted dialogue lang files
  for (const [ns, obj] of mergedDlgByNs.entries()) {
    if (!Object.keys(obj).length) continue;
    const abs = path.join(root, '.mctranslate', 'extracted', 'dialogues', 'assets', ns, 'lang', 'en_us.json');
    writeExtractedJson(abs, obj);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const rows = extractFile(abs, 'dialogue-lang', langCode);
    if (rows.length) {
      const rel = `Диалоги NPC (${ns})`;
      files.push({ id: abs.replace(/\\/g, '/'), rel, abs, base: root, type: 'dialogue-lang', rows });
    }
  }

  // Materialize extracted datapack dialogue JSON files
  for (const df of datapackFiles) {
    if (seen.has(df.abs)) continue;
    seen.add(df.abs);
    try {
      const rows = extractFile(df.abs, 'dialogue-json', langCode);
      if (rows.length) {
        files.push({ id: df.abs.replace(/\\/g, '/'), rel: df.rel, abs: df.abs, base: root, type: 'dialogue-json', rows });
      }
    } catch {}
  }

  // Materialize extracted core modpack lang files
  for (const [ns, obj] of mergedLangByNs.entries()) {
    if (!Object.keys(obj).length) continue;
    const abs = path.join(root, '.mctranslate', 'extracted', 'lang', 'assets', ns, 'lang', 'en_us.json');
    writeExtractedJson(abs, obj);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const rows = extractFile(abs, 'lang-json', langCode);
    if (rows.length) {
      const rel = `Модпак: ${ns} (предметы, боссы, интерфейс)`;
      files.push({ id: abs.replace(/\\/g, '/'), rel, abs, base: root, type: 'lang-json', rows });
    }
  }
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

  // Also scan modpack archives (.jar / Paxi .zip) for dialogues and modpack lang entries
  try {
    extractArchives(root, files, seen, langCode);
  } catch (e) {
    errors.push(`Архивы модов: ${e.message}`);
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
