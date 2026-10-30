// Packs room-acp/ into room-acp.tgz at the repo root so the Worker can serve
// it at /room-acp.tgz. `npx https://room.trydemigod.com/room-acp.tgz <invite>`
// then works without an npm publish. The package has no dependencies.
import { execFileSync } from 'node:child_process';
import { renameSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = mkdtempSync(join(tmpdir(), 'room-acp-pack-'));
const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', join(root, 'room-acp'), '--json', '--pack-destination', out], { encoding: 'utf8' }));
renameSync(join(out, filename), join(root, 'room-acp.tgz'));
rmSync(out, { recursive: true, force: true });
console.log('Packed room-acp.tgz');
