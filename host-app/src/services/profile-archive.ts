import { ProfileSnapshot } from './chrome-profiles';

// A small ustar writer with fixed allowlisted paths; no filesystem staging copies.
export function profileArchive(snapshot: ProfileSnapshot): Buffer {
  const chunks: Buffer[] = [];
  for (const file of snapshot.files) {
    if (!['.config/google-chrome/Default/Bookmarks', '.config/google-chrome/Default/Preferences'].includes(file.name)) throw new Error('Invalid profile archive entry.');
    const header = Buffer.alloc(512);
    const octal = (value: number, offset: number, size: number) => header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size, 'ascii');
    header.write(file.name, 0, 100, 'utf8');
    octal(0o600, 100, 8); octal(1000, 108, 8); octal(1000, 116, 8);
    octal(file.data.length, 124, 12); octal(Math.floor(Date.now() / 1000), 136, 12);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, file.data, Buffer.alloc((512 - file.data.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
