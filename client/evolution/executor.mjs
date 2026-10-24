import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { availableParallelism, freemem, loadavg } from 'node:os';
import { canonical, digest, event, requireThat, transaction } from './store.mjs';
import { activation, getPackage, verifyPackage } from './registry.mjs';

export function configure(store, policy) {
  requireThat(Array.isArray(policy?.rooms) && policy.rooms.length > 0 && policy.rooms.every(r => typeof r === 'string' && r.length > 0)
    && Array.isArray(policy.capabilities) && policy.capabilities.every(c => typeof c === 'string')
    && Number.isInteger(policy.maxJobs) && policy.maxJobs > 0 && policy.maxJobs <= 64
    && Number.isInteger(policy.cpuSlots) && policy.cpuSlots > 0 && policy.cpuSlots <= 64
    && Number.isSafeInteger(policy.memoryBytes) && policy.memoryBytes >= 64 * 1024 ** 2
    && Number.isSafeInteger(policy.reserveMemoryBytes) && policy.reserveMemoryBytes >= 0
    && typeof policy.paused === 'boolean', 'invalid_policy');
  transaction(store, () => {
    store.db.prepare("INSERT INTO settings VALUES('policy',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(canonical(policy));
    event(store, 'policy.changed', 'device', policy);
  });
  return policy;
}
export function policy(store) { const r = store.db.prepare("SELECT value FROM settings WHERE id='policy'").get(); requireThat(r, 'device_not_configured'); return JSON.parse(r.value); }
export function getJob(store, jobId) {
  const row = store.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId); requireThat(row, 'job_not_found');
  return { ...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null };
}
export function submit(store, { room, operation, capability, input, candidateHash }) {
  requireThat([room, operation, capability].every(v => typeof v === 'string' && v.length > 0 && v.length <= 200), 'invalid_job');
  const payload = canonical({ capability, input, candidateHash: candidateHash ?? null }); requireThat(Buffer.byteLength(payload) <= 65536, 'input_too_large');
  return transaction(store, () => {
    const previous = store.db.prepare('SELECT * FROM jobs WHERE room=? AND operation=?').get(room, operation);
    if (previous) { requireThat(previous.payload === payload, 'operation_payload_changed'); return getJob(store, previous.id); }
    const p = policy(store); requireThat(p.rooms.includes(room) && p.capabilities.includes(capability), 'job_not_authorized');
    const active = activation(store, capability); requireThat(active || candidateHash, 'capability_not_active');
    const bucket = parseInt(digest(canonical([room, operation])).slice(0, 8), 16) % 100;
    const pin = candidateHash ?? (active.candidate && bucket < active.percent ? active.candidate : active.current);
    requireThat(getPackage(store, pin).manifest.capability === capability, 'capability_mismatch');
    const jobId = digest(canonical([room, operation]));
    store.db.prepare("INSERT INTO jobs(id,room,operation,payload,pin,state) VALUES(?,?,?,?,?,'queued')").run(jobId, room, operation, payload, pin);
    event(store, 'job.queued', jobId, { room, capability, pin, evaluation: Boolean(candidateHash) });
    return getJob(store, jobId);
  });
}
export function observe() { return { at: Date.now(), cpuSlots: Math.max(0, availableParallelism() - Math.ceil(loadavg()[0])), memoryBytes: freemem() }; }
export function admission(store, job, observation = observe()) {
  const p = policy(store), manifest = getPackage(store, job.pin).manifest;
  if (p.paused) return { allowed: false, reason: 'paused' };
  if (!p.rooms.includes(job.room) || !p.capabilities.includes(manifest.capability)) return { allowed: false, reason: 'job_not_authorized' };
  if (!Number.isSafeInteger(observation.at) || observation.at > Date.now() || Date.now() - observation.at > 30000
    || !Number.isFinite(observation.cpuSlots) || !Number.isFinite(observation.memoryBytes)) return { allowed: false, reason: 'stale_resources' };
  // Unknown execution retains its reservation until a local operator reconciles it.
  const active = store.db.prepare("SELECT pin FROM jobs WHERE state IN ('running','cancelling','interrupted')").all();
  const used = active.reduce((sum, row) => { const r = getPackage(store, row.pin).manifest.resources; return { cpu: sum.cpu + r.cpu, memory: sum.memory + r.memoryBytes }; }, { cpu: 0, memory: 0 });
  const r = manifest.resources;
  if (active.length >= p.maxJobs || used.cpu + r.cpu > p.cpuSlots || used.memory + r.memoryBytes > p.memoryBytes
    || r.cpu > observation.cpuSlots || r.memoryBytes + p.reserveMemoryBytes > observation.memoryBytes) return { allowed: false, reason: 'resources_reserved' };
  return { allowed: true, cpu: r.cpu, memoryBytes: r.memoryBytes };
}
export function cancel(store, jobId) {
  return transaction(store, () => {
    const job = getJob(store, jobId);
    if (job.state === 'queued') store.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(jobId);
    else if (job.state === 'running') store.db.prepare("UPDATE jobs SET state='cancelling' WHERE id=?").run(jobId);
    event(store, 'job.cancel_requested', jobId, { previous: job.state }); return getJob(store, jobId);
  });
}
export function reconcile(store, jobId, { owner, attempt, processesStopped, reason }) {
  requireThat(processesStopped === true && typeof reason === 'string' && reason.trim(), 'process_stop_evidence_required');
  return transaction(store, () => {
    const job = getJob(store, jobId);
    requireThat(['running', 'cancelling', 'interrupted'].includes(job.state) && job.owner === owner && job.attempt === attempt, 'reconcile_conflict');
    store.db.prepare("UPDATE jobs SET state='needs_attention',owner=NULL WHERE id=?").run(jobId);
    event(store, 'job.reconciled', jobId, { owner, attempt, reason, automaticRetry: false }); return getJob(store, jobId);
  });
}
export function feedback(store, jobId, { category, note }) {
  requireThat(['correct', 'incorrect', 'slow', 'interruptions', 'other'].includes(category) && typeof note === 'string' && note.length <= 2000, 'invalid_feedback');
  getJob(store, jobId); event(store, 'job.feedback', jobId, { category, note, scope: 'this_job' });
  return { recorded: true, preferenceChanged: false };
}
export function status(store) {
  return { policy: policy(store), activations: store.db.prepare('SELECT * FROM activations ORDER BY capability').all(),
    jobs: store.db.prepare('SELECT id,room,operation,pin,state,attempt,heartbeat FROM jobs ORDER BY rowid DESC LIMIT 100').all(),
    executionAuthority: 'local_owner_only', physicalLimitsEnforced: false };
}
function artifactTree(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), name = prefix + entry.name;
    requireThat(!entry.isSymbolicLink(), 'artifact_symlink');
    if (entry.isDirectory()) files.push(...artifactTree(path, name + '/'));
    else { const stat = lstatSync(path); requireThat(stat.isFile() && stat.size <= 16 * 1024 ** 2, 'artifact_limit'); files.push({ path: name, sha256: digest(readFileSync(path)), bytes: stat.size }); }
    requireThat(files.length <= 256, 'artifact_limit');
  }
  return files;
}
async function executeStep(store, job, step, ordinal, pack, directory, inputPath, outputPath, signal) {
  verifyPackage(store, job.pin);
  const stdoutPath = join(directory, `${ordinal}.stdout`), stderrPath = join(directory, `${ordinal}.stderr`);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pack.directory, step.module), ...step.args], { detached: true, cwd: directory,
      env: { PATH: '/usr/bin:/bin', ROOM_TASK_INPUT: inputPath, ROOM_TASK_OUTPUT: outputPath, ROOM_TASK_CPU_SLOTS: String(pack.manifest.resources.cpu) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let total = 0, reason = null;
    const stop = why => { reason ??= why; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Process already ended. */ } };
    const abort = () => stop('cancelled');
    const collect = sink => bytes => { total += bytes.length; if (total > 1024 ** 2) stop('output_limit'); else sink.push(bytes); };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), step.timeoutMs);
    const heartbeat = setInterval(() => {
      try {
        const current = getJob(store, job.id);
        if (current.state !== 'running' || current.owner !== job.owner || current.attempt !== job.attempt) { stop('ownership_or_cancel'); return; }
        store.db.prepare('UPDATE jobs SET heartbeat=? WHERE id=? AND owner=? AND attempt=?').run(Date.now(), job.id, job.owner, job.attempt);
      } catch { stop('journal_unavailable'); }
    }, 200);
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      clearTimeout(timer); clearInterval(heartbeat); signal?.removeEventListener('abort', abort);
      try {
        writeFileSync(stdoutPath, Buffer.concat(stdout), { mode: 0o600, flag: 'wx' }); writeFileSync(stderrPath, Buffer.concat(stderr), { mode: 0o600, flag: 'wx' });
        if (spawnError) throw spawnError;
        resolve({ step: step.id, exitCode: code, passed: code === 0 && reason === null, reason, elapsedMs: Date.now() - started,
          stdout: { path: stdoutPath, sha256: digest(Buffer.concat(stdout)) }, stderr: { path: stderrPath, sha256: digest(Buffer.concat(stderr)) } });
      } catch (error) { reject(error); }
    });
  });
}
export async function runJob(store, jobId, { signal, observation } = {}) {
  const owner = randomUUID();
  const admitted = transaction(store, () => {
    const job = getJob(store, jobId);
    if (job.state !== 'queued') return { claimed: false, job };
    const budget = admission(store, job, observation);
    if (!budget.allowed) return { claimed: false, job, reason: budget.reason };
    verifyPackage(store, job.pin);
    store.db.prepare("UPDATE jobs SET state='running',owner=?,attempt=attempt+1,heartbeat=? WHERE id=?").run(owner, Date.now(), jobId);
    event(store, 'job.started', jobId, { owner, pin: job.pin }); return { claimed: true, job: getJob(store, jobId) };
  });
  if (!admitted.claimed) return admitted;
  const job = admitted.job, pack = getPackage(store, job.pin), started = Date.now();
  const directory = join(store.directory, 'runs', jobId, String(job.attempt)); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const inputPath = join(directory, 'input.json'), outputPath = join(directory, 'artifacts'); mkdirSync(outputPath, { mode: 0o700 });
  writeFileSync(inputPath, canonical(job.payload.input), { mode: 0o400, flag: 'wx' });
  const receipts = [];
  try {
    for (const [ordinal, step] of pack.manifest.steps.entries()) {
      signal?.throwIfAborted();
      const current = getJob(store, jobId); requireThat(current.state === 'running' && current.owner === owner, 'job_ownership_changed');
      store.db.prepare("INSERT INTO steps VALUES(?,?,'running',NULL)").run(jobId, ordinal);
      const receipt = await executeStep(store, job, step, ordinal, pack, directory, inputPath, outputPath, signal);
      transaction(store, () => {
        const current = getJob(store, jobId); requireThat(current.owner === owner && current.attempt === job.attempt, 'job_ownership_changed');
        store.db.prepare('UPDATE steps SET state=?,receipt=? WHERE job=? AND ordinal=?').run(receipt.passed ? 'completed' : 'failed', canonical(receipt), jobId, ordinal);
        event(store, 'job.step', jobId, { step: step.id, passed: receipt.passed });
      });
      receipts.push(receipt); if (!receipt.passed) break;
    }
    const artifacts = artifactTree(outputPath), passed = receipts.length === pack.manifest.steps.length && receipts.every(r => r.passed);
    const result = { passed, pin: job.pin, steps: receipts, artifacts, artifactDigest: digest(canonical(artifacts)), artifactDirectory: outputPath,
      elapsedMs: Date.now() - started, modelCalls: 'not_instrumented', acceptance: 'script_exit_and_artifact_hashes' };
    transaction(store, () => {
      const current = getJob(store, jobId); requireThat(current.owner === owner && current.attempt === job.attempt && ['running', 'cancelling'].includes(current.state), 'job_ownership_changed');
      const state = current.state === 'cancelling' ? 'cancelled' : passed ? 'completed' : 'needs_attention';
      store.db.prepare('UPDATE jobs SET state=?,result=?,owner=NULL WHERE id=?').run(state, canonical(result), jobId);
      event(store, 'job.finished', jobId, { state, artifactDigest: result.artifactDigest, elapsedMs: result.elapsedMs });
    });
  } catch (error) {
    transaction(store, () => {
      const current = getJob(store, jobId);
      if (current.owner !== owner || current.attempt !== job.attempt) return;
      store.db.prepare("UPDATE jobs SET state='needs_attention',owner=NULL,result=? WHERE id=?").run(canonical({ passed: false, error: error.message, steps: receipts, pin: job.pin }), jobId);
      event(store, 'job.failed', jobId, { error: error.message });
    });
  }
  return { claimed: true, job: getJob(store, jobId) };
}
