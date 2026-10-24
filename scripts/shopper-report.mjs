// Mystery Shopper report contract (prototype for the "summon a shopper"
// feature; design: the shopper-feature issue). A shopper is a platform agent
// that attempts one room's board cold, through the public door only, and
// files this report to the room owner. The schema is the contract between
// the shopper runner (scripts/mystery-shopper.mjs), the owner's inbox, and
// any future server-side summon endpoint: a report that does not validate
// here is not deliverable.
//
// Secrecy rule: a report NEVER carries credentials. Call evidence records
// method, path, status, timing and a hash + short excerpt of the response;
// the runner redacts secret-bearing fields before an excerpt is taken.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/audit-receipts.mjs';

export const SHOPPER_REPORT_SCHEMA = 'shopper-report/1';
export const SHOPPER_PROVENANCE = 'platform-shopper/1';
// Severity is ordered: a stranger's loop dies at "blocking", is taxed at
// "minor", and is likely to fail or misread at "major".
export const SHOPPER_SEVERITIES = Object.freeze(['none', 'minor', 'major', 'blocking']);
export const SHOPPER_STEP_STATUSES = Object.freeze(['ok', 'friction', 'blocked', 'skipped']);
// The step taxonomy mirrors the R1 agent loop (fetch door -> mint -> board
// -> claim -> finish -> receipt), plus the two shopper-only duties: scoping
// the board to the summoned room, and proving restraint on real work.
export const SHOPPER_STEPS = Object.freeze({
  'fetch-front-door': 'GET /llms.txt answers 200 and names the public-work door',
  'mint-identity': 'A fresh identity can be minted with no prior credential',
  'list-board': 'GET /api/public-work/tasks returns the public board',
  'scope-board': "The summoned room's tasks are identifiable in the board",
  'read-task': 'One test task reads back with terms, criteria and files',
  'match': 'POST /api/public-work/match recommends without claiming',
  'guard-real-task': 'Real (non-test) claimable work is observed and NOT attempted',
  'claim-test-task': 'The shopper claims a marked test task',
  'finish-test-task': 'The shopper finishes the test task and receives a receipt id',
  'read-receipt': 'The receipt reads back through the public door',
});

const fail = message => { throw new Error(`shopper-report: ${message}`); };
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

function checkCall(call, where) {
  if (!isRecord(call)) fail(`${where} must be an object`);
  // Exact key set, no extras: an evidence record that could carry a raw
  // response body could carry a credential with it. The secrecy rule is
  // enforced structurally here, not by runner good behavior.
  const keys = Object.keys(call).sort().join(',');
  if (keys !== 'excerpt,method,ms,path,responseSha256,status' && keys !== 'method,ms,path,responseSha256,status')
    fail(`${where} must carry exactly method, path, status, ms, responseSha256 and optional excerpt`);
  if (!['GET', 'POST'].includes(call.method)) fail(`${where}.method is not a door method`);
  if (!isText(call.path, 300) || !call.path.startsWith('/')) fail(`${where}.path must be a door path`);
  if (!Number.isInteger(call.status) || call.status < 100 || call.status > 599) fail(`${where}.status must be an HTTP status`);
  if (!Number.isFinite(call.ms) || call.ms < 0) fail(`${where}.ms must be a non-negative number`);
  if (typeof call.responseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(call.responseSha256)) fail(`${where}.responseSha256 must be a sha256 hex digest`);
  if (call.excerpt !== undefined && (typeof call.excerpt !== 'string' || call.excerpt.length > 280)) fail(`${where}.excerpt must be at most 280 characters`);
}

