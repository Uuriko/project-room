import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repository = fileURLToPath(new URL('..', import.meta.url));
const builder = new URL('../scripts/build-room-acp-pack.mjs', import.meta.url).href;
const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;
// An empty tar fixture is sufficient here: the real npm packaging test checks
// source contents. These tests isolate npm metadata compatibility and failures.
const archiveBytes = gzipSync(Buffer.alloc(1024));

function fixture(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'room-acp-npm-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'), bin = join(directory, 'bin');
  mkdirSync(root); mkdirSync(bin);
  cpSync(join(repository, 'room-acp'), join(root, 'room-acp'), { recursive: true });
  const destination = join(root, 'room-acp.tgz');
  const previous = Buffer.from('previous successfully built archive');
  writeFileSync(destination, previous);
  const record = join(directory, 'pack-destination.txt');
  const fake = join(bin, 'npm.mjs');
  writeFileSync(fake, `
import { writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] !== 'pack' || !args.includes('--ignore-scripts')) process.exit(2);
const out = args[args.indexOf('--pack-destination') + 1];
writeFileSync(${JSON.stringify(record)}, out);
const mode = ${JSON.stringify(mode)};
const bytes = Buffer.from(${JSON.stringify(archiveBytes.toString('base64'))}, 'base64');
if (mode === 'single' || mode === 'multiple') writeFileSync(join(out, 'actual-artifact.tgz'), bytes);
if (mode === 'multiple') writeFileSync(join(out, 'second-artifact.tgz'), bytes);
if (mode === 'symlink') symlinkSync(${JSON.stringify(destination)}, join(out, 'linked-artifact.tgz'));
// npm 12 uses keyed metadata. Deliberately do not identify the actual artifact:
// output inspection, not JSON parsing or its filename field, is the contract.
console.log(JSON.stringify({ 'room-acp@0.0.0': { filename: 'metadata-only.tgz' } }));
`);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(fake)} "$@"\n`, { mode: 0o755 });
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { buildRoomAcpPack } from ${JSON.stringify(builder)}; buildRoomAcpPack(${JSON.stringify(root)});`], {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }, encoding: 'utf8',
  });
  return { run, destination, previous, record };
}

test('ACP pack accepts npm keyed metadata and publishes the sole regular archive', t => {
  const f = fixture(t, 'single');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(f.destination), archiveBytes);
  assert.equal(existsSync(readFileSync(f.record, 'utf8')), false, 'private staging is removed after success');
});

for (const mode of ['missing', 'multiple', 'symlink']) {
  test(`ACP pack refuses ${mode} archives and preserves the last successful artifact`, t => {
    const f = fixture(t, mode);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm pack did not produce exactly one archive/);
    assert.deepEqual(readFileSync(f.destination), f.previous);
    assert.equal(existsSync(readFileSync(f.record, 'utf8')), false, 'private staging is removed after failure');
  });
}
