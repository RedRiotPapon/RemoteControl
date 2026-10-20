import { WebSocketServer as WSServer, WebSocket as WS } from 'ws';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';
import * as stream from 'stream';
import { randomBytes, timingSafeEqual } from 'crypto';
import { MessageType, createMessage, parseMessage, AuthRequestPayload,
  ApprovalGrantedPayload, WEBSOCKET_PROXY_PORT, SessionStatus } from '@parallelbrowser/shared';
import { SessionManager } from './session-manager';
import { MAX_UPLOAD_BYTES } from './workspace-files';

interface PendingClient { ws: WS; clientName: string; token: string; }

export class WebSocketServer extends EventEmitter {
  private httpServer: http.Server | null = null;
  private wss: WSServer | null = null;
  private connectedClient: WS | null = null;
  private pendingClient: PendingClient | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private port = WEBSOCKET_PROXY_PORT;
  private hostIp = '127.0.0.1';
  private streamToken: string | null = null;
  private proxySockets = new Set<stream.Duplex>();
  private displaySockets = new Set<WS>();
  private displayWss = new WSServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
  private proxyRequests = new Set<http.ClientRequest>();
  private fileInputs = new Set<http.IncomingMessage>();
  private hostSetupServer: http.Server | null = null;
  private hostSetupToken: string | null = null;
  private lastClientPong = 0;
  private resume: { token: string; clientName: string; deadline: number } | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private readonly reconnectWindowMs = 60000;
  private publicOrigin: string | null = null;
  private readonly instance = randomBytes(16).toString('hex');

  constructor(private sessionManager: SessionManager) {
    super();
    sessionManager.on('session-update', info => {
      if ([SessionStatus.STOPPING, SessionStatus.ERROR, SessionStatus.IDLE].includes(info.status)) {
        this.closeHostSetup(); this.disconnectClient();
      }
    });
  }

