#!/usr/bin/env node
// One explicit local job; no watcher, model, remote status, or cache reuse.
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {arch, platform} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = (cwd, args) => execFileSync('git', args, {cwd, encoding:'utf8', maxBuffer:8*1024*1024}).trim();
function source(cwd, expectedHead) {
  if (git(cwd, ['rev-parse', 'HEAD']) !== expectedHead) throw Error('source_head_changed');
  if (git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) throw Error('source_not_clean');
}
function fileHash(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('artifact_not_regular');
  return hash(readFileSync(path));
}
function outputDirectory(root, name) {
  const path = join(root,name);
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw Error('unsafe_output_directory');
  mkdirSync(path,{recursive:true,mode:0o700});
  if (realpathSync(path) !== path) throw Error('unsafe_output_directory');
  return path;
}
function environment(cwd) {
  // Do not forward provider credentials, NODE_OPTIONS, or inherited CI identity.
  const env = {};
  for (const key of ['PATH','HOME','LANG','LC_ALL','SYSTEMROOT','I18N_ALLOW_GROWTH']) if (process.env[key]) env[key] = process.env[key];
  env.TMPDIR = join(cwd, '.tmp'); env.XDG_RUNTIME_DIR = env.TMPDIR;
  return env;
}
export function affectedPlan({checkout, baseSha, env}) {
  const code = "import {affectedUnitFiles} from './scripts/ci-affected.mjs'; console.log(JSON.stringify(affectedUnitFiles(process.argv[1]).files));";
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module','-e',code,baseSha],
    {cwd:checkout,env,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024}));
}
export async function executeUnits({checkout, baseSha, env, logPath, timeoutMs, signal}) {
  if (platform() === 'win32') throw Error('process_group_cancellation_not_supported');
  signal?.throwIfAborted();
  const fd = openSync(logPath, 'wx', 0o600);
  try {
    return await new Promise(resolveResult => {
      const child = spawn(process.execPath, ['scripts/unit-ci.mjs','--affected',`--base=${baseSha}`],
        {cwd:checkout,env,detached:true,stdio:['ignore',fd,fd]});
      let timedOut = false, cancelled = false;
      const kill = () => {try {process.kill(-child.pid, 'SIGKILL');} catch {}};
      const abort = () => {cancelled = true; kill();};
      const timer = setTimeout(() => {timedOut = true; kill();}, timeoutMs);
      const cleanup = () => {clearTimeout(timer); signal?.removeEventListener('abort',abort);};
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
      child.once('error', () => {cleanup(); resolveResult({status:null, signal:null, spawnFailed:true, timedOut:false,cancelled});});
      child.once('close', (status, childSignal) => {cleanup(); resolveResult({status,signal:childSignal,timedOut,cancelled});});
    });
  } finally {closeSync(fd);}
}

