import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { DockerService } from '../services/docker-service';
import { SessionManager } from '../services/session-manager';
import { WebSocketServer } from '../services/websocket-server';
import { DependencyChecker } from '../services/dependency-checker';
import { SessionConfig, getBestHostIP } from '@parallelbrowser/shared';
import { ChromeProfiles, ProfileSnapshot } from '../services/chrome-profiles';
import { randomBytes } from 'crypto';

let mainWindow: BrowserWindow | null = null;
let dockerService: DockerService;
let sessionManager: SessionManager;
let wsServer: WebSocketServer;
let setupWindow: BrowserWindow | null = null;
const profiles = new ChromeProfiles();
let startingBrowser = false;

async function closePrivateSetup(): Promise<void> {
  wsServer.closeHostSetup();
  const window = setupWindow;
  setupWindow = null;
  if (window && !window.isDestroyed()) {
    const session = window.webContents.session;
    window.destroy();
    await session.clearStorageData();
    await session.clearCache();
  }
}

async function openPrivateSetup(): Promise<void> {
  await closePrivateSetup();
  const url = await wsServer.openHostSetup();
  const origin = new URL(url).origin;
  const window = new BrowserWindow({ width: 1120, height: 800, minWidth: 800, minHeight: 600,
    title: 'Private host setup — finish in the Host app when ready',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: `host-setup-${randomBytes(16).toString('hex')}` } });
  setupWindow = window;
  const viewerSession = window.webContents.session;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== origin) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, target) => { if (new URL(target).origin !== origin) event.preventDefault(); });
  window.on('closed', () => {
    if (setupWindow === window) { setupWindow = null; wsServer.closeHostSetup(); }
    void viewerSession.clearStorageData().then(() => viewerSession.clearCache()).catch(() => {});
  });
  await window.loadURL(url);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 550,
    title: 'ParallelBrowser Host',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function initializeServices(): void {
  dockerService = new DockerService();
  sessionManager = new SessionManager(dockerService);
  wsServer = new WebSocketServer(sessionManager);
}

