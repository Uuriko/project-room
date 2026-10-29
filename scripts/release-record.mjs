// Read-only evidence composition. Digests identify bytes, not trusted producers.
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verificationPolicy } from './release-checkpoint.mjs';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_FILE = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const identity = value => value && SHA.test(value.revision) && SHA.test(value.tree) && typeof value.clean === 'boolean';
const origin = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href.replace(/\/$/, '') === value; }
  catch { return false; }
};
function doorsMatch(rows, origins, revision, start, end) {
  if (!Array.isArray(rows) || rows.length !== 4) return false;
  const keys = new Set();
  for (const row of rows) {
    if (!origins.includes(row?.origin) || row.error || row.httpStatus !== 200 || row.value?.status !== 'ok'
        || row.value.sourceRevision !== revision || !date(row.checkedAt) || row.checkedAt < start || row.checkedAt > end) return false;
    const key = `${row.origin}:${row.value.servedBy === 'worker' ? 'worker' : 'do'}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}
function strictFacts(report, origins, revision) {
  if (!Array.isArray(report?.checks)) return false;
  const byName = new Map(report.checks.map(row => [row.name, row]));
  for (const door of origins) {
    for (const path of ['/api/version', '/api/version/worker']) {
      const row = byName.get(`version ${door}${path}`);
      if (row?.status !== 200 || row.got !== revision) return false;
    }
    const health = byName.get(`health ${door}/api/health`), ready = byName.get(`ready ${door}/api/ready`);
    if (health?.status !== 200 || health.body !== 'ok' || ready?.status !== 200 || ready.body !== 'ready'
        || ready.do?.status !== 'ok' || ready.emailVerification !== 'enforced' || ready.emailVerificationScope !== 'durable-object') return false;
    for (const path of ['/terms', '/privacy', '/']) if (byName.get(`page ${door}${path}`)?.status !== 200) return false;
    const card = byName.get(`agent-card ${door}/.well-known/agent-card.json`);
    if (card?.fetches !== 10 || card.converged !== true || !Number.isSafeInteger(card.attempts) || card.attempts < 10
        || card.failureCount !== 0 || !Array.isArray(card.failures) || card.failures.length !== 0) return false;
  }
  return true;
}

export async function composeReleaseRecord({ repository, revision, tree, evidenceRoot, attempts }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !SHA.test(revision ?? '') || !SHA.test(tree ?? '')) fail('invalid_target');
  if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 32) fail('invalid_attempt_count');
  const root = await realpath(evidenceRoot);
  const evidence = new Map(), history = new Map(); let total = 0;
  const read = async (path, kind, producer = null) => {
    const actual = await realpath(resolve(root, path));
    const ref = relative(root, actual);
    if (!ref || ref === '..' || ref.startsWith(`..${sep}`) || isAbsolute(ref)) fail('evidence_outside_root');
    const handle = await open(actual, 'r');
    let bytes;
    try {
      if (!(await handle.stat()).isFile()) fail('evidence_not_file');
      const buffer = Buffer.alloc(MAX_FILE + 1);
      let used = 0;
      while (used < buffer.length) {
        const result = await handle.read(buffer, used, buffer.length - used, null);
        if (!result.bytesRead) break;
        used += result.bytesRead;
      }
      if (used > MAX_FILE) fail('evidence_too_large');
      bytes = buffer.subarray(0, used); total += used;
      if (total > 16 * MAX_FILE) fail('evidence_budget_exceeded');
    } finally { await handle.close(); }
    let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid_evidence_json'); }
    const digest = hash(bytes), reference = ref.split(sep).join('/');
    const item = { kind, reference, sha256: digest, bytes: bytes.length, producer, recordedAt: null, source: { revision, tree } };
    evidence.set(`${reference}:${kind}`, item);
    return { value, item, actual };
  };
  for (const path of attempts) {
    const loaded = await read(path, 'verification-receipt'), r = loaded.value;
    if (r?.schemaVersion !== 1 || r.mode !== 'verify-only' || !['verified', 'failed'].includes(r.state)
        || !date(r.startedAt) || !date(r.completedAt) || r.completedAt < r.startedAt
        || !Array.isArray(r.origins) || r.origins.length !== 2 || new Set(r.origins).size !== 2 || !r.origins.every(origin)) fail('invalid_verification_receipt');
    if (r.expectedRevision !== revision) fail('mixed_target_revision');
    if (!identity(r.sourceBefore) || r.sourceBefore.revision !== revision || r.sourceBefore.tree !== tree) fail('mixed_target_source');
    if (!identity(r.toolingBefore)) fail('invalid_tool_identity');
    const producer = { revision: r.toolingBefore.revision, tree: r.toolingBefore.tree };
    loaded.item.producer = producer; loaded.item.recordedAt = r.completedAt;
    for (const [key, file] of [['strict', 'strict-smoke.json'], ['live', 'live-smoke.json']]) {
      if (r[key] === undefined) continue;
      const sidecar = await read(resolve(dirname(loaded.actual), file), `${key}-smoke`, producer);
      sidecar.item.recordedAt = r.completedAt;
      if (canonical(sidecar.value) !== canonical(r[key])) fail('sidecar_receipt_mismatch');
    }
    let originalFailure = null;
    if (r.originalFailure !== undefined) {
      const original = r.originalFailure;
      if (original?.file !== 'original-failure.json' || !DIGEST.test(original.sha256 ?? '') || !Number.isSafeInteger(original.bytes)) fail('invalid_original_reference');
      const saved = await read(resolve(dirname(loaded.actual), original.file), 'original-failed-smoke');
      if (saved.item.sha256 !== original.sha256 || saved.item.bytes !== original.bytes) fail('original_failure_digest_mismatch');
      const report = saved.value;
      if (report?.ok !== false || report.sha !== revision || report.origin !== r.origins[0] || report.entry !== r.origins[1]
          || !Array.isArray(report.checks) || !report.checks.some(c => c.pass === false)) fail('invalid_original_failure');
      originalFailure = { evidence: saved.item.reference, sha256: saved.item.sha256, result: 'failed', recordedAt: null };
    }
    const policy = verificationPolicy(r.strict, r.live, { expectedRevision: revision, origins: r.origins });
    const stableSource = r.sourceBefore.clean && r.toolingBefore.clean && canonical(r.sourceBefore) === canonical(r.sourceAfter)
      && canonical(r.toolingBefore) === canonical(r.toolingAfter);
    const stableServing = doorsMatch(r.before, r.origins, revision, r.startedAt, r.completedAt)
      && doorsMatch(r.after, r.origins, revision, r.startedAt, r.completedAt)
      && Math.max(...r.before.map(row => Date.parse(row.checkedAt))) <= Math.min(...r.after.map(row => Date.parse(row.checkedAt)));
    const passed = !r.error && stableSource && stableServing && policy.strictPassed && policy.livePassed && strictFacts(r.strict?.report, r.origins, revision);
    const result = passed ? 'verified-observation' : 'failed';
    const warnings = policy.warnings.map(w => ({ code: /^[a-z0-9_-]{1,80}$/.test(w.code) ? w.code : 'unrecognized', severity: w.severity, known: typeof w.known === 'string' }));
    const attempt = { id: loaded.item.sha256, evidence: loaded.item.reference, startedAt: r.startedAt, completedAt: r.completedAt,
      target: { revision, tree }, producer, origins: r.origins, result, claimedState: r.state,
      sourceObservations: { before: { revision: r.sourceBefore.revision, tree: r.sourceBefore.tree, clean: r.sourceBefore.clean },
        after: identity(r.sourceAfter) ? { revision: r.sourceAfter.revision, tree: r.sourceAfter.tree, clean: r.sourceAfter.clean } : null },
      claimedStateConsistent: (r.state === 'verified') === passed, stableSource, stableServing,
      strictPassed: Boolean(policy.strictPassed && strictFacts(r.strict?.report, r.origins, revision)), livePassed: policy.livePassed,
      warnings, originalFailure };
    // Identical receipt bytes are one observation, even if explicitly supplied twice.
    const previous = history.get(attempt.id);
    if (!previous || attempt.evidence < previous.evidence) history.set(attempt.id, attempt);
  }
  const ordered = [...history.values()].sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id));
  const target = { repository, revision, tree };
  return { schemaVersion: 1, id: hash(canonical(target)), target,
    adapters: { verification: 'implemented', merge: 'not-implemented', deployment: 'not-implemented', publication: 'not-implemented' },
    observations: { merge: { state: 'unknown' }, deployment: { state: 'unknown' }, publication: { state: 'unknown' },
      verification: { state: 'observed', latestAttempt: ordered.at(-1).id, latestResult: ordered.at(-1).result, currentHealth: 'unknown' } },
    attempts: ordered, evidence: [...evidence.values()].sort((a, b) => a.reference.localeCompare(b.reference) || a.kind.localeCompare(b.kind)),
    limitations: ['Local consistency validation only: digests identify bytes, not producer authenticity or release authority.',
      'Receipt times are producer-reported. A past passing sample is not current health or proof of merge, upload, publication or incident resolution.',
      'Public checks do not establish authenticated or browser journeys. Only the verification adapter is implemented.'],
    nextActions: ['Use fresh observations before any release action; inspect original evidence for warnings and failures.',
      'Supply separately validated merge, deployment and publication evidence when those adapters exist.'] };
}

function options(argv) {
  const result = { attempts: [] }, flags = { '--repo': 'repository', '--revision': 'revision', '--tree': 'tree', '--evidence-root': 'evidenceRoot', '--attempt': 'attempt' };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]], value = argv[++i];
    if (!key || !value || value.startsWith('--') || (key !== 'attempt' && result[key] !== undefined)) fail('invalid_arguments');
    if (key === 'attempt') result.attempts.push(value); else result[key] = value;
  }
  if (!result.evidenceRoot) fail('missing_evidence_root');
  return result;
}
const HELP = 'Usage: node scripts/release-record.mjs --repo OWNER/REPO --revision FULL_SHA --tree FULL_TREE_SHA --evidence-root DIRECTORY --attempt RELATIVE_RECEIPT [--attempt RELATIVE_RECEIPT...]\nReads only explicit attempts and their fixed adjacent sidecars. JSON record on stdout; concise observation summary on stderr. No network or mutation APIs.';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') === '--help') console.log(HELP);
  else {
    try {
      const record = await composeReleaseRecord(options(process.argv.slice(2)));
      console.log(JSON.stringify(record, null, 2));
      console.error(`Verification history: ${record.attempts.length} attempt(s); latest ${record.observations.verification.latestResult}; current health, merge, deployment and publication unknown.`);
    } catch (error) {
      const code = /^[a-z_]+$/.test(error.message ?? '') ? error.message : 'evidence_unavailable';
      console.error(`release-record: ${code}`); process.exitCode = 1;
    }
  }
}
