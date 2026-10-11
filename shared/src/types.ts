export interface SessionConfig {
  browserWidth: number;
  browserHeight: number;
  maxSessionDurationMinutes: number;
  containerImage: string;
}

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  startedAt: string | null;
  clientConnectedAt: string | null;
  browserResolution: { width: number; height: number };
  containerName: string;
  resourceUsage: ResourceUsage;
  profileName?: string;
  hostSetupRequired?: boolean;
}

export interface ResourceUsage {
  cpuPercent: number;
  memoryMB: number;
  memoryLimitMB: number;
}

export enum SessionStatus {
  IDLE = 'idle',
  STARTING = 'starting',
  RUNNING = 'running',
  CLIENT_PENDING = 'client_pending',
  CLIENT_CONNECTED = 'client_connected',
  STOPPING = 'stopping',
  ERROR = 'error',
}

export enum ClientAuthStatus {
  CONNECTING = 'connecting',
  AWAITING_APPROVAL = 'awaiting_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
}

export interface InvitationCode {
  hostAddress: string;
  port: number;
  token: string;
  expiresAt: string;
  secure: boolean;
}

export interface DependencyStatus {
  docker: { installed: boolean; running: boolean; version: string | null };
  wsl: { installed: boolean; version: string | null };
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  browserWidth: 1920,
  browserHeight: 1080,
  maxSessionDurationMinutes: 480,
  containerImage: 'kasmweb/chrome:1.15.0',
};

export const KASM_VNC_PORT = 6901;
export const WEBSOCKET_PROXY_PORT = 9500;
export const CONTAINER_NAME_PREFIX = 'parallelbrowser-session';
