const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  discoverNAS: () => ipcRenderer.invoke('discover-nas'),
  connectNAS: (opts) => ipcRenderer.invoke('connect-nas', opts),
  runBackup: () => ipcRenderer.invoke('run-backup'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  onStatusUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('status-update', handler);
    return () => ipcRenderer.removeListener('status-update', handler);
  },
});
