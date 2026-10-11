// Build-time only. Users receive this pinned, verified executable inside Host.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const sha = '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c';
const directory = path.resolve(__dirname, '../host-app/vendor');
const target = path.join(directory, 'cloudflared.exe');
(async () => {
  await fs.mkdir(directory, { recursive: true });
  try { if (createHash('sha256').update(await fs.readFile(target)).digest('hex') === sha) { console.log('Verified bundled internet helper.'); return; } } catch {}
  const partial = target + '.partial';
  try {
    const response = await fetch('https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe');
    if (!response.ok) throw new Error('Internet helper download failed: ' + response.status);
    await pipeline(Readable.fromWeb(response.body), require('node:fs').createWriteStream(partial));
    if (createHash('sha256').update(await fs.readFile(partial)).digest('hex') !== sha) throw new Error('Internet helper checksum mismatch');
    await fs.rename(partial, target); console.log('Bundled verified cloudflared 2026.10.0 (Windows x64).');
  } finally { await fs.rm(partial, { force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
