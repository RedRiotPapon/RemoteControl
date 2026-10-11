import { exec } from 'child_process';
import { promisify } from 'util';
import { DependencyStatus } from '@parallelbrowser/shared';

const run = promisify(exec);
const execAsync = (command: string) => run(command, { timeout: 10000, windowsHide: true });

export class DependencyChecker {
  async checkAll(): Promise<DependencyStatus> {
    const [docker, wsl] = await Promise.all([
      this.checkDocker(),
      this.checkWSL(),
    ]);

    return { docker, wsl };
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
