// demo.mjs — end-to-end walkthrough of the plugin prototype.
// Usage: node demo.mjs
// Installs + enables the greet and audit example plugins, fires hook events,
// and prints the captured plugin logs. Everything runs on fakes; no I/O.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginRegistry } from './src/registry.mjs';
import { makeBackends } from './fakes/fake-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const source = (name) => {
  const dir = join(ROOT, 'examples', name);
  return Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
};

const { files, logs, backends } = makeBackends();
const registry = new PluginRegistry(files, backends);

for (const name of ['greet', 'audit']) {
  registry.install(source(name));
  registry.enable(name);
  console.log(`enabled: ${name} (${registry.get(name).state})`);
}

console.log('\n-- room.member.joined { member: "zoe" } --');
console.log(JSON.stringify(registry.dispatch('room.member.joined', { member: 'zoe' }), null, 1));

console.log('\n-- room.message.posted x2 --');
registry.dispatch('room.message.posted', { author: 'zoe', body: 'hello everyone' });
registry.dispatch('room.message.posted', { author: 'john', body: 'welcome!' });

await new Promise((r) => setTimeout(r, 80)); // let greet's deferred timer fire

console.log('\n-- captured plugin logs --');
for (const l of logs.lines) console.log(`[${l.level}] ${l.plugin}: ${l.line}`);

console.log('\n-- disabling greet, then uninstalling audit --');
registry.disable('greet');
registry.uninstall('audit');
console.log('installed plugins:', JSON.stringify(registry.list().map((p) => `${p.name}:${p.state}`)));

console.log('\n-- registry journal --');
for (const j of registry.journal) console.log(`${j.ts} ${j.action} ${j.plugin} ${j.from ?? '-'} -> ${j.to ?? '-'}`);
