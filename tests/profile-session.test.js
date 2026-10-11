const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WS = require('../host-app/node_modules/ws');
const { SessionManager } = require('../host-app/dist/services/session-manager');
const { WebSocketServer } = require('../host-app/dist/services/websocket-server');
const { createMessage, parseMessage, parseInvitationCode, MessageType } = require('../shared/dist');
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, response => { response.resume(); response.on('end', () => resolve(response)); }).on('error', reject);
});

test('An unresponsive approved connection revokes access and ends its imported-profile session', { timeout: 10000 }, async () => {
  process.env.PB_TEST_MODE = '1';
  const manager = new SessionManager({ isAvailable: async () => false, stopBrowser: async () => {}, getContainerId: () => null });
  const server = new WebSocketServer(manager); server.port = 0;
  let client;
  try {
    await manager.startSession(undefined, { profile: { profile: { id: 'Default', name: 'Fixture' }, files: [] } });
    manager.finishHostSetup(); await server.start();
    const token = parseInvitationCode(await manager.generateInvitation()).token;
    client = new WS(`ws://127.0.0.1:${server.httpServer.address().port}/control`);
    await once(client, 'open');
    const pending = once(server, 'client-connecting');
    client.send(JSON.stringify(createMessage(MessageType.AUTH_REQUEST, { token, clientName: 'Test' }))); await pending;
    const approved = new Promise(resolve => client.on('message', data => { if (parseMessage(data.toString())?.type === MessageType.APPROVAL_GRANTED) resolve(); }));
    server.handleApproval(true); await approved;
    const idle = new Promise(resolve => manager.on('session-update', info => { if (info.status === 'idle') resolve(); }));
    // Advance the heartbeat deadline without delaying the suite for a minute.
    server.lastClientPong = Date.now() - 60000;
    server.heartbeatInterval._onTimeout(); await idle;
    assert.equal(server.streamToken, null); assert.equal(server.connectedClient, null);
    assert.equal(manager.getSessionInfo().profileName, undefined);
  } finally { client?.terminate(); server.stop(); await manager.stopSession(); }
});

test('Private setup stays on loopback, cannot authorize public stream, and gates invitations', { timeout: 15000 }, async () => {
  process.env.PB_TEST_MODE = '1';
  let removals = 0;
  const manager = new SessionManager({ isAvailable: async () => false, stopBrowser: async () => { removals++; }, getContainerId: () => null });
  const server = new WebSocketServer(manager); server.port = 0;
  let backend, socket;
  try {
    await manager.startSession(undefined, { profile: { profile: { id: 'Default', name: 'Fixture' }, files: [] } });
    assert.equal(manager.getSessionInfo().hostSetupRequired, true);
    await assert.rejects(manager.generateInvitation(), /Finish private/);
    await server.start(); const publicBase = `http://127.0.0.1:${server.httpServer.address().port}`;
    const privateUrl = await server.openHostSetup(); const privateBase = new URL(privateUrl).origin;
    assert.equal(server.hostSetupServer.address().address, '127.0.0.1');
    assert.equal((await get(privateBase)).statusCode, 403);
    const bootstrap = await get(privateUrl); assert.equal(bootstrap.statusCode, 302);
    const cookie = bootstrap.headers['set-cookie'][0].split(';')[0];
    assert.equal((await get(privateBase, { Cookie: cookie })).statusCode, 200);
    assert.equal((await get(publicBase, { Cookie: cookie })).statusCode, 403);
    assert.equal((await get(publicBase + new URL(privateUrl).pathname + new URL(privateUrl).search)).statusCode, 403);
    backend = new WS.WebSocketServer({ server: manager.mockServer });
    backend.on('connection', ws => ws.on('message', value => ws.send(value)));
    socket = new WS(privateBase.replace('http:', 'ws:') + '/websockify', { headers: { Cookie: cookie, Origin: privateBase } });
    await once(socket, 'open'); const echo = once(socket, 'message'); socket.send('private-frame');
    assert.equal((await echo)[0].toString(), 'private-frame');
    const closed = once(socket, 'close'); server.closeHostSetup(); await closed;
    manager.finishHostSetup(); assert.ok(await manager.generateInvitation('127.0.0.1'));
    manager.beginHostSetup(); assert.equal(manager.getCurrentToken(), null);
    await assert.rejects(manager.generateInvitation(), /Finish private/);
    manager.finishHostSetup(); manager.setClientConnected(true);
    const ended = new Promise(resolve => manager.on('session-update', info => { if (info.status === 'idle') resolve(); }));
    manager.setClientConnected(false); await ended;
    assert.equal(manager.getSessionInfo().profileName, undefined); assert.equal(removals, 1);
  } finally { socket?.terminate(); backend?.close(); server.stop(); await manager.stopSession(); }
});
