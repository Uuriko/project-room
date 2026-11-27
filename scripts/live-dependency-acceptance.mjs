#!/usr/bin/env node
// Post-deployment acceptance for dependency-aware continuation, run by the
// operator against an EXISTING room with an EXISTING saved member credential.
// It creates two clearly labelled synthetic tasks and nothing else: no account,
// identity, room, listener, permission or configuration change.
//
// This is synthetic release evidence. It shows the deployed build behaves as
// qualified; it is not evidence that the product helped real project work.
//
// Required environment (paths, never secret values):
//   ROOM_ORIGIN              e.g. https://room.example
//   ROOM_ID                  e.g. commons
//   ROOM_EXPECTED_REVISION   full 40-character serving revision expected
//   ROOM_MEMBER_TOKEN_FILE   file holding the acting member's existing credential
//   ROOM_RUN_ID              short unique label, e.g. 20261116a  (reuse it to resume)
//   ROOM_EVIDENCE_DIR        private directory for the evidence JSON
// Gate for the prerequisite (pick one):
//   ROOM_REVIEWER_MEMBER_ID  an existing, different member with verify: the prerequisite
//                            requires that member's independent review. The script stops
//                            after submitting and resumes when that member has recorded a verdict.
//   ROOM_GATE=none           no independent gate; evidence is marked accordingly.
// Optional rehearsal against a disposable packaged instance behind no proxy:
//   ROOM_LOOPBACK_BASE       e.g. http://127.0.0.1:4999 (ROOM_ORIGIN still names the declared origin)
//
//   node scripts/live-dependency-acceptance.mjs            run or resume
//   node scripts/live-dependency-acceptance.mjs --dry-run  preflight only, no writes
//
// The service rate-limits a member (HTTP 429 after roughly two full runs a minute). A 429 stops the
// run safely; wait a minute and rerun with the same ROOM_RUN_ID.
// Every write uses a deterministic id derived from ROOM_RUN_ID, so a rerun after
// an unknown outcome repeats the same operations. Any unexpected observation
// stops the run before further writes and leaves the evidence file in place.
import fs from 'node:fs';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

process.umask(0o077);
const env = name => { const value = process.env[name]; if (!value) { console.error(`Missing ${name}`); process.exit(2); } return value; };
const origin = env('ROOM_ORIGIN').replace(/\/$/, ''), roomId = env('ROOM_ID'), expected = env('ROOM_EXPECTED_REVISION'), run = env('ROOM_RUN_ID');
if (!/^[0-9a-f]{40}$/.test(expected) || !/^[a-z0-9]{4,24}$/.test(run)) { console.error('ROOM_EXPECTED_REVISION must be a full commit; ROOM_RUN_ID must be 4-24 lowercase letters or digits'); process.exit(2); }
const token = fs.readFileSync(env('ROOM_MEMBER_TOKEN_FILE'), 'utf8').trim();
const evidenceDir = env('ROOM_EVIDENCE_DIR'); fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const evidencePath = path.join(evidenceDir, `dependency-acceptance-${run}.json`);
const reviewerId = process.env.ROOM_REVIEWER_MEMBER_ID || null, gate = reviewerId ? 'independent_review' : process.env.ROOM_GATE === 'none' ? 'none' : null;
if (!gate) { console.error('Set ROOM_REVIEWER_MEMBER_ID (preferred) or ROOM_GATE=none'); process.exit(2); }
const dryRun = process.argv.includes('--dry-run');
const loopback = process.env.ROOM_LOOPBACK_BASE || null;
const ids = { base: `relqual-${run}-prerequisite`, child: `relqual-${run}-dependent` };
const label = '[synthetic release qualification, not project work] ';

const evidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
  : { kind: 'synthetic-release-acceptance', notProjectWorkEvidence: true, origin, roomId, expectedRevision: expected, run, gate, tasks: ids, steps: {}, startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2).split(token).join('[credential withheld]') + '\n', { mode: 0o600 });
const record = (step, value) => { evidence.steps[step] = { at: new Date().toISOString(), ...value }; save(); };
const stop = (reason, detail) => { evidence.status = 'STOPPED'; evidence.stoppedBecause = reason; evidence.detail = detail ?? null; save();
  console.error(`STOPPED: ${reason}. No further writes were made. Evidence: ${evidencePath}`); process.exit(1); };
const expect = (ok, reason, detail) => { if (!ok) stop(reason, detail); };

