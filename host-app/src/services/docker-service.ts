import Docker from 'dockerode';
import { SessionConfig, KASM_VNC_PORT, CONTAINER_NAME_PREFIX, ResourceUsage } from '@parallelbrowser/shared';
import { randomBytes } from 'crypto';
import { FILE_AGENT, FILES_PORT, FileEndpoint } from './workspace-files';
import { ProfileSnapshot } from './chrome-profiles';
import { profileArchive } from './profile-archive';
import { fork, ChildProcess } from 'child_process';
import * as path from 'path';

export class DockerService {
  private docker: Docker;
  private currentContainerId: string | null = null;
  private fileEndpoint: FileEndpoint | null = null;
  private cleanupWorker: ChildProcess | null = null;

  constructor() {
    // On Windows, use named pipe
    this.docker = new Docker({ socketPath: '//./pipe/docker_engine' });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const version = await this.docker.version();
      return version.Version;
    } catch {
      return null;
    }
  }

  async pullImage(imageName: string, onProgress?: (progress: string) => void): Promise<void> {
    const images = await this.docker.listImages();
    const exists = images.some(img =>
      img.RepoTags && img.RepoTags.includes(imageName)
    );

    if (exists) {
      onProgress?.('Image already available');
      return;
    }

    onProgress?.(`Pulling ${imageName}...`);
    const stream = await this.docker.pull(imageName);

    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else {
          onProgress?.('Image pulled successfully');
          resolve();
        }
      }, (event: any) => {
        if (event.status) {
          onProgress?.(event.status + (event.progress ? `: ${event.progress}` : ''));
        }
      });
    });
  }

  async startBrowser(config: SessionConfig, vncPassword: string, profile?: ProfileSnapshot): Promise<{ containerId: string; vncPort: number }> {
    // Clean up any existing container
    await this.stopBrowser();

    const containerName = `${CONTAINER_NAME_PREFIX}-${Date.now()}`;

    // Find available port
    const hostVncPort = await this.findAvailablePort(6901);
    const hostFilesPort = await this.findAvailablePort(7901);
    const fileToken = randomBytes(32).toString('hex');

    const container = await this.docker.createContainer({
      Image: config.containerImage,
      name: containerName,
      Env: [
        `VNC_PW=${vncPassword}`,
        'VNC_RESOLUTION=' + `${config.browserWidth}x${config.browserHeight}`,
        'VNC_COL_DEPTH=24',
      ],
      ExposedPorts: {
        [`${KASM_VNC_PORT}/tcp`]: {},
        [`${FILES_PORT}/tcp`]: {},
      },
      HostConfig: {
        PortBindings: {
          [`${KASM_VNC_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(hostVncPort) }],
          [`${FILES_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(hostFilesPort) }],
        },
        // Security: restrict container capabilities
        CapDrop: ['ALL'],
        CapAdd: ['SYS_CHROOT', 'SETUID', 'SETGID'],
        // Memory limit: 2GB
        Memory: 2 * 1024 * 1024 * 1024,
        // CPU limit: 2 cores
        NanoCpus: 2_000_000_000,
        // No privileged mode
        Privileged: false,
        // Read-only root filesystem causes issues with Chrome, so we allow write
        // but block host mounts
        SecurityOpt: ['no-new-privileges:true'],
        // SHM size for Chrome (needs at least 512MB)
        ShmSize: 512 * 1024 * 1024,
        // Network: use default bridge (internet access, but isolated from host services)
        NetworkMode: 'bridge',
      },
    });

    this.currentContainerId = container.id;
    if (profile) {
      this.cleanupWorker = fork(path.join(__dirname, 'cleanup-worker.js'), [container.id], {
        detached: true, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      } as import('child_process').ForkOptions & { windowsHide: boolean });
      const worker = this.cleanupWorker;
      await new Promise<void>((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error('Could not start the temporary-profile cleanup helper.')), 10000);
        worker.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', () => { clearTimeout(timer); reject(new Error(`Temporary-profile cleanup helper stopped: ${stderr}`)); });
        worker.once('message', message => { if (message === 'ready') { clearTimeout(timer); resolve(); } });
      });
      this.cleanupWorker.unref();
      this.cleanupWorker.channel?.unref();
      await container.putArchive(profileArchive(profile), { path: '/home/kasm-default-profile' });
    }
    await container.start();

    const agent = await container.exec({ Cmd: ['python3', '-u', '-c', FILE_AGENT],
      User: '1000:1000', Env: [`PB_FILES_TOKEN=${fileToken}`], AttachStdout: false, AttachStderr: false });
    await agent.start({ Detach: true });
    await this.waitForFiles(hostFilesPort, fileToken);
    this.fileEndpoint = { port: hostFilesPort, token: fileToken };

    // Wait for VNC to be ready
    await this.waitForVNC(hostVncPort, vncPassword);

    return { containerId: container.id, vncPort: hostVncPort };
  }

  async stopBrowser(): Promise<void> {
    this.fileEndpoint = null;
    if (this.currentContainerId) {
      const container = this.docker.getContainer(this.currentContainerId);
      try { await container.stop({ t: 5 }); } catch { /* Force-removal below also handles a stopped container. */ }
      try {
        await container.remove({ force: true, v: true });
      } catch (error: any) {
        if (error.statusCode !== 404) {
          if (this.cleanupWorker?.connected) this.cleanupWorker.send('cleanup', () => {});
          throw new Error(`Could not remove the workspace container: ${error.message}`);
        }
      }
      this.currentContainerId = null;
      if (this.cleanupWorker?.connected) this.cleanupWorker.send('removed', () => {});
      this.cleanupWorker = null;
    }

    // Never remove another host instance's containers.
  }

  async getResourceUsage(): Promise<ResourceUsage> {
    if (!this.currentContainerId) {
      return { cpuPercent: 0, memoryMB: 0, memoryLimitMB: 0 };
    }

    try {
      const container = this.docker.getContainer(this.currentContainerId);
      const stats = await container.stats({ stream: false }) as any;

      // Calculate CPU percentage
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const numCpus = stats.cpu_stats.online_cpus || 1;
      const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

      // Memory
      const memoryMB = (stats.memory_stats.usage || 0) / (1024 * 1024);
      const memoryLimitMB = (stats.memory_stats.limit || 0) / (1024 * 1024);

      return {
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memoryMB: Math.round(memoryMB),
        memoryLimitMB: Math.round(memoryLimitMB),
      };
    } catch {
      return { cpuPercent: 0, memoryMB: 0, memoryLimitMB: 0 };
    }
  }

  async isContainerRunning(): Promise<boolean> {
    if (!this.currentContainerId) return false;
    try {
      const container = this.docker.getContainer(this.currentContainerId);
      const info = await container.inspect();
      return info.State.Running;
    } catch {
      return false;
    }
  }

  getContainerId(): string | null {
    return this.currentContainerId;
  }

  getFileEndpoint(): FileEndpoint | null {
    return this.fileEndpoint ? { ...this.fileEndpoint } : null;
  }

  private async waitForFiles(port: number, token: string): Promise<void> {
    const http = await import('http');
    for (let retry = 0; retry < 60; retry++) {
      const ready = await new Promise<boolean>(resolve => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/health',
          headers: { Authorization: `Bearer ${token}` }, timeout: 1000 }, response => {
          response.resume(); resolve(response.statusCode === 200);
        });
        request.on('error', () => resolve(false));
        request.on('timeout', () => { request.destroy(); resolve(false); });
      });
      if (ready) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Workspace file transfer service did not start. Restart the workspace.');
  }

  private async findAvailablePort(startPort: number): Promise<number> {
    const net = await import('net');
    for (let port = startPort; port < startPort + 100; port++) {
      const available = await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
          server.close(() => resolve(true));
        });
        server.listen(port, '127.0.0.1');
      });
      if (available) return port;
    }
    throw new Error('No available port found');
  }

  private async waitForVNC(port: number, password: string, timeoutMs: number = 90000): Promise<void> {
    const https = await import('https');
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const connected = await new Promise<boolean>((resolve) => {
        const request = https.get({ hostname: '127.0.0.1', port, path: '/',
          auth: `kasm_user:${password}`, rejectUnauthorized: false, timeout: 1500,
        }, response => {
          response.resume();
          resolve(response.statusCode === 200);
        });
        request.on('error', () => resolve(false));
        request.on('timeout', () => { request.destroy(); resolve(false); });
      });

      if (connected) return;
      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error(`VNC service did not start within ${timeoutMs / 1000} seconds`);
  }
}
