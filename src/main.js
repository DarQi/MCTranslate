'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { scanInstance, openSingleFile } = require('./core/scanner');
const { buildOutput, outputAbs } = require('./core/extractors');
const { translateBatch } = require('./core/translate');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  engine: 'google',
  sourceLang: 'auto',
  targetLang: 'ru_ru',
  requestDelayMs: 300,
  deeplApiKey: '',
  deeplApiUrl: '',
  mymemoryEmail: '',
  llmBaseUrl: 'https://api.deepseek.com/v1',
  llmApiKey: '',
  llmModel: 'deepseek-chat',
  llmParamMode: 'auto',
  llmDeepThink: false,
  llmReasoningEffort: 'auto',
  llmTemperature: 0.2,
  llmTopP: 0.95,
  llmMaxTokens: 4096,
  llmBatchSize: 25,
  llmStyle: 'balanced',
  llmKeepOriginalNames: 'mods',
  llmExtraPrompt: '',
  glossary: '# Формат: English = Перевод\nHopper = Воронка\nChest = Сундук\nCrafting Table = Верстак\nFurnace = Печь\nRedstone = Редстоун\nNether = Незер\nThe End = Энд\nEnder Pearl = Жемчуг Края\nBlaze Rod = Огненный стержень',
  lastSourceType: 'instance',
  lastInstance: '',
  lastFiles: [],
  lastSelectedFile: '',
  lastPage: 0,
  lastMode: 'manual',
  lastScope: 'file',
  lastOnlyTodo: false,
  lastOnlyWarn: false,
  lastPreview: false,
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const progressFile = () => path.join(app.getPath('userData'), 'progress.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* ignore write errors on read-only paths */ }
}

function getSettings() { return { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) }; }

function saveProgressToDisk(data) {
  if (!data || typeof data !== 'object') return;
  const all = readJson(progressFile(), {});
  for (const [fileKey, rowMap] of Object.entries(data)) {
    all[fileKey] = rowMap;
  }
  writeJson(progressFile(), all);

  // Also mirror progress inside the active instance folder (.mctranslate/progress.json)
  const s = getSettings();
  if (s.lastInstance && fs.existsSync(s.lastInstance)) {
    const instProgFile = path.join(s.lastInstance, '.mctranslate', 'progress.json');
    const instData = readJson(instProgFile, {});
    for (const [fileKey, rowMap] of Object.entries(data)) {
      instData[fileKey] = rowMap;
    }
    writeJson(instProgFile, instData);
  }
}

function loadMergedProgress() {
  const globalProg = readJson(progressFile(), {});
  const s = getSettings();
  if (s.lastInstance && fs.existsSync(s.lastInstance)) {
    const instProgFile = path.join(s.lastInstance, '.mctranslate', 'progress.json');
    const instProg = readJson(instProgFile, {});
    const merged = { ...instProg };
    for (const [k, v] of Object.entries(globalProg)) {
      merged[k] = { ...(merged[k] || {}), ...v };
    }
    return merged;
  }
  return globalProg;
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#14161b',
    title: 'MCTranslate',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ------------------------------------------------------------------ IPC
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (e, s) => { writeJson(settingsFile(), { ...getSettings(), ...s }); return getSettings(); });
ipcMain.on('settings:set-sync', (e, s) => { writeJson(settingsFile(), { ...getSettings(), ...s }); e.returnValue = true; });

ipcMain.handle('dialog:folder', async (e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Выберите папку', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Выберите файлы для перевода',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Квесты и lang-файлы', extensions: ['snbt', 'json', 'lang'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('scan', (e, dir) => {
  if (!dir || !fs.existsSync(dir)) return { root: dir || '', files: [], errors: ['Папка не найдена'] };
  const s = getSettings();
  const res = scanInstance(dir, s.targetLang);
  writeJson(settingsFile(), { ...s, lastSourceType: 'instance', lastInstance: res.root || dir });
  return res;
});

ipcMain.handle('open-files', (e, paths) => {
  const s = getSettings();
  const files = [];
  const errors = [];
  const validPaths = (paths || []).filter((p) => p && fs.existsSync(p));
  for (const p of validPaths) {
    try {
      const f = openSingleFile(p, s.targetLang);
      if (f.rows.length) files.push(f);
      else errors.push(`${path.basename(p)}: не найдено строк для перевода`);
    } catch (err) {
      errors.push(`${path.basename(p)}: ${err.message}`);
    }
  }
  if (validPaths.length) {
    writeJson(settingsFile(), { ...s, lastSourceType: 'files', lastFiles: validPaths });
  }
  return { files, errors };
});

