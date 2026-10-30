#!/usr/bin/env node
// Finite, operator-started seeded testing; no network or scheduler.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const suites = ['tests/events-kernel.property.test.js', 'tests/spend-grants-property.test.js'];
export function jobs(lane, lanes, count, base = 10300000) {
  if (![lane, lanes, count, base].every(Number.isSafeInteger) || lanes < 1 || lane < 0 || lane >= lanes || count < 1 || count > 10000 || base < 0 || base + (count * lanes + lane) * 100 > 2147483647) throw new Error('Invalid seed partition');
  return Array.from({ length: count }, (_, round) => ({ seed: base + (lane + round * lanes) * 100, suite: suites[round % suites.length] }));
}
export function execute(args, { cwd, env, timeoutMs, logLimit = 1048576 }) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', bytes = 0, reason = null;
    const stop = (why) => { if (reason) return; reason = why; try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const collect = chunk => { bytes += chunk.length; if (bytes <= logLimit) log += chunk.toString(); else stop('output-limit'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const interrupt = () => stop('interrupted');
    process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
    const finish = result => { clearTimeout(timer); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); resolveResult({ ...result, reason, log, bytes }); };
    child.once('error', error => finish({ code: null, error: error.message }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
async function exists(path) { try { await access(path); return true; } catch { return false; } }
export async function main(args) {
  const [outArg, laneArg = '0', lanesArg = '2', countArg = '24', minutesArg = '20'] = args;
  if (!outArg || args.length > 5) throw new Error('Usage: node scripts/local-test-campaign.mjs OUTPUT_DIR [LANE=0] [LANES=2] [JOBS=24] [MINUTES=20]');
  const plan = jobs(Number(laneArg), Number(lanesArg), Number(countArg));
  const minutes = Number(minutesArg);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) throw new Error('Minutes must be >0 and <=240');
  const source = git('rev-parse', 'HEAD');
  const clean = () => { if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Tracked source is dirty'); if (git('rev-parse', 'HEAD') !== source) throw new Error('Source revision changed'); };
  clean();
  const out = resolve(outArg); await mkdir(out, { recursive: true });
  const lock = resolve(out, 'running.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, source }), { flag: 'wx' });
  const deadline = Date.now() + minutes * 60000;
  const identity = { source, node: process.version, platform: process.platform, arch: process.arch, lane: Number(laneArg), lanes: Number(lanesArg) };
  try {
    for (const job of plan) {
      if (Date.now() >= deadline || await exists(resolve(out, 'STOP'))) break;
      clean();
      const name = `${source}-${job.seed}-${job.suite.split('/').pop()}`;
      const receiptPath = resolve(out, `${name}.json`);
      if (await exists(receiptPath)) {
        const old = JSON.parse(await readFile(receiptPath, 'utf8'));
        if (old.source === source && old.node === process.version && old.platform === process.platform && old.arch === process.arch && old.seed === job.seed && old.suite === job.suite && old.code === 0 && !old.reason && !old.error) { console.log(JSON.stringify({ skipped: true, ...job })); continue; }
        throw new Error(`Existing unsuccessful or incompatible receipt: ${receiptPath}`);
      }
      const started = new Date().toISOString();
      const result = await execute(['--test', job.suite], { cwd: process.cwd(), env: { ...process.env, PROPERTY_TEST_SEED: String(job.seed) }, timeoutMs: Math.min(120000, deadline - Date.now()) });
      await writeFile(resolve(out, `${name}.log`), result.log, { flag: 'wx' });
      const { log, ...status } = result;
      const receipt = { ...identity, ...job, started, finished: new Date().toISOString(), ...status };
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
      console.log(JSON.stringify(receipt));
      if (status.code !== 0 || status.reason || status.error) { process.exitCode = 1; break; }
    }
  } finally { await unlink(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
