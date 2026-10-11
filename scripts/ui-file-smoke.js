// Real Docker + Electron integration. Native file dialogs are stubbed only in the QA process.
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'docs/qa');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-file-qa-'));
const fixture = Buffer.from(Array.from({ length: 128 * 1024 }, (_, i) => i % 251));
const filename = 'client café বাংলা.bin', source = path.join(directory, filename), saved = path.join(directory, 'saved.bin');
fs.writeFileSync(source, fixture);
const hash = createHash('sha256').update(fixture).digest('hex');
const apps = [], errors = [];
const docker = args => execFileSync('docker', args, { windowsHide: true, encoding: 'utf8' });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function clickCenter(client, page, point = null) {
  await page.locator('#remote-browser').evaluate(element => element.focus());
  const target = await page.locator('#remote-browser').evaluate((element, point) => element.executeJavaScript(`(() => {
    const canvas = [...document.querySelectorAll('canvas')].find(c => c.width >= 800 && c.height >= 400);
    const rect = canvas.getBoundingClientRect(); return { x: rect.left + rect.width * ${point ? point.x / 1280 : .5}, y: rect.top + rect.height * ${point ? point.y / 720 : .5}, count: ${point?.count || 1} };
  })()`), point);
  await client.evaluate(async ({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview');
    guest.debugger.attach('1.3');
    try {
      await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
      for (let index = 1; index <= target.count; index++) {
        for (const type of ['mousePressed', 'mouseReleased']) await guest.debugger.sendCommand('Input.dispatchMouseEvent',
          { type, x: target.x, y: target.y, button: 'left', clickCount: index });
        if (index < target.count) await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally { guest.debugger.detach(); }
  }, target);
}
async function title(container, expected) {
  for (let retry = 0; retry < 70; retry++) {
    if (docker(['exec', container, 'wmctrl', '-l']).includes(expected)) return;
    await wait(150);
  }
  throw new Error('Browser did not reach title: ' + expected + '\n' + docker(['exec', container, 'wmctrl', '-l']));
}

(async () => {
  const env = { ...process.env }; delete env.PB_TEST_MODE; delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.PB_QA_PACKAGED === '1';
  try {
    const host = await _electron.launch({ executablePath: packaged ? path.join(root, 'host-app/release/win-unpacked/ParallelBrowser Host.exe') : require(path.join(root, 'host-app/node_modules/electron')),
      args: packaged ? [] : [path.join(root, 'host-app/dist/main/index.js')], env }); apps.push(host);
    const hp = await host.firstWindow(); hp.setDefaultTimeout(180000); hp.on('pageerror', e => errors.push(e.message));
    await hp.locator('#btn-recheck:not([disabled])').waitFor(); await hp.locator('#btn-recheck').click();
    await hp.locator('#btn-continue-setup:not([disabled])').click();
    await hp.locator('#connection-mode').selectOption(process.env.PB_QA_INTERNET === '1' ? 'internet' : 'lan');
    await hp.locator('#btn-settings').click(); await hp.locator('#setting-width').fill('1280');
    await hp.locator('#setting-height').fill('720'); await hp.locator('#setting-duration').fill('0');
    await hp.locator('#btn-save-settings').click(); await hp.locator('#btn-start-browser').click();
    await hp.locator('#btn-generate-invite:not([disabled])').waitFor(); await hp.locator('#btn-generate-invite').click();
    await hp.locator('#invitation-section').waitFor({ state: 'visible' });
    console.log('Workspace started.');
    const code = await hp.locator('#invitation-code').textContent();
    if (process.env.PB_QA_INTERNET === '1') {
      const { parseInvitationCode } = require('../shared/dist');
      const invite = parseInvitationCode(code); assert.equal(invite.secure, true);
      const https = require('node:https');
      for (const route of ['/', '/api/files/downloads']) {
        const status = await new Promise((resolve, reject) => https.get(`https://${invite.hostAddress}${route}`,
          response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject));
        assert.equal(status, 403, 'Public content must require approval');
      }
    }
    const client = await _electron.launch({ executablePath: packaged ? path.join(root, 'client-app/release/win-unpacked/ParallelBrowser Client.exe') : require(path.join(root, 'client-app/node_modules/electron')),
      args: packaged ? [] : [path.join(root, 'client-app/dist/main/index.js')], env }); apps.push(client);
    const cp = await client.firstWindow(); cp.setDefaultTimeout(60000); cp.on('pageerror', e => errors.push(e.message));
    await client.evaluate(({ dialog }, { source, saved }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: saved });
    }, { source, saved });
    await cp.locator('#input-code').fill(code); await cp.locator('#btn-connect').click();
    await hp.locator('#approval-section').waitFor({ state: 'visible' }); await hp.locator('#btn-approve').click();
    console.log('Client approved.');
    await cp.waitForFunction(() => document.getElementById('toolbar-status').textContent === 'Workspace connected');
    console.log('Display connected.');
    const container = (await hp.evaluate(() => window.hostAPI.getSessionInfo())).containerName;
    await cp.locator('#btn-upload-files').click();
    await cp.waitForFunction(() => document.getElementById('file-message').textContent.startsWith('Uploaded 1 file(s)'));
    assert.equal(docker(['exec', container, 'python3', '-c', `import hashlib; print(hashlib.sha256(open(${JSON.stringify('/home/kasm-user/Uploads/' + filename)}, 'rb').read()).hexdigest())`]).trim(), hash);
    // A second upload preserves the first and reports the renamed duplicate.
    await cp.locator('#btn-upload-files:not([disabled])').click();
    await cp.waitForFunction(() => document.getElementById('file-message').textContent.includes('(1).bin'));
    const browserSource = path.join(directory, 'client-file.bin'); fs.writeFileSync(browserSource, fixture);
    await client.evaluate(({ dialog }, browserSource) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [browserSource] });
    }, browserSource);
    await cp.locator('#btn-upload-files:not([disabled])').click();
    await cp.waitForFunction(() => document.getElementById('file-message').textContent.startsWith('Uploaded 1 file(s): client-file.bin'));
    // Remove already verified Unicode fixtures so the remote chooser has one unambiguous target.
    docker(['exec', container, 'python3', '-c', "import os; [os.unlink('/home/kasm-user/Uploads/' + n) for n in os.listdir('/home/kasm-user/Uploads') if n != 'client-file.bin']"]);
    await cp.locator('#btn-dismiss-file-notice').click();
    console.log('PASS: toolbar upload, binary/Unicode integrity, and duplicate preservation.');

    const connection = await client.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview');
      const cookies = await guest.session.cookies.get({ name: 'pb_stream' });
      return new URL(guest.getURL()).origin + '/stream/?access=' + cookies[0].value;
    });
    const { FileTransfer } = require('../client-app/dist/services/file-transfer');
    const bridge = new FileTransfer(); bridge.approve(connection);
    try {
      docker(['exec', container, 'python3', '-c', "import os; os.symlink('/etc/hostname', '/home/kasm-user/Downloads/blocked'); os.mkdir('/home/kasm-user/Downloads/folder'); open('/home/kasm-user/Downloads/incomplete.crdownload', 'wb').close()"]);
      assert.deepEqual(await bridge.list(), []);
      await assert.rejects(bridge.download('../Uploads/client-file.bin', saved));
      await assert.rejects(bridge.download('blocked', saved));
      assert.equal(fs.existsSync(saved), false);
      const empty = path.join(directory, 'empty.bin'); fs.writeFileSync(empty, '');
      assert.equal((await bridge.upload(empty)).size, 0);
      if (process.env.PB_QA_LARGE === '1') {
        const large = path.join(directory, 'large.bin'), size = 105 * 1024 * 1024;
        const descriptor = fs.openSync(large, 'w'); fs.ftruncateSync(descriptor, size); fs.closeSync(descriptor);
        assert.equal((await bridge.upload(large)).size, size);
        const remote = docker(['exec', container, 'python3', '-c', "import os; print(os.path.getsize('/home/kasm-user/Uploads/large.bin'))"]).trim();
        assert.equal(Number(remote), size);
        const expected = createHash('sha256'), zeros = Buffer.alloc(1024 * 1024);
        for (let index = 0; index < 105; index++) expected.update(zeros);
        const digest = docker(['exec', container, 'python3', '-c', "import hashlib; h=hashlib.sha256(); f=open('/home/kasm-user/Uploads/large.bin','rb'); [h.update(b) for b in iter(lambda: f.read(1048576), b'')]; print(h.hexdigest())"]).trim();
        assert.equal(digest, expected.digest('hex'));
        console.log('PASS: upload above 100 MiB through public HTTPS with bounded chunks.');
      }
      console.log('PASS: real agent rejects traversal/symlinks, omits folders/partial downloads, and accepts empty files.');
    } finally { bridge.clear(); }

    const site = String.raw`
import hashlib, json, base64
from http.server import HTTPServer, BaseHTTPRequestHandler
from email.parser import BytesParser
from email.policy import default
DATA = bytes(i % 251 for i in range(128 * 1024))
STYLE = 'position:fixed;inset:0;display:grid;place-items:center;font:32px sans-serif;color:white;background:#17324c'
class Site(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def page(self, title, body):
        data = ('<title>' + title + '</title>' + body).encode()
        self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == '/download':
            self.send_response(200); self.send_header('Content-Type', 'application/octet-stream'); self.send_header('Content-Disposition', 'attachment; filename="remote-browser-result.bin"'); self.send_header('Content-Length', str(len(DATA))); self.end_headers(); self.wfile.write(DATA)
        else: self.page('Choose client file', '<form method="post" enctype="multipart/form-data"><label for="file" style="' + STYLE + '">Choose uploaded client file</label><input hidden id="file" name="file" type="file" onchange="this.form.submit()"></form>')
    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        message = BytesParser(policy=default).parsebytes(('Content-Type: ' + self.headers['Content-Type'] + '\r\n\r\n').encode() + data)
        parts = list(message.iter_parts()); content = parts[0].get_payload(decode=True)
        digest = hashlib.sha256(content).hexdigest()
        open('/tmp/pb-file-test.json', 'w').write(json.dumps({'sha256': digest, 'size': len(content)}))
        self.page('Upload verified' if digest == '${hash}' else 'Upload mismatch', '<a href="/download" style="' + STYLE + '">Download browser result</a>')
HTTPServer(('127.0.0.1', 8088), Site).serve_forever()
`;
    docker(['exec', '-d', container, 'python3', '-c', site]); await wait(300);
    await title(container, 'Google Chrome');
    docker(['exec', '-d', container, 'google-chrome', '--no-sandbox', 'http://127.0.0.1:8088/']);
    await title(container, 'Choose client file');
    await clickCenter(client, cp);
    await wait(600);
    await title(container, 'Open File');
    await clickCenter(client, cp, { x: 350, y: 154, count: 2 }); await wait(500);
    await clickCenter(client, cp, { x: 350, y: 106, count: 2 }); await title(container, 'Upload verified');
    assert.equal(JSON.parse(docker(['exec', container, 'cat', '/tmp/pb-file-test.json'])).sha256, hash);
    console.log('PASS: client file selected in the remote website and posted with matching SHA-256.');
    await clickCenter(client, cp);
    await wait(700); await cp.locator('#btn-downloads').click();
    await cp.locator('#downloads-list button').waitFor();
    assert.match(await cp.locator('#downloads-list').textContent(), /remote-browser-result.bin/);
    await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
    await cp.screenshot({ path: path.join(out, 'client-downloads.png') });
    await cp.locator('#downloads-list button').click();
    await cp.waitForFunction(() => document.getElementById('file-message').textContent.startsWith('Saved remote-browser-result.bin'));
    assert.deepEqual(fs.readFileSync(saved), fixture);
    assert.deepEqual(errors, []);
    await cp.screenshot({ path: path.join(out, 'client-file-saved.png') });
    await hp.locator('#btn-stop-browser').click(); await cp.locator('#screen-disconnected.active').waitFor();
    const afterDisconnect = await cp.evaluate(() => window.clientAPI.listDownloads());
    assert.equal(afterDisconnect.success, false);
    console.log('PASS: actual browser download saved to the client PC with matching bytes; minimum-size UI and disconnect revocation verified.');
  } catch (error) {
    console.error(error);
    for (const [index, app] of apps.entries()) {
      const page = app.windows()[0];
      if (page) { await page.screenshot({ path: path.join(out, `file-failure-${index}.png`), timeout: 3000 }).catch(() => {}); console.error((await page.locator('body').innerText({ timeout: 3000 }).catch(() => 'UI unavailable')).replace(/[A-Za-z0-9_-]{64,}/g, '[REDACTED]')); }
    }
    throw error;
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
