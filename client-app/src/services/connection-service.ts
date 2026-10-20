import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { MessageType, createMessage, parseMessage, parseInvitationCode,
  isInvitationExpired, ClientAuthStatus } from '@parallelbrowser/shared';

export class ConnectionService extends EventEmitter {
  private ws: WebSocket | null = null;
  private status = ClientAuthStatus.DISCONNECTED;
  private approvalTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private recoveryDeadline = 0;
  private retries = 0;
  private resumeToken: string | null = null;
  private sessionId: string | null = null;
  private origin = '';
  private lastActivity = 0;
  private generation = 0;

  async connect(code: string, name: string): Promise<void> {
    this.disconnect();
    const invitation = parseInvitationCode(code.trim());
    if (!invitation) throw new Error('Invalid invitation code. Please check and try again.');
    if (isInvitationExpired(invitation.expiresAt)) throw new Error('This invitation has expired. Request a new one from the host.');
    this.origin = new URL(`${invitation.secure ? 'https' : 'http'}://${invitation.hostAddress}:${invitation.port}`).origin;
    this.setStatus(ClientAuthStatus.CONNECTING);
    await this.open(false, { token: invitation.token, clientName: name.trim().slice(0, 100) || 'Remote Client', clientVersion: '1.1.1' });
  }

