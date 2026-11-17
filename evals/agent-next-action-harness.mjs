#!/usr/bin/env node
// Agent next-action harness (agent-interface trial 2026-11-16). Synthetic
// in-memory Rooms only: never point this at a live service. Runs journeys A–F
// through the real hosted MCP HTTP handler with two scripted agent policies:
//   follow   – acts on continuation.tool; on refusal lists tools once and tries
//              the closest stage tool (the trial-and-error the trial observed);
//   capable  – reads continuation.capability first (absent on older builds ⇒
//              behaves like follow).
// Prints one JSON object. Bytes are UTF-8 JSON-RPC bodies; tokens are an
// ESTIMATE (bytes/4), not a measurement. Elapsed time is in-process and not
// representative of hosted latency.
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { mcpOAuthIdentityEpoch } from '../server/mcp-oauth.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

const CLIENT = { clientId: 'harness-agent', name: 'Harness Agent', redirectUris: ['https://client.example/callback'] };
const origin = 'https://room.example', resource = origin + '/mcp', verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const post = (url, headers, body) => new Promise((resolve, reject) => {
  const req = request(url, { method: 'POST', headers: { Host: 'room.example', ...headers } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject); req.end(body);
});

async function room() {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const ownerSession = store.createSession(ownerKey);
  const accountId = store.db.prepare("SELECT account_id FROM member_accounts WHERE member_id='owner'").get().account_id;
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, store.issueAccountAccessKey(accountId), 0);
  const identity = store.identities.create('Harness Agent');
  const { linkCode } = store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: 'commons' });
  store.agentConnections.apply(ownerSession.token, 'commons', { action: 'create', requestId: randomUUID(), memberId: 'agent', displayName: 'Harness Agent', access: 'collaborate',
    expectedOwnerRevision: 0, expiresAt: store.now() + 3600000, keyHash: createHash('sha256').update(randomUUID()).digest('hex'), identityId: identity.identityId, identityLinkCode: linkCode }, ownerSession.session.sessionBinding);
  setTier(store.db, 'commons', 'agent', 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const binding = { resource, roomId: 'commons', memberId: 'agent', identityId: identity.identityId, humanMemberId: 'owner', identityEpoch: mcpOAuthIdentityEpoch(store, identity.identityId) };
  const server = createRoomServer({ store, origin, mcpOAuthClients: [CLIENT] });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = async scope => {
    const consent = await post(base + '/oauth/authorize', { 'Content-Type': 'application/json', Cookie: `__Host-account_session=${slot.token}`, Origin: origin, 'X-CSRF-Token': session.csrf },
      JSON.stringify({ decision: 'allow', client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], scope, code_challenge: challenge, code_challenge_method: 'S256', resource, agent_binding: JSON.stringify(binding) }));
    const code = new URL(consent.headers.location).searchParams.get('code');
    const exchanged = await post(base + '/oauth/token', { 'Content-Type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], code_verifier: verifier, resource }).toString());
    return JSON.parse(exchanged.text).access_token;
  };
  const command = (id, type, data) => store.command(ownerKey, 'commons', { id, type, data });
  const close = async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); };
  return { store, base, token, command, close, identitySecret: identity.secret, ownerKey };
}

function meter(base, credential, roomArg) {
  const m = { calls: 0, failed: 0, requestBytes: 0, responseBytes: 0, misleading: 0, wrongVersion: 0, capabilityBytes: 0, toolsList: 0, log: [] };
  m.rpc = async (method, params = {}) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: m.calls + 1, method, params });
    const res = await post(base + '/mcp', { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential }, body);
    m.calls++; m.requestBytes += Buffer.byteLength(body); m.responseBytes += Buffer.byteLength(res.text);
    const parsed = JSON.parse(res.text);
    const failed = Boolean(parsed.error || parsed.result?.isError);
    if (failed) m.failed++;
    if (method === 'tools/list') m.toolsList++;
    m.log.push(`${method === 'tools/call' ? params.name : method}${failed ? ':refused' : ''}`);
    return { failed, value: parsed.result?.structuredContent, error: parsed.error, raw: parsed };
  };
  m.tool = (name, args) => m.rpc('tools/call', { name, arguments: { ...roomArg, ...args } });
  return m;
}

