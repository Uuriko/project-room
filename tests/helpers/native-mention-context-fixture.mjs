// Synthetic native OAuth and callback fixture. Transport and DNS are injected;
// the real provider, binding, subscription, signing and outbox code still run.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { backup } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../../server/store.mjs';
import { initialRoom } from '../../server/bootstrap.mjs';
import { event } from '../../src/events.js';
import { createMcpInviteOAuth } from '../../server/mcp-invite-oauth.mjs';
import { createMcpEventsRuntime } from '../../server/mcp-events-runtime.mjs';
import { resolveMcpOAuthPrincipal, mcpOAuthPrincipalDescriptor } from '../../server/mcp-oauth.mjs';
export const resource = 'https://room.example/mcp';
const client = { clientId: 'native-context-test', name: 'Native context test', redirectUris: ['https://client.example/callback'] };
const secret = 'whsec_' + Buffer.alloc(32, 9).toString('base64');
function attach(t, store, details) {
  const oauth = createMcpInviteOAuth({ store, clients: [client], resource });
  const deliveries = [], challenges = [];
  let onLookup;
  const runtime = createMcpEventsRuntime({ store, inviteProvider: oauth.provider, resource, externalScheduler: true,
    dnsResolvers: { lookup: async () => { const next = onLookup; onLookup = undefined; next?.(); return [{ address: '8.8.8.8', family: 4 }]; } },
    transport: async (url, addresses, request) => {
      assert.equal(String(url), 'https://callback.example/events'); assert.deepEqual(addresses, ['8.8.8.8']);
      const signature = createHmac('sha256', Buffer.alloc(32, 9)).update(`${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${request.body}`).digest('base64');
      assert.equal(request.headers['webhook-signature'], `v1,${signature}`);
      const body = JSON.parse(request.body);
      if (body.type === 'verification') { challenges.push(body); return { status: 200, text: async () => JSON.stringify({ challenge: body.challenge }) }; }
      deliveries.push({ body, headers: request.headers }); return { status: 200, text: async () => '{}' };
    } });
  store.enqueueNativeMcpEvent = runtime.emit;
  t.after(() => { runtime.stop(); store.close(); });
  const post = (id = 'native-update', extra = {}) => store.command(details.sender, 'commons', {
    id, type: 'message.posted', data: { messageId: id, body: '@ReceiverAgent checkpoint complete; please review.', ...extra }
  });
  return { ...details, store, oauth, runtime, post, deliveries, challenges, beforeSend(fn) { onLookup = fn; } };
}
export async function nativeFixture(t, retained = 12, { crossOwner = false } = {}) {
  const store = new RoomStore(':memory:'), history = initialRoom(), at = '2026-11-01T12:00:00.000Z';
  if (crossOwner) history.push(event({ id: 'add-other-owner', type: 'member.added', roomId: 'commons', actorId: 'owner', at,
    data: { memberId: 'other-owner', displayName: 'Other owner', kind: 'human', permissions: [] } }));
  history.push(event({ id: 'add-coordinator', type: 'member.added', roomId: 'commons', actorId: 'owner', at,
    data: { memberId: 'coordinator', displayName: 'Coordinator', kind: 'agent', permissions: [], ...(crossOwner ? { accountableHumanId: 'other-owner' } : {}) } }));
  history.push(event({ id: 'seed-work', type: 'work.proposed', roomId: 'commons', actorId: 'owner', at,
    data: { workItemId: 'review', title: 'Review patch', definitionOfDone: 'Report findings', mode: 'read', accountableMemberId: 'coordinator' } }));
  for (let i = 0; i < retained; i++) history.push(event({ id: `seed-event-${i}`, type: 'message.posted', roomId: 'commons', actorId: 'owner', at,
    data: { messageId: `seed-${i}`, body: `Retained message ${i}: ${'x'.repeat(64)}` } }));
  store.initialize(history); while (!store.backfillMessages({ limit: 1000 }).done) {}
  assert.equal(store.checkMessagesParity({ roomId: 'commons' }).ok, true); store.migrateMessageAuthority('commons');
  const owner = store.issueAccessKey('commons', 'owner'), sender = store.issueAccessKey('commons', 'coordinator');
  const invite = store.invites.create(owner, 'commons', { profile: 'member' });
  const oauth = createMcpInviteOAuth({ store, clients: [client], resource }), verifier = 'v'.repeat(43);
  const { nonce } = oauth.begin(new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0], scope: 'rooms:read chat:read chat:write',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource }));
  const code = new URL(oauth.approve(nonce, invite.code, 'ReceiverAgent')).searchParams.get('code');
  const tokens = oauth.provider.exchangeCode({ code, clientId: client.clientId, redirectUri: client.redirectUris[0], codeVerifier: verifier, resource });
  const principal = resolveMcpOAuthPrincipal({ store, provider: oauth.provider, token: tokens.accessToken, resource, roomId: 'commons', requiredScopes: ['chat:read'] });
  assert.ok(principal);
  const clock = store.now(); store.now = () => clock;
  const f = attach(t, store, { owner, sender, tokens, principal, descriptor: mcpOAuthPrincipalDescriptor(principal), clock });
  const subscribed = await f.runtime.handler({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: { name: 'room.requested',
    arguments: { roomId: 'commons', memberId: principal.memberId }, delivery: { mode: 'webhook', url: 'https://callback.example/events', secret } } }, { descriptor: f.descriptor });
  assert.ok(subscribed.result?.id, JSON.stringify(subscribed)); assert.equal(f.challenges.length, 1);
  assert.equal(store.agentHeartbeats.statusOf(principal.identityId).hosts.length, 0);
  return { ...f, subscriptionId: subscribed.result.id };
}
export async function cloneNativeFixture(t, f) {
  const directory = mkdtempSync(join(tmpdir(), 'native-context-clone-')), path = join(directory, 'room.sqlite');
  await backup(f.store.db, path);
  const store = new RoomStore(path); store.now = () => f.clock;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return attach(t, store, { owner: f.owner, sender: f.sender, tokens: f.tokens, principal: f.principal, descriptor: f.descriptor, clock: f.clock, subscriptionId: f.subscriptionId });
}
export async function measureNative(f, operation) {
  const prepare = f.store.db.prepare, room = f.store.room;
  const result = { fullRoomReads: 0, messageRows: 0, messageBytes: 0 };
  f.store.room = function(...args) { result.fullRoomReads++; return room.apply(this, args); };
  f.store.db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (!/\b(?:FROM|JOIN)\s+messages\b/i.test(sql)) return statement;
    const record = row => { if (row !== undefined) { result.messageRows++; result.messageBytes += Buffer.byteLength(JSON.stringify(row)); } };
    return new Proxy(statement, { get(target, key) {
      if (key === 'all') return (...args) => { const rows = target.all(...args); rows.forEach(record); return rows; };
      if (key === 'get') return (...args) => { const row = target.get(...args); record(row); return row; };
      if (key === 'iterate') return function* (...args) { for (const row of target.iterate(...args)) { record(row); yield row; } };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try { result.value = await operation(); } finally { f.store.db.prepare = prepare; f.store.room = room; }
  return result;
}
