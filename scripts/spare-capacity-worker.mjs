#!/usr/bin/env node
// Operator-owned local worker. Only fixed repository tests are executable.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, statSync, readdirSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus, loadavg, setPriority } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execute, suites } from './local-test-campaign.mjs';
const verification = ['tests/development-loop.test.js', 'tests/mcp-events-http.test.js', 'tests/mcp-events-wire.test.js'];
const allowed = [...suites, ...verification];
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export function sourceIdentity() {
  if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Tracked checkout is dirty');
  return { source: git('rev-parse', 'HEAD'), node: process.version, platform: process.platform, arch: process.arch,
    lockfile: existsSync('package-lock.json') ? hash(readFileSync('package-lock.json')) : null };
}
export class Queue {
  constructor(dir, initial) {
    this.dir = resolve(dir); mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(this.dir, 'queue.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, suite TEXT NOT NULL, seed INTEGER, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, started TEXT, finished TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS failures (signature TEXT PRIMARY KEY, suite TEXT NOT NULL, seed INTEGER, count INTEGER NOT NULL, example TEXT NOT NULL);`);
    const existing = this.db.prepare('SELECT value FROM settings WHERE id=1').get();
    if (!existing) {
      if (!initial) { this.db.close(); throw new Error('Initialize the worker first'); }
      const { lane, lanes } = initial;
      if (!Number.isSafeInteger(lane) || !Number.isSafeInteger(lanes) || lane < 0 || lanes < 1 || lane >= lanes) throw new Error('Invalid lane');
      this.db.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({ ...initial, next: 0, mode: 'paused', version: 1 }));
      for (const suite of verification) this.db.prepare("INSERT INTO jobs(suite,status) VALUES(?,'queued')").run(suite);
    } else if (initial) throw new Error('Worker already initialized; use its existing configuration');
  }
  config() { return JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  mode(mode) {
    if (!['paused', 'spare', 'dedicated'].includes(mode)) throw new Error('Mode must be paused, spare or dedicated');
    this.transaction(() => { const c = this.config(); c.mode = mode; this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(c)); });
  }
  recover() { // Only called while holding the local worker lock. Tests are disposable.
    this.db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();
  }
  next() {
    return this.transaction(() => {
      if (this.config().mode === 'paused') return null;
      if (this.db.prepare("SELECT id FROM jobs WHERE status='failed' LIMIT 1").get()) throw new Error('Investigate the failed job before starting another campaign');
      let job = this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
      if (!job) {
        const c = this.config(), seed = 10300000 + (c.lane + c.next * c.lanes) * 100;
        if (!Number.isSafeInteger(seed) || seed > 2147483600) throw new Error('Seed range exhausted');
        const result = this.db.prepare("INSERT INTO jobs(suite,seed,status) VALUES(?,?,'queued')").run(suites[c.next % suites.length], seed);
        c.next++; this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(c));
        job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(result.lastInsertRowid);
      }
      if (!allowed.includes(job.suite)) throw new Error('Unknown test suite in queue');
      this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,started=? WHERE id=?").run(new Date().toISOString(), job.id);
      return { ...job, attempts: job.attempts + 1 };
    });
  }
  finish(job, result) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
      if (!current || current.status !== 'running' || current.attempts !== job.attempts) throw new Error('Stale job result');
      const status = result.reason === 'interrupted' ? 'queued' : result.code === 0 && !result.reason && !result.error ? 'passed' : 'failed';
      this.db.prepare('UPDATE jobs SET status=?,finished=?,result=? WHERE id=?').run(status, new Date().toISOString(), JSON.stringify(result), job.id);
      if (status === 'failed') {
        // Exact output digest intentionally avoids merging distinct failures by guesswork.
        const signature = hash(JSON.stringify([job.suite, result.code, result.reason, result.logHash]));
        this.db.prepare(`INSERT INTO failures VALUES(?,?,?,1,?) ON CONFLICT(signature) DO UPDATE SET count=count+1`)
          .run(signature, job.suite, job.seed, JSON.stringify({ jobId: job.id, ...result }));
      }
      return status;
    });
  }
  summary() { return { ...this.config(), jobs: this.db.prepare('SELECT status,count(*) count FROM jobs GROUP BY status').all(), failures: this.db.prepare('SELECT count(*) count FROM failures').get().count }; }
  failures() { return { version: 1, identity: this.config().identity, failures: this.db.prepare('SELECT * FROM failures').all() }; }
  close() { this.db.close(); }
}
export function validateFailurePacket(packet, identity) {
  if (packet?.version !== 1 || JSON.stringify(packet.identity) !== JSON.stringify(identity) || !Array.isArray(packet.failures) || packet.failures.length > 1000) throw new Error('Incompatible failure packet');
  for (const f of packet.failures) if (!allowed.includes(f.suite) || (f.seed !== null && (!Number.isSafeInteger(f.seed) || f.seed < 0 || f.seed > 2147483600)) || !/^[a-f0-9]{64}$/.test(f.signature)) throw new Error('Invalid failure record');
  return packet.failures.map(({ suite, seed, signature }) => ({ suite, seed, signature }));
}
export async function run(queue, { count = 240, minutes = 20, continuous = false } = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000 || !Number.isFinite(minutes) || minutes <= 0 || minutes > 240) throw new Error('Invalid job/time budget');
  const lock = resolve(queue.dir, 'worker.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const deadline = Date.now() + minutes * 60000;
  try {
    const expected = queue.config().identity;
    const verify = () => { if (JSON.stringify(sourceIdentity()) !== JSON.stringify(expected)) throw new Error('Source/runtime changed; initialize a new worker directory'); };
    verify(); queue.recover();
    // Priority stays low even in dedicated mode; dedicated bypasses load gating only.
    try { setPriority(10); } catch { /* optional scheduling hint */ }
    let completed = 0;
    while (!interrupted && (continuous || (completed < count && Date.now() < deadline))) {
      const mode = queue.config().mode;
      if (mode === 'paused' || existsSync(resolve(queue.dir, 'STOP'))) break;
      const bytes = readdirSync(queue.dir).reduce((sum, name) => sum + statSync(resolve(queue.dir, name)).size, 0);
      if (bytes + 65536 > 128 * 1024 * 1024) throw new Error('128 MiB evidence budget reached; archive evidence before starting a new directory');
      if (mode === 'spare' && loadavg()[0] > cpus().length * 0.7) { await new Promise(r => setTimeout(r, 2000)); continue; }
      verify(); const job = queue.next(); if (!job) break;
      const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'NODE_NO_WARNINGS'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
      if (job.seed !== null) env.PROPERTY_TEST_SEED = String(job.seed);
      const started = Date.now();
      const result = await execute(['--test', job.suite], { cwd: process.cwd(), env, timeoutMs: continuous ? 120000 : Math.max(1, Math.min(120000, deadline - Date.now())), logLimit: 65536 });
      const logName = `job-${job.id}-attempt-${job.attempts}.log`;
      writeFileSync(resolve(queue.dir, logName), result.log, { flag: 'wx', mode: 0o600 });
      const { log, ...metadata } = result;
      const receipt = { ...metadata, logName, logHash: hash(log), elapsedMs: Date.now() - started };
      const status = queue.finish(job, receipt);
      console.log(JSON.stringify({ jobId: job.id, suite: job.suite, seed: job.seed, status, ...receipt }));
      completed++;
      if (status === 'failed') { process.exitCode = 1; break; }
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); unlinkSync(lock); }
}
async function main(args) {
  const [command, directory, ...rest] = args;
  if (!directory) throw new Error('Usage: spare-capacity-worker.mjs init|mode|run|start|status|export|inspect DIRECTORY [arguments]');
  if (command === 'init') { const q = new Queue(directory, { identity: sourceIdentity(), lane: Number(rest[0] ?? 0), lanes: Number(rest[1] ?? 2) }); console.log(JSON.stringify(q.summary())); q.close(); return; }
  const q = new Queue(directory);
  try {
    if (command === 'start') {
      if (q.config().mode === 'paused') throw new Error('Choose spare or dedicated mode before starting');
      if (existsSync(resolve(q.dir, 'worker.lock'))) throw new Error('Worker lock exists; inspect status before starting');
      if (JSON.stringify(sourceIdentity()) !== JSON.stringify(q.config().identity)) throw new Error('Source/runtime changed');
      const fd = openSync(resolve(q.dir, 'progress.jsonl'), 'a', 0o600);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', q.dir, '--continuous'], { cwd: process.cwd(), detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd); child.unref();
      await new Promise((resolveWait, reject) => { child.once('error', reject); child.once('spawn', resolveWait); });
      let confirmed = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        try { if (JSON.parse(readFileSync(resolve(q.dir, 'worker.lock'), 'utf8')).pid === child.pid) { confirmed = true; break; } } catch {}
      }
      console.log(JSON.stringify({ spawnedPid: child.pid, lockObserved: confirmed, execution: 'local detached Node process, no model turns' }));
      if (!confirmed) throw new Error('Worker did not acquire its lock; inspect progress.jsonl');
    }
    else if (command === 'mode') q.mode(rest[0]);
    else if (command === 'run') await run(q, rest[0] === '--continuous' ? { continuous: true } : { count: Number(rest[0] ?? 240), minutes: Number(rest[1] ?? 20) });
    else if (command === 'export') { if (!rest[0]) throw new Error('Export needs destination'); writeFileSync(rest[0], JSON.stringify(q.failures(), null, 2), { flag: 'wx', mode: 0o600 }); }
    else if (command === 'inspect') { if (!rest[0] || statSync(rest[0]).size > 1048576) throw new Error('Packet missing or too large'); console.log(JSON.stringify({ reproductionCandidates: validateFailurePacket(JSON.parse(readFileSync(rest[0], 'utf8')), q.config().identity), executed: false })); }
    else if (command !== 'status') throw new Error('Unknown command');
    console.log(JSON.stringify(q.summary()));
  } finally { q.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
