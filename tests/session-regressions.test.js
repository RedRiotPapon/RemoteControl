const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { once } = require('events');
const WS = require('../host-app/node_modules/ws');
const { SessionManager } = require('../host-app/dist/services/session-manager');
const { WebSocketServer } = require('../host-app/dist/services/websocket-server');
const { ConnectionService } = require('../client-app/dist/services/connection-service');
const { validateSessionConfig, generateInvitationCode, parseInvitationCode, isInvitationExpired,
  MessageType, createMessage, parseMessage, SessionStatus } = require('../shared/dist');

const docker = () => ({ isAvailable: async () => false, stopBrowser: async () => {}, getContainerId: () => null });
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, res => {
    let body = ''; res.on('data', data => body += data); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});
const next = (ws, type) => new Promise(resolve => {
  const listener = data => {
    const msg = parseMessage(data.toString());
    if (msg?.type === type) { ws.off('message', listener); resolve(msg); }
  };
  ws.on('message', listener);
});

test('Settings preserve unlimited duration and reject invalid dimensions and image names', () => {
  assert.equal(validateSessionConfig({ maxSessionDurationMinutes: 0 }).maxSessionDurationMinutes, 0);
  for (const bad of [{ browserWidth: 799 }, { browserHeight: NaN }, { browserWidth: 900.5 },
    { maxSessionDurationMinutes: -1 }, { containerImage: '../bad image' },
    { cpuCores: 0 }, { cpuCores: 9 }, { cpuCores: 1.5 }, { memoryLimitMB: 512 }, { memoryLimitMB: 8193 }]) assert.throws(() => validateSessionConfig(bad));
  assert.equal(validateSessionConfig({}).cpuCores, 4);
  assert.equal(validateSessionConfig({}).memoryLimitMB, 4096);
});

test('Invitation parsing rejects malformed endpoints, token types and expiry dates', () => {
  for (const data of [
    { h: '127.0.0.1/path', p: 9500, t: 'a'.repeat(64), e: new Date().toISOString() },
    { h: '127.0.0.1', p: 99999, t: 'a'.repeat(64), e: new Date().toISOString() },
    { h: '127.0.0.1', p: 9500, t: {}, e: new Date().toISOString() },
    { h: '127.0.0.1', p: 9500, t: 'a'.repeat(64), e: 'never' },
  ]) assert.equal(parseInvitationCode(Buffer.from(JSON.stringify(data)).toString('base64url')), null);
  assert.equal(isInvitationExpired('never'), true);
});

test('Start failure cleans up its container and does not report running', async () => {
  const previous = process.env.PB_TEST_MODE; delete process.env.PB_TEST_MODE;
  let stopped = 0;
  const manager = new SessionManager({ ...docker(), isAvailable: async () => true,
    pullImage: async () => {}, startBrowser: async () => { throw new Error('VNC failed'); }, stopBrowser: async () => { stopped++; } });
  try {
    await assert.rejects(manager.startSession(), /VNC failed/);
    assert.equal(manager.getSessionInfo().status, SessionStatus.ERROR);
    assert.equal(manager.getVNCPort(), null); assert.equal(stopped, 1);
  } finally { if (previous === undefined) delete process.env.PB_TEST_MODE; else process.env.PB_TEST_MODE = previous; }
});

test('Session enforces invitation expiry on host and rejects settings changes during a session', async () => {
  process.env.PB_TEST_MODE = '1';
  const manager = new SessionManager(docker());
  try {
    await manager.startSession({ maxSessionDurationMinutes: 0 });
    const invite = parseInvitationCode(await manager.generateInvitation('127.0.0.1'));
    assert.equal(manager.verifyToken(invite.token), true);
    manager.tokenExpiresAt = Date.now() - 1;
    assert.equal(manager.verifyToken(invite.token), false);
    assert.throws(() => manager.updateConfig({ browserWidth: 1280 }), /Stop the session/);
  } finally { await manager.stopSession(); }
});

test('Container removal failure is reported and retains the owned container for retry', async () => {
  const { DockerService } = require('../host-app/dist/services/docker-service');
  const service = new DockerService();
  service.currentContainerId = 'owned-container';
  let removals = 0;
  service.docker = { getContainer: id => {
    assert.equal(id, 'owned-container');
    return { stop: async () => {}, remove: async options => {
      assert.equal(options.v, true); removals++;
      if (removals === 1) throw new Error('Docker offline');
    } };
  } };
  await assert.rejects(service.stopBrowser(), /Could not remove/);
  assert.equal(service.getContainerId(), 'owned-container');
  await service.stopBrowser(); assert.equal(service.getContainerId(), null);
});

