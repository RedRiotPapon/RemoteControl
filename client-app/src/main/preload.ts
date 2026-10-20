import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clientAPI', {
  connect: (invitationCode: string, clientName: string) =>
    ipcRenderer.invoke('connect', invitationCode, clientName),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),
  uploadFiles: () => ipcRenderer.invoke('upload-files'),
  listDownloads: () => ipcRenderer.invoke('list-downloads'),
  saveDownload: (name: string) => ipcRenderer.invoke('save-download', name),
  cancelFileTransfer: () => ipcRenderer.invoke('cancel-file-transfer'),
  onFileProgress: (cb: (progress: any) => void) => {
    ipcRenderer.on('file-progress', (_event, value) => cb(value));
  },

  // Events
  onConnectionStatus: (cb: (status: any) => void) => {
    ipcRenderer.on('connection-status', (_e, d) => cb(d));
  },
  onResumed: (cb: () => void) => { ipcRenderer.on('connection-resumed', () => cb()); },
  onApprovalPending: (cb: () => void) => {
    ipcRenderer.on('approval-pending', () => cb());
  },
  onApproved: (cb: (config: any) => void) => {
    ipcRenderer.on('approved', (_e, d) => cb(d));
  },
  onRejected: (cb: (reason: string) => void) => {
    ipcRenderer.on('rejected', (_e, d) => cb(d));
  },
  onDisconnected: (cb: (reason: string) => void) => {
    ipcRenderer.on('disconnected', (_e, d) => cb(d));
  },
  onError: (cb: (error: string) => void) => {
    ipcRenderer.on('connection-error', (_e, d) => cb(d));
  },
  onSessionStatus: (cb: (status: any) => void) => {
    ipcRenderer.on('session-status', (_e, d) => cb(d));
  },
});
