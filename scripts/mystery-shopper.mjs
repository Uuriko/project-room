// Mystery Shopper runner (prototype for the "summon a shopper" feature).
//
// A shopper attempts ONE room's board cold, through the public door only:
// it holds no room credential and no insider session — just the published
// front door (llms.txt), a self-minted identity, and the public board. It
// may claim ONLY the tasks the summon named as test tasks; every other
// claimable task it sees is recorded as observed and deliberately not
// attempted (the guard step in the report proves the restraint happened).
//
// Usage:
//   node scripts/mystery-shopper.mjs --base http://127.0.0.1:4173 \
//     --room <roomId> --namespace <public namespaceId> \
//     --test-task <offerId> [--test-task <offerId> ...] \
//     --requested-by <memberId> [--summon-id <id>] [--out report.json]
//
// The report (shopper-report/1, see scripts/shopper-report.mjs) is written
// to --out or stdout. The shopper's identity secret is never printed or
// written anywhere: call evidence carries hashes and redacted excerpts.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SHOPPER_STEPS, SHOPPER_PROVENANCE, buildShopperReport } from './shopper-report.mjs';
import { solveIdentityMintProof } from '../server/agent-identities.mjs';

export const SHOPPER_DISPLAY_NAME = 'Mystery Shopper';
const REDACTED_KEYS = new Set(['secret', 'privateKey', 'secretHash']);
export const excerptOf = body => {
  let text;
  try {
    const parsed = JSON.parse(body);
    const scrub = value => Array.isArray(value) ? value.map(scrub)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, REDACTED_KEYS.has(key) ? '<redacted>' : scrub(item)]))
      : value;
    text = JSON.stringify(scrub(parsed));
  } catch { text = body; }
  return text.replace(/\s+/g, ' ').slice(0, 280);
};

// The restraint rule, pure so tests can pin it: from everything claimable,
// a shopper may attempt only tasks the summon marked as test tasks, in the
// summoned room's namespace. Anything else is untouchable, even if it is
// the only claimable work on the board.
export function selectClaimTarget(tasks, { namespaceId, testTaskIds }) {
  const test = new Set(testTaskIds);
  return tasks.find(task => task.claimable && task.namespaceId === namespaceId && test.has(task.taskId)) ?? null;
}

function parseArgs(argv) {
  const args = { testTasks: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--test-task') args.testTasks.push(argv[++i]);
    else if (key.startsWith('--')) args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`mystery-shopper: unexpected argument ${key}`);
  }
  for (const key of ['base', 'room', 'namespace', 'requestedBy']) if (!args[key]) throw new Error(`mystery-shopper: --${key.replace(/([A-Z])/g, '-$1').toLowerCase()} is required`);
  if (!args.testTasks.length) throw new Error('mystery-shopper: at least one --test-task is required (a shopper never chooses its own targets)');
  return args;
}

