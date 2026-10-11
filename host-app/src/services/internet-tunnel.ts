import { EventEmitter } from 'events';
import { fork, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createHash } from 'crypto';

export const TUNNEL_SHA256 = '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c';
export class InternetTunnel extends EventEmitter {
  private worker: ChildProcess | null = null;
  private origin: string | null = null;
  constructor(private binary: string) { super(); }
  getOrigin(): string | null { return this.origin; }
  async start(port: number, instance: string): Promise<string> {
    await this.stop();
    const hash = createHash('sha256');
    try { for await (const block of fs.createReadStream(this.binary)) hash.update(block); }
    catch { throw new Error('The internet helper is missing. Reinstall the latest Host app.'); }
    if (hash.digest('hex') !== TUNNEL_SHA256) throw new Error('The internet helper failed verification. Reinstall the Host app.');
    const worker = fork(path.join(__dirname, 'tunnel-worker.js'), [this.binary, String(port)], {
      detached: true, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    } as import('child_process').ForkOptions & { windowsHide: boolean });
    this.worker = worker;
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => done(new Error('Internet sharing could not connect. Check your internet connection and try again, or select Local network.')), 90000);
        let checking = false, settled = false;
        const done = (error?: Error, value?: string) => {
          if (settled) return; settled = true; clearTimeout(timer);
          error ? reject(error) : resolve(value!);
        };
        worker.on('error', () => done(new Error('The internet helper could not start.')));
        worker.on('exit', () => done(new Error('Internet sharing stopped before it became ready.')));
        worker.on('message', async (message: any) => {
          if (message?.error) { done(new Error(message.error)); return; }
          if (checking || !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(message?.origin || '')) return;
          checking = true;
          while (this.worker === worker && !settled) {
            if (await this.check(message.origin, instance)) { done(undefined, message.origin); return; }
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        });
      });
      if (this.worker !== worker) throw new Error('Internet sharing was cancelled.');
      this.origin = origin;
      worker.on('exit', () => {
        if (this.worker !== worker) return;
        this.worker = null; this.origin = null; this.emit('unavailable');
      });
      worker.unref(); worker.channel?.unref();
      return origin;
    } catch (error) { await this.stop(); throw error; }
  }
  private check(origin: string, instance: string): Promise<boolean> {
    return new Promise(resolve => {
      const request = https.get(origin + '/health', { timeout: 4000 }, response => {
        let body = '';
        response.on('data', data => { body += data.toString(); if (body.length > 4096) response.destroy(); });
        response.on('error', () => resolve(false));
        response.on('end', () => { try { resolve(response.statusCode === 200 && JSON.parse(body).instance === instance); } catch { resolve(false); } });
      });
      request.on('error', () => resolve(false)); request.on('timeout', () => request.destroy());
    });
  }
  async stop(): Promise<void> {
    const worker = this.worker; this.worker = null; this.origin = null;
    if (!worker) return;
    if (worker.connected) worker.send('stop', () => {});
    await new Promise<void>(resolve => {
      if (worker.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { if (worker.connected) worker.disconnect(); resolve(); }, 4000);
      worker.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
