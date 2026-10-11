document.addEventListener('DOMContentLoaded', async () => {
  'use strict';
  const $ = id => document.getElementById(id);
  let config, session, busy = false, ready = false;
  let sharing = { state: 'idle', message: 'Internet sharing starts automatically with the browser.' };
  const notice = (message, error = false) => {
    $('host-notice').textContent = message;
    $('host-notice').className = 'notice' + (error ? ' error' : '');
    $('host-notice').hidden = !message;
  };
  const invoke = async (method, ...args) => {
    const result = await window.hostAPI[method](...args);
    if (result?.success === false) throw new Error(result.error || 'The action failed.');
    return result;
  };
  function renderSession(info) {
    session = info;
    const active = ['running', 'client_pending', 'client_connected'].includes(info.status);
    const transitioning = ['starting', 'stopping'].includes(info.status);
    const labels = { idle: 'Idle', starting: 'Starting', running: 'Ready', client_pending: 'Approval needed',
      client_connected: 'Client connected', stopping: 'Stopping', error: 'Failed' };
    $('session-badge').textContent = labels[info.status] || info.status;
    $('session-badge').className = 'badge badge-' + (active ? 'running' : transitioning ? 'starting' : info.status === 'error' ? 'danger' : 'idle');
    $('stat-session-id').textContent = info.sessionId || '—';
    $('stat-resolution').textContent = active ? `${info.browserResolution.width} × ${info.browserResolution.height}` : '—';
    $('btn-start-browser').disabled = busy || transitioning || active || !ready;
    $('btn-stop-browser').disabled = busy || transitioning || (!active && !(info.status === 'error' && info.containerName));
    $('btn-generate-invite').disabled = busy || info.status !== 'running' || info.hostSetupRequired || sharing.state !== 'ready';
    $('connection-mode').disabled = busy || transitioning || active;
    $('sharing-status').textContent = sharing.state === 'idle'
      ? ($('connection-mode').value === 'lan' ? 'Local sharing starts with the browser. Both PCs must be on the same network.' : 'Internet sharing starts with the browser. No extra network tools are needed.')
      : sharing.message;
    $('invite-help').textContent = info.status === 'starting' ? 'Preparing the browser. Your invitation will be available when it is ready.'
      : info.hostSetupRequired ? 'Finish private setup and sign in yourself before generating an invitation.'
      : info.status === 'client_pending' ? 'Your client is waiting. Review their request in Client Connection below.'
      : info.status === 'client_connected' ? 'Your client is connected. Stop the session when you are finished.'
      : info.status === 'running' && sharing.state === 'connecting' ? 'Connecting internet sharing. Your invitation will be available shortly.'
      : info.status === 'running' && sharing.state === 'error' ? 'Sharing is unavailable. Stop and restart the browser to try again.'
      : info.status === 'running' ? 'Generate an invitation, copy it and send it to your client. You approve them after they connect.'
      : info.status === 'stopping' ? 'Stopping the browser and removing its temporary data.'
      : 'Choose a browser profile below, then click “1. Start Browser”. An invitation is available after the browser starts.';
    $('chrome-profile').disabled = busy || transitioning || active;
    $('btn-refresh-profiles').disabled = busy || transitioning || active;
    $('host-setup-section').hidden = !active;
    $('btn-open-host-setup').disabled = busy || info.status !== 'running';
    $('btn-finish-host-setup').disabled = busy || info.status !== 'running' || !info.hostSetupRequired;
    $('btn-finish-host-setup').hidden = !info.hostSetupRequired;
    $('host-setup-status').textContent = info.status === 'client_connected' ? `${info.profileName ? 'Profile: ' + info.profileName + '. ' : ''}Client has control of the workspace.${info.profileName ? ' Disconnecting ends this session and removes its temporary data.' : ''}` : info.hostSetupRequired
      ? `${info.profileName ? 'Profile: ' + info.profileName + '. ' : ''}Private setup required. Sign in yourself, then mark setup finished before inviting a client.`
      : `${info.profileName ? 'Profile: ' + info.profileName + '. ' : ''}Ready to invite. You can reopen private setup before sharing.`;
    $('btn-settings').disabled = busy || transitioning || active;
    $('session-progress').textContent = info.pullProgress || (info.status === 'starting' ? 'Preparing the browser. The first image download can take several minutes.' : '');
    if (!active && !transitioning) resetClient();
    if (info.status === 'idle') {
      $('invitation-section').style.display = 'none';
      $('invitation-code').textContent = '';
    }
    if (info.hostSetupRequired) { $('invitation-section').style.display = 'none'; $('invitation-code').textContent = ''; }
  }
  function resetClient() {
    $('client-badge').textContent = 'No client';
    $('client-badge').className = 'badge badge-idle';
    $('approval-section').style.display = 'none';
    $('connected-section').style.display = 'none';
    $('btn-disconnect-client').disabled = true;
  }
  async function action(task) {
    if (busy) return;
    busy = true; notice('');
    if (session) renderSession(session);
    try { await task(); }
    catch (error) { notice(error.message || String(error), true); }
    finally {
      busy = false;
      try { renderSession(await window.hostAPI.getSessionInfo()); } catch (_) {}
    }
  }
  async function checkDependencies() {
    $('btn-recheck').disabled = true;
    $('btn-continue-setup').disabled = true;
    ready = false;
    $('dep-docker').querySelector('.dep-status').textContent = 'Checking…';
    try {
      const deps = await window.hostAPI.checkDependencies();
      ready = deps.docker.installed && deps.docker.running;
      $('dep-docker').querySelector('.dep-icon').textContent = ready ? '✓' : '!';
      $('dep-docker').querySelector('.dep-status').textContent = ready ? 'Running' : deps.docker.installed ? 'Start Docker Desktop, then re-check' : 'Install Docker Desktop with WSL2';
      $('btn-continue-setup').disabled = !ready;
    } catch (error) { notice(`System check failed: ${error.message}`, true); }
    finally { $('btn-recheck').disabled = false; if (session) renderSession(session); }
  }
  $('btn-recheck').addEventListener('click', checkDependencies);
  $('connection-mode').addEventListener('change', () => { if (session) renderSession(session); });
  $('btn-continue-setup').addEventListener('click', () => {
    $('screen-setup').classList.remove('active');
    $('screen-dashboard').classList.add('active');
  });
  $('btn-start-browser').addEventListener('click', () => action(async () => {
    const result = await invoke('startBrowser', config, $('chrome-profile').value || undefined, $('connection-mode').value);
    if (result.cancelled) { notice('Profile sharing cancelled. No profile data was copied.'); return; }
    renderSession(result.session);
    notice(result.session.hostSetupRequired ? 'Temporary profile ready. Open private setup and sign in yourself before inviting the client.' : 'Browser ready. Generate an invitation, then approve your client.');
  }));
  async function refreshProfiles() {
    const result = await invoke('listChromeProfiles');
    const selected = $('chrome-profile').value;
    $('chrome-profile').replaceChildren(new Option('Fresh browser — no profile data', ''));
    for (const profile of result.profiles) $('chrome-profile').append(new Option(`${profile.name} (${profile.id})`, profile.id));
    if (result.profiles.some(profile => profile.id === selected)) $('chrome-profile').value = selected;
    $('profile-help').textContent = result.profiles.length ? 'Only web bookmarks and basic settings are copied with your permission. Sign in privately for this session. Disconnecting the client ends a profile session and removes its workspace.' : 'No Windows Chrome profiles found for this user. You can use a fresh browser and sign in through private setup.';
  }
  $('btn-refresh-profiles').addEventListener('click', () => action(refreshProfiles));
  $('btn-open-host-setup').addEventListener('click', () => action(async () => {
    await invoke('openHostSetup');
    notice('Private setup is open in a separate window. Sign in there yourself, then return here and select “I\'ve finished setup”.');
  }));
  $('btn-finish-host-setup').addEventListener('click', () => action(async () => {
    const result = await invoke('finishHostSetup');
    notice(result.cancelled ? 'Private setup remains closed to clients.' : 'Setup complete. Generate an invitation, then approve your client.');
  }));
  $('btn-stop-browser').addEventListener('click', () => action(async () => {
    await invoke('stopBrowser'); notice('Session stopped. Its temporary browser data has been removed.');
  }));
  $('btn-generate-invite').addEventListener('click', () => action(async () => {
    const result = await invoke('generateInvitation');
    $('invitation-code').textContent = result.invitation;
    $('host-address').textContent = result.hostIp;
    $('invitation-section').style.display = 'flex';
    $('invitation-section').scrollIntoView({ block: 'nearest' });
    notice('Invitation ready. It expires in 60 minutes and works for one approved connection.');
  }));
  $('btn-copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('invitation-code').textContent); notice('Invitation copied.'); }
    catch (_) { notice('Copy failed. Select and copy the invitation manually.', true); }
  });
  for (const [id, approved] of [['btn-approve', true], ['btn-reject', false]]) {
    $(id).addEventListener('click', () => action(async () => {
      await invoke('approveClient', approved);
      $('approval-section').style.display = 'none';
      $('invitation-section').style.display = 'none';
      notice(approved ? 'Client approved.' : 'Connection declined.');
    }));
  }
  $('btn-disconnect-client').addEventListener('click', () => action(async () => {
    await invoke('disconnectClient'); resetClient();
    notice(session?.profileName ? 'Client disconnected. Removing the temporary profile workspace.' : 'Client disconnected. Generate a new invitation to reconnect.');
  }));
  let previousFocus;
  function closeSettings() {
    $('settings-modal').style.display = 'none';
    previousFocus?.focus();
  }
  $('btn-settings').addEventListener('click', () => {
    previousFocus = document.activeElement;
    $('setting-width').value = config.browserWidth;
    $('setting-height').value = config.browserHeight;
    $('setting-duration').value = config.maxSessionDurationMinutes;
    $('settings-error').textContent = '';
    $('settings-modal').style.display = 'flex';
    $('setting-width').focus();
  });
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('settings-modal').addEventListener('click', e => { if (e.target === $('settings-modal')) closeSettings(); });
  document.addEventListener('keydown', e => {
    if ($('settings-modal').style.display !== 'flex') return;
    if (e.key === 'Escape') closeSettings();
    if (e.key === 'Tab') {
      const items = [...$('settings-modal').querySelectorAll('button, input')];
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  $('btn-save-settings').addEventListener('click', async () => {
    const inputs = ['setting-width', 'setting-height', 'setting-duration'].map($);
    if (inputs.some(input => !input.reportValidity())) return;
    const next = { ...config, browserWidth: Number(inputs[0].value), browserHeight: Number(inputs[1].value),
      maxSessionDurationMinutes: Number(inputs[2].value) };
    try { await invoke('updateConfig', next); config = next; closeSettings(); notice('Session settings saved for this app run.'); }
    catch (error) { $('settings-error').textContent = error.message; }
  });
  window.hostAPI.onSessionUpdate(renderSession);
  window.hostAPI.onSharingUpdate(info => { sharing = info; if (session) renderSession(session); });
  window.hostAPI.onApprovalRequested(info => {
    $('pending-client-name').textContent = info.clientName;
    $('approval-section').style.display = 'block';
    $('client-badge').textContent = 'Approval needed';
    $('client-badge').className = 'badge badge-starting';
    $('approval-section').scrollIntoView({ block: 'nearest' });
  });
  window.hostAPI.onClientConnected(info => {
    $('connected-client-name').textContent = info.clientName;
    $('stat-client-connected').textContent = new Date().toLocaleTimeString();
    $('connected-section').style.display = 'flex';
    $('approval-section').style.display = $('invitation-section').style.display = 'none';
    $('client-badge').textContent = 'Connected';
    $('client-badge').className = 'badge badge-running';
    $('btn-disconnect-client').disabled = false;
  });
  window.hostAPI.onClientDisconnected(resetClient);
  window.hostAPI.onServerError(error => notice(`Connection server: ${error}`, true));
  window.hostAPI.onResourceUpdate(stats => {
    $('cpu-bar').style.width = `${Math.min(100, stats.cpuPercent)}%`;
    $('cpu-text').textContent = `${stats.cpuPercent}%`;
    $('mem-bar').style.width = `${Math.min(100, 100 * stats.memoryMB / (stats.memoryLimitMB || 2048))}%`;
    $('mem-text').textContent = `${stats.memoryMB} MB`;
  });
  setInterval(() => {
    const seconds = session?.startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(session.startedAt)) / 1000)) : 0;
    $('stat-duration').textContent = session?.startedAt ? [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':') : '—';
  }, 1000);
  try {
    config = await window.hostAPI.getConfig();
    sharing = await window.hostAPI.getSharingInfo();
    renderSession(await window.hostAPI.getSessionInfo());
    await checkDependencies();
    try { await refreshProfiles(); } catch (error) { notice(error.message, true); }
  } catch (error) { notice(`Could not initialize the host: ${error.message}`, true); }
});
