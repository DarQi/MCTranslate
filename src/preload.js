'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  setSettingsSync: (s) => ipcRenderer.sendSync('settings:set-sync', s),
  pickFolder: (title) => ipcRenderer.invoke('dialog:folder', title),
  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  scan: (dir) => ipcRenderer.invoke('scan', dir),
  openFiles: (paths) => ipcRenderer.invoke('open-files', paths),
  translate: (texts) => ipcRenderer.invoke('translate', texts),
  loadProgress: () => ipcRenderer.invoke('progress:load'),
  saveProgress: (data) => ipcRenderer.invoke('progress:save', data),
  saveProgressSync: (data) => ipcRenderer.sendSync('progress:save-sync', data),
  write: (payload) => ipcRenderer.invoke('write', payload),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
});
