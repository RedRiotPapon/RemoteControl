// Interrupt only servers created by this test. Never touch a user's running workspace.
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const real = process.env.PB_QA_REAL === '1', internet = process.env.PB_QA_INTERNET === '1';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
if (real) delete env.PB_TEST_MODE; else env.PB_TEST_MODE = '1';
const apps = [], errors = [];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true });
(async () => {
  let hp;
  try {
    const host = await _electron.launch({ executablePath: require('../host-app/node_modules/electron'), args: [path.join(root, 'scripts/qa-recovery-host.cjs')], env }); apps.push(host);
    host.process().stderr.on('data', data => { const message = data.toString(); if (message.includes('QA display proxy:')) console.error(message.replace(/access=[a-f0-9]+/g, 'access=REDACTED')); });
    hp = await host.firstWindow(); hp.setDefaultTimeout(180000); hp.on('pageerror', e => errors.push(e.message));
    await hp.locator('#btn-recheck:not([disabled])').waitFor(); await hp.locator('#btn-continue-setup:not([disabled])').click();
    await hp.locator('#btn-settings').click();
    await hp.locator('#setting-cpus').fill('3'); await hp.locator('#setting-memory').fill('3');
    await hp.locator('#btn-save-settings').click(); await hp.locator('#settings-modal').waitFor({ state: 'hidden' });
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.git/qa-recovery/host/session-settings.json'), 'utf8'));
    assert.equal(saved.cpuCores, 3); assert.equal(saved.memoryLimitMB, 3072);
    await hp.locator('#btn-settings').click();
    await hp.locator('#setting-cpus').fill('4'); await hp.locator('#setting-memory').fill('4');
    await hp.locator('#btn-save-settings').click(); await hp.locator('#settings-modal').waitFor({ state: 'hidden' });
    await hp.locator('#connection-mode').selectOption(internet ? 'internet' : 'lan');
    await hp.locator('#btn-start-browser').click(); await hp.locator('#btn-generate-invite:not([disabled])').waitFor();
    await hp.locator('#btn-generate-invite').click(); const code = await hp.locator('#invitation-code').textContent();
    const client = await _electron.launch({ executablePath: require('../client-app/node_modules/electron'), args: [path.join(root, 'scripts/qa-recovery-client.cjs')], env }); apps.push(client);
    const cp = await client.firstWindow(); cp.setDefaultTimeout(30000); cp.on('pageerror', e => errors.push(e.message));
    await cp.locator('#input-code').fill(code); await cp.locator('#btn-connect').click();
    await hp.locator('#approval-section').waitFor({ state: 'visible' }); await hp.locator('#btn-approve').click();
    const connected = () => cp.waitForFunction(() => document.getElementById('toolbar-status').textContent === 'Workspace connected');
    await connected();
    const original = await hp.evaluate(() => window.hostAPI.getSessionInfo());
    const partition = await cp.locator('#remote-browser').getAttribute('partition');
    console.log('Connected to QA workspace: ' + (real ? 'Docker' : 'mock') + ', ' + (internet ? 'public HTTPS/WSS' : 'LAN'));
    await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
    for (const id of ['display-quality', 'btn-refresh-display', 'btn-upload-files', 'btn-downloads', 'btn-disconnect-client']) {
      assert.ok(await cp.locator('#' + id).evaluate(e => { const r = e.getBoundingClientRect(), bar = document.querySelector('.browser-toolbar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= bar.bottom; }), id + ' visible inside toolbar at minimum size');
    }
    if (real) {
      const limits = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', original.containerName]));
      assert.equal(limits.NanoCpus, 4_000_000_000); assert.equal(limits.Memory, 4 * 1024 ** 3);
      // Put a marker only in our own container; display reconnect must retain its process/window.
      docker(['exec', original.containerName, 'sh', '-c', 'printf "<title>Recovery QA marker</title><h1>Recovery keeps this page</h1>" > /tmp/recovery-qa.html; python3 -m http.server 8889 --bind 127.0.0.1 --directory /tmp >/tmp/recovery-qa-http.log 2>&1 &']);
      docker(['exec', original.containerName, 'sh', '-c', 'google-chrome --no-sandbox http://127.0.0.1:8889/recovery-qa.html >/dev/null 2>&1 &']);
      for (let i = 0; i < 30; i++) {
        if (docker(['exec', original.containerName, 'wmctrl', '-l']).includes('Recovery QA marker')) break;
        await cp.waitForTimeout(300);
      }
      assert.match(docker(['exec', original.containerName, 'wmctrl', '-l']), /Recovery QA marker/, 'Synthetic page loads before interruptions');
    }
    for (const quality of ['data', 'sharp', 'balanced']) {
      await cp.locator('#display-quality').selectOption(quality); await connected();
      if (real) {
        const config = await cp.locator('#remote-browser').evaluate(e => e.executeJavaScript(`JSON.stringify({ fps: document.getElementById('noVNC_setting_framerate').value, min: document.getElementById('noVNC_setting_dynamic_quality_min').value })`));
        assert.equal(JSON.parse(config).fps, { data: '18', sharp: '30', balanced: '24' }[quality]);
      }
    }
    // A display-only failure recovers without disturbing control approval.
    if (real) {
      await host.evaluate(() => {
        global.__pbQaOldDisplay = [...global.__pbQaServer.displaySockets].find(ws => ws._isServer);
        for (const ws of global.__pbQaServer.displaySockets) ws.terminate();
      });
      let recovered = false;
      for (let i = 0; i < 30; i++) {
        recovered = await host.evaluate(() => [...global.__pbQaServer.displaySockets].some(ws => ws._isServer && ws !== global.__pbQaOldDisplay && ws.readyState === 1));
        if (recovered) break; await cp.waitForTimeout(1000);
      }
      assert.ok(recovered, 'Display creates a new connection automatically');
    } else {
      await cp.locator('#remote-browser').evaluate(e => e.executeJavaScript("document.documentElement.className = 'noVNC_disconnected'"));
      await cp.waitForFunction(() => document.getElementById('toolbar-status').textContent.includes('Reconnecting display'));
    }
    await connected(); console.log('PASS: automatic display recovery and three applied quality presets');
    await cp.evaluate(() => {
      window.__pbQaResumes = 0; window.__pbQaRecoveries = 0;
      window.clientAPI.onResumed(() => window.__pbQaResumes++);
      window.clientAPI.onConnectionStatus(value => { if (value === 'reconnecting') window.__pbQaRecoveries++; });
    });
    for (let i = 0; i < 3; i++) {
      await host.evaluate(() => global.__pbQaServer.connectedClient.terminate());
      await cp.waitForFunction(expected => window.__pbQaResumes === expected, i + 1);
      await connected();
      assert.equal((await hp.evaluate(() => window.hostAPI.getSessionInfo())).sessionId, original.sessionId);
      assert.equal(await cp.locator('#remote-browser').getAttribute('partition'), partition);
    }
    assert.equal(await cp.evaluate(() => window.__pbQaRecoveries), 3);
    console.log('PASS: three control drops recovered with the same session and viewer partition');
    await cp.locator('#btn-refresh-display').click(); await connected();
    if (real) {
      assert.match(docker(['exec', original.containerName, 'wmctrl', '-l']), /Recovery QA marker/);
      await host.evaluate(() => {
        global.__pbPongs = { client: 0, backend: 0 };
        global.__pbIdleSockets = [...global.__pbQaServer.displaySockets];
        for (const ws of global.__pbIdleSockets) ws.on('pong', () => global.__pbPongs[ws._isServer ? 'client' : 'backend']++);
      });
      // Stay idle beyond the former HTTP inactivity deadline. The app must keep streaming alive.
      for (let i = 0; i < 7; i++) await cp.waitForTimeout(10000);
      assert.ok(await host.evaluate(() => global.__pbPongs.client >= 3 && global.__pbIdleSockets.every(ws => ws.readyState === 1)), 'Display ping/pong keeps the internet hop and original loopback socket alive');
      await connected(); console.log('PASS: 70 seconds idle with display heartbeats and page preserved');
    }
    assert.deepEqual(errors, []);
    await hp.locator('#btn-stop-browser').click(); await cp.locator('#screen-disconnected.active').waitFor();
    assert.equal(await cp.locator('#remote-browser').getAttribute('src'), 'about:blank');
    console.log('PASS: host stop revokes the recovered session and clears the viewer');
  } catch (error) {
    const client = apps[1];
    if (client) {
      const cp = client.windows()[0];
      console.error(await cp.evaluate(() => ({ status: document.getElementById('toolbar-status').textContent, message: document.getElementById('viewer-message').textContent, screen: document.querySelector('.screen.active').id })));
      console.error(await cp.locator('#remote-browser').evaluate(async e => e.executeJavaScript('JSON.stringify({state:document.documentElement.className, errors:document.getElementById("noVNC_status")?.innerText, fps:document.getElementById("noVNC_setting_framerate")?.value})')).catch(() => 'Guest unavailable'));
    }
    throw error;
  } finally {
    if (hp) await hp.evaluate(() => window.hostAPI.stopBrowser()).catch(() => {});
    for (const instance of apps.reverse()) await instance.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
