import { EventEmitter } from 'events';
import * as http from 'http';
import { DockerService } from './docker-service';
import { FileEndpoint } from './workspace-files';
import { ProfileSnapshot } from './chrome-profiles';
import {
  SessionConfig,
  SessionInfo,
  SessionStatus,
  ResourceUsage,
  DEFAULT_SESSION_CONFIG,
  generateSessionToken,
  generateSessionId,
  hashToken,
  generateSecret,
  generateInvitationCode,
  getBestHostIP,
  WEBSOCKET_PROXY_PORT,
  validateSessionConfig,
  verifyToken as verifyHashedToken,
} from '@parallelbrowser/shared';

export class SessionManager extends EventEmitter {
  private dockerService: DockerService;
  private config: SessionConfig = { ...DEFAULT_SESSION_CONFIG };
  private sessionId: string | null = null;
  private sessionStatus: SessionStatus = SessionStatus.IDLE;
  private startedAt: Date | null = null;
  private clientConnectedAt: Date | null = null;
  private vncPort: number | null = null;
  private vncPassword: string | null = null;
  private sessionSecret: string = generateSecret();
  private currentToken: string | null = null;
  private currentTokenHash: string | null = null;
  private tokenExpiresAt = 0;
  private currentHostAddress: string = '127.0.0.1';
  private resourceMonitorInterval: NodeJS.Timeout | null = null;
  private sessionTimerInterval: NodeJS.Timeout | null = null;
  private mockServer: http.Server | null = null;
  private profileName: string | undefined;
  private hostSetupRequired = false;
  private stopping: Promise<void> | null = null;

  constructor(dockerService: DockerService) {
    super();
    this.dockerService = dockerService;
  }

  setHostAddress(addr: string): void {
    this.currentHostAddress = addr;
  }

  getCurrentToken(): string | null {
    return this.currentToken;
  }

  async startSession(
    config?: Partial<SessionConfig>,
    options?: { allowFallback?: boolean; profile?: ProfileSnapshot }
  ): Promise<SessionInfo> {
    if (this.sessionStatus !== SessionStatus.IDLE && this.sessionStatus !== SessionStatus.ERROR) {
      throw new Error('A browser session is already active. Please stop it first.');
    }

    if (config) {
      this.config = validateSessionConfig({ ...this.config, ...config });
    }

    this.sessionStatus = SessionStatus.STARTING;
    this.profileName = options?.profile?.profile.name;
    this.hostSetupRequired = !!options?.profile;
    this.emit('session-update', this.getSessionInfo());

    try {
      this.vncPassword = generateSessionToken().substring(0, 16);
      this.sessionId = generateSessionId();

      const dockerReady = await this.dockerService.isAvailable();

      if (process.env.PB_TEST_MODE === '1') {
        this.vncPort = await this.startMockBrowserService();
      } else if (dockerReady) {
        // Primary path: Production container via Docker Desktop
        await this.dockerService.pullImage(this.config.containerImage, (progress) => {
          this.emit('session-update', { ...this.getSessionInfo(), pullProgress: progress });
        });

        const result = await this.dockerService.startBrowser(this.config, this.vncPassword, options?.profile);
        this.vncPort = result.vncPort;
      } else if (options?.allowFallback || process.env.PB_TEST_MODE === '1') {
        // Fallback / Test path: local mock browser service
        console.log('Docker not running - starting standalone mock browser service for testing');
        this.vncPort = await this.startMockBrowserService();
      } else {
        throw new Error(
          'Docker Desktop is not running. Please start Docker Desktop with the WSL2 backend enabled and click Re-check.'
        );
      }

      this.startedAt = new Date();
      this.sessionStatus = SessionStatus.RUNNING;

      this.startResourceMonitor();
      this.startSessionTimer();

      const info = this.getSessionInfo();
      this.emit('session-update', info);
      return info;
    } catch (error: any) {
      try { await this.dockerService.stopBrowser(); } catch (cleanupError) { console.error('Startup cleanup failed:', cleanupError); }
      this.vncPort = null;
      this.vncPassword = null;
      this.sessionStatus = SessionStatus.ERROR;
      this.emit('session-update', this.getSessionInfo());
      throw error;
    }
  }

