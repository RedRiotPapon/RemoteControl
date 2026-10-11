const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { generateInvitationCode, parseInvitationCode, generateSessionToken, createMessage, MessageType } = require('../shared/dist');
const { FileTransfer } = require('../client-app/dist/services/file-transfer');
const { ConnectionService } = require('../client-app/dist/services/connection-service');
const { WebSocketServer } = require('../host-app/node_modules/ws');
const { InternetTunnel } = require('../host-app/dist/services/internet-tunnel');

test('Missing or modified bundled helpers fail before execution', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-helper-test-'));
  const binary = path.join(directory, 'helper.exe');
  const tunnel = new InternetTunnel(binary);
  try {
    await assert.rejects(tunnel.start(9500, 'proof'), /helper is missing/);
    await fs.writeFile(binary, 'modified executable');
    await assert.rejects(tunnel.start(9500, 'proof'), /failed verification/);
    assert.equal(tunnel.getOrigin(), null);
  } finally { await tunnel.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('PB2 invitations require secure version markers and cannot downgrade to legacy transport', () => {
  const token = generateSessionToken();
  const code = generateInvitationCode('example.trycloudflare.com', 443, token, 60, true);
  assert.ok(code.startsWith('PB2-'));
  assert.equal(parseInvitationCode(code).secure, true);
  assert.equal(parseInvitationCode(code.slice(4)), null);
  const legacy = generateInvitationCode('127.0.0.1', 9500, token);
  assert.equal(parseInvitationCode(legacy).secure, false);
  assert.equal(parseInvitationCode('PB2-' + legacy), null);
});

test('Client rejects a workspace origin different from its invitation', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', ws => ws.once('message', () => ws.send(JSON.stringify(createMessage(MessageType.APPROVAL_GRANTED,
    { streamUrl: 'http://evil.example/stream/?access=' + 'a'.repeat(64) })))));
  const client = new ConnectionService();
  try {
    const rejected = new Promise(resolve => client.once('error', resolve));
    await client.connect(generateInvitationCode('127.0.0.1', server.address().port, generateSessionToken()), 'QA');
    assert.match(await rejected, /invalid workspace address/);
    assert.equal(client.getStatus(), 'error');
  } finally { client.disconnect(); for (const ws of server.clients) ws.terminate(); server.close(); }
});

test('Internet uploads use bounded ordered parts and cancellation cannot start another part', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-chunk-test-'));
  const source = path.join(directory, 'test.bin'), content = Buffer.alloc(9 * 1024 * 1024, 123);
  await fs.writeFile(source, content);
  let parts = [], started = 0, finished = 0, cancelled = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(64));
    if (url.pathname.endsWith('upload-start')) { started++; res.end(JSON.stringify({ id: 'b'.repeat(32) })); }
    else if (url.pathname.endsWith('upload-part')) {
      const blocks = []; for await (const block of req) blocks.push(block);
      const data = Buffer.concat(blocks); assert.ok(data.length <= 4 * 1024 * 1024);
      assert.equal(Number(url.searchParams.get('offset')), parts.reduce((size, part) => size + part.length, 0));
      parts.push(data); res.end('{}');
    } else if (url.pathname.endsWith('upload-finish')) { finished++; res.end(JSON.stringify({ name: 'test.bin', size: content.length })); }
    else { cancelled++; req.resume(); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // Unit seam only: exercise the HTTPS branch against a local fixture. The live
  // internet integration separately verifies CA-validated HTTPS and WSS.
  const original = https.request;
  https.request = (url, options, callback) => { assert.equal(url.protocol, 'https:'); url.protocol = 'http:'; return http.request(url, options, callback); };
  const client = new FileTransfer();
  try {
    client.approve(`https://127.0.0.1:${server.address().port}/stream/?access=${'a'.repeat(64)}`);
    assert.equal((await client.upload(source)).size, content.length);
    assert.deepEqual(Buffer.concat(parts), content); assert.equal(parts.length, 3); assert.equal(finished, 1);
    parts = [];
    client.progress = value => { if (value.transferred >= 4 * 1024 * 1024) client.cancel(); };
    await assert.rejects(client.upload(source), /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(started, 2); assert.equal(finished, 1); assert.ok(parts.length <= 1); assert.equal(cancelled, 1);
  } finally {
    https.request = original; client.clear(); server.closeAllConnections(); server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