export async function runShopper({ base, room, namespace, testTasks, requestedBy, summonId, fetchImpl = fetch }) {
  const origin = base.replace(/\/$/, '');
  const call = async (method, path, { secret, body } = {}) => {
    const started = performance.now();
    const response = await fetchImpl(origin + path, { method,
      headers: { 'content-type': 'application/json', 'user-agent': 'project-room-mystery-shopper/1', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const record = { method, path, status: response.status, ms: Math.round((performance.now() - started) * 10) / 10,
      responseSha256: createHash('sha256').update(text).digest('hex'), excerpt: excerptOf(text) };
    let json = null;
    try { json = JSON.parse(text); } catch { /* the door also serves text (llms.txt) */ }
    // Steps evidence the record only — never json/text: a raw body in a
    // report is a credential leak waiting for a sensitive endpoint.
    return { record, json, text };
  };
  const steps = [];
  const step = (id, status, severity, observed, stepCalls) =>
    steps.push({ step: id, status, severity, expected: SHOPPER_STEPS[id], observed, calls: stepCalls });
  const door = await call('GET', '/llms.txt');
  const doorNamesDoor = /public[-_ ]work|\/api\/public-work/.test(door.text);
  step('fetch-front-door', door.record.status === 200 && doorNamesDoor ? 'ok' : 'blocked', door.record.status === 200 && doorNamesDoor ? 'none' : 'blocking',
    door.record.status !== 200 ? `Front door answered HTTP ${door.record.status}` : doorNamesDoor ? 'llms.txt answered 200 and names the public-work door' : 'llms.txt answered 200 but never names the public-work door', [door.record]);

  let identity = null, secret = null;
  const mintBody = { displayName: SHOPPER_DISPLAY_NAME };
  let mint = await call('POST', '/api/agent-identities', { body: mintBody });
  const mintCalls = [mint.record];
  if (mint.record.status !== 201 && mint.record.status !== 200) {
    mint = await call('POST', '/api/agent-identities', { body: { ...mintBody, proof: solveIdentityMintProof(SHOPPER_DISPLAY_NAME) } });
    mintCalls.push(mint.record);
  }
  if (mint.json?.identityId && mint.json?.secret) { identity = mint.json; secret = mint.json.secret; }
  step('mint-identity', identity ? 'ok' : 'blocked', identity ? 'none' : 'blocking',
    identity ? `Minted identity ${identity.identityId} with no prior credential` : `Mint refused: HTTP ${mint.record.status} ${mint.json?.error?.code ?? ''}`.trim(), mintCalls);

  let tasks = [], boardCall = null;
  if (identity) {
    boardCall = await call('GET', '/api/public-work/tasks?limit=100');
    tasks = boardCall.json?.tasks ?? [];
    step('list-board', boardCall.record.status === 200 ? 'ok' : 'blocked', boardCall.record.status === 200 ? 'none' : 'blocking',
      boardCall.record.status === 200 ? `Board listed ${tasks.length} tasks, ${boardCall.json.claimableCount} claimable` : `Board read failed: HTTP ${boardCall.record.status}`, [boardCall.record]);
    const mine = tasks.filter(task => task.namespaceId === namespace);
    step('scope-board', mine.length ? 'ok' : 'blocked', mine.length ? 'none' : 'blocking',
      mine.length ? `${mine.length} of ${tasks.length} board tasks carry the room's namespace` : "None of the board tasks carries the summoned room's namespace — the packet's opaque namespaceId is the only room attribution the public door offers", [boardCall.record]);
  }
  const inScope = tasks.filter(task => task.namespaceId === namespace);
  const target = identity ? selectClaimTarget(tasks, { namespaceId: namespace, testTaskIds: testTasks }) : null;
  const realObserved = inScope.filter(task => task.claimable && !testTasks.includes(task.taskId)).length;

  if (target) {
    const read = await call('GET', `/api/public-work/tasks/${encodeURIComponent(target.taskId)}`);
    const packet = read.json;
    step('read-task', read.record.status === 200 && Array.isArray(packet?.acceptanceCriteria) ? 'ok' : 'friction',
      read.record.status === 200 && Array.isArray(packet?.acceptanceCriteria) ? 'none' : 'major',
      read.record.status === 200 ? `Test task ${target.taskId} reads back with ${packet.acceptanceCriteria?.length ?? 0} acceptance criteria and ${packet.files?.length ?? 0} declared files` : `Test task read failed: HTTP ${read.record.status}`, [read.record]);
    const match = await call('POST', '/api/public-work/match', { secret, body: { requestId: `shopper-match-${summonId}`, autoClaim: false, limit: 5 } });
    const recommended = (match.json?.recommendations ?? []).some(entry => entry.task?.taskId === target.taskId);
    step('match', match.record.status === 200 ? 'ok' : 'friction', match.record.status === 200 && recommended ? 'none' : match.record.status === 200 ? 'minor' : 'major',
      match.record.status !== 200 ? `Match failed: HTTP ${match.record.status}` : recommended ? 'Match recommended the test task without claiming it' : 'Match answered 200 but did not recommend the claimable test task', [match.record]);
  }
  step('guard-real-task', 'ok', 'none',
    realObserved ? `${realObserved} real claimable task(s) in the room were observed and deliberately not attempted` : 'No real claimable work was on the board to restrain from', []);

  let receiptId = null;
  if (target && identity) {
    const claimed = await call('POST', `/api/public-work/tasks/${encodeURIComponent(target.taskId)}/claim`, { secret,
      body: { requestId: `shopper-claim-${summonId}`, expectedTermsVersion: target.termsVersion, leaseHours: 1 } });
    const generation = claimed.json?.task?.claim?.generation;
    step('claim-test-task', claimed.record.status === 200 ? 'ok' : 'blocked', claimed.record.status === 200 ? 'none' : 'blocking',
      claimed.record.status === 200 ? `Claimed test task ${target.taskId} at generation ${generation}` : `Claim refused: HTTP ${claimed.record.status} ${claimed.json?.error?.message ?? ''}`.trim(), [claimed.record]);
    if (claimed.record.status === 200) {
      const finished = await call('POST', `/api/public-work/tasks/${encodeURIComponent(target.taskId)}/finish`, { secret,
        body: { requestId: `shopper-finish-${summonId}`, expectedTermsVersion: target.termsVersion, generation,
          artifactText: 'Receipt: the stored, hash-verifiable record that a piece of work was delivered and what it claimed.',
          checksReported: ['read acceptance criteria', 'artifact is exactly one line of text'] } });
      receiptId = finished.json?.receipt?.receiptId ?? null;
      step('finish-test-task', receiptId ? 'ok' : 'blocked', receiptId ? 'none' : 'blocking',
        receiptId ? `Finish accepted; receipt ${receiptId} issued` : `Finish refused: HTTP ${finished.record.status} ${finished.json?.error?.message ?? ''}`.trim(), [finished.record]);
      if (receiptId) {
        const readBack = await call('GET', `/api/public-work/receipts/${receiptId}`);
        step('read-receipt', readBack.record.status === 200 ? 'ok' : 'friction', readBack.record.status === 200 ? 'none' : 'major',
          readBack.record.status === 200 ? `Receipt reads back publicly with verification: ${readBack.json?.verification ?? 'unspecified'}` : `Receipt read-back failed: HTTP ${readBack.record.status}`, [readBack.record]);
      }
    }
  }
  return buildShopperReport({
    generatedAt: new Date().toISOString(),
    summon: { summonId, roomId: room, requestedBy },
    shopper: { identityId: identity?.identityId ?? null, displayName: SHOPPER_DISPLAY_NAME, provenance: SHOPPER_PROVENANCE, mode: 'public-door-only' },
    scope: { origin, namespaceId: namespace, testTaskIds: testTasks, realTasksObservedNotAttempted: realObserved },
    steps, receiptId });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summonId = args.summonId ?? `sum_${createHash('sha256').update(`${args.room}:${Date.now()}`).digest('hex').slice(0, 24)}`;
  const report = await runShopper({ base: args.base, room: args.room, namespace: args.namespace, testTasks: args.testTasks, requestedBy: args.requestedBy, summonId });
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.out) writeFileSync(args.out, text); else process.stdout.write(text);
  console.error(`mystery-shopper: outcome=${report.outcome} calls=${report.totals.calls} blocking=${report.totals.blocking} major=${report.totals.major} minor=${report.totals.minor} receipt=${report.receiptId ?? 'none'}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