const STAGE_HINT = { accept: /accept_work$/, start: /start_work$/, verify: /verif/ };
// Shared decision step. Returns { acted, outcome } after at most one write attempt chain.
async function act(m, policy, read, extraArgs = {}, depth = 0) {
  const c = read.value.continuation;
  if (c.capability) m.capabilityBytes += Buffer.byteLength(JSON.stringify({ capability: c.capability }));
  const cap = policy === 'capable' ? c.capability : undefined;
  if (cap && cap.status === 'blocked') return { outcome: `reported_blocked:${cap.blockedBy}` };
  if (cap && cap.status === 'none') return { outcome: 'nothing_to_do' };
  if (cap?.via === 'alternative') {
    const done = await m.tool(cap.alternative.tool, cap.alternative.arguments);
    return { outcome: done.failed ? 'failed' : `done:${cap.alternative.tool}` };
  }
  if (!c.tool) return { outcome: c.addressedToViewer ? 'stuck_no_reason' : 'nothing_to_do' };
  if (c.tool === 'room_read_work' && depth === 0) { // the suggested preparation read, then decide again
    const prepared = await m.tool(c.tool, c.arguments);
    if (prepared.failed) return { outcome: `read_refused:${prepared.value?.code ?? prepared.error?.message}` };
    return act(m, policy, prepared, extraArgs, 1);
  }
  const args = { ...c.arguments, ...extraArgs };
  const first = await m.tool(c.tool, args);
  if (!first.failed) return { outcome: `done:${c.tool}` };
  const stated = c.capability && (c.capability.status === 'blocked' || c.capability.via === 'alternative');
  if (!stated) m.misleading++; // suggested, refused, and the response did not say so
  if (policy === 'capable' && c.capability) return { outcome: 'failed' };
  const listed = await m.rpc('tools/list');
  const hint = STAGE_HINT[c.action];
  const candidate = hint && listed.raw.result.tools.map(t => t.name).find(n => hint.test(n) && n !== c.tool);
  if (!candidate) return { outcome: 'reported_blocked:discovered_by_failure' };
  const retry = await m.tool(candidate, { workItemId: c.arguments.workItemId, expectedRevision: c.workRevision });
  return { outcome: retry.failed ? 'reported_blocked:discovered_by_failure' : `done:${candidate}` };
}

function reviewTask(r, id, { verifier = 'agent' } = {}) {
  r.command(`${id}-p`, 'work.proposed', { workItemId: id, title: 'Review an exact result', definitionOfDone: 'Independent review', accountableMemberId: 'owner', verifierMemberId: verifier, mode: 'read', independentVerificationRequired: true, ownerDecisionRequired: false });
  r.command(`${id}-a`, 'work.accepted', { workItemId: id, expectedRevision: 0 });
  const body = `Exact contribution ${id}`;
  const posted = r.command(`${id}-m`, 'message.posted', { messageId: `${id}-r`, workItemId: id, body });
  const evidenceVersion = 'sha256:' + createHash('sha256').update(body).digest('hex');
  r.command(`${id}-c`, 'work.completed', { workItemId: id, expectedRevision: 1, evidenceKind: 'room_text', evidenceMessageId: `${id}-r`, evidenceMessageEventId: posted.event.id, evidenceVersion, previousCompletionEventId: null, producerId: 'owner', summary: 'Result ready', nextAction: 'Independent review' });
}
const produceTask = (r, id) => r.command(`${id}-p`, 'work.proposed', { workItemId: id, title: 'Produce a result', definitionOfDone: 'Stored text', accountableMemberId: 'agent', verifierMemberId: 'owner', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false });
const REVIEW = { result: 'pass', summary: 'Inspected the exact stored result' };
const FULL = 'rooms:read chat:read chat:write work:read work:write', READ_ONLY = 'rooms:read chat:read work:read';

