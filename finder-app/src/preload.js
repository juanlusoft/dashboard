const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('finder', {
  scanNetwork: () => ipcRenderer.invoke('scan-network'),
  openNAS: (url) => {
    // Validate URL before sending to main process
    if (typeof url !== 'string') return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
      ipcRenderer.invoke('open-nas', url);
    } catch (e) {
      console.error('Invalid URL:', e.message);
    }
  }
});
