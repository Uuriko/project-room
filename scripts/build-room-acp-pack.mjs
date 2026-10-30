// Stage explicit source inputs only: local credentials, caches, tests and
// untracked files must never enter the public npx archive.
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, renameSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const roomAcpInputs = Object.freeze(['package.json', 'README.md',
  ...['agent-host', 'agents', 'args', 'bridge', 'cli', 'credentials', 'join',
    'jsonrpc', 'link', 'permission', 'prompt', 'queue', 'redact', 'render',
    'room', 'run', 'sessions'].map(name => `src/${name}.mjs`)]);

export function buildRoomAcpPack(root) {
  const out = mkdtempSync(join(tmpdir(), 'room-acp-pack-'));
  try {
    const staging = join(out, 'source');
    for (const file of roomAcpInputs) {
      const source = join(root, 'room-acp', file);
      if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error(`Not a regular ACP source: ${file}`);
      const target = join(staging, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    // npm versions differ in their JSON result shape. Inspect the artifact in
    // our private, initially empty destination instead of depending on metadata.
    execFileSync('npm', ['pack', staging, '--ignore-scripts', '--json', '--pack-destination', out], { encoding: 'utf8' });
    const archives = readdirSync(out).filter(file => file.endsWith('.tgz'));
    if (archives.length !== 1 || !lstatSync(join(out, archives[0])).isFile()) throw new Error('npm pack did not produce exactly one archive');
    const filename = archives[0];
    renameSync(join(out, filename), join(root, 'room-acp.tgz'));
    return join(root, 'room-acp.tgz');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildRoomAcpPack(resolve(fileURLToPath(new URL('..', import.meta.url))));
  console.log('Packed room-acp.tgz');
}
