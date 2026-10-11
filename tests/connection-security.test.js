const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('../host-app/node_modules/ws');

const {
  MessageType,
  createMessage,
  parseMessage,
  generateInvitationCode,
  parseInvitationCode,
  SessionStatus,
} = require('../shared/dist');

const { DockerService } = require('../host-app/dist/services/docker-service');
const { SessionManager } = require('../host-app/dist/services/session-manager');
const { WebSocketServer } = require('../host-app/dist/services/websocket-server');

const TEST_PORT = 9505;

describe('Host-Client Connection & Security Boundaries', () => {
  let dockerService;
  let sessionManager;
  let wsServer;

  before(async () => {
    process.env.PB_TEST_MODE = '1';
    dockerService = new DockerService();
    sessionManager = new SessionManager(dockerService);
    wsServer = new WebSocketServer(sessionManager);
    wsServer.port = TEST_PORT;
    wsServer.setHostIp('127.0.0.1');
    sessionManager.setHostAddress('127.0.0.1');

    await wsServer.start();
  });

  after(async () => {
    wsServer.stop();
    await sessionManager.stopSession().catch(() => {});
  });

  test('Host rejects unauthenticated client connections', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

    const result = await new Promise((resolve) => {
      ws.on('open', () => {
        // Send invalid auth token
        const authMsg = createMessage(MessageType.AUTH_REQUEST, {
          token: 'invalid-fake-token-00000000000000000000',
          clientName: 'Attacker',
          clientVersion: '1.0.0',
        });
        ws.send(JSON.stringify(authMsg));
      });

      ws.on('message', (data) => {
        const msg = parseMessage(data.toString());
        resolve(msg);
      });
    });

    assert.ok(result !== null);
    assert.strictEqual(result.type, MessageType.AUTH_RESULT);
    assert.strictEqual(result.payload.success, false);
    ws.close();
  });

  test('Protected browser stream returns 403 Forbidden without approved session', async () => {
    const res = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/stream/`, (response) => {
        resolve(response);
      });
    });

    assert.strictEqual(res.statusCode, 403);
  });

  test('Full authorization workflow: invitation -> approval -> stream access -> disconnect', async () => {
    // 1. Host starts session
    const session = await sessionManager.startSession(undefined, { allowFallback: true });
    assert.strictEqual(session.status, SessionStatus.RUNNING);

    // 2. Host generates invitation
    const invitationCode = await sessionManager.generateInvitation('127.0.0.1');
    const parsedInvite = parseInvitationCode(invitationCode);
    assert.ok(parsedInvite !== null);

    // 3. Client connects with authentic invitation token
    const clientWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

    let hostReceivedClientInfo = null;
    wsServer.once('client-connecting', (info) => {
      hostReceivedClientInfo = info;
    });

    const pendingMsg = await new Promise((resolve) => {
      clientWs.on('open', () => {
        const authMsg = createMessage(MessageType.AUTH_REQUEST, {
          token: parsedInvite.token,
          clientName: 'Authorized Remote User',
          clientVersion: '1.0.0',
        });
        clientWs.send(JSON.stringify(authMsg));
      });

      clientWs.on('message', (data) => {
        const msg = parseMessage(data.toString());
        if (msg.type === MessageType.APPROVAL_PENDING) {
          resolve(msg);
        }
      });
    });

    assert.strictEqual(pendingMsg.type, MessageType.APPROVAL_PENDING);
    assert.ok(hostReceivedClientInfo !== null);
    assert.strictEqual(hostReceivedClientInfo.clientName, 'Authorized Remote User');

    // 4. Host approves client
    const approvalPromise = new Promise((resolve) => {
      clientWs.on('message', (data) => {
        const msg = parseMessage(data.toString());
        if (msg.type === MessageType.APPROVAL_GRANTED) {
          resolve(msg);
        }
      });
    });

    wsServer.handleApproval(true);
    const approvedMsg = await approvalPromise;

    assert.strictEqual(approvedMsg.type, MessageType.APPROVAL_GRANTED);
    assert.ok(approvedMsg.payload.streamUrl.includes('/stream/'));
    assert.strictEqual(sessionManager.getSessionInfo().status, SessionStatus.CLIENT_CONNECTED);

    // 5. Approval does not authorize arbitrary network visitors.
    const streamRes = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/stream/`, (response) => {
        resolve(response);
      });
    });
    assert.strictEqual(streamRes.statusCode, 403);
    const bootstrap = await new Promise(resolve => {
      http.get(approvedMsg.payload.streamUrl, response => { response.resume(); resolve(response); });
    });
    assert.strictEqual(bootstrap.statusCode, 302);
    const cookie = bootstrap.headers['set-cookie'][0].split(';')[0];
    const authorizedRes = await new Promise(resolve => {
      http.get(`http://127.0.0.1:${TEST_PORT}/`, { headers: { Cookie: cookie } }, response => { response.resume(); resolve(response); });
    });
    assert.strictEqual(authorizedRes.statusCode, 200);
    assert.strictEqual(sessionManager.verifyToken(parsedInvite.token), false, 'Invitation is consumed after approval');

    // 6. Host disconnects client
    const disconnectPromise = new Promise((resolve) => {
      clientWs.on('message', (data) => {
        const msg = parseMessage(data.toString());
        if (msg.type === MessageType.DISCONNECT) {
          resolve(msg);
        }
      });
    });

    wsServer.disconnectClient();
    const disconnectMsg = await disconnectPromise;

    assert.strictEqual(disconnectMsg.type, MessageType.DISCONNECT);
    assert.strictEqual(sessionManager.getSessionInfo().status, SessionStatus.RUNNING);

    // 7. Verify stream endpoint is immediately cut off and blocked again (403 Forbidden)
    const postDisconnectRes = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/stream/`, (response) => {
        resolve(response);
      });
    });
    assert.strictEqual(postDisconnectRes.statusCode, 403);
    const staleCookie = await new Promise(resolve => {
      http.get(`http://127.0.0.1:${TEST_PORT}/`, { headers: { Cookie: cookie } }, response => { response.resume(); resolve(response); });
    });
    assert.strictEqual(staleCookie.statusCode, 403);

    clientWs.close();
    await sessionManager.stopSession();
    assert.strictEqual(sessionManager.getSessionInfo().status, SessionStatus.IDLE);
  });
});
