import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hostAPI', {
  // Dependencies
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),

  // Session
  startBrowser: (config?: any, profileId?: string, mode?: string) => ipcRenderer.invoke('start-browser', config, profileId, mode),
  getSharingInfo: () => ipcRenderer.invoke('get-sharing-info'),
  onSharingUpdate: (callback: (data: any) => void) => ipcRenderer.on('sharing-update', (_event, data) => callback(data)),
  listChromeProfiles: () => ipcRenderer.invoke('list-chrome-profiles'),
  openHostSetup: () => ipcRenderer.invoke('open-host-setup'),
  finishHostSetup: () => ipcRenderer.invoke('finish-host-setup'),
  stopBrowser: () => ipcRenderer.invoke('stop-browser'),
  getSessionInfo: () => ipcRenderer.invoke('get-session-info'),

  // Connection
  generateInvitation: () => ipcRenderer.invoke('generate-invitation'),
  disconnectClient: () => ipcRenderer.invoke('disconnect-client'),
  approveClient: (approve: boolean) => ipcRenderer.invoke('approve-client', approve),

  // Settings
  getConfig: () => ipcRenderer.invoke('get-config'),
  updateConfig: (config: any) => ipcRenderer.invoke('update-config', config),

  // Events
  onSessionUpdate: (callback: (data: any) => void) => {
    ipcRenderer.on('session-update', (_event, data) => callback(data));
  },
  onResourceUpdate: (callback: (data: any) => void) => {
    ipcRenderer.on('resource-update', (_event, data) => callback(data));
  },
  onClientConnecting: (callback: (data: any) => void) => {
    ipcRenderer.on('client-connecting', (_event, data) => callback(data));
  },
  onClientConnected: (callback: (data: any) => void) => {
    ipcRenderer.on('client-connected', (_event, data) => callback(data));
  },
  onClientDisconnected: (callback: (data: any) => void) => {
    ipcRenderer.on('client-disconnected', (_event, data) => callback(data));
  },
  onApprovalRequested: (callback: (data: any) => void) => {
    ipcRenderer.on('approval-requested', (_event, data) => callback(data));
  },
  onServerError: (callback: (data: any) => void) => {
    ipcRenderer.on('server-error', (_event, data) => callback(data));
  },
});