  async stopSession(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.performStop();
    try { await this.stopping; } finally { this.stopping = null; }
  }

  private async performStop(): Promise<void> {
    this.sessionStatus = SessionStatus.STOPPING;
    this.emit('session-update', this.getSessionInfo());

    this.stopResourceMonitor();
    this.stopSessionTimer();

    if (this.mockServer) {
      this.mockServer.close();
      this.mockServer = null;
    }

    try {
      await this.dockerService.stopBrowser();
    } catch (error) {
      this.revokeToken();
      this.sessionStatus = SessionStatus.ERROR;
      this.emit('session-update', this.getSessionInfo());
      throw error;
    }

    this.sessionId = null;
    this.startedAt = null;
    this.clientConnectedAt = null;
    this.vncPort = null;
    this.vncPassword = null;
    this.profileName = undefined;
    this.hostSetupRequired = false;
    this.revokeToken();
    this.sessionStatus = SessionStatus.IDLE;
    this.emit('session-update', this.getSessionInfo());
  }

  async generateInvitation(hostAddress?: string, port = WEBSOCKET_PROXY_PORT, secure = false): Promise<string> {
    if (this.hostSetupRequired) throw new Error('Finish private host setup before inviting a client.');
    if (this.sessionStatus !== SessionStatus.RUNNING && this.sessionStatus !== SessionStatus.CLIENT_PENDING) {
      throw new Error('Browser session must be running before generating an invitation code.');
    }

    // Revoke any previous token and issue a fresh one
    this.currentToken = generateSessionToken();
    this.currentTokenHash = hashToken(this.currentToken, this.sessionSecret);
    this.tokenExpiresAt = Date.now() + 60 * 60 * 1000;

    const targetIp =
      hostAddress && hostAddress.trim() !== ''
        ? hostAddress.trim()
        : this.currentHostAddress !== '127.0.0.1'
        ? this.currentHostAddress
        : getBestHostIP();

    return generateInvitationCode(targetIp, port, this.currentToken, 60, secure);
  }

  verifyToken(token: string): boolean {
    if (this.hostSetupRequired) return false;
    if (!this.currentTokenHash || typeof token !== 'string' || !token || Date.now() >= this.tokenExpiresAt) return false;
    try {
      return verifyHashedToken(token, this.currentTokenHash, this.sessionSecret);
    } catch {
      return false;
    }
  }

  revokeToken(): void {
    this.currentToken = null;
    this.currentTokenHash = null;
    this.tokenExpiresAt = 0;
  }

  setClientConnected(connected: boolean): void {
    const endProfileSession = !connected && [SessionStatus.CLIENT_CONNECTED, SessionStatus.CLIENT_RECONNECTING].includes(this.sessionStatus) && !!this.profileName;
    if (connected) {
      this.clientConnectedAt = this.clientConnectedAt || new Date();
      this.sessionStatus = SessionStatus.CLIENT_CONNECTED;
    } else {
      this.clientConnectedAt = null;
      if (
        this.sessionStatus === SessionStatus.CLIENT_CONNECTED ||
        this.sessionStatus === SessionStatus.CLIENT_RECONNECTING ||
        this.sessionStatus === SessionStatus.CLIENT_PENDING
      ) {
        this.sessionStatus = SessionStatus.RUNNING;
      }
    }
    this.emit('session-update', this.getSessionInfo());
    if (endProfileSession) void this.stopSession().catch(error => this.emit('cleanup-error', error.message));
  }

  beginHostSetup(): void {
    if (this.sessionStatus !== SessionStatus.RUNNING) throw new Error('Private setup is available before inviting a client.');
    this.revokeToken();
    this.hostSetupRequired = true;
    this.emit('session-update', this.getSessionInfo());
  }

