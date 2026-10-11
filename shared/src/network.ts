import * as os from 'os';

export function getBestHostIP(tailscaleIP?: string | null): string {
  if (tailscaleIP && tailscaleIP.trim() !== '') {
    return tailscaleIP.trim();
  }

  const interfaces = os.networkInterfaces();

  // 1. Look for Tailscale interface / 100.x.y.z IP
  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('100.')) {
        return iface.address;
      }
    }
  }

  // 2. Look for LAN IPv4 (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    if (!list) continue;
    for (const iface of list) {
      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        !iface.address.startsWith('169.254.') &&
        !iface.address.startsWith('127.')
      ) {
        return iface.address;
      }
    }
  }

  // 3. Fallback to loopback
  return '127.0.0.1';
}
