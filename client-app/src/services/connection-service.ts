import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { MessageType, createMessage, parseMessage, parseInvitationCode,
  isInvitationExpired, ClientAuthStatus } from '@parallelbrowser/shared';

export class ConnectionService extends EventEmitter {
  private ws: WebSocket | null = null;
  private status = ClientAuthStatus.DISCONNECTED;
  private approvalTimer: NodeJS.Timeout | null = null;

  async connect(code: string, name: string): Promise<void> {
    this.disconnect();
    const invitation = parseInvitationCode(code.trim());
    if (!invitation) throw new Error('Invalid invitation code. Please check and try again.');
    if (isInvitationExpired(invitation.expiresAt)) throw new Error('This invitation has expired. Request a new one from the host.');
    this.setStatus(ClientAuthStatus.CONNECTING);
    const origin = new URL(`${invitation.secure ? 'https' : 'http'}://${invitation.hostAddress}:${invitation.port}`).origin;
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/control', { handshakeTimeout: 15000, followRedirects: false });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      let opened = false, terminal = false;
      const timeout = setTimeout(() => {
        if (this.ws !== ws) return;
        terminal = true;
        this.setStatus(ClientAuthStatus.ERROR);
        reject(new Error('Connection timeout. Check that the host is running and reachable.'));
        ws.terminate();
      }, 15000);
      ws.on('open', () => {
        if (this.ws !== ws) return;
        opened = true; clearTimeout(timeout);
        ws.send(JSON.stringify(createMessage(MessageType.AUTH_REQUEST, {
          token: invitation.token, clientName: name.trim().slice(0, 100) || 'Remote Client', clientVersion: '1.1.0',
        })));
        this.approvalTimer = setTimeout(() => {
          if (this.ws !== ws || this.status === ClientAuthStatus.APPROVED) return;
          terminal = true;
          this.setStatus(ClientAuthStatus.ERROR);
          this.emit('error', 'Host approval timed out. Reconnect and ask the host to approve.');
          ws.close();
        }, 120000);
        resolve();
      });
      ws.on('message', (data, binary) => {
        if (this.ws !== ws || binary) return;
        const msg = parseMessage(data.toString());
        if (!msg) return;
        const payload = msg.payload as any;
        switch (msg.type) {
          case MessageType.APPROVAL_PENDING:
            this.setStatus(ClientAuthStatus.AWAITING_APPROVAL); this.emit('approval-pending'); break;
          case MessageType.APPROVAL_GRANTED:
            try {
              const stream = new URL(payload?.streamUrl);
              if (stream.origin !== origin || stream.username || stream.password || stream.pathname !== '/stream/' ||
                  !/^[a-f0-9]{64}$/.test(stream.searchParams.get('access') || '')) throw new Error();
            } catch {
              terminal = true; this.clearApprovalTimer(); this.setStatus(ClientAuthStatus.ERROR);
              this.emit('error', 'The host returned an invalid workspace address. Update both apps and request a new invitation.'); ws.close(); break;
            }
            this.clearApprovalTimer(); this.setStatus(ClientAuthStatus.APPROVED); this.emit('approved', payload); break;
          case MessageType.APPROVAL_DENIED:
            terminal = true; this.clearApprovalTimer(); this.setStatus(ClientAuthStatus.REJECTED);
            this.emit('rejected', payload?.reason || 'Access denied'); ws.close(); break;
          case MessageType.AUTH_RESULT:
            if (payload?.success) break;
            terminal = true; this.clearApprovalTimer(); this.setStatus(ClientAuthStatus.ERROR);
            this.emit('error', payload?.reason || 'Authentication failed'); ws.close(); break;
          case MessageType.ERROR:
            terminal = true; this.clearApprovalTimer(); this.setStatus(ClientAuthStatus.ERROR);
            this.emit('error', payload?.message || 'Connection failed'); ws.close(); break;
          case MessageType.DISCONNECT:
            terminal = true; this.clearApprovalTimer(); this.setStatus(ClientAuthStatus.DISCONNECTED);
            this.emit('disconnected', payload?.reason || 'Disconnected by host'); ws.close(); break;
          case MessageType.SESSION_STATUS: this.emit('session-status', payload); break;
          case MessageType.HEARTBEAT:
            // Only the host sends heartbeats; never echo a heartbeat.
            break;
        }
      });
      ws.on('close', (_code, reason) => {
        clearTimeout(timeout);
        if (!opened) reject(new Error(reason.toString() || 'Connection closed before authentication.'));
        if (this.ws !== ws) return;
        this.ws = null; this.clearApprovalTimer();
        if (!terminal) {
          this.setStatus(ClientAuthStatus.DISCONNECTED);
          this.emit('disconnected', reason.toString() || 'Connection closed. Request a new invitation from the host.');
        }
      });
      ws.on('error', error => {
        clearTimeout(timeout);
        if (this.ws !== ws || terminal) return;
        terminal = true; this.clearApprovalTimer(); this.setStatus(ClientAuthStatus.ERROR);
        if (!opened) reject(new Error(`Connection failed: ${error.message}`));
        else this.emit('error', error.message);
      });
    });
  }

  disconnect(): void {
    const ws = this.ws;
    this.ws = null; this.clearApprovalTimer();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(createMessage(MessageType.DISCONNECT, {}))); ws.close();
    } else ws?.terminate();
    this.setStatus(ClientAuthStatus.DISCONNECTED);
  }
  getStatus(): ClientAuthStatus { return this.status; }
  private setStatus(status: ClientAuthStatus): void { this.status = status; this.emit('status-change', status); }
  private clearApprovalTimer(): void {
    if (this.approvalTimer) clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
  }
}
