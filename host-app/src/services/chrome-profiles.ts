import * as fs from 'fs/promises';
import * as path from 'path';

export interface ChromeProfile {
  id: string;
  name: string;
}

export interface ProfileSnapshot {
  profile: ChromeProfile;
  files: { name: string; data: Buffer }[];
}

// Only portable, explicitly approved data is read. Credentials never leave Windows.
export class ChromeProfiles {
  constructor(private root = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')) {}

  async list(): Promise<ChromeProfile[]> {
    let root: string, state: any;
    try {
      root = await fs.realpath(this.root);
      const filename = path.join(root, 'Local State');
      const info = await fs.stat(filename);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Chrome profile metadata is invalid or too large.');
      state = JSON.parse(await fs.readFile(filename, 'utf8'));
    } catch (error: any) {
      if (error.code === 'ENOENT') return [];
      throw new Error('Could not read Chrome profiles. Check that Chrome is installed for this Windows user.');
    }
    const profiles: ChromeProfile[] = [];
    const cache = state?.profile?.info_cache;
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return profiles;
    for (const [id, entry] of Object.entries(cache)) {
      if (!/^(Default|Profile [0-9]+)$/.test(id)) continue;
      try {
        const directory = await fs.realpath(path.join(root, id));
        if (path.dirname(directory) !== root || !(await fs.stat(directory)).isDirectory()) continue;
        const name = typeof (entry as any)?.name === 'string' ? (entry as any).name.trim().slice(0, 120) : '';
        profiles.push({ id, name: name || id });
      } catch { /* Ignore stale metadata and profiles outside the Chrome data directory. */ }
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async snapshot(id: string): Promise<ProfileSnapshot> {
    const profile = (await this.list()).find(profile => profile.id === id);
    if (!profile) throw new Error('That Chrome profile is no longer available. Refresh the profile list.');
    const root = await fs.realpath(this.root);
    const directory = await fs.realpath(path.join(root, profile.id));
    if (path.dirname(directory) !== root) throw new Error('Invalid Chrome profile location.');
    const read = async (name: string) => {
      try {
        const filename = await fs.realpath(path.join(directory, name));
        if (path.dirname(filename) !== directory) throw new Error('Invalid profile file location.');
        const handle = await fs.open(filename, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Profile file is too large.');
          return JSON.parse(await handle.readFile('utf8'));
        } finally { await handle.close(); }
      } catch (error: any) {
        if (error.code === 'ENOENT') return {};
        throw new Error(`Could not read ${name}. Close Chrome and try again.`);
      }
    };
    const bookmarks = await read('Bookmarks');
    let count = 0, nextId = 4;
    const safeUrl = (value: unknown): string | undefined => {
      if (typeof value !== 'string' || value.length > 8192) return undefined;
      try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; }
      catch { return undefined; }
    };
    const node = (value: any, depth: number): any => {
      if (!value || typeof value !== 'object' || depth > 32 || ++count > 20000) return null;
      const common = { id: String(nextId++), name: typeof value.name === 'string' ? value.name.slice(0, 1024) : '', date_added: '0' };
      if (value.type === 'url') { const url = safeUrl(value.url); return url ? { ...common, type: 'url', url } : null; }
      if (value.type === 'folder' && Array.isArray(value.children)) return { ...common, type: 'folder', children: value.children.map((child: any) => node(child, depth + 1)).filter(Boolean) };
      return null;
    };
    const roots: Record<string, any> = {};
    for (const [index, key] of ['bookmark_bar', 'other', 'synced'].entries()) {
      const original = bookmarks?.roots?.[key];
      roots[key] = { id: String(index + 1), type: 'folder', name: key === 'bookmark_bar' ? 'Bookmarks bar' : key === 'other' ? 'Other bookmarks' : 'Mobile bookmarks', date_added: '0', date_modified: '0',
        children: (Array.isArray(original?.children) ? original.children : []).map((child: any) => node(child, 0)).filter(Boolean) };
    }
    const original = await read('Preferences');
    const preferences: any = { profile: { name: profile.name, exit_type: 'Normal', exited_cleanly: true }, bookmark_bar: { show_on_all_tabs: original?.bookmark_bar?.show_on_all_tabs === true } };
    const homepage = safeUrl(original?.homepage);
    if (homepage) preferences.homepage = homepage;
    if (typeof original?.homepage_is_newtabpage === 'boolean') preferences.homepage_is_newtabpage = original.homepage_is_newtabpage;
    return { profile, files: [
      { name: '.config/google-chrome/Default/Bookmarks', data: Buffer.from(JSON.stringify({ version: 1, roots })) },
      { name: '.config/google-chrome/Default/Preferences', data: Buffer.from(JSON.stringify(preferences)) },
    ] };
  }
}