  setClientReconnecting(): void {
    this.sessionStatus = SessionStatus.CLIENT_RECONNECTING;
    this.emit('session-update', this.getSessionInfo());
  }

  finishHostSetup(): void {
    if (this.sessionStatus !== SessionStatus.RUNNING) throw new Error('The workspace is not ready.');
    this.hostSetupRequired = false;
    this.emit('session-update', this.getSessionInfo());
  }

  setClientPending(): void {
    this.sessionStatus = SessionStatus.CLIENT_PENDING;
    this.emit('session-update', this.getSessionInfo());
  }

  getVNCPort(): number | null {
    return this.vncPort;
  }

  getVNCPassword(): string | null {
    return this.vncPassword;
  }

  getFileEndpoint(): FileEndpoint | null {
    return this.dockerService.getFileEndpoint?.() || null;
  }

  getConfig(): SessionConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<SessionConfig>): void {
    if (this.sessionStatus !== SessionStatus.IDLE && this.sessionStatus !== SessionStatus.ERROR) {
      throw new Error('Stop the session before changing its settings.');
    }
    this.config = validateSessionConfig({ ...this.config, ...config });
  }

  getSessionInfo(): SessionInfo {
    return {
      sessionId: this.sessionId || '',
      status: this.sessionStatus,
      startedAt: this.startedAt?.toISOString() || null,
      clientConnectedAt: this.clientConnectedAt?.toISOString() || null,
      browserResolution: {
        width: this.config.browserWidth,
        height: this.config.browserHeight,
      },
      containerName: this.dockerService.getContainerId()?.substring(0, 12) || (this.mockServer ? 'mock-container' : ''),
      resourceUsage: { cpuPercent: 0, memoryMB: 0, memoryLimitMB: 0 },
      profileName: this.profileName,
      hostSetupRequired: this.hostSetupRequired,
    };
  }

  private startResourceMonitor(): void {
    this.resourceMonitorInterval = setInterval(async () => {
      try {
        if (this.mockServer) {
          const mem = process.memoryUsage();
          this.emit('resource-update', {
            cpuPercent: 1.5,
            memoryMB: Math.round(mem.rss / (1024 * 1024)),
            memoryLimitMB: this.config.memoryLimitMB,
          });
        } else {
          const usage = await this.dockerService.getResourceUsage();
          this.emit('resource-update', usage);
        }
      } catch {}
    }, 3000);
  }

  private stopResourceMonitor(): void {
    if (this.resourceMonitorInterval) {
      clearInterval(this.resourceMonitorInterval);
      this.resourceMonitorInterval = null;
    }
  }

  private startSessionTimer(): void {
    this.sessionTimerInterval = setInterval(async () => {
      if (this.config.maxSessionDurationMinutes > 0 && this.startedAt) {
        const elapsed = (Date.now() - this.startedAt.getTime()) / 60000;
        if (elapsed >= this.config.maxSessionDurationMinutes) {
          console.log('Session duration limit reached, terminating session...');
          await this.stopSession();
        }
      }
    }, 60000);
  }

  private stopSessionTimer(): void {
    if (this.sessionTimerInterval) {
      clearInterval(this.sessionTimerInterval);
      this.sessionTimerInterval = null;
    }
  }

  private async startMockBrowserService(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.mockServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>ParallelBrowser Isolated Chromium</title>
          <style>body { margin:0; background:#111; color:#fff; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; }</style>
          </head>
          <body>
            <div>
              <h2>ParallelBrowser Isolated Chromium Session</h2>
              <p>Remote browser environment active and connected.</p>
            </div>
          </body>
          </html>
        `);
      });

      this.mockServer.once('error', reject);
      this.mockServer.listen(0, '127.0.0.1', () => {
        const addr = this.mockServer!.address() as any;
        resolve(addr.port);
      });
    });
  }
}
