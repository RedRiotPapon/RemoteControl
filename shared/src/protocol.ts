// WebSocket message protocol between host and client

export enum MessageType {
  // Auth flow
  AUTH_REQUEST = 'auth_request',
  RESUME_REQUEST = 'resume_request',
  SESSION_RESUMED = 'session_resumed',
  AUTH_CHALLENGE = 'auth_challenge',
  AUTH_RESPONSE = 'auth_response',
  AUTH_RESULT = 'auth_result',

  // Session control
  SESSION_STATUS = 'session_status',
  SESSION_CONFIG = 'session_config',

  // Client approval
  APPROVAL_PENDING = 'approval_pending',
  APPROVAL_GRANTED = 'approval_granted',
  APPROVAL_DENIED = 'approval_denied',

  // VNC relay
  VNC_DATA = 'vnc_data',
  VNC_RESIZE = 'vnc_resize',

  // Control
  DISCONNECT = 'disconnect',
  HEARTBEAT = 'heartbeat',
  ERROR = 'error',
}

export interface ProtocolMessage {
  type: MessageType;
  payload: unknown;
  timestamp: number;
  messageId: string;
}

export interface AuthRequestPayload {
  token: string;
  clientName: string;
  clientVersion: string;
}

export interface AuthResultPayload {
  success: boolean;
  reason?: string;
  sessionId?: string;
  vncConfig?: {
    width: number;
    height: number;
  };
}

export interface ApprovalGrantedPayload {
  sessionId: string;
  resumeToken?: string;
  reconnectWindowMs?: number;
  streamUrl?: string;
  hostAddress: string;
  port: number;
  token?: string;
  vncConfig?: {
    width: number;
    height: number;
  };
}

export interface SessionStatusPayload {
  status: string;
  uptime: number;
  clientConnected: boolean;
  resourceUsage: {
    cpuPercent: number;
    memoryMB: number;
  };
}

export interface VncResizePayload {
  width: number;
  height: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export function createMessage(type: MessageType, payload: unknown): ProtocolMessage {
  return {
    type,
    payload,
    timestamp: Date.now(),
    messageId: `${type}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
  };
}

export function parseMessage(data: string): ProtocolMessage | null {
  try {
    const msg = JSON.parse(data) as ProtocolMessage;
    if (!msg.type || !msg.timestamp || !msg.messageId) return null;
    return msg;
  } catch {
    return null;
  }
}
