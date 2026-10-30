import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimePackage } from '../scripts/runtime-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('newer tools package an exact target repository that has no publication tooling', t => {
  const temp = mkdtempSync(join(tmpdir(), 'runtime-old-target-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const target = join(temp, 'target');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  createRuntimePackage({ repository: root, commit: head, destination: target });
  rmSync(join(target, 'runtime-manifest.json'));
  const git = args => execFileSync('git', args, { cwd: target, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git(['init', '-q']); git(['add', '.']);
  git(['-c','user.name=Runtime Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','Target without release tools']);
  const commit = git(['rev-parse','HEAD']);
  assert.equal(existsSync(join(target,'scripts/runtime-package.mjs')),false);
  assert.equal(existsSync(join(target,'scripts/verify-runtime-release.py')),false);
  const output = join(temp,'package'), archive = join(temp,'runtime.tgz');
  execFileSync(process.execPath,[join(root,'scripts/runtime-package.mjs'),'create',target,commit,output]);
  execFileSync('python3',[join(root,'scripts/runtime-archive.py'),output,archive,'--expected-commit',commit,'--node',process.execPath]);
  const manifest = JSON.parse(readFileSync(join(output,'runtime-manifest.json')));
  assert.equal(manifest.sourceCommit,commit);
  assert.equal(manifest.sourceTree,git(['rev-parse','HEAD^{tree}']));
  assert.notEqual(commit,head,'the target is not the tooling revision');
  assert.deepEqual(readFileSync(join(output,'server.mjs')),readFileSync(join(target,'server.mjs')));
  const wrong = spawnSync('python3',[join(root,'scripts/runtime-archive.py'),output,join(temp,'wrong.tgz'),'--expected-commit',head,'--node',process.execPath]);
  assert.notEqual(wrong.status,0,'tooling SHA cannot substitute for target SHA');
  assert.equal(existsSync(join(temp,'wrong.tgz')),false);
});

test('download verifier accepts immutable correction tags and refuses malformed suffixes', () => {
  const python = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('verify',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
base='runtime-2026-10-29-aaaaaaa'
for suffix in ('','-r2','-r3','-r10'): assert m.valid_runtime_tag(base+suffix)
for suffix in ('-r0','-r1','-r02','-latest','-r2/other','-r2\\n'): assert not m.valid_runtime_tag(base+suffix)
`;
  execFileSync('python3',['-c',python,join(root,'scripts/verify-runtime-release.py')]);
});
