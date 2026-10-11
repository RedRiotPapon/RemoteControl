const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { FileTransfer, localDownloadName } = require('../client-app/dist/services/file-transfer');
const { SessionManager } = require('../host-app/dist/services/session-manager');
const { WebSocketServer } = require('../host-app/dist/services/websocket-server');
const { WebSocket } = require('../host-app/node_modules/ws');
const { parseInvitationCode, createMessage, MessageType } = require('../shared/dist');

test('Native file transfer preserves binary content and Unicode names, and sanitizes local download names', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-files-'));
  const content = Buffer.from(Array.from({ length: 512 * 1024 }, (_, index) => index % 256));
  const name = 'client café বাংলা.bin', saved = path.join(directory, 'saved.bin');
  const source = path.join(directory, name); await fs.writeFile(source, content);
  let uploaded, uploadName;
  const backend = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(64));
    const url = new URL(req.url, 'http://test');
    if (req.method === 'PUT') {
      const blocks = []; for await (const block of req) blocks.push(block);
      uploaded = Buffer.concat(blocks); uploadName = url.searchParams.get('name');
      res.end(JSON.stringify({ name: uploadName, size: uploaded.length }));
    } else if (url.pathname.endsWith('/downloads')) res.end(JSON.stringify({ files: [{ name, size: content.length, modified: 0 }] }));
    else { res.writeHead(200, { 'Content-Length': content.length }); res.end(content); }
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const progress = [], client = new FileTransfer(value => progress.push(value));
  try {
    client.approve(`http://127.0.0.1:${backend.address().port}/stream/?access=${'a'.repeat(64)}`);
    assert.equal((await client.upload(source)).name, name);
    assert.deepEqual(uploaded, content); assert.equal(uploadName, name);
    assert.equal((await client.list())[0].name, name);
    await client.download(name, saved); assert.deepEqual(await fs.readFile(saved), content);
    assert.ok(progress.some(value => value.direction === 'upload' && value.transferred === content.length));
    assert.ok(progress.some(value => value.direction === 'download' && value.transferred === content.length));
    const generation = client.getGeneration(); client.clear();
    assert.throws(() => client.assertConnected(generation), /Connect/);
    await assert.rejects(client.list(), /Connect/);
    assert.equal(localDownloadName('../../CON.txt'), 'download-CON.txt');
    assert.equal(localDownloadName('folder\\bad:name?.txt'), 'bad_name_.txt');
  } finally { client.clear(); backend.closeAllConnections(); backend.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Interrupted download preserves the existing local file and removes partial files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-files-'));
  const destination = path.join(directory, 'existing.txt'); await fs.writeFile(destination, 'keep this');
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': 1000000 }); res.write(Buffer.alloc(4096));
    setTimeout(() => res.destroy(), 30);
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const client = new FileTransfer();
  try {
    client.approve(`http://127.0.0.1:${backend.address().port}/stream/?access=${'a'.repeat(64)}`);
    await assert.rejects(client.download('file.txt', destination));
    assert.equal(await fs.readFile(destination, 'utf8'), 'keep this');
    assert.deepEqual(await fs.readdir(directory), ['existing.txt']);
  } finally { client.clear(); backend.closeAllConnections(); backend.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Cancel stops an active native download and cleans its partial destination', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-files-'));
  const destination = path.join(directory, 'cancelled.bin');
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': 1000000 }); res.write(Buffer.alloc(4096));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const client = new FileTransfer(() => client.cancel());
  try {
    client.approve(`http://127.0.0.1:${backend.address().port}/stream/?access=${'a'.repeat(64)}`);
    await assert.rejects(client.download('file.bin', destination));
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { client.clear(); backend.closeAllConnections(); backend.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('File API requires current approval, rejects cookies/foreign origins and oversized uploads, and revokes transfers', async () => {
  process.env.PB_TEST_MODE = '1';
  const backend = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-agent-token');
    if (req.url === '/download?name=slow') {
      res.writeHead(200, { 'Content-Length': 1000000 }); res.write(Buffer.alloc(4096));
    } else res.end(JSON.stringify({ files: [] }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const manager = new SessionManager({ isAvailable: async () => false, stopBrowser: async () => {}, getContainerId: () => null,
    getFileEndpoint: () => ({ port: backend.address().port, token: 'private-agent-token' }) });
  const server = new WebSocketServer(manager); server.port = 0; server.setHostIp('127.0.0.1');
  const call = (base, route, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const request = http.request(base + '/api/files/' + route, { headers, method }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); request.on('error', reject); request.end();
  });
  let control;
  try {
    await manager.startSession(); await server.start();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    assert.equal(await call(base, 'downloads'), 403);
    const invite = parseInvitationCode(await manager.generateInvitation('127.0.0.1'));
    control = new WebSocket(base.replace('http:', 'ws:') + '/control'); await once(control, 'open');
    const pending = once(control, 'message');
    control.send(JSON.stringify(createMessage(MessageType.AUTH_REQUEST, { token: invite.token, clientName: 'Files' })));
    await pending; const approved = once(control, 'message'); server.handleApproval(true);
    const access = new URL(JSON.parse((await approved)[0].toString()).payload.streamUrl).searchParams.get('access');
    const headers = { Authorization: 'Bearer ' + access };
    assert.equal(await call(base, 'downloads', { Cookie: 'pb_stream=' + access }), 403);
    assert.equal(await call(base, 'downloads', { ...headers, Origin: 'http://evil.example' }), 403);
    assert.equal(await call(base, 'downloads', headers), 200);
    assert.equal(await call(base, 'upload?name=a', { ...headers, 'Content-Length': 1073741825 }, 'PUT'), 413);
    const revoked = new Promise((resolve, reject) => {
      http.get(base + '/api/files/download?name=slow', { headers }, response => {
        response.on('error', () => resolve()); response.resume();
        response.on('data', () => server.disconnectClient());
        response.on('end', () => reject(new Error('Revoked transfer completed')));
      }).on('error', resolve);
    });
    await revoked;
    assert.equal(await call(base, 'downloads', headers), 403);
  } finally { control?.terminate(); server.stop(); await manager.stopSession(); backend.closeAllConnections(); backend.close(); }
});
