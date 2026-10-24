import { realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, requireThat } from './store.mjs';
import { installPackage } from './registry.mjs';

// The local owner chooses the repository and test paths when installing. Room
// jobs provide only a full revision; they cannot substitute cwd or commands.
export function installRepositoryPackage(store, { repository, tests, version = 'v1', memoryBytes = 512 * 1024 ** 2 }) {
  repository = realpathSync(repository);
  requireThat(Array.isArray(tests) && tests.length > 0 && tests.length <= 32 && tests.every(p => typeof p === 'string'
    && /^[a-zA-Z0-9_./-]+\.(mjs|js)$/.test(p) && !p.startsWith('/') && !p.split('/').includes('..')), 'invalid_test_paths');
  execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', '--git-dir'], { stdio: 'pipe' });
  const code = `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const input=JSON.parse(readFileSync(process.env.ROOM_TASK_INPUT));
if(Object.keys(input).length!==1 || !/^[a-f0-9]{40}$/.test(input.revision)) throw new Error('exact_revision_required');
const repository=${JSON.stringify(repository)}, tests=${JSON.stringify(tests)}, output=process.env.ROOM_TASK_OUTPUT;
const checkout=join(process.cwd(),'checkout');
execFileSync('/usr/bin/git',['-C',repository,'worktree','add','--detach',checkout,input.revision],{stdio:'pipe',timeout:30000});
try {
 const result=spawnSync(process.execPath,['--test',...tests],{cwd:checkout,encoding:'utf8',maxBuffer:1024*1024,timeout:120000,env:{PATH:'/usr/bin:/bin'}});
 console.log(result.stdout??''); console.error(result.stderr??'');
 if(result.status!==0 || result.error) throw new Error('repository_verification_failed');
 const head=execFileSync('/usr/bin/git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const dirty=execFileSync('/usr/bin/git',['-C',checkout,'status','--porcelain'],{encoding:'utf8'}).trim();
 if(head!==input.revision || dirty) throw new Error('verification_changed_checkout');
 const evidence={revision:head,runtime:process.version,tests,passed:true,releaseAuthorized:false};
 writeFileSync(join(output,'release-evidence.json'),JSON.stringify(evidence));
 writeFileSync(join(output,'preview.html'),'<!doctype html><meta charset="utf-8"><title>Repository verification</title><h1>Verification passed</h1><p>Revision: '+head+'</p><p>Release evidence prepared. Deployment has not run.</p>');
} finally {execFileSync('/usr/bin/git',['-C',repository,'worktree','remove','--force',checkout],{stdio:'pipe',timeout:30000});}
`;
  const root = mkdtempSync(join(tmpdir(), 'room-repository-package-'));
  try {
    writeFileSync(join(root, 'verify.mjs'), code, { mode: 0o600 });
    return installPackage(store, root, { schema: 1, capability: 'repository-verify', version, runtime: process.version,
      resources: { cpu: 1, memoryBytes }, files: [{ path: 'verify.mjs', sha256: digest(code) }],
      steps: [{ id: 'verify-preview-evidence', module: 'verify.mjs', args: [], timeoutMs: 180000 }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