export async function verifyLocal(options, {plan = affectedPlan, execute = executeUnits} = {}) {
  const {checkout, expectedHead, baseSha, recipe, timeoutMs = 1800000, signal} = options;
  if (Object.keys(options).some(key => !['checkout','expectedHead','baseSha','recipe','timeoutMs','signal'].includes(key))
    || typeof checkout !== 'string' || !isAbsolute(checkout) || !sha(expectedHead) || !sha(baseSha)
    || (signal !== undefined && !(signal instanceof AbortSignal))
    || recipe !== 'affected-unit' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw Error('invalid_local_verification_request');
  signal?.throwIfAborted();
  const cwd = realpathSync(checkout);
  if (realpathSync(git(cwd, ['rev-parse','--show-toplevel'])) !== cwd) throw Error('checkout_must_be_repository_root');
  source(cwd, expectedHead);
  if (git(cwd, ['rev-parse',`${baseSha}^{commit}`]) !== baseSha) throw Error('invalid_base_commit');
  const gitDir = realpathSync(git(cwd, ['rev-parse','--absolute-git-dir']));
  const receiptRoot = outputDirectory(gitDir,'local-verification');
  outputDirectory(cwd,'.tmp'); outputDirectory(cwd,'test-results');
  const lockPath = join(gitDir, 'local-verification.lock');
  const lock = openSync(lockPath, 'wx', 0o600); // A stale/unknown run is never replayed automatically.
  const runId = `local-${randomUUID()}`, dir = join(receiptRoot,runId);
  let receipt;
  try {
    writeFileSync(lock, JSON.stringify({runId,expectedHead,pid:process.pid}));
    mkdirSync(dir,{recursive:true,mode:0o700});
    const env = environment(cwd);
    const lockHash = fileHash(join(cwd,'package-lock.json'));
    const files = await plan({checkout:cwd,baseSha,env});
    if (!Array.isArray(files) || !files.length || files.length > 20000 || files.some(file => typeof file !== 'string'
      || !/^[A-Za-z0-9_./-]+$/.test(file) || file.startsWith('/') || file.split('/').includes('..'))) throw Error('invalid_affected_plan');
    const planHash = hash(files.join('\n'));
    source(cwd,expectedHead);
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const artifactNames = [`unit-affected-attempt-${runId}.json`, `unit-junit-affected-attempt-${runId}.xml`];
    const unitPath = join(cwd,'test-results',artifactNames[0]);
    if (existsSync(unitPath)) throw Error('run_artifact_already_exists');
    let execution, reason = null;
    try {execution = await execute({checkout:cwd,baseSha,env:{...env,GITHUB_SHA:expectedHead,GITHUB_RUN_ID:runId,GITHUB_RUN_ATTEMPT:runId},logPath:join(dir,'process.log'),timeoutMs,signal});}
    catch {execution = {status:null,signal:null}; reason = 'execution_unconfirmed';}
    if (signal?.aborted || execution.cancelled) reason = 'cancelled';
    else if (execution.timedOut) reason = 'timeout';
    else if (execution.spawnFailed) reason = 'spawn_failed';
    else if (execution.signal) reason = 'signal';
    try {source(cwd,expectedHead);} catch {reason = 'source_changed';}
    const artifacts = [];
    let unit;
    try {
      unit = JSON.parse(readFileSync(unitPath,'utf8'));
      if (unit.revision !== expectedHead || unit.runId !== runId || unit.runAttempt !== runId
        || unit.planHash !== planHash || JSON.stringify(unit.files) !== JSON.stringify(files)
        || unit.status !== execution.status || unit.signal !== execution.signal) throw Error('receipt_mismatch');
      const junit = artifactNames[1];
      for (const name of [artifactNames[0],junit,`${junit}.spec.log`,`${junit}.progress.ndjson`]) {
        const path = join(cwd,'test-results',name);
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('artifact_not_regular');
        const bytes = readFileSync(path), digest = hash(bytes);
        const target = join(dir,name); writeFileSync(target,bytes,{flag:'wx',mode:0o600});
        artifacts.push({name,sha256:digest});
      }
    } catch {reason ??= 'missing_or_mismatched_evidence';}
    const status = reason || execution.timedOut || execution.spawnFailed || execution.signal ? 'invalid' : execution.status === 0 ? 'passed' : 'failed';
    receipt = {schema:'project-room-local-verification/1',runId,provenance:'local',hostedCI:false,recipe,
      source:{head:expectedHead,base:baseSha,packageLockSha256:lockHash},plan:{files,sha256:planHash},
      environment: {node: process.version, platform: platform(), arch: arch(),
        i18nAllowGrowth: env.I18N_ALLOW_GROWTH === '1'},
      startedAt,finishedAt:new Date().toISOString(),status,reason:reason ?? (execution.timedOut ? 'timeout' : execution.spawnFailed ? 'spawn_failed' : execution.signal ? 'signal' : null),
      exitCode:execution.status,signal:execution.signal,artifacts,
      limitations:['Affected tests only; not full CI.','Local self-reported evidence; no remote trust or cache reuse.','Clean source checked before and after; dependencies and transient concurrent edits are not attested.']};
    const temp = join(dir,'receipt.tmp'); writeFileSync(temp,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600}); renameSync(temp,join(dir,'receipt.json'));
    return {receipt,path:join(dir,'receipt.json')};
  } finally {closeSync(lock); unlinkSync(lockPath);}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i=0;i<args.length;i+=2) {
      const key = {'--checkout':'checkout','--head':'expectedHead','--base':'baseSha','--recipe':'recipe'}[args[i]];
      if (!key || Object.hasOwn(options,key) || !args[i+1]) throw Error('usage: node scripts/verify-local.mjs --checkout /absolute/repo --head <sha> --base <sha> --recipe affected-unit');
      options[key] = args[i+1];
    }
    const result = await verifyLocal(options); console.log(JSON.stringify({status:result.receipt.status,receipt:result.path,hostedCI:false}));
    process.exitCode = result.receipt.status === 'passed' ? 0 : 1;
  } catch (error) {console.error(error.code === 'EEXIST' ? 'local_verification_already_reserved; reconcile the existing run' : error.message); process.exitCode = 1;}
}