function call(route, body, auth = true) {
  const target = new URL((loopback ?? origin) + route), send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(target, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(loopback ? { Host: new URL(origin).host, 'X-Real-IP': '127.0.0.1', 'X-Forwarded-Proto': 'https' } : {}),
      ...(auth ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ } resolve({ status: response.statusCode, json }); });
    });
    outgoing.on('error', reject); outgoing.setTimeout(20000, () => outgoing.destroy(new Error('request-timeout')));
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const tool = async (name, args = {}) => {
  const result = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { roomId, ...args } } });
  if (result.status !== 200 || result.json?.error || result.json?.result?.isError) stop(`tool ${name} failed`, { status: result.status, body: result.json?.error ?? result.json?.result?.structuredContent ?? null });
  return result.json.result.structuredContent;
};
// A repeated command id returns the original outcome; both count as recorded.
const command = async (step, type, data) => {
  const result = await call(`/api/rooms/${encodeURIComponent(roomId)}/commands`, { id: `relqual-${run}-${step}`, type, data });
  return { status: result.status, code: result.json?.error?.code ?? null, duplicate: result.json?.duplicate === true, eventId: result.json?.event?.id ?? null };
};
const work = id => tool('room_read_work', { workItemId: id });
const brief = (id, extra = {}) => tool('room_read_work', { workItemId: id, brief: true, ...extra });
// Exists only on a successful read; absent only on an explicit not-found. Anything else stops.
const exists = async id => {
  const result = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'room_read_work', arguments: { roomId, workItemId: id } } });
  const content = result.json?.result?.structuredContent;
  if (result.status === 200 && result.json?.result?.isError !== true && content?.work?.id === id) return true;
  const code = content?.code ?? content?.error?.code ?? result.json?.error?.data?.code ?? null;
  if (code === 'work_not_found' || /not found/i.test(JSON.stringify(content ?? result.json?.error ?? ''))) return false;
  return stop(`could not establish whether ${id} exists`, { status: result.status, body: content ?? result.json?.error ?? null });
};
const hint = value => ({ action: value.action, tool: value.tool, waitingOn: value.waitingOn ?? null, guidance: value.guidance });
const row = (state, id) => [...state.needsYou, ...state.inProgress, ...state.blocked].find(entry => entry.id === id) ?? null;
const proseWaits = text => /Do not claim or start/.test(text ?? '');

// Preflight: the intended build is serving, the credential is accepted, and the acting member is known.
const version = await call('/api/version', undefined, false), ready = await call('/api/ready', undefined, false);
expect(ready.status === 200 && ready.json?.status === 'ready', 'service is not ready', ready.json);
expect(version.json?.sourceRevision === expected, 'serving revision is not the expected revision', { serving: version.json?.sourceRevision ?? null, expected });
const access = await tool('room_check_access');
const me = access.memberId ?? access.member?.id ?? access.rooms?.find?.(entry => entry.roomId === roomId)?.memberId ?? null;
expect(typeof me === 'string', 'could not determine the acting member id from room_check_access', Object.keys(access));
expect(reviewerId !== me, 'the reviewer must be a different existing member; an independent review cannot be recorded by the producer');
const listed = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
const catalog = new Set((listed.json?.result?.tools ?? []).map(entry => entry.name));
expect(['room_project_state', 'room_read_work', 'room_begin_work', 'room_submit_text_result'].every(name => catalog.has(name)), 'default catalog lacks a required tool', [...catalog]);
if (!evidence.steps.preflight) record('preflight', { servingRevision: version.json.sourceRevision, buildId: version.json.buildId ?? null, actingMemberId: me, reviewerMemberId: reviewerId, catalogSize: catalog.size });
if (dryRun) { console.log(`Preflight passed for ${expected.slice(0, 8)} as ${me}. Dry run: nothing was written. Planned task ids: ${ids.base}, ${ids.child}`); process.exit(0); }

// 1. Prerequisite: proposed to the acting member, accepted and started. On legacy storage the
// dependent names the prerequisite's Board card, which exists once it has been accepted.
if (!await exists(ids.base)) {
  const proposed = await command('propose-prerequisite', 'work.proposed', { workItemId: ids.base, title: label + 'prerequisite', mode: 'read',
    definitionOfDone: 'One synthetic text result. Created by scripts/live-dependency-acceptance.mjs.', accountableMemberId: me,
    ...(reviewerId ? { verifierMemberId: reviewerId, independentVerificationRequired: true } : {}) });
  expect(proposed.status === 201 || proposed.duplicate, 'could not propose the prerequisite', proposed);
}
let base = await work(ids.base);
if (['proposed', 'accepted'].includes(base.work.state)) { const begun = await tool('room_begin_work', { workItemId: ids.base }); expect(begun.working === true, 'prerequisite did not reach working', begun); base = await work(ids.base); }