test('Kasm proxy serves assets, authenticates upgrades, isolates control and revokes open streams', { timeout: 15000 }, async () => {
  process.env.PB_TEST_MODE = '1';
  const manager = new SessionManager(docker());
  const server = new WebSocketServer(manager);
  server.port = 0; server.setHostIp('127.0.0.1');
  let control, stream, backend;
  try {
    await manager.startSession(); await server.start();
    const port = server.httpServer.address().port; server.port = port;
    const base = `http://127.0.0.1:${port}`;
    const invitation = parseInvitationCode(await manager.generateInvitation('127.0.0.1'));
    const backendRequests = [];
    manager.mockServer.on('request', req => backendRequests.push({ url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie, rawHeaders: req.rawHeaders }));
    backend = new WS.WebSocketServer({ server: manager.mockServer });
    backend.on('connection', (ws, request) => {
      assert.equal(request.headers.origin, base, 'Pinned Kasm requires an Origin header on the upstream handshake');
      ws.on('message', (data, binary) => ws.send(data, { binary }));
    });
    control = new WS(`${base.replace('http:', 'ws:')}/control`);
    await once(control, 'open');
    let pending = next(control, MessageType.APPROVAL_PENDING);
    control.send(JSON.stringify(createMessage(MessageType.AUTH_REQUEST, { token: invitation.token, clientName: 'Test' })));
    await pending;
    const approval = next(control, MessageType.APPROVAL_GRANTED); server.handleApproval(true);
    const payload = (await approval).payload;
    assert.equal((await get(base + '/app.js')).status, 403);
    const bootstrap = await get(payload.streamUrl);
    const cookie = bootstrap.headers['set-cookie'][0].split(';')[0];
    const asset = await get(base + '/app.js?version=1', { Cookie: cookie });
    assert.equal(asset.status, 200);
    assert.equal(backendRequests.at(-1).url, '/app.js?version=1');
    assert.equal(backendRequests.at(-1).auth, 'Basic ' + Buffer.from(`kasm_user:${manager.getVNCPassword()}`).toString('base64'));
    assert.equal(backendRequests.at(-1).cookie, undefined);
    assert.ok(backendRequests.at(-1).rawHeaders.includes('Authorization'), 'Pinned KasmVNC requires canonical header casing');
    // Stream upgrades with no credential or a foreign origin must fail.
    for (const headers of [{}, { Cookie: cookie, Origin: 'http://untrusted.example' }]) {
      await new Promise((resolve, reject) => {
        const attacker = new WS(base.replace('http:', 'ws:') + '/websockify', { headers });
        attacker.on('open', () => { attacker.terminate(); reject(new Error('Unauthorized upgrade accepted')); });
        attacker.on('error', resolve);
      });
    }
    stream = new WS(base.replace('http:', 'ws:') + '/websockify', { headers: { Cookie: cookie, Origin: base } });
    await once(stream, 'open');
    const echo = once(stream, 'message'); stream.send('frame');
    assert.equal((await echo)[0].toString(), 'frame');
    const bytes = Buffer.alloc(2 * 1024 * 1024, 173), binaryEcho = once(stream, 'message');
    stream.send(bytes.subarray(0, 1048576), { binary: true, fin: false });
    stream.send(bytes.subarray(1048576), { binary: true, fin: true });
    const [binaryFrame, isBinary] = await binaryEcho;
    assert.equal(isBinary, true); assert.deepEqual(binaryFrame, bytes, 'Fragmented binary display frames survive the relay');
    let heartbeatCount = 0;
    control.on('message', data => { if (parseMessage(data.toString())?.type === MessageType.HEARTBEAT) heartbeatCount++; });
    control.send(JSON.stringify(createMessage(MessageType.HEARTBEAT, {})));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(heartbeatCount, 0);
    const closed = once(stream, 'close');
    await manager.stopSession(); await closed;
    assert.equal((await get(base + '/', { Cookie: cookie })).status, 403);
  } finally {
    control?.terminate(); stream?.terminate(); backend?.close(); server.stop(); await manager.stopSession();
  }
});

test('Client cancel stops pending approval; rejection is preserved instead of overwritten by close', { timeout: 15000 }, async () => {
  process.env.PB_TEST_MODE = '1';
  const manager = new SessionManager(docker());
  const server = new WebSocketServer(manager); server.port = 0;
  const client = new ConnectionService();
  client.on('error', () => {});
  try {
    await manager.startSession(); await server.start();
    server.port = server.httpServer.address().port;
    const code = generateInvitationCode('127.0.0.1', server.port, parseInvitationCode(await manager.generateInvitation()).token);
    const pending = once(client, 'approval-pending'); await client.connect(code, 'Client'); await pending;
    const rejected = once(client, 'rejected'); server.handleApproval(false); await rejected;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(client.getStatus(), 'rejected');
    const again = once(client, 'approval-pending'); await client.connect(code, 'Client'); await again;
    const hostClosed = once(server, 'client-disconnected'); client.disconnect(); await hostClosed;
    assert.equal(client.getStatus(), 'disconnected'); assert.equal(manager.getSessionInfo().status, 'running');
  } finally { client.disconnect(); server.stop(); await manager.stopSession(); }
});
