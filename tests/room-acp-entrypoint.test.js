import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../room-acp', import.meta.url));
function fixture(t, name = 'package') {
  const root = mkdtempSync(join(tmpdir(), 'room-acp-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, name);
  cpSync(source, directory, { recursive: true });
  return { root, directory, cli: join(directory, 'src', 'cli.mjs') };
}
function invoke(path, cwd) {
  const result = spawnSync(process.execPath, [path, '--help'], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:\n  room-acp /);
  assert.match(result.stdout, /--credential-file/);
  return result.stdout;
}

test('ACP direct CLI runs from absolute and relative paths', t => {
  const f = fixture(t);
  assert.equal(invoke(f.cli, f.root), invoke(relative(f.root, f.cli), f.root));
});

test('ACP direct CLI runs from space and URL-escaped filesystem paths', t => {
  const f = fixture(t, 'room acp # percent % check');
  invoke(f.cli, f.root);
});

test('ACP direct CLI runs through directory aliases and npm-style bin symlinks', t => {
  const f = fixture(t);
  const alias = join(f.root, 'directory alias');
  symlinkSync(f.directory, alias, 'junction');
  invoke(join(alias, 'src', 'cli.mjs'), f.root);
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const linkedBin = join(bin, 'room-acp');
  symlinkSync(f.cli, linkedBin, 'file');
  invoke(linkedBin, f.root);
});

test('importing ACP CLI stays side-effect free even from another program named room-acp', t => {
  const f = fixture(t, 'room acp # percent % check');
  const importer = join(f.root, 'room-acp');
  writeFileSync(importer, `import(${JSON.stringify(pathToFileURL(f.cli).href)}).then(() => console.log('imported'));\n`);
  const result = spawnSync(process.execPath, [importer, '--help'], { cwd: f.root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'imported\n');
});
