const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('readageInstaller', {
  status: () => ipcRenderer.invoke('readage-installer-status'),
  download: version => ipcRenderer.invoke('readage-installer-download', version),
  cancel: () => ipcRenderer.invoke('readage-installer-cancel'),
  install: version => ipcRenderer.invoke('readage-installer-install', version),
});