ipcMain.handle('translate', async (e, texts) => {
  try {
    return { ok: true, results: await translateBatch(texts, getSettings()) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('llm:models', async (e, { baseUrl, apiKey }) => {
  try {
    const base = String(baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${base}/models`, { method: 'GET', headers, signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 150)}`);
    }
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const ids = list
      .map((m) => String(m.id || m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    return { ok: true, models: Array.from(new Set(ids)) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// progress: { [absPath]: { [rowId]: translation } }
ipcMain.handle('progress:load', () => loadMergedProgress());
ipcMain.handle('progress:save', (e, data) => {
  saveProgressToDisk(data);
  return true;
});
ipcMain.on('progress:save-sync', (e, data) => {
  saveProgressToDisk(data);
  e.returnValue = true;
});
ipcMain.handle('progress:clear', () => {
  try { fs.rmSync(progressFile(), { force: true }); } catch { /* ignore */ }
  const s = getSettings();
  if (s.lastInstance && fs.existsSync(s.lastInstance)) {
    try { fs.rmSync(path.join(s.lastInstance, '.mctranslate', 'progress.json'), { force: true }); } catch { /* ignore */ }
  }
  return true;
});

function timestamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * jobs: [{ abs, base, type, translations }]
 * mode: 'apply' (write into the modpack, with backup) | 'export' (write into targetDir)
 */
ipcMain.handle('write', (e, { jobs, mode, targetDir }) => {
  const s = getSettings();
  const ts = timestamp();
  const written = [];
  const errors = [];
  let backupDir = null;
  const packDirs = new Set();

  for (const j of jobs) {
    try {
      const content = buildOutput(j.abs, j.type, j.translations, s.targetLang);
      const out = outputAbs(j.abs, j.type, s.targetLang);
      const relOut = path.relative(j.base, out);
      let dest = out;
      if (mode === 'export') {
        dest = path.join(targetDir, relOut);
      } else if (fs.existsSync(out)) {
        backupDir = path.join(j.base, '.mctranslate', 'backups', ts);
        const b = path.join(backupDir, relOut);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(out, b);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if ((j.type === 'lang-json' || j.type === 'dialogue-lang') && mode === 'export' && fs.existsSync(dest)) {
        try {
          const prev = JSON.parse(fs.readFileSync(dest, 'utf8'));
          const next = JSON.parse(content);
          fs.writeFileSync(dest, JSON.stringify({ ...prev, ...next }, null, 2) + '\n', 'utf8');
        } catch {
          fs.writeFileSync(dest, content, 'utf8');
        }
      } else {
        fs.writeFileSync(dest, content, 'utf8');
      }
      written.push(dest);

      // Track generated MCTranslate_RU resourcepack / datapack roots so we write pack.mcmeta
      const mPack = /^(.*[\\/]MCTranslate_RU(?:_Data)?)(?:[\\/]|$)/i.exec(dest);
      if (mPack) packDirs.add(mPack[1]);
    } catch (err) {
      errors.push(`${path.basename(j.abs)}: ${err.message}`);
    }
  }

  for (const pd of packDirs) {
    try {
      const mcmeta = path.join(pd, 'pack.mcmeta');
      if (!fs.existsSync(mcmeta)) {
        fs.writeFileSync(
          mcmeta,
          JSON.stringify(
            {
              pack: {
                pack_format: 15,
                supported_formats: [6, 48],
                description: 'MCTranslate Localization Pack',
              },
            },
            null,
            2
          ) + '\n',
          'utf8'
        );
      }
    } catch {}
  }

  return { written, errors, backupDir };
});

ipcMain.handle('write:server-pack', (e, { jobs, targetDir }) => {
  const s = getSettings();
  const written = [];
  const errors = [];
  const serverDir = path.join(targetDir, '1_Для_Сервера');
  const clientRpDir = path.join(targetDir, '2_Для_Игроков_ResourcePack', 'MCTranslate_RU');
  let serverCount = 0;
  let clientCount = 0;

  const SERVER_TYPES = new Set(['ftb', 'bq', 'puffish', 'dialogue-json']);

  for (const j of jobs) {
    try {
      const content = buildOutput(j.abs, j.type, j.translations, s.targetLang);
      const out = outputAbs(j.abs, j.type, s.targetLang);
      const relOut = path.relative(j.base, out).replace(/\\/g, '/');

      if (SERVER_TYPES.has(j.type)) {
        const dest = path.join(serverDir, relOut);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, 'utf8');
        written.push(dest);
        serverCount++;
        const mDp = /^(.*[\\/]MCTranslate_RU_Data)(?:[\\/]|$)/i.exec(dest);
        if (mDp) {
          const mcmeta = path.join(mDp[1], 'pack.mcmeta');
          if (!fs.existsSync(mcmeta)) {
            fs.writeFileSync(mcmeta, JSON.stringify({ pack: { pack_format: 15, supported_formats: [6, 48], description: 'MCTranslate Server Data Pack' } }, null, 2) + '\n', 'utf8');
          }
        }
      } else {
        // Client-side lang / dialogue-lang -> put inside clean resourcepack structure assets/<ns>/lang/ru_ru.json
        const assetsIdx = relOut.toLowerCase().indexOf('assets/');
        const innerAssets = assetsIdx >= 0 ? relOut.slice(assetsIdx) : path.posix.join('assets/modpack/lang', path.posix.basename(relOut));
        const dest = path.join(clientRpDir, innerAssets);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest) && (j.type === 'lang-json' || j.type === 'dialogue-lang')) {
          try {
            const prev = JSON.parse(fs.readFileSync(dest, 'utf8'));
            const next = JSON.parse(content);
            fs.writeFileSync(dest, JSON.stringify({ ...prev, ...next }, null, 2) + '\n', 'utf8');
          } catch {
            fs.writeFileSync(dest, content, 'utf8');
          }
        } else {
          fs.writeFileSync(dest, content, 'utf8');
        }
        written.push(dest);
        clientCount++;
      }
    } catch (err) {
      errors.push(`${path.basename(j.abs)}: ${err.message}`);
    }
  }

  let zipPath = null;
  let sha1 = '';
  if (clientCount > 0) {
    const mcmeta = path.join(clientRpDir, 'pack.mcmeta');
    fs.mkdirSync(clientRpDir, { recursive: true });
    fs.writeFileSync(
      mcmeta,
      JSON.stringify(
        {
          pack: {
            pack_format: 15,
            supported_formats: [6, 48],
            description: 'MCTranslate Localization ResourcePack (RU)',
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    zipPath = path.join(targetDir, '2_Для_Игроков_ResourcePack', 'MCTranslate_RU.zip');
    try {
      fs.rmSync(zipPath, { force: true });
      execSync(`tar.exe -a -c -f "${zipPath}" -C "${clientRpDir}" "pack.mcmeta" "assets"`, { stdio: 'ignore' });
      sha1 = crypto.createHash('sha1').update(fs.readFileSync(zipPath)).digest('hex');
    } catch { /* ignore if tar unavailable */ }
  }

  const readmeTxt = [
    '=== ПАКЕТ РУСИФИКАЦИИ СЕРВЕРА И КЛИЕНТОВ (MCTranslate) ===',
    '',
    '1. ПАПКА «1_Для_Сервера»:',
    '   Содержит серверные файлы (квесты FTB Quests, ветки талантов Puffish Skills и датапаки диалогов).',
    '   -> Скопируйте содержимое папки «1_Для_Сервера» (папку config) в корень вашего сервера с заменой файлов.',
    '   -> При входе на сервер эти квесты и таланты АВТОМАТИЧЕСКИ синхронизируются всем игрокам!',
    '',
    '2. ПАПКА «2_Для_Игроков_ResourcePack»:',
    '   Содержит ресурспак MCTranslate_RU.zip с переводом сюжетных диалогов NPC, предметов, боссов и интерфейса.',
    '   Поскольку сервер Minecraft не передаёт языковые файлы (ru_ru.json) сам по себе, есть 2 варианта:',
    '   Вариант А (простой): скиньте игрокам архив MCTranslate_RU.zip в папку resourcepacks (или config/paxi/resourcepacks).',
    '   Вариант Б (автоматический через server.properties):',
    '     Загрузите MCTranslate_RU.zip на любой прямой хостинг (Dropbox с ?dl=1, GitHub Releases или Discord) и укажите в server.properties:',
    '     resource-pack=<ПРЯМАЯ_ССЫЛКА_НА_MCTranslate_RU.zip>',
    ...(sha1 ? [`     resource-pack-sha1=${sha1}`] : []),
    '',
  ].join('\r\n');
  try {
    fs.writeFileSync(path.join(targetDir, 'ИНСТРУКЦИЯ_СЕРВЕР.txt'), readmeTxt, 'utf8');
  } catch {}

  return { written, errors, serverCount, clientCount, zipPath, sha1 };
});

ipcMain.handle('shell:open', (e, p) => shell.openPath(p));
ipcMain.handle('shell:show', (e, p) => shell.showItemInFolder(p));