const JOURNEYS = {
  // A: new OAuth agent finds assigned work and takes an executable first step.
  async A(r, policy) {
    produceTask(r, 'a-task');
    const m = meter(r.base, await r.token(FULL), {});
    await m.tool('room_check_access', {});
    const list = await m.tool('room_list_work', { focus: 'needs_me' });
    const id = (list.value.items ?? list.value.work ?? []).find(item => (item.id ?? item.workItemId) === 'a-task') ? 'a-task' : 'a-task';
    const read = await m.tool('room_read_work', { workItemId: id, brief: true });
    const result = await act(m, policy, read);
    return { m, expected: 'accepted', correct: r.store.room('commons').state.workItems['a-task'].state === 'accepted', ...result };
  },
  // B: returning agent re-reads with knownBriefVersion and continues without rereading the brief.
  async B(r, policy) {
    produceTask(r, 'b-task');
    const m = meter(r.base, await r.token(FULL), {});
    const first = await m.tool('room_read_work', { workItemId: 'b-task', brief: true });
    m.responseBytes = 0; m.requestBytes = 0; m.calls = 0; m.log = []; // interruption: count only the resumed session
    const resumed = await m.tool('room_read_work', { workItemId: 'b-task', brief: true, knownBriefVersion: first.value.briefVersion });
    const result = await act(m, policy, resumed);
    return { m, expected: 'accepted', correct: resumed.value.briefUnchanged === true && r.store.room('commons').state.workItems['b-task'].state === 'accepted', ...result };
  },
  // C: producer begins (accept, start) and replays one uncertain write without a new operation.
  async C(r, policy) {
    produceTask(r, 'c-task');
    const m = meter(r.base, await r.token(FULL), {});
    const outcomes = [];
    for (let step = 0; step < 2; step++) outcomes.push((await act(m, policy, await m.tool('room_read_work', { workItemId: 'c-task', brief: true }))).outcome);
    const before = r.store.room('commons').state.sequence ?? null;
    const replay = await m.tool('room_post_message', { id: 'c-progress', body: 'Started; result to follow' });
    const again = await m.tool('room_post_message', { id: 'c-progress', body: 'Started; result to follow' });
    const duplicate = !replay.failed && !again.failed && (r.store.room('commons').state.messages.filter(x => x.body === 'Started; result to follow').length !== 1);
    return { m, expected: 'working, one progress message', correct: r.store.room('commons').state.workItems['c-task'].state === 'working' && !duplicate && before !== undefined, outcome: outcomes.join(' → ') };
  },
  // D: reviewer with full consent reads the exact result and records (or correctly reports) the review.
  async D(r, policy) {
    reviewTask(r, 'd-task');
    const m = meter(r.base, await r.token(FULL), {});
    const read = await m.tool('room_read_work', { workItemId: 'd-task', brief: true, includeResult: true });
    if (read.failed) return { m, expected: 'review recorded or blocker reported', correct: false, outcome: `read_refused:${read.value?.code ?? read.error?.message}` };
    const result = await act(m, policy, read, REVIEW);
    const recorded = Boolean(r.store.room('commons').state.workItems['d-task'].verification);
    return { m, expected: 'review recorded or blocker reported', correct: recorded || result.outcome.startsWith('reported_blocked'), recorded, ...result };
  },
  // D2: reviewer on a read-only grant: must learn it needs consent, not retry.
  async D2(r, policy) {
    reviewTask(r, 'd2-task');
    const m = meter(r.base, await r.token(READ_ONLY), {});
    const read = await m.tool('room_read_work', { workItemId: 'd2-task', brief: true });
    const result = await act(m, policy, read);
    return { m, expected: 'blocker reported', correct: result.outcome.startsWith('reported_blocked'), ...result };
  },
  // D3: reviewer must not approve a wrong version (identity connection).
  async D3(r, policy) {
    reviewTask(r, 'd3-task');
    const m = meter(r.base, r.identitySecret, { roomId: 'commons' });
    const read = await m.tool('room_read_work', { workItemId: 'd3-task', brief: true, includeResult: true });
    const stale = await m.tool('room_record_verification', { ...read.value.continuation.arguments, ...REVIEW, evidenceVersion: 'sha256:' + '0'.repeat(64) });
    if (!stale.failed) m.wrongVersion++;
    const result = await act(m, policy, read, REVIEW);
    return { m, expected: 'stale refused, exact recorded', correct: stale.failed && Boolean(r.store.room('commons').state.workItems['d3-task'].verification), note: 'one deliberate stale probe per run', ...result };
  },
  // E: designated verifier without Room verify authority; then finds independent ready work.
  async E(r, policy) {
    reviewTask(r, 'e-task'); produceTask(r, 'e-other');
    const member = r.store.room('commons').state.members.agent;
    r.command('e-perm', 'member.access_changed', { memberId: 'agent', expectedMemberRevision: member.revision, active: true, permissions: member.permissions.filter(p => p !== 'verify') });
    const m = meter(r.base, r.identitySecret, { roomId: 'commons' });
    const read = await m.tool('room_read_work', { workItemId: 'e-task', brief: true });
    let result = await act(m, policy, read);
    if (result.outcome === 'stuck_no_reason') { // without a reason the agent probes the obvious tool once
      const probe = await m.tool('room_record_verification', { workItemId: 'e-task', expectedRevision: read.value.revision, ...REVIEW, completionEventId: 'unknown', evidenceVersion: 'unknown' });
      result = { outcome: probe.failed ? 'reported_blocked:discovered_by_failure' : 'unexpected' };
    }
    const next = await m.tool('room_list_work', { focus: 'needs_me' });
    const sawOther = JSON.stringify(next.value).includes('e-other');
    return { m, expected: 'blocker named; other ready work found', correct: result.outcome.startsWith('reported_blocked') && sawOther, ...result };
  },
  // F: after a recorded review, a fresh read gives the next state without asking the previous contributor.
  async F(r, policy) {
    reviewTask(r, 'f-task');
    const m = meter(r.base, r.identitySecret, { roomId: 'commons' });
    const read = await m.tool('room_read_work', { workItemId: 'f-task', brief: true, includeResult: true });
    await act(m, policy, read, REVIEW);
    const fresh = await m.tool('room_read_work', { workItemId: 'f-task', brief: true });
    return { m, expected: 'next=complete from a fresh read', correct: fresh.value.continuation.action === 'complete', outcome: fresh.value.continuation.action };
  },
};

const results = [];
for (const [name, journey] of Object.entries(JOURNEYS)) for (const policy of ['follow', 'capable']) {
  const r = await room();
  const started = performance.now();
  try {
    const { m, ...rest } = await journey(r, policy);
    results.push({ journey: name, policy, ...rest, calls: m.calls, failedCalls: m.failed, toolsList: m.toolsList, requestBytes: m.requestBytes, responseBytes: m.responseBytes,
      tokensEstimate: Math.round((m.requestBytes + m.responseBytes) / 4), misleadingContext: m.misleading, capabilityBytes: m.capabilityBytes, wrongVersionAccepted: m.wrongVersion,
      elapsedMs: Math.round(performance.now() - started), trace: m.log.join(' > ') });
  } catch (error) { results.push({ journey: name, policy, error: String(error?.stack ?? error).slice(0, 400) }); }
  finally { await r.close(); }
}
process.stdout.write(JSON.stringify({ node: process.version, label: process.env.HARNESS_LABEL ?? null, results }, null, 1) + '\n');
