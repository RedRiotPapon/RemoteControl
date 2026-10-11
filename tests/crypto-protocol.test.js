const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  generateSessionToken,
  generateSessionId,
  hashToken,
  verifyToken,
  generateInvitationCode,
  parseInvitationCode,
  isInvitationExpired,
  generateSecret,
  createMessage,
  parseMessage,
  MessageType,
  getBestHostIP,
} = require('../shared/dist');

describe('Cryptographic Token & Invitation Security', () => {
  test('generateSessionToken produces 64-char hex strings with high entropy', () => {
    const token1 = generateSessionToken();
    const token2 = generateSessionToken();
    assert.strictEqual(typeof token1, 'string');
    assert.strictEqual(token1.length, 64);
    assert.notStrictEqual(token1, token2);
  });

  test('generateSessionId produces unique prefixed session IDs', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    assert.ok(id1.startsWith('pb-'));
    assert.notStrictEqual(id1, id2);
  });

  test('verifyToken verifies authentic tokens with timingSafeEqual', () => {
    const secret = generateSecret();
    const token = generateSessionToken();
    const hashed = hashToken(token, secret);

    assert.strictEqual(verifyToken(token, hashed, secret), true);
  });

  test('verifyToken rejects tampered or forged tokens', () => {
    const secret = generateSecret();
    const token = generateSessionToken();
    const forgedToken = generateSessionToken();
    const hashed = hashToken(token, secret);

    assert.strictEqual(verifyToken(forgedToken, hashed, secret), false);
  });

  test('Invitation code encodes and decodes hostAddress, port, token, expiresAt', () => {
    const token = generateSessionToken();
    const code = generateInvitationCode('100.85.20.10', 9500, token, 60);

    assert.strictEqual(typeof code, 'string');
    const parsed = parseInvitationCode(code);

    assert.ok(parsed !== null);
    assert.strictEqual(parsed.hostAddress, '100.85.20.10');
    assert.strictEqual(parsed.port, 9500);
    assert.strictEqual(parsed.token, token);
    assert.strictEqual(isInvitationExpired(parsed.expiresAt), false);
  });

  test('isInvitationExpired detects expired timestamps', () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    const futureTime = new Date(Date.now() + 60000).toISOString();

    assert.strictEqual(isInvitationExpired(pastTime), true);
    assert.strictEqual(isInvitationExpired(futureTime), false);
  });

  test('parseInvitationCode rejects invalid base64 or non-JSON payloads', () => {
    assert.strictEqual(parseInvitationCode('invalid-base64-garbage!!'), null);
    assert.strictEqual(parseInvitationCode(Buffer.from('not json').toString('base64url')), null);
    assert.strictEqual(parseInvitationCode(Buffer.from('{"missing":"keys"}').toString('base64url')), null);
  });
});

describe('Protocol Message Serialization', () => {
  test('createMessage creates valid envelope with timestamp and messageId', () => {
    const msg = createMessage(MessageType.AUTH_REQUEST, { token: 'abc' });
    assert.strictEqual(msg.type, MessageType.AUTH_REQUEST);
    assert.deepStrictEqual(msg.payload, { token: 'abc' });
    assert.ok(msg.timestamp > 0);
    assert.ok(msg.messageId.startsWith('auth_request-'));
  });

  test('parseMessage deserializes valid JSON and rejects malformed strings', () => {
    const raw = JSON.stringify(createMessage(MessageType.HEARTBEAT, { time: 123 }));
    const parsed = parseMessage(raw);

    assert.ok(parsed !== null);
    assert.strictEqual(parsed.type, MessageType.HEARTBEAT);

    assert.strictEqual(parseMessage('not json'), null);
    assert.strictEqual(parseMessage('{}'), null);
  });
});

describe('Network IP Resolution', () => {
  test('getBestHostIP resolves to a valid IPv4 address', () => {
    const ip = getBestHostIP();
    assert.strictEqual(typeof ip, 'string');
    assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });
});
