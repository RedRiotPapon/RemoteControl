// Synthetic profile only: never imports this PC's real bookmarks or credentials.
// Native approval dialogs are stubbed in the QA process, with cancel and accept tested.
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'docs/qa');
const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-profile-qa-'));
const fixture = path.join(localAppData, 'Google/Chrome/User Data');
fs.mkdirSync(path.join(fixture, 'Default'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'QA temporary profile' } } } }));
fs.writeFileSync(path.join(fixture, 'Default/Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [{ type: 'url', name: 'QA imported bookmark', url: 'https://example.com/' }] } } }));
fs.writeFileSync(path.join(fixture, 'Default/Preferences'), JSON.stringify({ bookmark_bar: { show_on_all_tabs: true }, homepage: 'https://example.com/', password_manager: { secret: 'DO-NOT-COPY' } }));
fs.writeFileSync(path.join(fixture, 'Default/Cookies'), 'DO-NOT-COPY');
const original = fs.readFileSync(path.join(fixture, 'Default/Bookmarks'));
const apps = [], errors = [];
const docker = args => execFileSync('docker', args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, retries = 100) {
  for (let i = 0; i < retries; i++) { if (await check()) return; await wait(200); }
  throw new Error(message);
}
async function absent(container) {
  await until(() => { try { docker(['inspect', container]); return false; } catch { return true; } }, 'Temporary container was not removed');
}
const site = `from http.server import BaseHTTPRequestHandler,HTTPServer
class Site(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  signed = 'qa_signed=host-approved' in self.headers.get('Cookie','')
  open('/tmp/qa-profile-visited','w').write('signed' if signed else 'unsigned')
  title = 'QA signed in by host' if signed else 'QA private host sign in'
  self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
  self.wfile.write(('<title>'+title+'</title><form action="/signin" method="POST"><button style="position:fixed;inset:0;width:100%;height:100%;font-size:32px">'+title+'</button></form>').encode())
 def do_POST(self):
  self.send_response(302); self.send_header('Set-Cookie','qa_signed=host-approved; HttpOnly; SameSite=Lax; Path=/'); self.send_header('Location','/'); self.end_headers()
HTTPServer(('127.0.0.1',8088),Site).serve_forever()`;

(async () => {
  const env = { ...process.env }; delete env.PB_TEST_MODE; delete env.ELECTRON_RUN_AS_NODE;
  env.LOCALAPPDATA = localAppData;
  const packaged = process.env.PB_QA_PACKAGED === '1';
  let container;
  try {
    const host = await _electron.launch({ executablePath: packaged ? path.join(root, 'host-app/release/win-unpacked/ParallelBrowser Host.exe') : require(path.join(root, 'host-app/node_modules/electron')),
      args: packaged ? [] : [path.join(root, 'host-app/dist/main/index.js')], env }); apps.push(host);
    const hp = await host.firstWindow(); hp.setDefaultTimeout(90000); hp.on('pageerror', e => errors.push(e.message));
    await hp.locator('#btn-recheck:not([disabled])').waitFor();
    await host.evaluate(({ dialog }) => {
      global.qaProfileApprove = false; global.qaProfileDialogs = [];
      dialog.showMessageBox = async (_window, options) => {
        global.qaProfileDialogs.push(options);
        return { response: global.qaProfileApprove ? 1 : 0, checkboxChecked: false };
      };
    });
    await hp.locator('#btn-recheck').click(); await hp.locator('#btn-continue-setup:not([disabled])').click();
    await hp.locator('#btn-refresh-profiles').click();
    await hp.locator('#chrome-profile').selectOption('Default');
    await hp.locator('#btn-settings').click(); await hp.locator('#setting-width').fill('1280'); await hp.locator('#setting-height').fill('720'); await hp.locator('#btn-save-settings').click();
    await hp.locator('#btn-start-browser').click();
    await hp.waitForFunction(() => document.getElementById('host-notice').textContent.includes('cancelled'));
    assert.equal((await hp.evaluate(() => window.hostAPI.getSessionInfo())).status, 'idle');
    await host.evaluate(() => { global.qaProfileApprove = true; });
    await hp.locator('#btn-start-browser:not([disabled])').click();
    await hp.waitForFunction(() => document.getElementById('session-badge').textContent === 'Ready', { timeout: 90000 });
    const info = await hp.evaluate(() => window.hostAPI.getSessionInfo()); container = info.containerName;
    assert.equal(info.profileName, 'QA temporary profile'); assert.equal(info.hostSetupRequired, true);
    assert.equal(await hp.locator('#btn-generate-invite').isDisabled(), true);
    assert.equal((await hp.evaluate(() => window.hostAPI.generateInvitation())).success, false);
    const copied = docker(['exec', container, 'cat', '/home/kasm-user/.config/google-chrome/Default/Bookmarks']);
    assert.match(copied, /QA imported bookmark/);
    assert.doesNotMatch(docker(['exec', container, 'cat', '/home/kasm-user/.config/google-chrome/Default/Preferences']), /DO-NOT-COPY/);
    const opened = host.waitForEvent('window'); await hp.locator('#btn-open-host-setup').click(); const setup = await opened;
    setup.on('pageerror', e => errors.push(e.message));
    await setup.waitForFunction(() => [...document.querySelectorAll('canvas')].some(c => c.width >= 800));
    docker(['exec', '-d', container, 'python3', '-c', site]); await wait(300);
    await until(() => docker(['exec', container, 'wmctrl', '-l']).includes('Google Chrome'), 'Chrome failed to start');
    docker(['exec', '-d', container, 'google-chrome', '--no-sandbox', 'http://127.0.0.1:8088/']);
    await until(() => docker(['exec', container, 'wmctrl', '-l']).includes('QA private host sign in'), 'Private login page not shown');
    await wait(600);
    // Click through the host-only remote viewer; no browser password/cookie injection.
    const point = await setup.evaluate(() => {
      const c = [...document.querySelectorAll('canvas')].find(c => c.width >= 800); const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await setup.mouse.click(point.x, point.y);
    await until(() => docker(['exec', container, 'wmctrl', '-l']).includes('QA signed in by host'), 'Host-only sign-in click failed');
    await setup.screenshot({ path: path.join(out, 'host-private-setup.png') });
    await hp.locator('#btn-finish-host-setup').click();
    await hp.locator('#btn-generate-invite:not([disabled])').waitFor();
    assert.ok(setup.isClosed());
    const dialogs = await host.evaluate(() => global.qaProfileDialogs);
    assert.ok(dialogs.some(d => d.detail.includes('Passwords, cookies, history')));
    await hp.locator('#btn-generate-invite').click(); await hp.locator('#invitation-section').waitFor({ state: 'visible' });
    const code = await hp.locator('#invitation-code').textContent();
    const client = await _electron.launch({ executablePath: packaged ? path.join(root, 'client-app/release/win-unpacked/ParallelBrowser Client.exe') : require(path.join(root, 'client-app/node_modules/electron')),
      args: packaged ? [] : [path.join(root, 'client-app/dist/main/index.js')], env }); apps.push(client);
    const cp = await client.firstWindow(); cp.setDefaultTimeout(90000); cp.on('pageerror', e => errors.push(e.message));
    await cp.locator('#input-name').fill('Profile QA client'); await cp.locator('#input-code').fill(code); await cp.locator('#btn-connect').click();
    await hp.locator('#approval-section').waitFor({ state: 'visible' }); await hp.locator('#btn-approve').click();
    await cp.waitForFunction(() => document.getElementById('toolbar-status').textContent === 'Workspace connected');
    const viewerPartition = await cp.locator('#remote-browser').getAttribute('partition');
    assert.match(viewerPartition, /^pb-remote-[a-f0-9]{32}$/);
    assert.equal(docker(['exec', container, 'cat', '/tmp/qa-profile-visited']).trim(), 'signed');
    await host.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 550));
    await hp.screenshot({ path: path.join(out, 'host-profile-small.png') });
    await cp.locator('#btn-disconnect-client').click();
    await hp.waitForFunction(() => document.getElementById('session-badge').textContent === 'Idle');
    await cp.locator('#screen-disconnected.active').waitFor();
    assert.equal(await cp.locator('#remote-browser').getAttribute('partition'), 'pb-remote-inactive');
    await until(async () => (await client.evaluate(async ({ session }, partition) =>
      (await session.fromPartition(partition).cookies.get({})).length, viewerPartition)) === 0, 'Old viewer cookies remained after disconnect');
    await absent(container); container = null;
    assert.deepEqual(fs.readFileSync(path.join(fixture, 'Default/Bookmarks')), original);
    assert.equal(fs.readFileSync(path.join(fixture, 'Default/Cookies'), 'utf8'), 'DO-NOT-COPY');
    assert.deepEqual(errors, []);
    console.log('PASS: approval cancel/accept, portable profile, private host sign-in, invitation gate, approved client and disconnect cleanup.');
    // A killed host must also remove its exact workspace via the detached helper.
    await hp.locator('#btn-start-browser').click();
    await hp.waitForFunction(() => document.getElementById('session-badge').textContent === 'Ready');
    container = (await hp.evaluate(() => window.hostAPI.getSessionInfo())).containerName;
    const hostPid = await host.evaluate(() => process.pid);
    // Playwright's Windows process can be a cmd.exe wrapper; kill the actual
    // Electron main PID returned by our own launched app, without killing helper children.
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${hostPid} -Force`], { windowsHide: true });
    await absent(container); container = null;
    console.log('PASS: abrupt host termination removed the temporary profile container.');
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    if (container) { try { docker(['rm', '-f', '-v', container]); } catch {} }
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
