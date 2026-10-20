document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const $ = id => document.getElementById(id);
  let viewer = $('remote-browser');
  let attempt = 0, loadingTimer, connecting = false, viewerFailed = false;
  let fileBusy = false;
  let controlLost = false, streamUrl = '', displayRetryTimer, displayFailures = 0, viewerReady = false;
  let displayFailureAt = 0, displayStableAt = 0, displayChecking = false;
  let displayLoadAt = 0, displayStopped = false;
  const downloadsDialog = $('downloads-dialog');
  function fileNotice(message, failed = false) {
    $('file-notice').hidden = false;
    $('file-notice').classList.toggle('error', failed);
    $('file-message').textContent = message;
  }
  function fileControls(busy) {
    fileBusy = busy;
    $('btn-upload-files').disabled = busy || controlLost;
    $('btn-cancel-transfer').hidden = !busy;
    $('btn-dismiss-file-notice').hidden = busy;
    $('file-progress').hidden = !busy;
    if (busy) $('file-progress').value = 0;
    for (const button of $('downloads-list').querySelectorAll('button')) button.disabled = busy;
  }
  function bytes(size) {
    if (size < 1024) return `${size} B`;
    return size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  async function transfer(action, initial, complete) {
    if (fileBusy) return;
    const current = attempt;
    fileControls(true); fileNotice(initial);
    try {
      const result = await action();
      if (current !== attempt) return;
      if (!result.success) fileNotice(result.error, true);
      else if (result.cancelled) $('file-notice').hidden = true;
      else fileNotice(complete(result));
    } catch (error) { if (current === attempt) fileNotice(error.message, true); }
    finally {
      fileControls(false);
      if (current === attempt && !downloadsDialog.open && $('screen-browser').classList.contains('active')) viewer.focus();
    }
  }
  $('btn-upload-files').addEventListener('click', () => transfer(
    () => window.clientAPI.uploadFiles(), 'Choose files from this PC (up to 1 GiB each)…',
    result => `Uploaded ${result.uploaded.length} file(s): ${result.uploaded.join(', ')}. In the website’s file picker, open Uploads and select your file. Files remain until the host stops the workspace.`));
  $('btn-cancel-transfer').addEventListener('click', () => window.clientAPI.cancelFileTransfer());
  $('btn-dismiss-file-notice').addEventListener('click', () => { $('file-notice').hidden = true; viewer.focus(); });
  async function refreshDownloads() {
    const current = attempt;
    $('downloads-list').replaceChildren();
    $('downloads-status').textContent = 'Checking the workspace…';
    $('btn-refresh-downloads').disabled = true;
    try {
      const result = await window.clientAPI.listDownloads();
      if (current !== attempt || !downloadsDialog.open) return;
      if (!result.success) { $('downloads-status').textContent = result.error; return; }
      $('downloads-status').textContent = result.files.length ? `${result.files.length} completed file(s)` :
        'No completed downloads yet. Download a file in the remote browser, then refresh this list.';
      for (const file of result.files) {
        const row = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
        label.textContent = `${file.name} · ${bytes(file.size)}`;
        button.textContent = 'Save to this PC'; button.className = 'btn btn-primary btn-small'; button.disabled = fileBusy;
        button.addEventListener('click', () => {
          downloadsDialog.close();
          transfer(() => window.clientAPI.saveDownload(file.name), `Choose where to save ${file.name}…`, () => `Saved ${file.name} to this PC.`);
        });
        row.append(label, button); $('downloads-list').append(row);
      }
    } catch (error) { if (current === attempt) $('downloads-status').textContent = error.message; }
    finally { $('btn-refresh-downloads').disabled = false; }
  }
  $('btn-downloads').addEventListener('click', () => { downloadsDialog.showModal(); refreshDownloads(); });
  $('btn-close-downloads').addEventListener('click', () => downloadsDialog.close());
  $('btn-refresh-downloads').addEventListener('click', refreshDownloads);
  window.clientAPI.onFileProgress(value => {
    if (!fileBusy || !$('screen-browser').classList.contains('active')) return;
    $('file-progress').value = value.total ? Math.min(100, value.transferred / value.total * 100) : 0;
    fileNotice(`${value.direction === 'upload' ? 'Uploading' : 'Saving'} ${value.name} · ${bytes(value.transferred)} / ${bytes(value.total)}`);
  });
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(screen => screen.classList.toggle('active', screen.id === id));
  }
  function status(text, state) {
    $('toolbar-status').textContent = text;
    document.querySelectorAll('.connection-dot').forEach(dot => dot.className = `connection-dot ${state}`);
  }
  function clearViewer() {
    controlLost = false; streamUrl = ''; displayStopped = true;
    clearTimeout(displayRetryTimer); displayRetryTimer = null;
    downloadsDialog.close(); $('file-notice').hidden = true;
    $('downloads-list').replaceChildren(); $('file-message').textContent = '';
    clearTimeout(loadingTimer);
    replaceViewer('pb-remote-inactive', 'about:blank'); viewer.style.display = 'none';
    $('vnc-placeholder').hidden = true;
  }
  function error(message) {
    $('connect-status').textContent = message;
    $('connect-status').className = 'status-message error';
    $('connect-status').style.display = 'block';
  }
  function disconnected(title, message) {
    connecting = false; attempt++;
    clearViewer(); status('Disconnected', 'disconnected');
    $('disconnect-title').textContent = title;
    $('disconnect-message').textContent = message;
    showScreen('screen-disconnected');
  }
  async function connect() {
    if (connecting) return;
    const name = $('input-name').value.trim(), code = $('input-code').value.trim().replace(/^["']|["']$/g, '');
    if (!name) { error('Enter your name so the host can identify your request.'); $('input-name').focus(); return; }
    if (!code) { error('Paste the invitation code from the host.'); $('input-code').focus(); return; }
    connecting = true;
    const current = ++attempt;
    $('connect-status').style.display = 'none';
    $('waiting-title').textContent = 'Connecting…';
    $('waiting-message').textContent = code.startsWith('PB2-') ? 'Contacting your host securely over the internet…' : 'Contacting your host on the local network. For different networks, ask for an Internet sharing invitation.';
    showScreen('screen-waiting'); status('Connecting…', 'pending');
    try {
      const result = await window.clientAPI.connect(code, name);
      if (current !== attempt) return;
      if (!result.success) { connecting = false; showScreen('screen-connect'); error(result.error); }
    } catch (err) {
      if (current !== attempt) return;
      connecting = false; showScreen('screen-connect'); error(err.message);
    }
  }
  $('btn-connect').addEventListener('click', connect);
  $('input-name').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  $('input-code').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); connect(); }
  });
  $('btn-paste-code').addEventListener('click', async () => {
    try { $('input-code').value = (await navigator.clipboard.readText()).trim(); }
    catch (_) { error('Clipboard unavailable. Paste the invitation with Ctrl+V.'); }
    $('input-code').focus();
  });
  $('btn-cancel').addEventListener('click', async () => {
    attempt++; connecting = false; clearViewer();
    await window.clientAPI.disconnect(); showScreen('screen-connect');
  });
  $('btn-disconnect-client').addEventListener('click', async () => {
    await window.clientAPI.disconnect();
    disconnected('Disconnected', 'You left the workspace. Ask the host for a new invitation to connect again.');
  });
  $('btn-fullscreen').addEventListener('click', () => window.clientAPI.toggleFullscreen());
  for (const id of ['btn-reconnect', 'btn-back-to-login']) $(id).addEventListener('click', () => {
    $('connect-status').style.display = 'none'; showScreen('screen-connect'); $('input-code').focus();
  });
  function loadDisplay(manual = false) {
    if (controlLost || !streamUrl || !$('screen-browser').classList.contains('active')) return;
    clearTimeout(displayRetryTimer); displayRetryTimer = null;
    if (manual) { displayFailureAt = 0; displayFailures = 0; displayStopped = false; }
    viewerFailed = false;
    displayStableAt = 0; displayLoadAt = Date.now();
    $('vnc-placeholder').hidden = false;
    $('viewer-message').textContent = 'Loading the workspace…';
    status('Loading workspace…', 'pending');
    const url = new URL(streamUrl);
    url.searchParams.set('display', $('display-quality').value);
    // Bootstrap the same in-memory partition; this does not reload the website inside Chrome.
    if (!viewerReady) viewer.src = url.href;
    else void viewer.loadURL(url.href).catch(() => recoverDisplay('The workspace could not load.'));
  }
  $('btn-reload-viewer').addEventListener('click', () => loadDisplay(true));
  $('btn-refresh-display').addEventListener('click', () => loadDisplay(true));
  $('display-quality').addEventListener('change', () => loadDisplay(true));
  function recoverDisplay(message) {
    if (controlLost || !streamUrl || displayStopped) return;
    viewerFailed = true; displayStableAt = 0;
    if (!displayFailureAt) displayFailureAt = Date.now();
    $('vnc-placeholder').hidden = false;
    if (Date.now() - displayFailureAt >= 60000) {
      displayStopped = true;
      $('viewer-message').textContent = 'The display could not reconnect. Check your internet, then click Reload view. Your browser work stays open while the host session is running.';
      status('Display needs attention', 'disconnected'); return;
    }
    status('Reconnecting display…', 'pending');
    $('viewer-message').textContent = navigator.onLine ? message + ' Reconnecting automatically…' : 'You are offline. Waiting for your internet connection…';
    if (displayRetryTimer) return;
    const current = attempt;
    const delay = Math.min(10000, 1000 * 2 ** Math.min(displayFailures++, 4));
    displayRetryTimer = setTimeout(() => {
      displayRetryTimer = null;
      if (current !== attempt || controlLost || !streamUrl) return;
      if (Date.now() - displayFailureAt >= 60000 || !navigator.onLine) { recoverDisplay('Connection interrupted.'); return; }
      loadDisplay();
    }, delay);
  }
  window.addEventListener('online', () => {
    if (viewerFailed && !controlLost && !displayStopped) loadDisplay();
  });
  async function refreshDisplayStatus() {
    if (controlLost || displayChecking || !$('screen-browser').classList.contains('active')) return;
    if (viewerFailed) { recoverDisplay('Display connection interrupted.'); return; }
    displayChecking = true;
    const element = viewer, current = attempt;
    try {
      if (viewer.getURL() === 'about:blank') return;
      let checkTimer;
      const state = await Promise.race([
        viewer.executeJavaScript('document.documentElement.className'),
        new Promise((_, reject) => { checkTimer = setTimeout(() => reject(new Error('Display is not responding.')), 3000); }),
      ]).finally(() => clearTimeout(checkTimer));
      if (element !== viewer || current !== attempt || controlLost) return;
      if (state.includes('noVNC_disconnected')) {
        recoverDisplay('Display connection interrupted.');
      } else if (state.includes('noVNC_') && !state.includes('noVNC_connected')) {
        status('Connecting display…', 'pending');
        if (Date.now() - displayLoadAt > 20000) recoverDisplay('The display is taking longer than expected.');
      } else {
        clearTimeout(displayRetryTimer); displayRetryTimer = null;
        if (!displayStableAt) displayStableAt = Date.now();
        if (Date.now() - displayStableAt > 10000) { displayFailureAt = 0; displayFailures = 0; }
        clearTimeout(loadingTimer); $('vnc-placeholder').hidden = true;
        status('Workspace connected', 'connected');
      }
    } catch (_) {
      if (element === viewer && current === attempt && !controlLost && Date.now() - displayLoadAt > 20000)
        recoverDisplay('The display stopped responding.');
    }
    finally { displayChecking = false; }
  }
  setInterval(refreshDisplayStatus, 1000);
  function replaceViewer(partition, url) {
    viewerReady = false;
    const next = viewer.cloneNode(false);
    next.setAttribute('partition', partition);
    next.setAttribute('src', url);
    viewer.replaceWith(next);
    viewer = next;
    bindViewer(next);
  }
  function bindViewer(element) {
  element.addEventListener('dom-ready', () => { if (element === viewer) viewerReady = true; });
  element.addEventListener('render-process-gone', () => {
    if (element === viewer) recoverDisplay('The display needs to restart.');
  });
  element.addEventListener('did-stop-loading', () => {
    if (element !== viewer) return;
    refreshDisplayStatus();
    if ($('screen-browser').classList.contains('active')) viewer.focus();
  });
  element.addEventListener('did-navigate', event => {
    if (element !== viewer) return;
    if (event.httpResponseCode < 400) return;
    recoverDisplay('The host could not open the display.');
  });
  element.addEventListener('did-fail-load', e => {
    if (element !== viewer) return;
    if (e.errorCode === -3 || !$('screen-browser').classList.contains('active')) return;
    clearTimeout(loadingTimer);
    recoverDisplay('The workspace could not load.');
  });
  }
  bindViewer(viewer);
  window.clientAPI.onConnectionStatus(state => {
    if (['connecting', 'awaiting_approval'].includes(state)) status('Waiting for host', 'pending');
    if (state === 'reconnecting') {
      clearTimeout(loadingTimer);
      controlLost = true; clearTimeout(displayRetryTimer); displayRetryTimer = null;
      $('btn-upload-files').disabled = true; $('btn-downloads').disabled = true;
      downloadsDialog.close();
      $('vnc-placeholder').hidden = false;
      $('viewer-message').textContent = 'Connection interrupted. Reconnecting for up to one minute. Your browser work stays open.';
      status('Reconnecting to host…', 'pending');
    }
  });
  window.clientAPI.onResumed(() => {
    controlLost = false;
    $('btn-upload-files').disabled = fileBusy; $('btn-downloads').disabled = false;
    loadDisplay(true);
  });
  window.clientAPI.onApprovalPending(() => {
    $('waiting-title').textContent = 'Waiting for the host';
    $('waiting-message').textContent = 'Your request is on the host dashboard. Ask the host to approve within two minutes.';
  });
  window.clientAPI.onApproved(config => {
    connecting = false;
    viewerFailed = false;
    controlLost = false; displayStopped = false; displayFailureAt = 0; displayFailures = 0;
    displayStableAt = 0; displayLoadAt = Date.now();
    $('btn-upload-files').disabled = fileBusy; $('btn-downloads').disabled = false;
    if (!config?.streamUrl || !/^https?:\/\//.test(config.streamUrl) || !/^pb-remote-[a-f0-9]{32}$/.test(config.viewerPartition || '')) {
      window.clientAPI.disconnect();
      disconnected('Display unavailable', 'The host did not provide a workspace URL. Restart the host session.'); return;
    }
    $('input-code').value = '';
    clearTimeout(loadingTimer); showScreen('screen-browser'); status('Loading workspace…', 'pending');
    $('viewer-message').textContent = 'Loading the workspace…'; $('vnc-placeholder').hidden = false;
    streamUrl = config.streamUrl;
    const initialUrl = new URL(streamUrl); initialUrl.searchParams.set('display', $('display-quality').value);
    replaceViewer(config.viewerPartition, initialUrl.href); viewer.style.display = 'flex';
    loadingTimer = setTimeout(() => {
      recoverDisplay('The display is taking longer than expected.');
    }, 20000);
  });
  window.clientAPI.onRejected(reason => disconnected('Connection declined', reason || 'The host declined your request.'));
  window.clientAPI.onDisconnected(reason => disconnected('Disconnected', reason || 'Ask the host for a new invitation.'));
  window.clientAPI.onError(message => {
    connecting = false; attempt++;
    if ($('screen-browser').classList.contains('active')) disconnected('Connection error', message);
    else { showScreen('screen-connect'); error(message); }
  });
  window.clientAPI.onSessionStatus(info => { if (info?.message) $('toolbar-status').textContent = info.message; });
});