export function validateShopperReport(report) {
  if (!isRecord(report)) fail('report must be an object');
  if (report.schema !== SHOPPER_REPORT_SCHEMA) fail(`schema must be ${SHOPPER_REPORT_SCHEMA}`);
  if (typeof report.reportId !== 'string' || !/^shr_[0-9a-f]{64}$/.test(report.reportId)) fail('reportId must be shr_<sha256>');
  if (!isText(report.generatedAt, 40) || !Number.isFinite(Date.parse(report.generatedAt))) fail('generatedAt must be an ISO timestamp');
  const { summon, shopper, scope } = report;
  if (!isRecord(summon) || !isText(summon.summonId, 80) || !isText(summon.roomId, 384) || !isText(summon.requestedBy, 200)) fail('summon needs summonId, roomId and requestedBy');
  if (!isRecord(shopper) || shopper.provenance !== SHOPPER_PROVENANCE || shopper.mode !== 'public-door-only') fail('shopper must carry platform provenance and public-door-only mode');
  if (shopper.identityId !== null && !isText(shopper.identityId, 200)) fail('shopper.identityId must be an id or null (mint blocked)');
  if (!isText(shopper.displayName, 80)) fail('shopper.displayName is required');
  if (!isRecord(scope) || !isText(scope.origin, 300) || !isText(scope.namespaceId, 200)) fail('scope needs origin and namespaceId');
  if (!Array.isArray(scope.testTaskIds) || !scope.testTaskIds.length || !scope.testTaskIds.every(id => isText(id, 384))) fail('scope.testTaskIds must name at least one marked test task');
  if (!Number.isInteger(scope.realTasksObservedNotAttempted) || scope.realTasksObservedNotAttempted < 0) fail('scope.realTasksObservedNotAttempted must be a count');
  if (!['completed-loop', 'blocked', 'partial'].includes(report.outcome)) fail('outcome must be completed-loop, blocked or partial');
  if (!Array.isArray(report.steps) || !report.steps.length) fail('steps must be a non-empty array');
  const seen = new Set();
  for (const [index, step] of report.steps.entries()) {
    const where = `steps[${index}]`;
    if (!isRecord(step) || !Object.hasOwn(SHOPPER_STEPS, step.step)) fail(`${where}.step is not in the shopper taxonomy`);
    if (seen.has(step.step)) fail(`${where}.step duplicates ${step.step}`);
    seen.add(step.step);
    if (!SHOPPER_STEP_STATUSES.includes(step.status)) fail(`${where}.status is not a shopper step status`);
    if (!SHOPPER_SEVERITIES.includes(step.severity)) fail(`${where}.severity is not a shopper severity`);
    if ((step.severity === 'none') !== (step.status === 'ok' || step.status === 'skipped')) fail(`${where} severity/status disagree: only ok/skipped steps carry severity none`);
    if (!isText(step.expected, 300) || !isText(step.observed, 2000)) fail(`${where} needs expected and observed text`);
    if (!Array.isArray(step.calls)) fail(`${where}.calls must be an array`);
    step.calls.forEach((call, callIndex) => checkCall(call, `${where}.calls[${callIndex}]`));
  }
  if (!Array.isArray(report.friction)) fail('friction must be an array');
  for (const [index, item] of report.friction.entries()) {
    if (!isRecord(item) || !Object.hasOwn(SHOPPER_STEPS, item.step) || !SHOPPER_SEVERITIES.includes(item.severity) || item.severity === 'none'
      || !isText(item.summary, 2000) || !Array.isArray(item.evidenceCallIndexes) || !item.evidenceCallIndexes.every(n => Number.isInteger(n) && n >= 0))
      fail(`friction[${index}] must name a step, a non-none severity, a summary and evidence call indexes`);
  }
  const totals = report.totals;
  if (!isRecord(totals) || !['calls', 'ms', 'blocking', 'major', 'minor'].every(key => Number.isInteger(totals[key]) && totals[key] >= 0)) fail('totals must count calls, ms, blocking, major and minor');
  if (report.receiptId !== null && (typeof report.receiptId !== 'string' || !/^pwr_[0-9a-f]{64}$/.test(report.receiptId))) fail('receiptId must be a pwr_ id or null');
  if (report.outcome === 'completed-loop' && !report.receiptId) fail('a completed loop must name its receipt');
  return report;
}

// The friction list is derived, never hand-written: every step that taxed
// or blocked the loop, in step order, pointing at its call evidence. Call
// indexes address the run's distinct calls in step order — one HTTP call
// can evidence two steps (the board read also evidences board scoping) and
// is indexed once, at first sight.
export function frictionOf(steps) {
  const friction = [];
  const indexOf = new Map();
  for (const step of steps) {
    const indexes = step.calls.map(call => {
      if (!indexOf.has(call)) indexOf.set(call, indexOf.size);
      return indexOf.get(call);
    });
    if (step.severity !== 'none') friction.push({ step: step.step, severity: step.severity, summary: step.observed, evidenceCallIndexes: indexes });
  }
  return friction;
}

export function summarizeShopperReport(report) {
  validateShopperReport(report);
  const worst = report.steps.reduce((rank, step) => Math.max(rank, SHOPPER_SEVERITIES.indexOf(step.severity)), 0);
  return { outcome: report.outcome, worstSeverity: SHOPPER_SEVERITIES[worst],
    blocking: report.totals.blocking, major: report.totals.major, minor: report.totals.minor,
    calls: report.totals.calls, receiptId: report.receiptId };
}

// Assemble a report from a finished run and validate it before it exists:
// totals and friction are computed here so a runner cannot inflate either.
export function buildShopperReport({ generatedAt, summon, shopper, scope, steps, receiptId = null }) {
  const friction = frictionOf(steps);
  const totals = { calls: 0, ms: 0, blocking: 0, major: 0, minor: 0 };
  const distinctCalls = new Set(steps.flatMap(step => step.calls));
  totals.calls = distinctCalls.size;
  totals.ms = [...distinctCalls].reduce((sum, call) => sum + Math.round(call.ms), 0);
  for (const step of steps) {
    if (step.severity === 'blocking') totals.blocking += 1;
    if (step.severity === 'major') totals.major += 1;
    if (step.severity === 'minor') totals.minor += 1;
  }
  const blocked = steps.some(step => step.status === 'blocked');
  const outcome = receiptId ? 'completed-loop' : blocked ? 'blocked' : 'partial';
  const body = { schema: SHOPPER_REPORT_SCHEMA, generatedAt, summon, shopper, scope, outcome, steps, friction, totals, receiptId };
  const reportId = 'shr_' + createHash('sha256').update(canonicalJson(body)).digest('hex');
  return validateShopperReport({ reportId, ...body });
}
