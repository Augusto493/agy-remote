// Expõe à interface (servida pelo servidor local) só o que o app desktop oferece a mais.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agyDesktop', {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  setTheme: (mode) => ipcRenderer.invoke('set-theme', mode),
  // Chat da missão numa janelinha sempre por cima (continua aberta mesmo fechando a janela principal)
  openMini: (missionId) => ipcRenderer.invoke('open-mini', missionId),
  closeMini: () => ipcRenderer.invoke('close-mini'),
  setMiniOnTop: (on) => ipcRenderer.invoke('mini-on-top', on),
});