  setHostIp(ip: string): void { this.hostIp = ip; }
  getPort(): number { return this.port; }
  getConnectivityProof(): string { return this.instance; }
  setPublicOrigin(origin: string | null): void {
    if (origin !== null) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Invalid internet endpoint.');
    }
    this.publicOrigin = origin;
  }

  async openHostSetup(): Promise<string> {
    this.closeHostSetup();
    this.sessionManager.beginHostSetup();
    this.hostSetupToken = randomBytes(32).toString('hex');
    const server = http.createServer((req, res) => this.handleHttpRequest(req, res, true));
    this.hostSetupServer = server;
    server.on('upgrade', (req, socket, head) => this.handleProxyWsUpgrade(req, socket, head, true));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
      });
    } catch (error) { this.closeHostSetup(); throw error; }
    const address = server.address() as import('net').AddressInfo;
    return `http://127.0.0.1:${address.port}/stream/?access=${this.hostSetupToken}`;
  }

  closeHostSetup(): void {
    if (!this.hostSetupServer) return;
    this.hostSetupToken = null;
    this.hostSetupServer.close(); this.hostSetupServer.closeAllConnections(); this.hostSetupServer = null;
    // Private setup is only allowed without a client. Revoke its upgraded sockets.
    this.clearStream();
  }

  async start(localOnly = false): Promise<void> {
    if (this.httpServer) return;
    const server = http.createServer((req, res) => this.handleHttpRequest(req, res));
    // Large transfers may take more than Node's default five-minute body deadline.
    // Keep the header deadline and enforce inactivity below instead.
    server.requestTimeout = 0;
    this.httpServer = server;
    // One upgrade owner: KasmVNC connections must not enter control authentication.
    this.wss = new WSServer({ noServer: true, maxPayload: 64 * 1024 });
    this.wss.on('connection', ws => this.handleConnection(ws));
    server.on('upgrade', (req, socket, head) => {
      let pathname: string;
      try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
      catch { socket.destroy(); return; }
      if (pathname === '/control' || (pathname === '/' && !this.isStreamAuthorized(req))) {
        if ((this.wss?.clients.size || 0) >= 16) { socket.destroy(); return; }
        this.wss?.handleUpgrade(req, socket, head, ws => this.wss?.emit('connection', ws));
      } else this.handleProxyWsUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(localOnly ? 0 : this.port, localOnly ? '127.0.0.1' : '0.0.0.0', resolve);
    }).catch(error => {
      this.wss?.close(); this.wss = null; this.httpServer = null;
      server.close(); throw error;
    });
    this.port = (server.address() as import('net').AddressInfo).port;
    server.on('error', error => this.emit('server-error', error.message));
    this.heartbeatInterval = setInterval(() => {
      if (this.connectedClient?.readyState === WS.OPEN) {
        if (Date.now() - this.lastClientPong > 45000) { this.suspendClient(this.connectedClient); return; }
        this.connectedClient.ping();
        this.connectedClient.send(JSON.stringify(createMessage(MessageType.HEARTBEAT, { time: Date.now() })));
      }
    }, 15000);
  }

  stop(): void {
    this.publicOrigin = null;
    this.closeHostSetup();
    this.disconnectClient();
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    for (const ws of this.wss?.clients || []) ws.terminate();
    this.wss?.close(); this.wss = null;
    this.httpServer?.close(); this.httpServer?.closeAllConnections(); this.httpServer = null;
  }

  disconnectClient(): void {
    const active = this.connectedClient, pending = this.pendingClient;
    const recovering = !!this.resume;
    this.resume = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.connectedClient = null; this.pendingClient = null;
    this.clearStream();
    for (const ws of [active, pending?.ws]) {
      if (!ws) continue;
      if (ws.readyState === WS.OPEN) {
        ws.send(JSON.stringify(createMessage(MessageType.DISCONNECT, { reason: 'Disconnected by host' })));
        ws.close();
      } else ws.terminate();
    }
    if (active || pending || recovering) {
      this.sessionManager.setClientConnected(false);
      this.emit('client-disconnected');
    }
  }

  handleApproval(approved: boolean): void {
    if (!this.pendingClient) return;
    const { ws, clientName, token } = this.pendingClient;
    if (ws.readyState !== WS.OPEN) { this.disconnectClient(); return; }
    if (!approved || !this.sessionManager.verifyToken(token) || this.sessionManager.getSessionInfo().hostSetupRequired) {
      ws.send(JSON.stringify(createMessage(MessageType.APPROVAL_DENIED, {
        reason: approved ? 'Invitation expired or was replaced. Request a new invitation.' : 'Access denied by host',
      })));
      ws.close(); this.pendingClient = null;
      this.sessionManager.setClientConnected(false); this.emit('client-disconnected');
      return;
    }
    this.streamToken = randomBytes(32).toString('hex');
    this.resume = { token: randomBytes(32).toString('hex'), clientName, deadline: 0 };
    const payload: ApprovalGrantedPayload = {
      sessionId: this.sessionManager.getSessionInfo().sessionId,
      resumeToken: this.resume.token, reconnectWindowMs: this.reconnectWindowMs,
      streamUrl: `${this.publicOrigin || `http://${this.hostIp}:${this.port}`}/stream/?access=${this.streamToken}`,
      hostAddress: this.hostIp, port: this.port,
      vncConfig: { width: this.sessionManager.getConfig().browserWidth,
        height: this.sessionManager.getConfig().browserHeight },
    };
    this.connectedClient = ws; this.pendingClient = null;
    this.lastClientPong = Date.now();
    this.sessionManager.revokeToken(); this.sessionManager.setClientConnected(true);
    ws.send(JSON.stringify(createMessage(MessageType.APPROVAL_GRANTED, payload)));
    this.emit('client-connected', { clientName });
  }

  private handleConnection(ws: WS): void {
    ws.on('error', () => {});
    ws.on('pong', () => { if (this.connectedClient === ws) this.lastClientPong = Date.now(); });
    const timeout = setTimeout(() => ws.close(1008, 'Authentication timeout'), 10000);
    ws.once('close', () => {
      clearTimeout(timeout);
      if (this.pendingClient?.ws === ws || this.connectedClient === ws) {
        if (this.pendingClient?.ws === ws) this.pendingClient = null;
        if (this.connectedClient === ws) { this.suspendClient(ws); return; }
        this.sessionManager.setClientConnected(false); this.emit('client-disconnected');
      }
    });
    ws.once('message', data => {
      clearTimeout(timeout);
      const msg = parseMessage(data.toString());
      if (msg?.type === MessageType.RESUME_REQUEST || msg?.type === MessageType.DISCONNECT) {
        const credential = (msg.payload as any)?.resumeToken;
        const valid = this.resume && typeof credential === 'string' && /^[a-f0-9]{64}$/.test(credential) &&
          timingSafeEqual(Buffer.from(credential), Buffer.from(this.resume.token));
        if (valid && msg.type === MessageType.DISCONNECT) { this.disconnectClient(); ws.close(); return; }
        if (!valid || this.connectedClient || !this.resume?.deadline || Date.now() >= this.resume.deadline) {
          ws.send(JSON.stringify(createMessage(MessageType.AUTH_RESULT, { success: false,
            retryable: !!valid && !!this.connectedClient,
            reason: 'The previous session cannot be resumed. Ask the host for a new invitation.' })));
          ws.close(); return;
        }
        if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null; this.resume.deadline = 0;
        this.connectedClient = ws; this.lastClientPong = Date.now();
        this.listenForDisconnect(ws);
        this.sessionManager.setClientConnected(true);
        ws.send(JSON.stringify(createMessage(MessageType.SESSION_RESUMED, {
          sessionId: this.sessionManager.getSessionInfo().sessionId,
        })));
        this.emit('client-connected', { clientName: this.resume.clientName, resumed: true });
        return;
      }
      const payload = msg?.payload as AuthRequestPayload | undefined;
      // Check after authentication as well, closing the simultaneous-connection race.
      if (this.connectedClient || this.pendingClient || this.resume) {
        ws.send(JSON.stringify(createMessage(MessageType.ERROR, {
          code: 'SESSION_BUSY', message: 'Another client is already connected or awaiting approval.',
        })));
        ws.close(); return;
      }
      if (msg?.type !== MessageType.AUTH_REQUEST || !payload || !this.sessionManager.verifyToken(payload.token)) {
        ws.send(JSON.stringify(createMessage(MessageType.AUTH_RESULT, {
          success: false, reason: 'Invalid, revoked, or expired invitation token',
        })));
        ws.close(); return;
      }
      this.pendingClient = { ws, token: payload.token,
        clientName: typeof payload.clientName === 'string' ? payload.clientName.slice(0, 100) : 'Remote Client' };
      this.listenForDisconnect(ws);
      ws.send(JSON.stringify(createMessage(MessageType.APPROVAL_PENDING, {})));
      this.sessionManager.setClientPending();
      this.emit('client-connecting', { clientName: this.pendingClient.clientName });
    });
  }

  private listenForDisconnect(ws: WS): void {
    ws.on('message', data => {
      if (parseMessage(data.toString())?.type === MessageType.DISCONNECT &&
          (this.connectedClient === ws || this.pendingClient?.ws === ws)) this.disconnectClient();
    });
  }

  private suspendClient(ws: WS): void {
    if (this.connectedClient !== ws) return;
    this.connectedClient = null;
    // Cut off display/files immediately, retaining credentials only for the same approved session.
    this.closeProxyConnections();
    ws.terminate();
    if (!this.resume) { this.disconnectClient(); this.sessionManager.setClientConnected(false); return; }
    this.resume.deadline = Date.now() + this.reconnectWindowMs;
    this.recoveryTimer = setTimeout(() => this.disconnectClient(), this.reconnectWindowMs);
    this.sessionManager.setClientReconnecting();
  }

  private tokenMatches(value: string | null | undefined): boolean {
    if (!this.streamToken || !value || !/^[a-f0-9]{64}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(value), Buffer.from(this.streamToken));
  }

  private isHostAuthorized(req: http.IncomingMessage): boolean {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('pb_host_setup='))?.slice(14);
    return !!this.hostSetupToken && typeof cookie === 'string' && /^[a-f0-9]{64}$/.test(cookie) &&
      timingSafeEqual(Buffer.from(cookie), Buffer.from(this.hostSetupToken));
  }

  private isStreamAuthorized(req: http.IncomingMessage): boolean {
    if (this.connectedClient?.readyState !== WS.OPEN) return false;
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('pb_stream='))?.slice(10);
    return this.tokenMatches(cookie);
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, privateView = false): void {
    req.setTimeout(60000, () => req.destroy());
    let url: URL;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { res.writeHead(400); res.end('Invalid request.'); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (!privateView && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', instance: this.instance })); return;
    }
    if (!privateView && url.pathname.startsWith('/api/files/')) {
      void this.handleFileRequest(req, res, url).catch(() => res.destroy()); return;
    }
    const setupAccess = url.searchParams.get('access');
    const hostBootstrap = privateView && !!this.hostSetupToken && !!setupAccess && /^[a-f0-9]{64}$/.test(setupAccess) && timingSafeEqual(Buffer.from(setupAccess), Buffer.from(this.hostSetupToken));
    if (url.pathname === '/stream/' && (hostBootstrap || (!privateView && this.connectedClient?.readyState === WS.OPEN && this.tokenMatches(setupAccess)))) {
      const cookie = (privateView ? `pb_host_setup=${this.hostSetupToken}` : `pb_stream=${this.streamToken}`) + (!privateView && this.publicOrigin ? '; Secure' : '');
      // Kasm's numbered presets override URL frame rates. Custom presets keep our explicit limits.
      const presets: Record<string, string[]> = {
        data: ['18', '3', '6', '5', '4', '960', '540'],
        balanced: ['24', '4', '8', '7', '7', '1280', '720'],
        sharp: ['30', '7', '9', '8', '8', '1920', '1080'],
      };
      const [fps, min, max, jpeg, webp, width, height] = presets[url.searchParams.get('display') || 'balanced'] || presets.balanced;
      const display = new URLSearchParams({ autoconnect: 'true', reconnect: 'true', reconnect_delay: '2000',
        video_quality: '10', framerate: fps, enable_hidpi: 'false', resize: 'remote',
        dynamic_quality_min: min, dynamic_quality_max: max, jpeg_video_quality: jpeg, webp_video_quality: webp,
        max_video_resolution_x: width, max_video_resolution_y: height });
      res.writeHead(302, { Location: '/?' + display, 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Strict; Path=/` });
      res.end(); return;
    }
    if (!(privateView ? this.isHostAuthorized(req) : this.isStreamAuthorized(req))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Access denied. Connect with an invitation and obtain host approval.'); return;
    }
    const port = this.sessionManager.getVNCPort();
    if (!port) { res.writeHead(503); res.end('Workspace is not running.'); return; }
    // Serve Kasm at the origin root so absolute asset and websocket paths work unchanged.
    const upstream = process.env.PB_TEST_MODE === '1' ? http : https;
    const proxy = upstream.request({ hostname: '127.0.0.1', port,
      path: req.url, method: req.method, rejectUnauthorized: false,
      headers: this.backendHeaders(req, port),
    }, response => {
      if (res.destroyed) { response.destroy(); return; }
      res.writeHead(response.statusCode || 502, { ...response.headers, 'cache-control': 'no-store' });
      response.pipe(res);
    });
    this.proxyRequests.add(proxy);
    proxy.once('close', () => this.proxyRequests.delete(proxy));
    res.once('close', () => proxy.destroy());
    proxy.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Cannot reach the workspace. Ask the host to restart it.');
    });
    req.pipe(proxy);
  }

  private async handleFileRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const fail = (status: number, error: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error }));
    };
    // Native client only: no ambient cookie authentication or cross-site upload.
    if (this.connectedClient?.readyState !== WS.OPEN ||
        !this.tokenMatches(req.headers.authorization?.replace(/^Bearer /, '')) || req.headers.origin) {
      fail(403, 'File access requires an approved client connection.'); return;
    }
    const route = url.pathname.slice('/api/files'.length);
    if (!((req.method === 'GET' && ['/downloads', '/download'].includes(route)) ||
      (req.method === 'PUT' && ['/upload', '/upload-start', '/upload-part', '/upload-finish', '/upload-cancel'].includes(route)))) { fail(405, 'Unknown file operation.'); return; }
    let body: Buffer | undefined;
    const credential = this.streamToken;
    if (req.method === 'PUT') {
      const limit = route === '/upload' ? MAX_UPLOAD_BYTES : route === '/upload-part' ? 4 * 1024 * 1024 : 0;
      const chunked = req.headers['transfer-encoding'] === 'chunked';
      const size = Number(req.headers['content-length'] ?? (route !== '/upload' ? 0 : NaN));
      if (!Number.isSafeInteger(size) || size < 0 || size > limit ||
          (req.headers['transfer-encoding'] && (!chunked || route === '/upload'))) {
        fail(413, 'Uploads must be at most 1 GiB.'); return;
      }
      if (route !== '/upload') {
        // Cloudflare may change Content-Length to chunked encoding. Buffer only
        // one bounded part, then supply an exact length to the private agent.
        if (this.fileInputs.size >= 4) { fail(429, 'Too many active file transfers. Try again shortly.'); return; }
        this.fileInputs.add(req);
        const blocks: Buffer[] = []; let received = 0;
        try {
          for await (const block of req) {
            received += block.length;
            if (received > limit) { fail(413, 'Upload part is too large.'); return; }
            blocks.push(block);
          }
        } finally { this.fileInputs.delete(req); }
        body = Buffer.concat(blocks);
        // Approval may have been revoked while the request body was arriving.
        if (this.streamToken !== credential || this.connectedClient?.readyState !== WS.OPEN) {
          fail(403, 'File access requires an approved client connection.'); return;
        }
      }
    }
    const endpoint = this.sessionManager.getFileEndpoint();
    if (!endpoint) { fail(503, 'File transfer is unavailable. Ask the host to restart the workspace.'); return; }
    const proxy = http.request({ hostname: '127.0.0.1', port: endpoint.port,
      method: req.method, path: route + url.search,
      headers: { Authorization: `Bearer ${endpoint.token}`,
        ...(req.method === 'PUT' ? { 'Content-Length': body ? body.length : req.headers['content-length'] || '0' } : {}) },
    }, response => {
      if (res.destroyed) { response.destroy(); return; }
      res.writeHead(response.statusCode || 502, {
        'Content-Type': response.headers['content-type'] || 'application/octet-stream',
        ...(response.headers['content-length'] ? { 'Content-Length': response.headers['content-length'] } : {}),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    this.proxyRequests.add(proxy);
    proxy.once('close', () => this.proxyRequests.delete(proxy));
    res.once('close', () => proxy.destroy());
    req.once('aborted', () => proxy.destroy());
    proxy.setTimeout(60000, () => proxy.destroy(new Error('File transfer timed out.')));
    proxy.on('error', () => {
      if (!res.headersSent) fail(502, 'File transfer interrupted. Reconnect or ask the host to restart the workspace.');
      else res.destroy();
    });
    if (body) proxy.end(body); else req.pipe(proxy);
  }

  private backendHeaders(req: http.IncomingMessage, port: number): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    const canonical: Record<string, string> = { host: 'Host', connection: 'Connection', upgrade: 'Upgrade',
      origin: 'Origin', 'sec-websocket-key': 'Sec-WebSocket-Key', 'sec-websocket-version': 'Sec-WebSocket-Version',
      'sec-websocket-protocol': 'Sec-WebSocket-Protocol', 'sec-websocket-extensions': 'Sec-WebSocket-Extensions' };
    for (const [name, value] of Object.entries(req.headers)) {
      if (name !== 'cookie' && name !== 'authorization') headers[canonical[name] || name] = value;
    }
    headers.Host = `127.0.0.1:${port}`;
    // KasmVNC 1.15 requires canonical casing for authentication and upgrade headers.
    headers.Authorization = `Basic ${Buffer.from(`kasm_user:${this.sessionManager.getVNCPassword()}`).toString('base64')}`;
    return headers;
  }

  private handleProxyWsUpgrade(req: http.IncomingMessage, socket: stream.Duplex, head: Buffer, privateView = false): void {
    const port = this.sessionManager.getVNCPort(), origin = req.headers.origin;
    const expectedOrigin = !privateView && this.publicOrigin ? this.publicOrigin : `http://${req.headers.host}`;
    if (!port || !(privateView ? this.isHostAuthorized(req) : this.isStreamAuthorized(req)) || (origin && origin !== expectedOrigin)) {
      socket.destroy(); return;
    }
    // Upgraded sockets must not inherit HTTP inactivity deadlines or delayed small input packets.
    const tune = (connection: stream.Duplex) => {
      const tcp = connection as import('net').Socket;
      tcp.setTimeout?.(0); tcp.setNoDelay?.(true); tcp.setKeepAlive?.(true, 15000);
    };
    tune(socket);
    if (this.displaySockets.size >= 32) { socket.destroy(); return; }
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(p => p.trim()).filter(Boolean) || [];
    if (protocols.length > 4 || new Set(protocols).size !== protocols.length || protocols.some(p => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p))) { socket.destroy(); return; }
    const target = new URL(req.url || '/', 'http://localhost');
    const backend = new WS(`${process.env.PB_TEST_MODE === '1' ? 'ws' : 'wss'}://127.0.0.1:${port}${target.pathname}${target.search}`, protocols, {
      headers: { Authorization: `Basic ${Buffer.from(`kasm_user:${this.sessionManager.getVNCPassword()}`).toString('base64')}` },
      origin: expectedOrigin,
      rejectUnauthorized: false, handshakeTimeout: 10000, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024,
    });
    this.displaySockets.add(backend);
    this.proxySockets.add(socket);
    socket.once('close', () => { this.proxySockets.delete(socket); backend.terminate(); });
    socket.on('error', () => socket.destroy());
    backend.once('close', () => { this.displaySockets.delete(backend); socket.destroy(); });
    backend.on('error', error => {
      if (socket.destroyed || !(privateView ? this.isHostAuthorized(req) : this.isStreamAuthorized(req))) { socket.destroy(); return; }
      this.emit('server-error', `Workspace display connection failed: ${error.message}`);
      socket.destroy();
    });
    backend.once('open', () => {
      if (socket.destroyed || !(privateView ? this.isHostAuthorized(req) : this.isStreamAuthorized(req))) { backend.terminate(); socket.destroy(); return; }
      this.displayWss.handleUpgrade(req, socket, head, client => {
        this.displaySockets.add(client);
        client.on('error', () => backend.terminate());
        let clientPong = Date.now(), backendPong = Date.now();
        client.on('pong', () => { clientPong = Date.now(); });
        backend.on('pong', () => { backendPong = Date.now(); });
        // Separate protocol endpoints allow safe ping frames even while a large frame is streaming.
        const heartbeat = setInterval(() => {
          if (Date.now() - Math.min(clientPong, backendPong) > 45000) { client.terminate(); backend.terminate(); return; }
          if (client.readyState === WS.OPEN) client.ping();
          if (backend.readyState === WS.OPEN) backend.ping();
        }, 15000);
        const relay = (from: WS, to: WS) => {
          let pending = 0;
          from.on('message', (data, binary) => {
            if (to.readyState !== WS.OPEN) return;
            pending++; from.pause();
            to.send(data, { binary }, error => {
              if (error) { from.terminate(); to.terminate(); return; }
              if (--pending === 0 && from.readyState === WS.OPEN) from.resume();
            });
          });
        };
        relay(client, backend); relay(backend, client);
        client.once('close', () => { clearInterval(heartbeat); this.displaySockets.delete(client); backend.terminate(); });
        backend.once('close', () => { clearInterval(heartbeat); client.terminate(); });
      });
    });
  }

  private clearStream(): void {
    this.streamToken = null;
    this.closeProxyConnections();
  }

  private closeProxyConnections(): void {
    for (const ws of this.displaySockets) ws.terminate();
    this.displaySockets.clear();
    for (const input of this.fileInputs) input.destroy();
    this.fileInputs.clear();
    for (const socket of this.proxySockets) socket.destroy();
    this.proxySockets.clear();
    for (const request of this.proxyRequests) request.destroy();
    this.proxyRequests.clear();
  }
}
