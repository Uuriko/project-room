// tests/helpers.mjs — shared test scaffolding.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginRegistry } from '../src/registry.mjs';
import { makeBackends } from '../fakes/fake-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read an example plugin dir into an installable source tree. */
export function exampleSource(name) {
  const dir = join(ROOT, 'examples', name);
  const tree = {};
  for (const f of readdirSync(dir)) {
    tree[f] = readFileSync(join(dir, f), 'utf8');
  }
  return tree;
}

/** Fresh registry wired to fakes; returns { registry, files, store, logs }. */
export function freshRegistry(overrides = {}) {
  const { files, store, logs, backends } = makeBackends(overrides);
  const registry = new PluginRegistry(files, backends);
  return { registry, files, store, logs };
}

/** Install + enable an example plugin; returns manifest. */
export function installEnable(registry, name) {
  registry.install(exampleSource(name));
  return registry.enable(name);
}
