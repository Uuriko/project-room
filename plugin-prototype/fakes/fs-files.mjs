// fs-files.mjs — production-shaped local-filesystem adapter for the registry's
// `files` interface. Demo/local use only: a real host would add signing,
// quarantine, and size quotas around install. Not used by tests (they use
// FakeFiles) so the suite stays hermetic.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class FsPluginFiles {
  constructor(rootDir) {
    this.root = rootDir;
  }
  #resolve(path) {
    const full = join(this.root, path);
    if (!full.startsWith(this.root)) throw new Error(`path escapes plugin root: ${path}`);
    return full;
  }
  writeFile(path, content) {
    const full = this.#resolve(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  readFile(path) {
    return readFileSync(this.#resolve(path), 'utf8');
  }
  removeDir(dir) {
    rmSync(this.#resolve(dir), { recursive: true, force: true });
  }
  listFiles(dir) {
    const full = this.#resolve(dir);
    if (!existsSync(full)) return [];
    const out = [];
    const walk = (d, rel) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, rel + e + '/');
        else out.push(rel + e);
      }
    };
    walk(full, dir.endsWith('/') ? dir : dir + '/');
    return out;
  }
}