// 2. Dependent, naming the prerequisite.
if (!await exists(ids.child)) {
  const proposed = await command('propose-dependent', 'work.proposed', { workItemId: ids.child, title: label + 'dependent', mode: 'read',
    definitionOfDone: 'One synthetic text result. Created by scripts/live-dependency-acceptance.mjs.', accountableMemberId: me, dependsOn: [ids.base] });
  expect(proposed.status === 201 || proposed.duplicate, 'could not propose the dependent', proposed);
}

// 3. While the prerequisite is unfinished: guidance, begin and admission must agree.
if (!evidence.steps.waiting) {
  expect(base.work.state === 'working', 'prerequisite is not in the expected working state for the waiting check', base.work.state);
  let child = await work(ids.child), read = await brief(ids.child), begin = null;
  if (child.work.state === 'proposed') {
    expect(read.continuation.action === 'accept' && read.continuation.tool === 'room_begin_work' && Array.isArray(read.continuation.waitingOn)
      && /^Accepts the assignment only/.test(read.continuation.guidance), 'accept hint does not describe accept-only with the awaited prerequisite', hint(read.continuation));
    begin = await tool('room_begin_work', { workItemId: ids.child });
    expect(begin.stopped === 'waiting_on_prerequisites' && begin.confirmed.length === 1 && begin.confirmed[0].action === 'room_accept_work', 'begin did not accept and then wait', begin);
    child = await work(ids.child); read = await brief(ids.child);
  }
  expect(child.work.state === 'accepted', 'dependent is not accepted', child.work.state);
  expect(proseWaits(read.brief) && read.continuation.tool === null && read.continuation.waitingOn?.[0]?.id === ids.base, 'brief or continuation recommends starting while the prerequisite is unfinished', hint(read.continuation));
  const state = await tool('room_project_state');
  expect(!state.needsYou.some(entry => entry.id === ids.child) && row(state, ids.child)?.next === 'wait_prerequisites', 'project state does not show the dependent as waiting', row(state, ids.child));
  const attempt = await command('start-while-waiting', 'work.started', { workItemId: ids.child, expectedRevision: child.work.revision });
  expect(attempt.status === 409 && attempt.code === 'work_claim_dependencies_unmet', 'admission did not refuse the start with work_claim_dependencies_unmet', attempt);
  record('waiting', { dependentRevision: child.work.revision, briefSaysWait: true, continuation: hint(read.continuation), projectStateRow: row(state, ids.child),
    begin: begin ? { confirmed: begin.confirmed.map(stage => stage.action), stopped: begin.stopped, waitingOn: begin.waitingOn } : 'not repeated on resume',
    admission: attempt, briefVersion: read.briefVersion });
}

// 4. Submit the prerequisite's exact result.
if (!base.work.receipt?.eventId) {
  const messageId = `relqual-${run}-prerequisite-result`;
  await tool('room_post_message', { id: messageId, workItemId: ids.base, body: `Synthetic release qualification result for ${expected.slice(0, 12)}. No project work was performed.` });
  const preview = await tool('room_read_result', { workItemId: ids.base, draftMessageId: messageId }), text = preview.result.text;
  await tool('room_submit_text_result', { workItemId: ids.base, requestId: `relqual-${run}-prerequisite-completion`, summary: 'Synthetic release qualification result', nextAction: gate === 'none' ? 'None' : 'Independent review of this exact text',
    producerId: me, evidenceMessageId: text.messageId, evidenceMessageEventId: text.messageEventId, evidenceVersion: text.evidenceVersion, previousCompletionEventId: preview.current.completionEventId });
  base = await work(ids.base);
}
const receipt = { completionEventId: base.work.receipt?.eventId ?? null, evidenceVersion: base.work.receipt?.evidenceVersion ?? null };
expect(receipt.completionEventId && receipt.evidenceVersion, 'prerequisite has no exact result reference', receipt);

