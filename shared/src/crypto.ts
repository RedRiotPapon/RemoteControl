import * as crypto from 'crypto';

const TOKEN_LENGTH = 32;
const HMAC_ALGORITHM = 'sha256';

export function generateSessionToken(): string {
  return crypto.randomBytes(TOKEN_LENGTH).toString('hex');
}

export function generateSessionId(): string {
  return `pb-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export function hashToken(token: string, secret: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, secret).update(token).digest('hex');
}

export function verifyToken(token: string, hashedToken: string, secret: string): boolean {
  const computed = hashToken(token, secret);
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hashedToken, 'hex'));
}

export function generateInvitationCode(hostAddress: string, port: number, token: string, expiresInMinutes: number = 60, secure = false): string {
  const data = {
    h: hostAddress,
    p: port,
    t: token,
    e: new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
    ...(secure ? { v: 2, s: 'https' } : {}),
  };
  return (secure ? 'PB2-' : '') + Buffer.from(JSON.stringify(data)).toString('base64url');
}

export function parseInvitationCode(code: string): { hostAddress: string; port: number; token: string; expiresAt: string; secure: boolean } | null {
  try {
    if (typeof code !== 'string' || code.length > 4096) return null;
    const secure = code.startsWith('PB2-');
    const encoded = secure ? code.slice(4) : code;
    if (!/^[a-zA-Z0-9_-]+$/.test(encoded)) return null;
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    if (secure ? data.v !== 2 || data.s !== 'https' : data.v !== undefined || data.s !== undefined) return null;
    if (typeof data.h !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(data.h) || data.h.length > 253 ||
        !Number.isInteger(data.p) || data.p < 1 || data.p > 65535 ||
        typeof data.t !== 'string' || !/^[a-f0-9]{64}$/.test(data.t) ||
        typeof data.e !== 'string' || !Number.isFinite(Date.parse(data.e))) return null;
    return {
      hostAddress: data.h,
      port: data.p,
      token: data.t,
      expiresAt: data.e,
      secure,
    };
  } catch {
    return null;
  }
}

export function isInvitationExpired(expiresAt: string): boolean {
  const time = Date.parse(expiresAt);
  return !Number.isFinite(time) || time <= Date.now();
}

export function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
