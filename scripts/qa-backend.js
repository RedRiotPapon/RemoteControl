const https = require('https');
const http = require('http');
const { once } = require('events');
const WS = require('../host-app/node_modules/ws');
const { DockerService } = require('../host-app/dist/services/docker-service');
const { SessionManager } = require('../host-app/dist/services/session-manager');
const { WebSocketServer } = require('../host-app/dist/services/websocket-server');
const { createMessage, parseMessage, parseInvitationCode, MessageType } = require('../shared/dist');
const get = (module, url, options) => new Promise((resolve, reject) => {
  module.get(url, options, response => { let body = ''; response.on('data', c => body += c); response.on('end', () => resolve({ code: response.statusCode, headers: response.headers, body })); }).on('error', reject);
});
(async () => {
  delete process.env.PB_TEST_MODE;
  const manager = new SessionManager(new DockerService());
  const server = new WebSocketServer(manager); server.port = 0; server.setHostIp('127.0.0.1');
  server.on('server-error', error => console.log('Proxy error:', error));
  let control;
  try {
    await manager.startSession({ browserWidth: 1280, browserHeight: 720 }); await server.start();
    server.port = server.httpServer.address().port;
    for (const [label, password] of [['full', manager.getVNCPassword()], ['8 chars', manager.getVNCPassword().slice(0, 8)]]) {
      const result = await get(https, `https://127.0.0.1:${manager.getVNCPort()}/`, { auth: `kasm_user:${password}`, rejectUnauthorized: false });
      console.log('Backend', label, result.code, result.body.length);
    }
    const invite = parseInvitationCode(await manager.generateInvitation());
    control = new WS(`ws://127.0.0.1:${server.port}/control`); await once(control, 'open');
    const pending = once(control, 'message'); control.send(JSON.stringify(createMessage(MessageType.AUTH_REQUEST, { token: invite.token, clientName: 'Backend QA' }))); await pending;
    const approved = once(control, 'message'); server.handleApproval(true);
    const payload = parseMessage((await approved)[0].toString()).payload;
    const bootstrap = await get(http, payload.streamUrl);
    const cookie = bootstrap.headers['set-cookie'][0].split(';')[0];
    const result = await get(http, `http://127.0.0.1:${server.port}/`, { headers: { Cookie: cookie } });
    console.log('Proxy', result.code, result.body.length, result.body.slice(0, 150));
    if (result.code !== 200) throw new Error('Real proxy did not authenticate');
    const stream = new WS(`ws://127.0.0.1:${server.port}/websockify`, 'binary', { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}` } });
    const greeting = await once(stream, 'message'); console.log('VNC handshake:', greeting[0].toString().trim()); stream.terminate();
  } finally { control?.terminate(); server.stop(); await manager.stopSession(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
