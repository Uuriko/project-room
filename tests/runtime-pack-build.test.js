import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildRoomAcpPack, roomAcpInputs } from '../scripts/build-room-acp-pack.mjs';
import { buildCandidateManifest } from '../scripts/candidate-manifest.mjs';
import { verifyRuntimeImports } from '../scripts/runtime-package.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));

test('public ACP archive contains only declared source inputs, regardless of local extra files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-public-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'room-acp'), join(dir, 'room-acp'), { recursive: true });
  mkdirSync(join(dir, 'room-acp', '__pycache__'));
  writeFileSync(join(dir, 'room-acp', '__pycache__', 'private.pyc'), 'do not ship');
  writeFileSync(join(dir, 'room-acp', 'credentials.json'), 'do not ship');
  const archive = buildRoomAcpPack(dir);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(entries, roomAcpInputs.map(path => `package/${path}`).sort());
  const first = readFileSync(archive);
  buildRoomAcpPack(dir);
  assert.deepEqual(readFileSync(archive), first, 'same source produces identical bytes');
  const manifest = buildCandidateManifest(root);
  assert.equal(manifest.assets['room-acp.tgz'], undefined);
  for (const input of roomAcpInputs) assert.match(manifest.assets[`room-acp/${input}`], /^sha256:/);
  assert.match(manifest.assets['scripts/build-room-acp-pack.mjs'], /^sha256:/);
});

test('literal module closure detects whitespace, dollar and escaped paths in static and dynamic imports', () => {
  for (const source of [
    'import "./missing part.mjs";', 'import { x } from "./missing$part.mjs";',
    'export { x } from "./missing part.mjs";', 'await import("./missing$part.mjs");',
    'import "./missing\\x20part.mjs";', 'const text = `result ${await import("./missing part.mjs")}`;',
    'import /* annotation */ "./missing part.mjs";',
  ]) assert.throws(() => verifyRuntimeImports(new Map([['entry.mjs', Buffer.from(source)]])), /which is not in the allowlisted runtime/);
});

test('module scanner ignores prose, properties, regular expressions and template text', () => {
  const source = [
    '// from "nowhere"; import "./comment.mjs";', '/* import("./comment.mjs") */',
    'const text = `from "nowhere" and import "./prose.mjs"`;',
    'const note = \'import "./quoted.mjs"\';',
    'const pattern = /from "nowhere"/;',
    'source.import("./not-a-module.mjs");',
    'const result = 4 / 2; import "./present.mjs";',
  ].join('\n');
  assert.doesNotThrow(() => verifyRuntimeImports(new Map([
    ['entry.mjs', Buffer.from(source)], ['present.mjs', Buffer.from('export const x = 1;')],
  ])));
});
