import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export interface WorkspaceFile { name: string; size: number; modified: number; }
export interface TransferProgress { direction: 'upload' | 'download'; name: string; transferred: number; total: number; }

export class FileTransfer {
  private origin: string | null = null;
  private token: string | null = null;
  private requests = new Set<http.ClientRequest>();
  private generation = 0;
  private cancellation = 0;
  constructor(private progress: (value: TransferProgress) => void = () => {}) {}

  approve(streamUrl: string): void {
    this.clear();
    const url = new URL(streamUrl), token = url.searchParams.get('access');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid file transfer connection.');
    this.origin = url.origin; this.token = token;
  }
  clear(): void { this.cancel(); this.origin = null; this.token = null; this.generation++; }
  cancel(): void {
    this.cancellation++;
    for (const request of this.requests) request.destroy(new Error('File transfer cancelled.'));
    this.requests.clear();
  }
  getGeneration(): number { return this.generation; }
  assertConnected(generation = this.generation): void {
    if (!this.origin || !this.token || generation !== this.generation) throw new Error('Connect to the workspace before transferring files.');
  }
  private request(method: string, route: string, size?: number): { request: http.ClientRequest; response: Promise<http.IncomingMessage> } {
    this.assertConnected();
    let request!: http.ClientRequest;
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      const transport = this.origin!.startsWith('https:') ? https : http;
      request = transport.request(new URL('/api/files/' + route, this.origin!), {
        method, headers: { Authorization: `Bearer ${this.token}`, ...(size === undefined ? {} : { 'Content-Length': size }) },
      }, resolve);
      request.once('error', reject);
      request.setTimeout(60000, () => request.destroy(new Error('File transfer timed out. Check the connection and try again.')));
    });
    this.requests.add(request);
    request.once('close', () => this.requests.delete(request));
    return { request, response };
  }
  private async json(response: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 1024 * 1024) { response.destroy(); throw new Error('The workspace returned too many files.'); }
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('The workspace returned an invalid file response. Restart the host workspace.'); }
    if (!response.statusCode || response.statusCode >= 400) throw new Error(value.error || 'File transfer failed.');
    return value;
  }
  private meter(direction: 'upload' | 'download', name: string, total: number, offset = 0): Transform {
    let transferred = offset, last = 0;
    return new Transform({ transform: (chunk, _encoding, callback) => {
      transferred += chunk.length;
      if (Date.now() - last >= 150 || transferred === total) {
        this.progress({ direction, name, transferred, total }); last = Date.now();
      }
      callback(null, chunk);
    } });
  }
  async list(): Promise<WorkspaceFile[]> {
    const { request, response } = this.request('GET', 'downloads'); request.end();
    const data = await this.json(await response);
    if (!Array.isArray(data.files)) throw new Error('The workspace returned an invalid download list.');
    return data.files.filter((file: any) => typeof file.name === 'string' && Number.isSafeInteger(file.size) && file.size >= 0);
  }
  async upload(filePath: string): Promise<{ name: string; size: number }> {
    this.assertConnected();
    const generation = this.generation, cancellation = this.cancellation;
    const assertActive = () => {
      this.assertConnected(generation);
      if (cancellation !== this.cancellation) throw new Error('File transfer cancelled.');
    };
    const file = await fs.promises.open(filePath, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Choose a regular file.');
      if (info.size > MAX_UPLOAD_BYTES) throw new Error('Choose a file no larger than 1 GiB.');
      const name = path.basename(filePath);
      assertActive();
      if (this.origin!.startsWith('https:')) {
        // Small sequential requests avoid the tunnel provider's request-body limit.
        const call = async (route: string) => {
          assertActive();
          const { request, response } = this.request('PUT', route, 0);
          request.end(); return this.json(await response);
        };
        const { id } = await call('upload-start?name=' + encodeURIComponent(name) + '&size=' + info.size);
        if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid upload identifier.');
        try {
          for (let offset = 0; offset < info.size; offset += 4 * 1024 * 1024) {
            assertActive();
            const size = Math.min(4 * 1024 * 1024, info.size - offset);
            const { request, response } = this.request('PUT', `upload-part?id=${id}&offset=${offset}`, size);
            async function* readPart() {
              let position = offset;
              while (position < offset + size) {
                const block = Buffer.allocUnsafe(Math.min(65536, offset + size - position));
                const { bytesRead } = await file.read(block, 0, block.length, position);
                if (!bytesRead) throw new Error('The selected file changed during upload. Try again.');
                position += bytesRead; yield block.subarray(0, bytesRead);
              }
            }
            await Promise.all([
              pipeline(Readable.from(readPart(), { objectMode: false }),
                this.meter('upload', name, info.size, offset), request),
              response.then(value => this.json(value)),
            ]);
          }
          return await call('upload-finish?id=' + id);
        } catch (error) {
          // The isolated workspace also removes abandoned chunks on expiry or stop.
          if (generation === this.generation && this.token) {
            const { request, response } = this.request('PUT', 'upload-cancel?id=' + id, 0);
            request.setTimeout(2000, () => request.destroy()); request.end();
            response.then(value => value.resume()).catch(() => {});
          }
          throw error;
        }
      }
      const { request, response } = this.request('PUT', 'upload?name=' + encodeURIComponent(name), info.size);
      const sending = pipeline(file.createReadStream({ autoClose: false }), this.meter('upload', name, info.size), request);
      const receiving = response.then(value => this.json(value));
      const [, result] = await Promise.all([sending, receiving]);
      return result;
    } finally { await file.close(); }
  }
  async download(name: string, destination: string): Promise<void> {
    this.assertConnected();
    const temporary = path.join(path.dirname(destination), '.pb-download-' + randomBytes(12).toString('hex'));
    try {
      const { request, response } = this.request('GET', 'download?name=' + encodeURIComponent(name)); request.end();
      const incoming = await response;
      if (incoming.statusCode !== 200) { await this.json(incoming); throw new Error('Download unavailable.'); }
      const total = Number(incoming.headers['content-length']);
      if (!Number.isSafeInteger(total) || total < 0) { incoming.destroy(); throw new Error('The workspace returned an invalid file size.'); }
      await pipeline(incoming, this.meter('download', name, total), fs.createWriteStream(temporary, { flags: 'wx' }));
      await fs.promises.rename(temporary, destination);
    } finally { await fs.promises.rm(temporary, { force: true }); }
  }
}

export function localDownloadName(name: string): string {
  const cleaned = path.win32.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
  return !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned) ? 'download-' + (cleaned || 'file') : cleaned;
}