  private open(resuming: boolean, auth?: unknown): Promise<void> {
    const generation = this.generation;
    const ws = new WebSocket(this.origin.replace(/^http/, 'ws') + '/control', {
      handshakeTimeout: resuming ? Math.max(1, Math.min(10000, this.recoveryDeadline - Date.now())) : 15000,
      followRedirects: false,
    });
    this.ws = ws;
    return new Promise<void>((resolve, reject) => {
      let opened = false, settled = false;
      const current = () => this.ws === ws && generation === this.generation;
      const failed = (message: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (!opened || resuming) reject(new Error(message));
        if (!current()) return;
        this.ws = null; this.clearSocketTimers(); ws.terminate();
        if (this.resumeToken) this.recover();
        else if (opened) this.finish(ClientAuthStatus.DISCONNECTED, 'disconnected', message);
        else this.setStatus(ClientAuthStatus.ERROR);
      };
      const timer = setTimeout(() => failed('Connection timed out. Check that the host is running and reachable.'),
        resuming ? Math.max(1, Math.min(12000, this.recoveryDeadline - Date.now())) : 15000);
      ws.on('open', () => {
        if (!current()) { ws.terminate(); return; }
        opened = true; this.lastActivity = Date.now();
        ws.send(JSON.stringify(createMessage(resuming ? MessageType.RESUME_REQUEST : MessageType.AUTH_REQUEST,
          resuming ? { resumeToken: this.resumeToken } : auth)));
        // Keep the deadline running until a resume has actually been authenticated.
        if (!resuming) { clearTimeout(timer); resolve(); }
        if (!resuming) this.approvalTimer = setTimeout(() => {
          if (!current() || this.status === ClientAuthStatus.APPROVED) return;
          settled = true; clearTimeout(timer);
          this.finish(ClientAuthStatus.ERROR, 'error', 'Host approval timed out. Reconnect and ask the host to approve.');
        }, 120000);
        this.heartbeat = setInterval(() => {
          if (!current()) return;
          if (Date.now() - this.lastActivity > 45000) { failed('The connection stopped responding.'); return; }
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 10000);
      });
      ws.on('pong', () => { if (current()) this.lastActivity = Date.now(); });
      ws.on('message', (data, binary) => {
        if (!current() || binary || settled) return;
        this.lastActivity = Date.now();
        const msg = parseMessage(data.toString());
        if (!msg) return;
        const payload = msg.payload as any;
        const terminal = (state: ClientAuthStatus, event: string, message: string) => {
          settled = true; clearTimeout(timer); this.finish(state, event, message);
          if (resuming) reject(new Error(message));
        };
        switch (msg.type) {
          case MessageType.APPROVAL_PENDING:
            if (!resuming) { this.setStatus(ClientAuthStatus.AWAITING_APPROVAL); this.emit('approval-pending'); }
            break;
          case MessageType.APPROVAL_GRANTED:
            if (resuming) { terminal(ClientAuthStatus.ERROR, 'error', 'The host could not restore the previous session.'); break; }
            try {
              const stream = new URL(payload?.streamUrl);
              if (stream.origin !== this.origin || stream.username || stream.password || stream.pathname !== '/stream/' ||
                  !/^[a-f0-9]{64}$/.test(stream.searchParams.get('access') || '') ||
                  (payload.resumeToken !== undefined && (typeof payload.resumeToken !== 'string' || !/^[a-f0-9]{64}$/.test(payload.resumeToken)))) throw new Error();
            } catch {
              terminal(ClientAuthStatus.ERROR, 'error', 'The host returned an invalid workspace address. Update both apps and request a new invitation.'); break;
            }
            this.clearApprovalTimer();
            this.resumeToken = payload.resumeToken || null; this.sessionId = payload.sessionId;
            this.setStatus(ClientAuthStatus.APPROVED); this.emit('approved', payload); break;
          case MessageType.SESSION_RESUMED:
            if (!resuming || payload?.sessionId !== this.sessionId) {
              terminal(ClientAuthStatus.ERROR, 'error', 'The host could not restore the previous session.'); break;
            }
            clearTimeout(timer); this.clearApprovalTimer(); this.recoveryDeadline = 0; this.retries = 0;
            this.setStatus(ClientAuthStatus.APPROVED); this.emit('resumed'); resolve(); break;
          case MessageType.APPROVAL_DENIED:
            terminal(ClientAuthStatus.REJECTED, 'rejected', payload?.reason || 'Access denied'); break;
          case MessageType.AUTH_RESULT:
            if (!payload?.success) {
              if (resuming && payload?.retryable === true) failed('Waiting for the host to recover the connection.');
              else terminal(ClientAuthStatus.ERROR, 'error', payload?.reason || 'Authentication failed');
            }
            break;
          case MessageType.ERROR:
            terminal(ClientAuthStatus.ERROR, 'error', payload?.message || 'Connection failed'); break;
          case MessageType.DISCONNECT:
            terminal(ClientAuthStatus.DISCONNECTED, 'disconnected', payload?.reason || 'Disconnected by host'); break;
          case MessageType.SESSION_STATUS: this.emit('session-status', payload); break;
          case MessageType.HEARTBEAT: break;
        }
      });
      ws.on('close', (_code, reason) => failed(reason.toString() || 'Connection closed. Request a new invitation from the host.'));
      ws.on('error', error => failed(`Connection failed: ${error.message}`));
    });
  }

  private recover(): void {
    if (!this.recoveryDeadline) {
      this.recoveryDeadline = Date.now() + 60000; this.retries = 0;
      this.setStatus(ClientAuthStatus.RECONNECTING);
    }
    const remaining = this.recoveryDeadline - Date.now();
    if (remaining <= 0) {
      this.finish(ClientAuthStatus.DISCONNECTED, 'disconnected', 'Could not reconnect within one minute. Ask the host for a new invitation.'); return;
    }
    const delay = Math.min(remaining, Math.min(8000, 500 * 2 ** Math.min(this.retries++, 4)) + Math.random() * 250);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (Date.now() >= this.recoveryDeadline) { this.recover(); return; }
      void this.open(true).catch(() => { /* The socket failure handler owns retries. */ });
    }, delay);
  }

  private finish(status: ClientAuthStatus, event: string, message: string): void {
    const ws = this.ws;
    this.ws = null; this.reset(); this.setStatus(status); ws?.terminate();
    this.emit(event, message);
  }

  disconnect(): void {
    const ws = this.ws, credential = this.resumeToken, origin = this.origin;
    this.ws = null; this.reset();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(createMessage(MessageType.DISCONNECT, { resumeToken: credential }))); ws.close();
    } else {
      ws?.terminate();
      // If the user leaves during recovery, revoke the suspended session when reachable.
      if (credential && origin) {
        const leave = new WebSocket(origin.replace(/^http/, 'ws') + '/control', { handshakeTimeout: 5000, followRedirects: false });
        const timer = setTimeout(() => leave.terminate(), 6000); timer.unref();
        leave.once('open', () => { leave.send(JSON.stringify(createMessage(MessageType.DISCONNECT, { resumeToken: credential }))); leave.close(); });
        leave.once('error', () => {}); leave.once('close', () => clearTimeout(timer));
      }
    }
    this.setStatus(ClientAuthStatus.DISCONNECTED);
  }
  getStatus(): ClientAuthStatus { return this.status; }
  private setStatus(status: ClientAuthStatus): void { this.status = status; this.emit('status-change', status); }
  private clearApprovalTimer(): void { if (this.approvalTimer) clearTimeout(this.approvalTimer); this.approvalTimer = null; }
  private clearSocketTimers(): void { this.clearApprovalTimer(); if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; }
  private reset(): void {
    this.generation++; this.clearSocketTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null; this.resumeToken = null; this.sessionId = null;
    this.recoveryDeadline = 0; this.origin = '';
  }
}