function setupIPC(): void {
  ipcMain.handle('list-chrome-profiles', async () => {
    try { return { success: true, profiles: await profiles.list() }; }
    catch (error: any) { return { success: false, error: error.message }; }
  });
  ipcMain.handle('open-host-setup', async () => {
    try { await openPrivateSetup(); return { success: true }; }
    catch (error: any) { return { success: false, error: error.message }; }
  });
  ipcMain.handle('finish-host-setup', async () => {
    try {
      if (!sessionManager.getSessionInfo().hostSetupRequired) throw new Error('Open private setup first.');
      const result = await dialog.showMessageBox(mainWindow!, { type: 'question', buttons: ['Cancel', 'Ready for client'], defaultId: 0, cancelId: 0,
        title: 'Allow client access after setup', message: 'Have you finished signing in and preparing the browser?',
        detail: 'An approved client can use websites you signed into and see the imported bookmarks. Only continue when the workspace is ready to share. Temporary workspace data is removed when the session ends.' });
      if (result.response !== 1) return { success: true, cancelled: true };
      await closePrivateSetup(); sessionManager.finishHostSetup(); return { success: true };
    } catch (error: any) { return { success: false, error: error.message }; }
  });
  // Dependency checks
  ipcMain.handle('check-dependencies', async () => {
    const checker = new DependencyChecker();
    return checker.checkAll();
  });

  // Session management
  ipcMain.handle('start-browser', async (_event, config?: Partial<SessionConfig>, profileId?: string) => {
    if (startingBrowser) return { success: false, error: 'A workspace is already being prepared.' };
    startingBrowser = true;
    try {
      let profile: ProfileSnapshot | undefined;
      if (profileId) {
        const selected = (await profiles.list()).find(profile => profile.id === profileId);
        if (!selected) throw new Error('Select an available Chrome profile.');
        const approval = await dialog.showMessageBox(mainWindow!, { type: 'question', buttons: ['Cancel', 'Allow temporary copy'], defaultId: 0, cancelId: 0,
          title: 'Authorize Chrome profile for this session', message: `Share a temporary copy of “${selected.name}”?`,
          detail: 'Only web bookmarks, the homepage and bookmark-bar settings are imported into an isolated browser on this PC. Passwords, cookies, history, autofill and extensions are not copied. You must sign in yourself in private setup before inviting the client. The client can see bookmarks and use signed-in websites after you approve access. Disconnecting the client or stopping the session removes the temporary workspace. Your original Windows Chrome profile stays unchanged.' });
        if (approval.response !== 1) return { success: true, cancelled: true };
        profile = await profiles.snapshot(selected.id);
      }
      const sessionConfig = { ...sessionManager.getConfig(), ...config };
      const session = await sessionManager.startSession(sessionConfig, { profile });
      const checker = new DependencyChecker();
      const deps = await checker.checkAll();
      const hostIp = getBestHostIP(deps.tailscale.ip);
      sessionManager.setHostAddress(hostIp);
      wsServer.setHostIp(hostIp);
      try {
        await wsServer.start();
      } catch (error) {
        await sessionManager.stopSession();
        throw error;
      }
      sendToRenderer('session-update', session);
      return { success: true, session };
    } catch (error: any) {
      return { success: false, error: error.message };
    } finally {
      startingBrowser = false;
    }
  });

  ipcMain.handle('stop-browser', async () => {
    try {
      wsServer.stop();
      await sessionManager.stopSession();
      sendToRenderer('session-update', sessionManager.getSessionInfo());
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-session-info', () => {
    return sessionManager.getSessionInfo();
  });

  // Connection management
  ipcMain.handle('generate-invitation', async () => {
    try {
      const checker = new DependencyChecker();
      const deps = await checker.checkAll();
      const hostIp = getBestHostIP(deps.tailscale.ip);
      sessionManager.setHostAddress(hostIp);
      wsServer.setHostIp(hostIp);
      const invitation = await sessionManager.generateInvitation(hostIp);
      return { success: true, invitation, hostIp };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('start-server', async () => {
    try {
      const checker = new DependencyChecker();
      const deps = await checker.checkAll();
      const hostIp = getBestHostIP(deps.tailscale.ip);
      sessionManager.setHostAddress(hostIp);
      wsServer.setHostIp(hostIp);
      await wsServer.start();
      return { success: true, port: wsServer.getPort(), hostIp };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('stop-server', async () => {
    try {
      wsServer.stop();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('disconnect-client', async () => {
    try {
      wsServer.disconnectClient();
      sendToRenderer('client-disconnected', null);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('approve-client', async (_event, approve: boolean) => {
    try {
      wsServer.handleApproval(approve);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-tailscale-ip', async () => {
    const checker = new DependencyChecker();
    const deps = await checker.checkAll();
    return deps.tailscale.ip;
  });

  // Settings
  ipcMain.handle('get-config', () => {
    return sessionManager.getConfig();
  });

  ipcMain.handle('update-config', (_event, config: Partial<SessionConfig>) => {
    try {
      sessionManager.updateConfig(config);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}

function sendToRenderer(channel: string, data: unknown): void {
  mainWindow?.webContents.send(channel, data);
}

function setupEventForwarding(): void {
  // Forward session manager events to renderer
  sessionManager.on('session-update', (info) => sendToRenderer('session-update', info));
  sessionManager.on('session-update', info => {
    if (['stopping', 'idle', 'error'].includes(info.status)) void closePrivateSetup().catch(() => {});
  });
  sessionManager.on('cleanup-error', error => sendToRenderer('server-error', `Workspace cleanup needs a retry: ${error}`));
  sessionManager.on('resource-update', (usage) => sendToRenderer('resource-update', usage));

  // Forward WebSocket server events
  wsServer.on('client-connecting', (clientInfo) => {
    sendToRenderer('client-connecting', clientInfo);
    // Show approval dialog
    if (mainWindow) {
      mainWindow.flashFrame(true);
      sendToRenderer('approval-requested', clientInfo);
    }
  });
  wsServer.on('client-connected', (clientInfo) => sendToRenderer('client-connected', clientInfo));
  wsServer.on('client-disconnected', () => sendToRenderer('client-disconnected', null));
  wsServer.on('server-error', (error) => sendToRenderer('server-error', error));
}

app.whenReady().then(() => {
  initializeServices();
  setupIPC();
  setupEventForwarding();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

let cleanupStarted = false;
app.on('before-quit', (event) => {
  if (cleanupStarted) return;
  event.preventDefault();
  cleanupStarted = true;
  void (async () => {
  try {
    wsServer?.stop();
    await sessionManager?.stopSession();
  } catch (e) {
    console.error('Cleanup error:', e);
  }
  app.quit();
  })();
});
