import { constants, mkdtempSync, writeFileSync, rmSync, realpathSync, lstatSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest, requireThat } from './store.mjs';
import { installPackage, getPackage } from './registry.mjs';
import { policy, submit, getJob } from './executor.mjs';

const capability = 'workspace-inventory';
// Local desktop entry point only. Never call from a Room-supplied tool manifest.
// Folder scope is sealed into the package, not selected by a remote job input.
export function prepareFirstJob(store, { workspace, room, operation }) {
  const p = policy(store), root = realpathSync(workspace), stat = lstatSync(root);
  requireThat(stat.isDirectory() && Array.isArray(p.workspaces) && p.workspaces.includes(root) && !p.paused
    && p.rooms.includes(room) && p.capabilities.includes(capability), 'workspace_grant_required');
  const scope = { path: root, dev: stat.dev, ino: stat.ino };
  const code = `import {opendirSync,lstatSync,realpathSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const scope=${JSON.stringify(scope)};
if(JSON.stringify(JSON.parse(readFileSync(process.env.ROOM_TASK_INPUT)))!=='{}')throw Error('unexpected_inventory_input');
function check(){const s=lstatSync(scope.path);if(!s.isDirectory()||s.dev!==scope.dev||s.ino!==scope.ino||realpathSync(scope.path)!==scope.path)throw Error('workspace_changed');}
check();
const summary={schema:1,kind:'workspace-inventory',recursive:false,entries:0,files:0,directories:0,symlinks:0,other:0,hiddenSkipped:0,complete:true};
const dir=opendirSync(scope.path);
try { let entry; while((entry=dir.readSync())) {
 if(summary.entries===512){summary.complete=false;break;} summary.entries++;
 if(entry.name.startsWith('.')){summary.hiddenSkipped++;continue;}
 if(entry.isSymbolicLink())summary.symlinks++;
 else if(entry.isFile())summary.files++;
 else if(entry.isDirectory())summary.directories++;
 else summary.other++;
}} finally {dir.closeSync();}
check();
writeFileSync(join(process.env.ROOM_TASK_OUTPUT,'workspace-summary.json'),JSON.stringify(summary));
`;
  const temporary = mkdtempSync(join(tmpdir(), 'room-first-job-'));
  try {
    writeFileSync(join(temporary, 'inventory.mjs'), code, { mode: 0o600 });
    const pack = installPackage(store, temporary, { schema: 1, capability, version: 'v1', runtime: process.version,
      workspaceScope: scope, resources: { cpu: 1, memoryBytes: 64 * 1024 ** 2 },
      files: [{ path: 'inventory.mjs', sha256: digest(code) }],
      steps: [{ id: 'inventory', module: 'inventory.mjs', args: [], timeoutMs: 15000 }] });
    // Exact package pin; do not replace an active version or widen grants.
    const job = submit(store, { room, operation, capability, input: {}, candidateHash: pack.hash });
    return { schema: 1, jobId: job.id, pin: job.pin, expectedAttempt: job.attempt || 1, state: job.state,
      next: job.state === 'queued' ? 'run' : 'first-job-verify' };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function verifyFirstJob(store, { jobId, expectedAttempt, expectedPin }) {
  const job = getJob(store, jobId), pack = getPackage(store, job.pin);
  requireThat(Number.isInteger(expectedAttempt) && expectedAttempt > 0 && job.attempt === expectedAttempt
    && typeof expectedPin === 'string' && job.pin === expectedPin, 'first_job_binding_changed');
  requireThat(pack.manifest.capability === capability && job.state === 'completed' && job.result?.passed === true
    && job.result.pin === job.pin && job.result.steps?.length === pack.manifest.steps.length
    && job.result.steps.every(step => step.passed === true), 'first_job_not_completed');
  const files = job.result.artifacts;
  requireThat(Array.isArray(files) && files.length === 1 && files[0].path === 'workspace-summary.json'
    && Number.isSafeInteger(files[0].bytes) && files[0].bytes > 0 && files[0].bytes <= 4096
    && digest(canonical(files)) === job.result.artifactDigest, 'first_job_artifact_invalid');
  const path = join(store.directory, 'runs', job.id, String(job.attempt), 'artifacts', files[0].path);
  requireThat(realpathSync(path) === path, 'first_job_artifact_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.alloc(files[0].bytes + 1); let length = 0;
  try {
    const stat = fstatSync(fd); requireThat(stat.isFile() && stat.size === files[0].bytes, 'first_job_artifact_changed');
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
  } finally { closeSync(fd); }
  const bytes = buffer.subarray(0, length);
  requireThat(length === files[0].bytes && digest(bytes) === files[0].sha256, 'first_job_artifact_changed');
  const summary = JSON.parse(bytes.toString());
  requireThat(summary.schema === 1 && summary.kind === capability && summary.recursive === false
    && typeof summary.complete === 'boolean'
    && ['entries', 'files', 'directories', 'symlinks', 'other', 'hiddenSkipped'].every(k => Number.isInteger(summary[k]) && summary[k] >= 0 && summary[k] <= 512)
    && summary.files + summary.directories + summary.symlinks + summary.other + summary.hiddenSkipped === summary.entries, 'first_job_summary_invalid');
  return { schema: 1, qualified: true, jobId, attempt: job.attempt, pin: job.pin, artifactDigest: job.result.artifactDigest,
    summary, scope: 'local_worker_only', roomArtifactQualified: false, twoDeviceQualified: false };
}
