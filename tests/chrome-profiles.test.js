const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ChromeProfiles } = require('../host-app/dist/services/chrome-profiles');

test('Chrome profile catalog returns display names and ignores missing/invalid profile entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-profile-'));
  try {
    await fs.mkdir(path.join(root, 'Default')); await fs.mkdir(path.join(root, 'Profile 2'));
    await fs.writeFile(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: {
      Default: { name: 'Personal' }, 'Profile 2': { name: 'Work' }, 'Profile 3': { name: 'Deleted profile' },
      '../outside': { name: 'Invalid path' }, 'System Profile': { name: 'Internal' },
    } } }));
    assert.deepEqual(await new ChromeProfiles(root).list(), [{ id: 'Default', name: 'Personal' }, { id: 'Profile 2', name: 'Work' }]);
    assert.deepEqual(await new ChromeProfiles(path.join(root, 'missing')).list(), []);
    await fs.writeFile(path.join(root, 'Local State'), 'invalid');
    await assert.rejects(new ChromeProfiles(root).list(), /Could not read Chrome profiles/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Profile snapshot excludes credentials, history, unsafe URLs and preference secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-snapshot-'));
  try {
    const directory = path.join(root, 'Default'); await fs.mkdir(directory);
    await fs.writeFile(path.join(root, 'Local State'), JSON.stringify({ os_crypt: { secret: 'private-key' }, profile: { info_cache: { Default: { name: 'Approved profile' } } } }));
    await fs.writeFile(path.join(directory, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [
      { type: 'url', name: 'Safe bookmark', url: 'https://example.com/' },
      { type: 'url', name: 'Host file', url: 'file:///C:/private.txt' },
      { type: 'url', name: 'Script', url: 'javascript:alert(1)' },
      { type: 'folder', name: 'Folder', children: [{ type: 'url', name: 'Nested', url: 'https://example.org/' }] },
    ] } } }));
    await fs.writeFile(path.join(directory, 'Preferences'), JSON.stringify({ homepage: 'https://example.com/', homepage_is_newtabpage: false,
      bookmark_bar: { show_on_all_tabs: true }, password_manager: { secret: 'private-password' }, signin: { account: 'private-account' }, extensions: { secret: 'private-extension' } }));
    for (const filename of ['Cookies', 'Login Data', 'History']) await fs.writeFile(path.join(directory, filename), 'private-secret');
    const catalog = new ChromeProfiles(root); const snapshot = await catalog.snapshot('Default');
    assert.equal(snapshot.files.length, 2);
    const data = snapshot.files.map(file => file.data.toString()).join('');
    assert.doesNotMatch(data, /private-|file:|javascript:|password_manager|extensions|signin/);
    assert.match(data, /Safe bookmark/); assert.match(data, /Nested/);
    assert.equal(JSON.parse(snapshot.files[1].data).bookmark_bar.show_on_all_tabs, true);
    await assert.rejects(catalog.snapshot('../outside'), /no longer available/);
    const { profileArchive } = require('../host-app/dist/services/profile-archive');
    assert.equal(profileArchive(snapshot).length % 512, 0);
    assert.throws(() => profileArchive({ files: [{ name: '../outside', data: Buffer.alloc(0) }] }), /Invalid/);
    assert.equal(await fs.readFile(path.join(directory, 'Cookies'), 'utf8'), 'private-secret');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
