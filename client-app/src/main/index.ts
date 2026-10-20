import { app, BrowserWindow, ipcMain, dialog, session } from 'electron';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ConnectionService } from '../services/connection-service';
import { FileTransfer, localDownloadName } from '../services/file-transfer';

let mainWindow: BrowserWindow | null = null;
let connectionService: ConnectionService;
let approvedOrigin: string | null = null;
const files = new FileTransfer(value => sendToRenderer('file-progress', value));
let fileBusy = false;
let approvedPartition: string | null = null;

async function clearRemoteStorage(): Promise<void> {
  const partition = approvedPartition;
  approvedPartition = null;
  if (!partition) return;
  const remote = session.fromPartition(partition);
  await Promise.all([remote.clearStorageData(), remote.clearCache()]);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'ParallelBrowser Client',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.backgroundThrottling = false;
    try {
      const blank = !params.src || params.src === 'about:blank';
      if (blank ? params.partition !== 'pb-remote-inactive' :
        params.partition !== approvedPartition || !approvedOrigin || new URL(params.src).origin !== approvedOrigin) event.preventDefault();
    } catch (_) { event.preventDefault(); }
  });
  mainWindow.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (url !== 'about:blank' && (!approvedOrigin || new URL(url).origin !== approvedOrigin)) event.preventDefault();
    });
  });
}

function sendToRenderer(channel: string, data: unknown): void {
  mainWindow?.webContents.send(channel, data);
}

function initializeServices(): void {
  connectionService = new ConnectionService();

  connectionService.on('status-change', (status) => {
    if (status === 'reconnecting') files.cancel();
    sendToRenderer('connection-status', status);
  });
  connectionService.on('resumed', () => sendToRenderer('connection-resumed', null));
  connectionService.on('approval-pending', () => sendToRenderer('approval-pending', null));
  connectionService.on('approved', (config) => {
    void clearRemoteStorage().catch(() => {});
    approvedPartition = `pb-remote-${randomBytes(16).toString('hex')}`;
    approvedOrigin = new URL(config.streamUrl).origin;
    files.approve(config.streamUrl);
    const { resumeToken, reconnectWindowMs, ...displayConfig } = config;
    sendToRenderer('approved', { ...displayConfig, viewerPartition: approvedPartition });
  });
  connectionService.on('rejected', (reason) => sendToRenderer('rejected', reason));
  connectionService.on('disconnected', (reason) => { approvedOrigin = null; files.clear(); sendToRenderer('disconnected', reason); void clearRemoteStorage().catch(() => {}); });
  connectionService.on('error', (error) => { approvedOrigin = null; files.clear(); sendToRenderer('connection-error', error); void clearRemoteStorage().catch(() => {}); });
  connectionService.on('session-status', (status) => sendToRenderer('session-status', status));
}

function setupIPC(): void {
  ipcMain.handle('connect', async (_event, invitationCode: string, clientName: string) => {
    try {
      await connectionService.connect(invitationCode, clientName);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('disconnect', async () => {
    try {
      approvedOrigin = null;
      files.clear();
      connectionService.disconnect();
      void clearRemoteStorage().catch(() => {});
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('toggle-fullscreen', () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  ipcMain.handle('get-connection-status', () => {
    return connectionService.getStatus();
  });

  ipcMain.handle('list-downloads', async event => {
    try {
      if (event.sender !== mainWindow?.webContents) throw new Error('File access denied.');
      return { success: true, files: await files.list() };
    } catch (error: any) { return { success: false, error: error.message }; }
  });
  ipcMain.handle('upload-files', async event => {
    if (event.sender !== mainWindow?.webContents || !mainWindow || fileBusy) return { success: false, error: 'Wait for the current file transfer.' };
    fileBusy = true;
    const generation = files.getGeneration();
    try {
      files.assertConnected();
      const selected = await dialog.showOpenDialog(mainWindow, { title: 'Upload from this PC', properties: ['openFile', 'multiSelections'] });
      if (selected.canceled) return { success: true, cancelled: true };
      files.assertConnected(generation);
      const uploaded: string[] = [];
      for (const file of selected.filePaths) {
        files.assertConnected(generation);
        try { uploaded.push((await files.upload(file)).name); }
        catch (error: any) {
          throw new Error(`${uploaded.length ? uploaded.length + ' file(s) uploaded. ' : ''}${path.basename(file)}: ${error.message}`);
        }
      }
      return { success: true, uploaded };
    } catch (error: any) { return { success: false, error: error.message }; }
    finally { fileBusy = false; }
  });
  ipcMain.handle('save-download', async (event, name: string) => {
    if (event.sender !== mainWindow?.webContents || !mainWindow || fileBusy) return { success: false, error: 'Wait for the current file transfer.' };
    fileBusy = true;
    const generation = files.getGeneration();
    try {
      files.assertConnected();
      if (typeof name !== 'string' || !name || name.length > 255) throw new Error('Invalid download name.');
      const selected = await dialog.showSaveDialog(mainWindow, { title: 'Save download to this PC',
        defaultPath: path.join(app.getPath('downloads'), localDownloadName(name)) });
      if (selected.canceled || !selected.filePath) return { success: true, cancelled: true };
      files.assertConnected(generation);
      await files.download(name, selected.filePath);
      return { success: true };
    } catch (error: any) { return { success: false, error: error.message }; }
    finally { fileBusy = false; }
  });
  ipcMain.handle('cancel-file-transfer', event => {
    if (event.sender === mainWindow?.webContents) files.cancel();
  });
}

app.whenReady().then(() => {
  initializeServices();
  setupIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  files.clear();
  connectionService?.disconnect();
  app.quit();
});
