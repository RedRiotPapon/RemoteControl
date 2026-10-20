const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WS = require('../host-app/node_modules/ws');
const { SessionManager } = require('../host-app/dist/services/session-manager');
const { WebSocketServer } = require('../host-app/dist/services/websocket-server');
const { ConnectionService } = require('../client-app/dist/services/connection-service');
const { generateInvitationCode, parseInvitationCode, createMessage, parseMessage, MessageType } = require('../shared/dist');

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, res => { res.resume(); res.once('end', () => resolve(res)); }).once('error', reject);
});
const waitUntil = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('State transition timed out');
};
async function fixture(profile = false) {
  process.env.PB_TEST_MODE = '1';
  const manager = new SessionManager({ isAvailable: async () => false, stopBrowser: async () => {}, getContainerId: () => null });
  await manager.startSession(undefined, profile ? { profile: { profile: { id: 'Default', name: 'Synthetic QA' }, files: [] } } : undefined);
  if (profile) manager.finishHostSetup();
  const server = new WebSocketServer(manager); server.port = 0; server.setHostIp('127.0.0.1'); await server.start(true);
  const base = `http://127.0.0.1:${server.getPort()}`;
  const token = parseInvitationCode(await manager.generateInvitation()).token;
  const code = generateInvitationCode('127.0.0.1', server.getPort(), token);
  const client = new ConnectionService(); client.on('error', () => {});
  const pending = once(client, 'approval-pending'); await client.connect(code, 'Recovery QA'); await pending;
  const approval = once(client, 'approved'); server.handleApproval(true); const [config] = await approval;
  return { manager, server, client, base, code, config, async close() {
    server.disconnectClient(); client.disconnect(); server.stop(); await manager.stopSession();
  } };
}

test('Approved control recovers repeated drops without another approval or losing its workspace credential', { timeout: 15000 }, async () => {
  const f = await fixture(true);
  try {
    let approvals = 0; f.server.on('client-connecting', () => approvals++);
    const cookie = (await get(f.config.streamUrl)).headers['set-cookie'][0].split(';')[0];
    const original = f.manager.getSessionInfo().sessionId;
    for (let i = 0; i < 3; i++) {
      const resumed = once(f.client, 'resumed');
      f.server.connectedClient.terminate();
      await waitUntil(() => f.manager.getSessionInfo().status === 'client_reconnecting');
      assert.equal((await get(f.base, { Cookie: cookie })).statusCode, 403, 'Paused connection cannot use old stream cookies');
      await resumed;
      assert.equal(f.client.getStatus(), 'approved');
      assert.equal(f.manager.getSessionInfo().sessionId, original);
      assert.equal((await get(f.base, { Cookie: cookie })).statusCode, 200);
    }
    assert.equal(approvals, 0);
    assert.equal(f.manager.getSessionInfo().profileName, 'Synthetic QA');
  } finally { await f.close(); }
});

test('Resume rejects strangers, reused invitations, simultaneous clients and expired credentials', { timeout: 15000 }, async () => {
  const f = await fixture();
  const probe = async (type, payload) => {
    const ws = new WS(f.base.replace('http:', 'ws:') + '/control'); await once(ws, 'open');
    const response = new Promise(resolve => ws.once('message', data => resolve(parseMessage(data.toString()))));
    ws.send(JSON.stringify(createMessage(type, payload))); const result = await response; ws.terminate(); return result;
  };
  try {
    assert.equal((await probe(MessageType.RESUME_REQUEST, { resumeToken: f.config.resumeToken })).payload.success, false, 'Cannot replace an active client');
    const token = f.config.resumeToken;
    f.server.connectedClient.terminate();
    await waitUntil(() => f.server.recoveryTimer);
    assert.equal((await probe(MessageType.RESUME_REQUEST, { resumeToken: '0'.repeat(64) })).payload.success, false);
    assert.equal((await probe(MessageType.RESUME_REQUEST, { resumeToken: parseInvitationCode(f.code).token })).payload.success, false);
    assert.equal((await probe(MessageType.AUTH_REQUEST, { token: parseInvitationCode(f.code).token })).payload.code, 'SESSION_BUSY');
    f.server.resume.deadline = Date.now() - 1;
    assert.equal((await probe(MessageType.RESUME_REQUEST, { resumeToken: token })).payload.success, false);
    f.server.recoveryTimer._onTimeout();
    assert.equal((await probe(MessageType.RESUME_REQUEST, { resumeToken: token })).payload.success, false);
    assert.equal((await get(f.config.streamUrl)).statusCode, 403);
  } finally { await f.close(); }
});

test('Explicit client leave during recovery immediately revokes access and removes imported profile', { timeout: 10000 }, async () => {
  const f = await fixture(true);
  try {
    f.server.connectedClient.terminate();
    await waitUntil(() => f.client.getStatus() === 'reconnecting');
    f.client.disconnect();
    await waitUntil(() => f.manager.getSessionInfo().status === 'idle');
    assert.equal(f.server.resume, null); assert.equal(f.server.streamToken, null);
    assert.equal(f.client.retryTimer, null); assert.equal(f.client.resumeToken, null);
  } finally { await f.close(); }
});

test('Host stop during recovery prevents reconnect and clears the client credential', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    f.server.connectedClient.terminate(); await waitUntil(() => f.server.recoveryTimer);
    const disconnected = once(f.client, 'error'); f.server.disconnectClient(); await disconnected;
    assert.equal(f.server.resume, null); assert.equal(f.client.resumeToken, null);
    assert.equal(f.client.getStatus(), 'error');
  } finally { await f.close(); }
});

test('Client detects a half-open socket and stops retrying at its fixed deadline', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    f.client.lastActivity = Date.now() - 46000;
    f.client.heartbeat._onTimeout();
    assert.equal(f.client.getStatus(), 'reconnecting');
    assert.ok(f.client.retryTimer);
    const disconnected = once(f.client, 'disconnected');
    f.client.recoveryDeadline = Date.now() - 1;
    await disconnected;
    assert.equal(f.client.getStatus(), 'disconnected'); assert.equal(f.client.resumeToken, null);
    assert.equal(f.client.retryTimer, null);
  } finally { await f.close(); }
});

test('Display bootstrap restricts bandwidth and frame rates to known presets', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const [preset, fps] of [['data', '18'], ['balanced', '24'], ['sharp', '30'], ['evil&host=attacker', '24']]) {
      const response = await get(f.config.streamUrl + '&display=' + encodeURIComponent(preset));
      assert.equal(response.statusCode, 302);
      const location = new URL(response.headers.location, f.base);
      assert.equal(location.origin, f.base); assert.equal(location.searchParams.get('framerate'), fps);
      assert.equal(location.searchParams.get('video_quality'), '10');
      assert.equal(location.searchParams.get('reconnect'), 'true'); assert.equal(location.searchParams.get('host'), null);
    }
  } finally { await f.close(); }
});
