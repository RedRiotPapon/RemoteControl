import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { DockerService } from '../services/docker-service';
import { SessionManager } from '../services/session-manager';
import { WebSocketServer } from '../services/websocket-server';
import { DependencyChecker } from '../services/dependency-checker';
import { SessionConfig, getBestHostIP } from '@parallelbrowser/shared';
import { ChromeProfiles, ProfileSnapshot } from '../services/chrome-profiles';
import { randomBytes } from 'crypto';
import { InternetTunnel } from '../services/internet-tunnel';

let mainWindow: BrowserWindow | null = null;
let dockerService: DockerService;
let sessionManager: SessionManager;
let wsServer: WebSocketServer;
let setupWindow: BrowserWindow | null = null;
const profiles = new ChromeProfiles();
let startingBrowser = false;
let internetTunnel: InternetTunnel;
let sharingMode: 'internet' | 'lan' = 'internet';
let connectionInfo = { mode: 'internet', state: 'idle', endpoint: '', message: 'Internet sharing starts automatically with the browser.' };
function connectionStatus(state: string, endpoint = '', message = '') {
  connectionInfo = { mode: sharingMode, state, endpoint, message };
  sendToRenderer('sharing-update', connectionInfo);
}

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
  try {
    const saved = fs.readFileSync(path.join(app.getPath('userData'), 'session-settings.json'), 'utf8');
    if (saved.length <= 16384) sessionManager.updateConfig(JSON.parse(saved));
  } catch { /* First launch or invalid saved settings: use validated defaults. */ }
  wsServer = new WebSocketServer(sessionManager);
  internetTunnel = new InternetTunnel(app.isPackaged ? path.join(process.resourcesPath, 'tools/cloudflared.exe') : path.resolve(__dirname, '../../vendor/cloudflared.exe'));
  internetTunnel.on('unavailable', () => {
    wsServer.setPublicOrigin(null); sessionManager.revokeToken(); wsServer.disconnectClient();
    connectionStatus('error', '', 'Internet sharing stopped. Stop and restart the browser to reconnect.');
    sendToRenderer('server-error', connectionInfo.message);
  });
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
  ipcMain.handle('get-sharing-info', () => connectionInfo);
  ipcMain.handle('start-browser', async (_event, config?: Partial<SessionConfig>, profileId?: string, mode = 'internet') => {
    if (startingBrowser) return { success: false, error: 'A workspace is already being prepared.' };
    if (!['internet', 'lan'].includes(mode)) return { success: false, error: 'Choose Internet or Local network sharing.' };
    if (!['idle', 'error'].includes(sessionManager.getSessionInfo().status)) return { success: false, error: 'Stop the current browser before starting another session.' };
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
      await internetTunnel.stop(); wsServer.stop(); sharingMode = mode as 'internet' | 'lan';
      connectionStatus('connecting', '', mode === 'internet' ? 'Preparing secure internet sharing…' : 'Preparing local network sharing…');
      const sessionConfig = { ...sessionManager.getConfig(), ...config };
      const session = await sessionManager.startSession(sessionConfig, { profile });
      const hostIp = sharingMode === 'internet' ? '127.0.0.1' : getBestHostIP();
      sessionManager.setHostAddress(hostIp);
      wsServer.setHostIp(hostIp);
      try {
        await wsServer.start(sharingMode === 'internet');
        if (sharingMode === 'internet') {
          connectionStatus('connecting', '', 'Connecting to the internet sharing service…');
          const origin = await internetTunnel.start(wsServer.getPort(), wsServer.getConnectivityProof());
          wsServer.setPublicOrigin(origin);
          connectionStatus('ready', origin, 'Internet sharing is ready. No VPN is needed on either PC.');
        } else connectionStatus('ready', hostIp, 'Local network sharing is ready. Both PCs must be on the same network.');
      } catch (error) {
        wsServer.stop(); await internetTunnel.stop();
        await sessionManager.stopSession();
        throw error;
      }
      sendToRenderer('session-update', session);
      return { success: true, session };
    } catch (error: any) {
      connectionStatus('error', '', error.message);
      return { success: false, error: error.message };
    } finally {
      startingBrowser = false;
    }
  });

  ipcMain.handle('stop-browser', async () => {
    try {
      wsServer.stop();
      await internetTunnel.stop();
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
      if (connectionInfo.state !== 'ready') throw new Error('Wait for sharing to become ready. If it failed, stop and restart the browser.');
      if (sharingMode === 'internet') {
        const origin = internetTunnel.getOrigin();
        if (!origin) throw new Error('Internet sharing is unavailable. Restart the browser session.');
        const url = new URL(origin);
        const invitation = await sessionManager.generateInvitation(url.hostname, 443, true);
        return { success: true, invitation, hostIp: url.hostname };
      }
      const hostIp = getBestHostIP();
      sessionManager.setHostAddress(hostIp);
      wsServer.setHostIp(hostIp);
      const invitation = await sessionManager.generateInvitation(hostIp, wsServer.getPort());
      return { success: true, invitation, hostIp };
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

  // Settings
  ipcMain.handle('get-config', () => {
    return sessionManager.getConfig();
  });

  ipcMain.handle('update-config', (_event, config: Partial<SessionConfig>) => {
    const previous = sessionManager.getConfig();
    try {
      sessionManager.updateConfig(config);
      const file = path.join(app.getPath('userData'), 'session-settings.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(sessionManager.getConfig(), null, 2));
      fs.renameSync(file + '.tmp', file);
      return { success: true };
    } catch (error: any) {
      try { sessionManager.updateConfig(previous); } catch { /* Active sessions retain their configuration. */ }
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
    if (['stopping', 'idle', 'error'].includes(info.status)) {
      void closePrivateSetup().catch(() => {});
      void internetTunnel.stop(); wsServer.setPublicOrigin(null); connectionStatus('idle');
    }
  });
  sessionManager.on('cleanup-error', error => sendToRenderer('server-error', `Workspace cleanup needs a retry: ${error}`));
  sessionManager.on('resource-update', (usage) => sendToRenderer('resource-update', usage));

  // Forward WebSocket server events
  wsServer.on('client-connecting', (clientInfo) => {
    sendToRenderer('client-connecting', clientInfo);
    // Show approval dialog
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
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
    await internetTunnel?.stop();
    await sessionManager?.stopSession();
  } catch (e) {
    console.error('Cleanup error:', e);
  }
  app.quit();
  })();
});
