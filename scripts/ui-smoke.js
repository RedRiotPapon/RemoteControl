// Run after build:all with PLAYWRIGHT_MODULE pointing to an installed Playwright module.
// Uses a clearly marked mock workspace; does not start Docker or control the host desktop.
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs', 'qa');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const real = process.env.PB_QA_REAL === '1';
  const env = { ...process.env }; if (real) delete env.PB_TEST_MODE; else env.PB_TEST_MODE = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  const apps = [], errors = [];
  try {
    const host = await electron.launch({ executablePath: require(path.join(root, 'host-app/node_modules/electron')),
      args: [path.join(root, real ? 'host-app/dist/main/index.js' : 'scripts/qa-host.cjs')], env }); apps.push(host);
    const hp = await host.firstWindow(); hp.on('pageerror', error => errors.push('host: ' + error.message));
    hp.setDefaultTimeout(90000);
    await hp.locator('#btn-recheck:not([disabled])').waitFor();
    await hp.screenshot({ path: path.join(out, 'host-system-check-mock.png') });
    await hp.locator('#btn-recheck').click();
    await hp.locator('#btn-continue-setup:not([disabled])').click();
    await hp.locator('#connection-mode').selectOption(process.env.PB_QA_INTERNET === '1' ? 'internet' : 'lan');
    await host.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 550));
    for (const id of ['btn-start-browser', 'btn-generate-invite']) {
      assert.ok(await hp.locator('#' + id).evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      }), id + ' must be visible without scrolling at the minimum window size');
    }
    assert.equal(await hp.locator('#btn-generate-invite').isDisabled(), true);
    assert.match(await hp.locator('#invite-help').textContent(), /Start Browser/);
    await hp.locator('.share-card').screenshot({ path: path.join(out, 'host-invite-idle.png') });
    await hp.locator('#btn-settings').click();
    await hp.locator('#setting-width').fill('1280');
    await hp.locator('#setting-height').fill('720');
    await hp.locator('#setting-duration').fill('0');
    await hp.locator('#btn-save-settings').click();
    const config = await hp.evaluate(() => window.hostAPI.getConfig());
    assert.equal(config.browserWidth, 1280); assert.equal(config.maxSessionDurationMinutes, 0);
    await hp.locator('#btn-start-browser').click();
    await hp.locator('#btn-generate-invite:not([disabled])').waitFor();
    assert.equal(await hp.locator('#stat-resolution').textContent(), '1280 × 720');
    await hp.locator('#btn-generate-invite').click();
    await hp.locator('#invitation-section').waitFor({ state: 'visible' });
    const code = await hp.locator('#invitation-code').textContent();
    await hp.locator('#btn-copy-code').click();
    assert.equal(await host.evaluate(({ clipboard }) => clipboard.readText()), code);
    assert.ok(await hp.locator('#btn-copy-code').evaluate(element => {
      const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
    }), 'Copy invitation must be visible after generation');
    await hp.screenshot({ path: path.join(out, 'host-ready.png') });
    const client = await electron.launch({ executablePath: require(path.join(root, 'client-app/node_modules/electron')),
      args: [path.join(root, real ? 'scripts/qa-client.cjs' : 'client-app/dist/main/index.js')], env }); apps.push(client);
    if (real) client.process().stdout.on('data', data => console.log(data.toString().replace(/access=[a-f0-9]+/g, 'access=REDACTED')));
    const cp = await client.firstWindow(); cp.on('pageerror', error => errors.push('client: ' + error.message));
    // Capture only after connection: a CDP capture of the initial Electron webview
    // can stall its replacement. Portable QA separately verifies the connect form.
    await cp.locator('#input-name').fill('UI smoke test');
    await cp.locator('#input-code').fill(code);
    await cp.locator('#btn-connect').click();
    await hp.locator('#approval-section').waitFor({ state: 'visible' });
    await hp.screenshot({ path: path.join(out, 'host-approval.png') });
    await hp.locator('#btn-approve').click();
    await cp.locator('#screen-browser.active').waitFor();
    await cp.waitForFunction(() => document.getElementById('toolbar-status').textContent === 'Workspace connected');
    await cp.screenshot({ path: path.join(out, 'client-workspace-loading.png') });
    const viewerText = await cp.locator('#remote-browser').evaluate(async element => element.executeJavaScript('document.body.innerText'));
    if (!real) assert.match(viewerText, /Isolated Chromium Session/);
    if (real) {
      let remoteState;
      for (let retry = 0; retry < 60; retry++) {
        remoteState = await cp.locator('#remote-browser').evaluate(async element => JSON.parse(await element.executeJavaScript(
        `JSON.stringify((() => {
          const canvas = [...document.querySelectorAll('canvas')].find(c => c.width >= 800 && c.height >= 400);
          if (!canvas) return { path: location.pathname, canvas: false };
          const pixels = canvas.getContext('2d').getImageData(0, 0, 300, 150).data;
          const colors = new Set();
          for (let i = 0; i < pixels.length; i += 128) colors.add(pixels.slice(i, i + 3).join(','));
          return { path: location.pathname, canvas: true, colors: colors.size };
        })())`))).catch(() => ({}));
        if (remoteState.colors > 8) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(remoteState.colors > 8, JSON.stringify(remoteState));
      console.log('Real browser framebuffer received.');
      const frameExpression = "[...document.querySelectorAll('canvas')].find(c => c.width >= 800 && c.height >= 400)";
      const before = await cp.locator('#remote-browser').evaluate((element, expression) => element.executeJavaScript(expression + '.toDataURL()'), frameExpression);
      await cp.locator('#remote-browser').evaluate((element, expression) => element.executeJavaScript(expression + '.focus()'), frameExpression);
      await client.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview');
        guest.debugger.attach('1.3');
        const key = (type, value, code, vk, modifiers = 0) => guest.debugger.sendCommand('Input.dispatchKeyEvent',
          { type, key: value, code, windowsVirtualKeyCode: vk, modifiers });
        await key('keyDown', 'Control', 'ControlLeft', 17, 2);
        await key('keyDown', 'l', 'KeyL', 76, 2); await key('keyUp', 'l', 'KeyL', 76, 2);
        await key('keyUp', 'Control', 'ControlLeft', 17);
        const url = `data:text/html,<title>ParallelBrowser QA</title><button style="position:fixed;inset:0;width:100%;height:100%;font-size:32px" onclick="document.title='Mouse input works';this.textContent='Mouse and keyboard work'">Remote input works - click to test mouse</button>`;
        for (const character of url) {
          await guest.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character });
          await guest.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
        }
        await key('keyDown', 'Enter', 'Enter', 13); await key('keyUp', 'Enter', 'Enter', 13);
        guest.debugger.detach();
      });
      const liveSession = await hp.evaluate(() => window.hostAPI.getSessionInfo());
      let titles = '';
      for (let retry = 0; retry < 40; retry++) {
        titles = execFileSync('docker', ['exec', liveSession.containerName, 'wmctrl', '-l'], { encoding: 'utf8', windowsHide: true });
        if (titles.includes('ParallelBrowser QA')) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      assert.match(titles, /ParallelBrowser QA/, 'Remote keyboard input must navigate the actual container browser');
      const target = await cp.locator('#remote-browser').evaluate((element, expression) => element.executeJavaScript(
        `(() => { const rect = (${expression}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`), frameExpression);
      await client.evaluate(async ({ webContents }, target) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview');
        guest.debugger.attach('1.3');
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await guest.debugger.sendCommand('Input.dispatchMouseEvent',
          { type, x: target.x, y: target.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
        guest.debugger.detach();
      }, target);
      for (let retry = 0; retry < 40; retry++) {
        titles = execFileSync('docker', ['exec', liveSession.containerName, 'wmctrl', '-l'], { encoding: 'utf8', windowsHide: true });
        if (titles.includes('Mouse input works')) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      assert.match(titles, /Mouse input works/, 'Remote mouse input must activate the actual browser page button');
      await hp.waitForFunction(() => parseInt(document.getElementById('mem-text').textContent, 10) > 0);
      console.log('Workspace memory:', await hp.locator('#mem-text').textContent());
      await cp.waitForFunction(async ({ before, expression }) => (await document.getElementById('remote-browser').executeJavaScript(
        expression + '.toDataURL()')) !== before, { before, expression: frameExpression }, { timeout: 15000 });
      // Native capture includes the embedded webview compositor, unlike CDP screenshots on some Electron builds.
      const native = await client.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(out, 'client-workspace-native.png'), Buffer.from(native, 'base64'));
      const frame = await cp.locator('#remote-browser').evaluate((element, expression) => element.executeJavaScript(expression + '.toDataURL()'), frameExpression);
      fs.writeFileSync(path.join(out, 'browser-framebuffer.png'), Buffer.from(frame.split(',')[1], 'base64'));
    }
    if (real) fs.copyFileSync(path.join(out, 'client-workspace-native.png'), path.join(out, 'client-workspace-real.png'));
    else await cp.screenshot({ path: path.join(out, 'client-workspace-mock.png') });
    await host.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 550));
    await hp.screenshot({ path: path.join(out, 'host-small-window.png') });
    assert.equal(await hp.locator('#btn-stop-browser').isVisible(), true);
    await hp.locator('#btn-stop-browser').click();
    await cp.locator('#screen-disconnected.active').waitFor();
    assert.equal(await cp.locator('#remote-browser').getAttribute('src'), 'about:blank');
    await cp.screenshot({ path: path.join(out, 'client-disconnected.png') });
    await cp.locator('#btn-reconnect').click();
    await cp.locator('#input-code').fill('invalid-invitation');
    await cp.locator('#btn-connect').click();
    await cp.locator('#connect-status').waitFor({ state: 'visible' });
    assert.match(await cp.locator('#connect-status').textContent(), /Invalid invitation/);
    await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
    await cp.screenshot({ path: path.join(out, 'client-error-small-window.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: actual Electron host/client launch, settings, invitation, approval, webview, stop, invalid-code recovery, and minimum window sizes. Backend: ' + (real ? 'DOCKER / KASM' : 'MOCK') + '.');
  } catch (error) {
    for (const [index, app] of apps.entries()) {
      const page = app.windows()[0];
      if (page) {
        await page.screenshot({ path: path.join(out, `failure-${index}.png`) }).catch(() => {});
        console.error(await page.evaluate(() => ({ text: document.body.innerText })), errors);
        if (index === 1) console.error(await page.locator('#remote-browser').evaluate(element => element.executeJavaScript(
          `JSON.stringify({ html: document.documentElement.outerHTML.slice(0, 5000), canvas: [...document.querySelectorAll('canvas')].map(c => [c.width, c.height]), globals: Object.keys(window).filter(k => /rfb|ui|vnc/i.test(k)) })`)).catch(() => 'Viewer unavailable'));
      }
    }
    throw error;
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
