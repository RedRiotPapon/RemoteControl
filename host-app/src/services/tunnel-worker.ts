import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Own exactly one tunnel child. IPC loss closes it even if Electron crashes.
const [binary, portText] = process.argv.slice(2);
const port = Number(portText);
if (!path.isAbsolute(binary || '') || !Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-tunnel-'));
const emptyConfig = path.join(directory, 'config.yml');
fs.writeFileSync(emptyConfig, '# Private ParallelBrowser tunnel configuration\n');
let child: ChildProcess | undefined, ending = false, buffer = '';
let announced = false;
function send(message: object) { if (process.connected) process.send?.(message, () => {}); }
function stop() {
  if (ending) return;
  ending = true;
  child?.kill();
  if (!child || child.exitCode !== null) finish();
}
function finish() { fs.rmSync(directory, { recursive: true, force: true }); process.exit(0); }
process.on('disconnect', stop);
process.on('message', message => { if (message === 'stop') stop(); });
child = spawn(binary, ['tunnel', '--config', emptyConfig, '--no-autoupdate', '--protocol', 'http2',
  '--url', `http://127.0.0.1:${port}`, '--loglevel', 'info'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NO_AUTOUPDATE: 'true', TUNNEL_ORIGIN_CERT: path.join(directory, 'unused.pem') },
});
const read = (data: Buffer) => {
  buffer = (buffer + data.toString()).slice(-8192);
  const match = buffer.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/);
  if (match && !ending && !announced) { announced = true; send({ origin: match[0] }); }
};
child.stdout?.on('data', read); child.stderr?.on('data', read);
child.on('error', () => { send({ error: 'The bundled internet helper could not start. Reinstall the Host app.' }); finish(); });
child.on('exit', () => { if (!ending) send({ error: 'Internet sharing stopped. Restart the browser session to reconnect.' }); finish(); });
