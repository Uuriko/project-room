// Preview only: evidence is inspected, never executed or sent to Room.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseJunit } from './report-test-failures.mjs';
import { buildWorkCommand } from '../client/work-actions.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const sha = /^[a-f0-9]{40}$/;
const scriptPath = value => typeof value === 'string' && value.length <= 240 && /^scripts\/[\w/-]+\.mjs$/.test(value) && !value.split('/').includes('..');
function boundedRead(path, limit) {
  if (!statSync(path).isFile() || statSync(path).size > limit) fail('Evidence file exceeds bound');
  const bytes = readFileSync(path);
  if (bytes.length > limit) fail('Evidence file exceeds bound');
  return bytes;
}

export function buildBrowserFailureWork(options) {
  const { checkout, revision, tree, runId, runAttempt, receipt: receiptPath, junit: junitPath,
    sourceRoot, accountableMember, repo } = options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !sha.test(revision ?? '') || !sha.test(tree ?? '')) fail('Require repository and full source revision/tree');
  if (!/^[\w.-]{1,100}$/.test(runId ?? '') || !/^[1-9]\d{0,8}$/.test(String(runAttempt ?? ''))) fail('Invalid run identity');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(accountableMember ?? '')) fail('Invalid accountable member');
  if (!sourceRoot || !isAbsolute(sourceRoot)) fail('Require absolute producer source root');
  const git = args => execFileSync('git', ['-C', resolve(checkout), ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['rev-parse', '--verify', `${revision}^{commit}`]) !== revision || git(['rev-parse', `${revision}^{tree}`]) !== tree) fail('Source revision/tree mismatch');
  const remote = git(['config', '--get', 'remote.origin.url']);
  const remoteRepo = remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  if (remoteRepo?.toLowerCase() !== repo.toLowerCase()) fail('Repository/source mismatch');
  const receiptBytes = boundedRead(receiptPath, 256 * 1024), junitBytes = boundedRead(junitPath, 8 * 1024 * 1024);
  let receipt;
  try { receipt = JSON.parse(receiptBytes.toString('utf8')); } catch { fail('Malformed receipt'); }
  if (!receipt || receipt.revision !== revision || receipt.runId !== runId || String(receipt.runAttempt) !== String(runAttempt)
    || !Number.isSafeInteger(receipt.index) || !Number.isSafeInteger(receipt.total) || receipt.index < 1 || receipt.index > receipt.total || receipt.total > 64
    || !/^[a-f0-9]{64}$/.test(receipt.planHash ?? '') || receipt.signal !== null || !Number.isInteger(receipt.status) || receipt.status < 1 || receipt.status > 255)
    fail('Receipt identity or failed-run status mismatch');
  if (!Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 1000 || receipt.files.some(file => !scriptPath(file))
    || new Set(receipt.files).size !== receipt.files.length) fail('Invalid receipt file membership');
  const tracked = new Set(git(['ls-tree', '-r', revision, '--', 'scripts']).split('\n')
    .filter(row => /^100(?:644|755) blob /.test(row)).map(row => row.slice(row.indexOf('\t') + 1)));
  if (receipt.files.some(file => !tracked.has(file))) fail('Receipt names a file outside source revision');
  const xml = junitBytes.toString('utf8');
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<testsuites\b/.test(xml) || !/<\/testsuites>\s*$/.test(xml)
    || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail('Malformed JUnit document');
  // parseJunit intentionally tolerates reporter variation. Intake additionally
  // refuses incomplete cases and mismatched failed-case cardinality.
  const openings = [...xml.matchAll(/<testcase\b(?:[^>"\n]|"[^"]*")*>/g)];
  const closes = [...xml.matchAll(/<\/testcase>/g)].length;
  if (openings.filter(match => !/\/\s*>$/.test(match[0])).length !== closes) fail('Incomplete JUnit testcases');
  for (const tag of ['failure', 'error']) {
    const starts = [...xml.matchAll(new RegExp(`<${tag}\\b(?:[^>"\\n]|"[^"]*")*>`, 'g'))];
    if (starts.filter(match => !/\/\s*>$/.test(match[0])).length !== [...xml.matchAll(new RegExp(`</${tag}>`, 'g'))].length)
      fail('Incomplete JUnit failure');
  }
  const parsed = parseJunit(xml, { cwd: resolve(sourceRoot) });
  if (parsed.cases.length !== openings.length || parsed.cases.length > 10000) fail('Invalid testcase count');
  const failed = parsed.cases.filter(item => item.status === 'failed');
  if (!failed.length || failed.length > 100 || [...xml.matchAll(/<(?:failure|error)\b/g)].length !== failed.length) fail('Require 1–100 actual failed cases');
  const byId = new Map();
  for (const item of parsed.cases) {
    const script = item.file;
    if (!scriptPath(script) || !receipt.files.includes(script)) fail('Testcase is outside receipt/source root');
    if (item.status !== 'failed') continue;
    if (!item.name || item.name.length > 512 || /[\u0000-\u001f\u007f]/.test(item.name)) fail('Invalid failed testcase name');
    const id = `browser-failure-${hash(JSON.stringify([repo.toLowerCase(), revision, script, item.name])).slice(0, 40)}`;
    const args = { requestId: `${id}-propose`, workItemId: id,
      title: `Reproduce browser failure in ${script}`,
      definitionOfDone: `Reproduce failure ${id} at ${repo.toLowerCase()} revision ${revision} (tree ${tree}); retain original evidence, classify product or test defect, and report fix validation and release outcome. Evidence must be reviewed locally; no command is supplied by testcase text.`,
      accountableMemberId: accountableMember, mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false };
    buildWorkCommand('room_propose_work', args); // Existing action contract, no I/O.
    byId.set(id, { id, script, testName: item.name, workAction: { name: 'room_propose_work', args } });
  }
  const failures = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const packet = { version: 1, mode: 'preview', source: { repo: repo.toLowerCase(), revision, tree },
    observation: { runId, runAttempt: String(runAttempt), shard: { index: receipt.index, total: receipt.total }, planHash: receipt.planHash },
    evidence: { receiptSha256: hash(receiptBytes), junitSha256: hash(junitBytes), attestation: 'unsigned-inputs; source identity checked, execution not independently attested' },
    failures };
  if (Buffer.byteLength(JSON.stringify(packet)) > 256 * 1024) fail('Failure packet exceeds bound');
  return packet;
}

export function main(argv) {
  const names = { checkout: 'checkout', revision: 'revision', tree: 'tree', 'run-id': 'runId', 'run-attempt': 'runAttempt', receipt: 'receipt', junit: 'junit', 'source-root': 'sourceRoot', 'accountable-member': 'accountableMember', repo: 'repo', out: 'out' };
  if (argv.length === 1 && argv[0] === '--help') return 'Preview only: --checkout PATH --repo owner/name --revision SHA --tree SHA --run-id ID --run-attempt N --receipt FILE --junit FILE --source-root PATH --accountable-member ID --out FILE';
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]?.slice(2)];
    if (!argv[i]?.startsWith('--') || !key || options[key] !== undefined || !argv[i + 1]) fail('Invalid CLI arguments');
    options[key] = argv[i + 1];
  }
  if (Object.keys(options).length !== Object.keys(names).length) fail('All input and output options are required');
  const packet = buildBrowserFailureWork(options);
  writeFileSync(options.out, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return `Preview written: ${packet.failures.length} failure(s); no Room writes`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(main(process.argv.slice(2))); } catch { console.error('Browser failure intake refused: invalid inputs or output unavailable. No Room writes.'); process.exitCode = 1; }
}