// 5. With a required review: submitted is not released. Then wait for the real reviewer.
if (gate === 'independent_review') {
  const verification = base.work.verification;
  const passed = verification?.result === 'pass' && verification.completionEventId === receipt.completionEventId && verification.evidenceVersion === receipt.evidenceVersion;
  if (!passed) {
    const read = await brief(ids.child);
    expect(read.continuation.tool === null && read.continuation.waitingOn?.[0]?.id === ids.base, 'a submitted, unreviewed prerequisite released the dependent', hint(read.continuation));
    if (!evidence.steps.submittedNotReleased) record('submittedNotReleased', { prerequisite: receipt, continuation: hint(read.continuation) });
    expect(verification?.result !== 'fail', 'the reviewer recorded a fail; correct or close the qualification tasks by hand', verification);
    evidence.status = 'AWAITING_INDEPENDENT_REVIEW'; save();
    console.log(`AWAITING REVIEW. Ask member ${reviewerId} to read ${ids.base} with room_read_work (brief:true, includeResult:true) and record its own verdict on completion ${receipt.completionEventId}. Then rerun this script with the same ROOM_RUN_ID. Do not record that verdict with this credential.`);
    process.exit(3);
  }
  expect(verification.verifierId !== me && verification.actorId !== me, 'the verdict was recorded by the acting member; that is not an independent review', verification);
  if (!evidence.steps.gate) record('gate', { kind: 'independent_review', prerequisite: receipt, verification: { eventId: verification.eventId ?? null, verifierId: verification.verifierId ?? verification.actorId ?? null, result: verification.result } });
} else if (!evidence.steps.gate) record('gate', { kind: 'none', prerequisite: receipt, note: 'No review or decision gate was exercised; submission alone satisfies this prerequisite.' });

// 6. Released on a fresh read, with no edit to the dependent, and the recommended action succeeds.
if (!evidence.steps.released) {
  const known = evidence.steps.waiting.briefVersion, child = await work(ids.child);
  if (child.work.state === 'accepted') {
    const read = await brief(ids.child, known ? { knownBriefVersion: known } : {});
    expect(read.briefUnchanged !== true, 'the retained brief hid the changed prerequisite state');
    expect(!proseWaits(read.brief) && read.continuation.action === 'start' && read.continuation.tool === 'room_begin_work' && read.continuation.waitingOn == null, 'the dependent was not offered start after its prerequisite finished', hint(read.continuation));
    expect(child.work.revision === evidence.steps.waiting.dependentRevision, 'the dependent was edited between the waiting and released reads', { before: evidence.steps.waiting.dependentRevision, after: child.work.revision });
    const state = await tool('room_project_state');
    expect(state.needsYou.some(entry => entry.id === ids.child && entry.next === 'start'), 'project state does not offer the released dependent', row(state, ids.child));
    const begun = await tool(read.continuation.tool, read.continuation.arguments);
    expect(begun.working === true, 'the recommended begin did not reach working', begun);
    record('released', { continuation: hint(read.continuation), projectStateRow: row(state, ids.child), begin: { working: begun.working, confirmed: begun.confirmed.map(stage => stage.action) } });
  } else expect(['working', 'completed'].includes(child.work.state), 'dependent is in an unexpected state', child.work.state);
}

// 7. Close: finish the dependent with a labelled synthetic result so nothing is left open.
let child = await work(ids.child);
if (child.work.state === 'working') {
  const messageId = `relqual-${run}-dependent-result`;
  await tool('room_post_message', { id: messageId, workItemId: ids.child, body: `Synthetic release qualification closed for ${expected.slice(0, 12)}. No project work was performed.` });
  const preview = await tool('room_read_result', { workItemId: ids.child, draftMessageId: messageId }), text = preview.result.text;
  await tool('room_submit_text_result', { workItemId: ids.child, requestId: `relqual-${run}-dependent-completion`, summary: 'Synthetic release qualification closed', nextAction: 'None',
    producerId: me, evidenceMessageId: text.messageId, evidenceMessageEventId: text.messageEventId, evidenceVersion: text.evidenceVersion, previousCompletionEventId: preview.current.completionEventId });
  child = await work(ids.child);
}
expect(child.work.state === 'completed', 'dependent was not closed', child.work.state);
const after = await call('/api/version', undefined, false);
expect(after.json?.sourceRevision === expected, 'serving revision changed during the run', after.json?.sourceRevision);
record('closed', { prerequisite: { state: (await work(ids.base)).work.state, ...receipt }, dependent: { state: child.work.state, completionEventId: child.work.receipt?.eventId ?? null } });
evidence.status = 'PASSED'; evidence.finishedAt = new Date().toISOString(); save();
console.log(`PASSED on ${expected}. Both qualification tasks are completed and labelled synthetic. Evidence: ${evidencePath}`);
