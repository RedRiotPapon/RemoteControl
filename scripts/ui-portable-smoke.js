// Launch the actual self-extracting client EXE; the host workspace is a QA mock.
const { _electron, chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = { ...process.env, PB_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  let host, browser, portable;
  try {
    host = await _electron.launch({ executablePath: require(path.join(root, 'host-app/node_modules/electron')),
      args: [path.join(root, 'scripts/qa-host.cjs')], env });
    const hp = await host.firstWindow(); hp.setDefaultTimeout(120000);
    await hp.locator('#btn-continue-setup:not([disabled])').click();
    await hp.locator('#connection-mode').selectOption(process.env.PB_QA_INTERNET === '1' ? 'internet' : 'lan');
    await hp.locator('#btn-start-browser').click();
    await hp.locator('#btn-generate-invite:not([disabled])').click();
    const code = await hp.locator('#invitation-code').textContent();
    portable = spawn(path.join(root, 'client-app/release/ParallelBrowser-Client-Portable.exe'),
      [`--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: 'ignore' });
    for (let retry = 0; retry < 90; retry++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; }
      catch { await wait(500); }
    }
    assert.ok(browser, 'Portable client must open its actual Electron window');
    const cp = browser.contexts()[0].pages().find(page => page.url().includes('index.html'));
    assert.ok(cp, 'Client renderer loaded from extracted package');
    assert.equal(await cp.evaluate(() => typeof window.clientAPI.connect), 'function');
    await cp.locator('#input-name').fill('Portable client QA');
    await cp.locator('#input-code').fill(code); await cp.locator('#btn-connect').click();
    await hp.locator('#approval-section').waitFor({ state: 'visible' });
    await hp.locator('#btn-approve').click();
    await cp.waitForFunction(() => document.getElementById('toolbar-status').textContent === 'Workspace connected');
    assert.match(await cp.locator('#remote-browser').evaluate(element => element.executeJavaScript('document.body.innerText')), /Isolated Chromium Session/);
    await hp.locator('#btn-stop-browser').click();
    await cp.locator('#screen-disconnected.active').waitFor();
    await cp.locator('#btn-back-to-login').click();
    await cp.locator('#input-code').fill('invalid'); await cp.locator('#btn-connect').click();
    await cp.locator('#connect-status').waitFor({ state: 'visible' });
    console.log('PASS: actual portable EXE launch, preload, invitation, host approval, viewer, disconnect and invalid-code recovery.');
  } finally {
    if (browser) {
      for (const page of browser.contexts()[0].pages()) await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }
    if (portable && portable.exitCode === null) portable.kill();
    if (host) await host.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
