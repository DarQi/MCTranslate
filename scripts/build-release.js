'use strict';
/**
 * Standalone builder for MCTranslate (used locally via `npm run dist` and in GitHub Actions).
 * Copies Electron runtime, strips ~88 MB of unused Chromium locales/DLLs,
 * packages app source, and compresses release/MCTranslate.zip.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const relRoot = path.join(root, 'release');
const outDir = path.join(relRoot, 'MCTranslate');
const zipPath = path.join(relRoot, 'MCTranslate.zip');

if (!fs.existsSync(electronDist)) {
  throw new Error('Electron dist not found. Run `npm install` first.');
}

fs.rmSync(relRoot, { recursive: true, force: true });
fs.mkdirSync(relRoot, { recursive: true });
fs.cpSync(electronDist, outDir, { recursive: true });

// Rename electron.exe -> MCTranslate.exe
const srcExe = path.join(outDir, 'electron.exe');
const dstExe = path.join(outDir, 'MCTranslate.exe');
if (fs.existsSync(srcExe)) fs.renameSync(srcExe, dstExe);

// Strip unused locales (keep only ru.pak and en-US.pak)
const localesDir = path.join(outDir, 'locales');
if (fs.existsSync(localesDir)) {
  for (const f of fs.readdirSync(localesDir)) {
    if (f !== 'ru.pak' && f !== 'en-US.pak') {
      fs.rmSync(path.join(localesDir, f), { force: true });
    }
  }
}

// Strip unused 3D shader compilers, Vulkan software renderer, and license bloat
const bloat = [
  'dxcompiler.dll',
  'd3dcompiler_47.dll',
  'LICENSES.chromium.html',
  'LICENSE.electron.txt',
  'vk_swiftshader.dll',
  'vulkan-1.dll',
  'vk_swiftshader_icd.json',
  'electron_wer.dll',
  path.join('resources', 'default_app.asar'),
];
for (const rel of bloat) {
  fs.rmSync(path.join(outDir, rel), { recursive: true, force: true });
}

// Copy application source into resources/app
const appDir = path.join(outDir, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });

console.log('Built standalone folder:', outDir);

// Create MCTranslate.zip
if (process.platform === 'win32') {
  execSync(`tar.exe -a -c -f "${zipPath}" -C "${relRoot}" "MCTranslate"`, { stdio: 'inherit' });
  console.log('Created archive:', zipPath);
}
