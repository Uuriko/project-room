import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { canonical, digest, event, requireThat, transaction } from './store.mjs';

const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const safePath = value => typeof value === 'string' && value.length < 240 && !value.includes('\\') && value.split('/').every(p => p && p !== '.' && p !== '..') && !value.startsWith('/');
export function installPackage(store, root, manifest) {
  requireThat(manifest?.schema === 1 && id(manifest.capability) && id(manifest.version) && manifest.runtime === process.version
    && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 128
    && Array.isArray(manifest.steps) && manifest.steps.length > 0 && manifest.steps.length <= 16, 'invalid_manifest');
  requireThat(Number.isSafeInteger(manifest.resources?.cpu) && manifest.resources.cpu >= 1 && manifest.resources.cpu <= 64
    && Number.isSafeInteger(manifest.resources?.memoryBytes) && manifest.resources.memoryBytes >= 64 * 1024 ** 2, 'invalid_resources');
  const names = new Set(); const bytes = new Map(); root = realpathSync(root);
  for (const file of manifest.files) {
    requireThat(safePath(file.path) && !names.has(file.path) && /^[a-f0-9]{64}$/.test(file.sha256), 'invalid_package_file');
    const path = resolve(root, file.path), real = realpathSync(path), stat = lstatSync(path);
    requireThat(real.startsWith(root + sep) && real === path && stat.isFile() && stat.size <= 8 * 1024 ** 2, 'unsafe_package_file');
    const data = readFileSync(path); requireThat(digest(data) === file.sha256, 'package_hash_mismatch');
    names.add(file.path); bytes.set(file.path, data);
  }
  const steps = new Set();
  for (const step of manifest.steps) {
    requireThat(id(step.id) && !steps.has(step.id) && names.has(step.module)
      && Number.isSafeInteger(step.timeoutMs) && step.timeoutMs > 0 && step.timeoutMs <= 3600000
      && Array.isArray(step.args) && step.args.length <= 32 && step.args.every(a => typeof a === 'string' && a.length <= 1024), 'invalid_step');
    steps.add(step.id);
  }
  const encoded = canonical(manifest), hash = digest(encoded);
  const target = join(store.directory, 'packages', hash); mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const [name, data] of bytes) {
    const path = join(target, name); mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, data, { flag: 'wx', mode: 0o400 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; requireThat(digest(readFileSync(path)) === digest(data), 'installed_package_changed'); }
  }
  transaction(store, () => {
    store.db.prepare('INSERT OR IGNORE INTO packages VALUES(?,?,?)').run(hash, manifest.capability, encoded);
    event(store, 'package.installed', hash, { capability: manifest.capability, version: manifest.version });
  });
  return { hash, capability: manifest.capability, version: manifest.version };
}
export function getPackage(store, hash) {
  const row = store.db.prepare('SELECT * FROM packages WHERE hash=?').get(hash);
  requireThat(row, 'package_not_found');
  const manifest = JSON.parse(row.manifest); requireThat(digest(canonical(manifest)) === hash, 'manifest_changed');
  return { hash, manifest, directory: join(store.directory, 'packages', hash) };
}
export function verifyPackage(store, hash) {
  const pack = getPackage(store, hash);
  requireThat(pack.manifest.runtime === process.version, 'runtime_changed');
  for (const file of pack.manifest.files) {
    const path = join(pack.directory, file.path);
    requireThat(realpathSync(path) === path && lstatSync(path).isFile() && digest(readFileSync(path)) === file.sha256, 'installed_package_changed');
  }
  return pack;
}
export function activation(store, capability) { return store.db.prepare('SELECT * FROM activations WHERE capability=?').get(capability) ?? null; }
export function activate(store, { capability, hash, expectedRevision, percent = 100, reason, bootstrap = false }) {
  requireThat(typeof reason === 'string' && reason.trim() && Number.isInteger(percent) && percent >= 0 && percent <= 100, 'invalid_activation');
  const pack = verifyPackage(store, hash); requireThat(pack.manifest.capability === capability, 'capability_mismatch');
  return transaction(store, () => {
    const old = activation(store, capability); requireThat((old?.revision ?? 0) === expectedRevision, 'activation_conflict');
    if (!old) {
      requireThat(bootstrap && percent === 100, 'bootstrap_required');
      store.db.prepare('INSERT INTO activations(capability,current) VALUES(?,?)').run(capability, hash);
    } else {
      if (hash !== old.current && percent > 0) {
        const evidence = store.db.prepare('SELECT evidence FROM evaluations WHERE capability=? AND baseline=? AND candidate=?').all(capability, old.current, hash);
        requireThat(evidence.some(e => JSON.parse(e.evidence).passed), 'evaluation_required');
      }
      store.db.prepare('UPDATE activations SET current=?,candidate=?,percent=?,revision=revision+1 WHERE capability=?').run(percent === 100 ? hash : old.current, percent === 100 || percent === 0 ? null : hash, percent === 100 ? 0 : percent, capability);
    }
    event(store, 'capability.activated', capability, { hash, percent, reason, previous: old?.current ?? null });
    return activation(store, capability);
  });
}
// Evidence is derived from completed jobs, never a caller-supplied pass boolean.
export function evaluate(store, { capability, baseline, candidate, pairs }) {
  requireThat(baseline !== candidate && Array.isArray(pairs) && pairs.length >= 2 && pairs.length <= 100, 'evaluation_cases_required');
  const inputs = new Set(), evidence = [];
  for (const pair of pairs) {
    const a = store.db.prepare('SELECT * FROM jobs WHERE id=?').get(pair.baselineJob);
    const b = store.db.prepare('SELECT * FROM jobs WHERE id=?').get(pair.candidateJob);
    requireThat(a?.state === 'completed' && b?.state === 'completed' && a.pin === baseline && b.pin === candidate && a.room === b.room, 'evaluation_jobs_invalid');
    const ai = JSON.parse(a.payload), bi = JSON.parse(b.payload);
    requireThat(ai.capability === capability && bi.capability === capability && canonical(ai.input) === canonical(bi.input), 'evaluation_input_mismatch');
    inputs.add(digest(canonical(ai.input)));
    const ar = JSON.parse(a.result), br = JSON.parse(b.result);
    requireThat(ar.artifacts?.length > 0 && br.artifacts?.length > 0, 'evaluation_artifacts_required');
    evidence.push({ ...pair, equal: ar.artifactDigest === br.artifactDigest, baselineMs: ar.elapsedMs, candidateMs: br.elapsedMs });
  }
  requireThat(inputs.size >= 2, 'distinct_evaluation_inputs_required');
  const value = { passed: evidence.every(e => e.equal), evaluator: 'artifact-equivalence-v1', pairs: evidence };
  const evaluationId = digest(canonical({ capability, baseline, candidate, value }));
  transaction(store, () => {
    store.db.prepare('INSERT OR IGNORE INTO evaluations VALUES(?,?,?,?,?)').run(evaluationId, capability, baseline, candidate, canonical(value));
    event(store, 'capability.evaluated', capability, { evaluationId, ...value });
  });
  return { evaluationId, ...value };
}

export function rollback(store, { capability, expectedRevision, reason }) {
  requireThat(typeof reason === 'string' && reason.trim(), 'rollback_reason_required');
  return transaction(store, () => {
    const old = activation(store, capability); requireThat(old?.revision === expectedRevision, 'activation_conflict');
    const history = store.db.prepare("SELECT data FROM events WHERE kind='capability.activated' AND subject=? ORDER BY seq DESC").all(capability);
    const previous = history.map(r => JSON.parse(r.data)).find(r => r.percent === 100 && r.hash === old.current && r.previous && r.previous !== old.current)?.previous;
    const target = old.candidate ? old.current : previous; requireThat(target, 'no_rollback_version'); verifyPackage(store, target);
    store.db.prepare('UPDATE activations SET current=?,candidate=NULL,percent=0,revision=revision+1 WHERE capability=?').run(target, capability);
    event(store, 'capability.rolled_back', capability, { previous: old.current, target, reason });
    return activation(store, capability);
  });
}
