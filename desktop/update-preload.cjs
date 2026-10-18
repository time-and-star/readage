const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('readageInstaller', {
  status: () => ipcRenderer.invoke('readage-installer-status'),
  download: (version, expected) => ipcRenderer.invoke('readage-installer-download', version, expected),
  pause: () => ipcRenderer.invoke('readage-installer-pause'),
  resume: () => ipcRenderer.invoke('readage-installer-resume'),
  cancel: () => ipcRenderer.invoke('readage-installer-cancel'),
  install: version => ipcRenderer.invoke('readage-installer-install', version),
});
