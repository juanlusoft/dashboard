const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { scanNetwork } = require('./scanner');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 600,
    minWidth: 400,
    minHeight: 500,
    resizable: true,
    frame: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../assets/icon.svg')
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  
  // Quitar menú en producción
  if (!process.argv.includes('--dev')) {
    mainWindow.setMenu(null);
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('scan-network', async () => {
  try {
    return await scanNetwork();
  } catch (err) {
    console.error('Network scan failed:', err);
    return [];
  }
});

ipcMain.handle('open-nas', (event, url) => {
  // SECURITY: Validate URL before opening — only allow https:// and http:// protocols
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      console.error('Blocked openExternal with non-HTTP protocol:', parsed.protocol);
      return;
    }
    shell.openExternal(url);
  } catch (e) {
    console.error('Invalid URL passed to open-nas:', e.message);
  }
});
