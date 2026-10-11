import { exec } from 'child_process';
import { promisify } from 'util';
import { DependencyStatus } from '@parallelbrowser/shared';

const run = promisify(exec);
const execAsync = (command: string) => run(command, { timeout: 10000, windowsHide: true });

export class DependencyChecker {
  async checkAll(): Promise<DependencyStatus> {
    const [docker, tailscale, wsl] = await Promise.all([
      this.checkDocker(),
      this.checkTailscale(),
      this.checkWSL(),
    ]);

    return { docker, tailscale, wsl };
  }

  private async checkDocker(): Promise<DependencyStatus['docker']> {
    try {
      const { stdout: versionOut } = await execAsync('docker --version');
      const version = versionOut.trim();

      try {
        await execAsync('docker info');
        return { installed: true, running: true, version };
      } catch {
        return { installed: true, running: false, version };
      }
    } catch {
      return { installed: false, running: false, version: null };
    }
  }

  private async checkTailscale(): Promise<DependencyStatus['tailscale']> {
    try {
      const { stdout: versionOut } = await execAsync('tailscale version');
      const version = versionOut.trim().split('\n')[0];

      try {
        const { stdout: statusOut } = await execAsync('tailscale status --json');
        const status = JSON.parse(statusOut);
        const selfIP = status.Self?.TailscaleIPs?.[0] || null;
        const connected = status.BackendState === 'Running' && Boolean(selfIP);
        return { installed: true, connected, ip: connected ? selfIP : null, version };
      } catch {
        // Try ip command as fallback
        try {
          const { stdout: ipOut } = await execAsync('tailscale ip -4');
          return { installed: true, connected: true, ip: ipOut.trim(), version };
        } catch {
          return { installed: true, connected: false, ip: null, version };
        }
      }
    } catch {
      return { installed: false, connected: false, ip: null, version: null };
    }
  }

  private async checkWSL(): Promise<DependencyStatus['wsl']> {
    try {
      const { stdout } = await execAsync('wsl --status');
      const version = stdout.includes('2') ? '2' : '1';
      return { installed: true, version };
    } catch {
      return { installed: false, version: null };
    }
  }
}
