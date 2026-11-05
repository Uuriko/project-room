import { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { RoomStore } from '../server/store.mjs';
import { durableStorage } from './storage.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { createHash, createHmac } from 'node:crypto';
import { createMcpInviteOAuth } from '../server/mcp-invite-oauth.mjs';
import { createMcpEventsRuntime } from '../server/mcp-events-runtime.mjs';
import { resolveMcpOAuthPrincipal, mcpOAuthPrincipalDescriptor } from '../server/mcp-oauth.mjs';
import { createWorkersMcpEventTransport } from './mcp-event-transport.mjs';

export class NativeMentionContextTestRoom extends HttpTestRoom {
  async fetch() {
    const store = this.store, history = initialRoom(), at = '2026-11-01T12:00:00.000Z';
    history.push(event({ id: 'agent', type: 'member.added', roomId: 'commons', actorId: 'owner', at,
      data: { memberId: 'coordinator', displayName: 'Coordinator', kind: 'agent', permissions: [] } }));
    history.push(event({ id: 'work', type: 'work.proposed', roomId: 'commons', actorId: 'owner', at,
      data: { workItemId: 'review', title: 'Review', definitionOfDone: 'Report findings', mode: 'read', accountableMemberId: 'coordinator' } }));
    for (let i = 0; i < 32; i++) history.push(event({ id: `seed-${i}`, type: 'message.posted', roomId: 'commons', actorId: 'owner', at,
      data: { messageId: `seed-${i}`, body: 'Retained history' } }));
    store.maintainMessageCertification = true; store.initialize(history);
    while (!store.backfillMessages({ limit: 1000 }).done) {}
    store.checkMessagesParity(); store.migrateMessageAuthority('commons'); store.maintainMessageCertification = false;
    const owner = store.issueAccessKey('commons', 'owner'), sender = store.issueAccessKey('commons', 'coordinator');
    const resource = 'https://room.example/mcp', client = { clientId: 'worker-native-test', name: 'Worker native test', redirectUris: ['https://client.example/callback'] };
    const invitation = store.invites.create(owner, 'commons', { profile: 'member' });
    const oauth = createMcpInviteOAuth({ store, clients: [client], resource }), verifier = 'v'.repeat(43);
    const { nonce } = oauth.begin(new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0], scope: 'rooms:read chat:read chat:write',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource }));
    const code = new URL(oauth.approve(nonce, invitation.code, 'ReceiverAgent')).searchParams.get('code');
    const tokens = oauth.provider.exchangeCode({ code, clientId: client.clientId, redirectUri: client.redirectUris[0], codeVerifier: verifier, resource });
    const principal = resolveMcpOAuthPrincipal({ store, provider: oauth.provider, token: tokens.accessToken, resource, roomId: 'commons', requiredScopes: ['chat:read'] });
    let callbacks = 0, challenges = 0;
    const transport = createWorkersMcpEventTransport(['https://callback.example'], async (_url, request) => {
      const body = JSON.parse(request.body);
      const expected = createHmac('sha256', Buffer.alloc(32, 9)).update(`${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${request.body}`).digest('base64');
      if (request.headers['webhook-signature'] !== `v1,${expected}`) throw Error('Bad signature');
      if (body.type === 'verification') { challenges++; return Response.json({ challenge: body.challenge }); }
      callbacks++; return new Response(null, { status: 204 });
    });
    const runtime = createMcpEventsRuntime({ store, inviteProvider: oauth.provider, resource, transport, externalScheduler: true,
      dnsResolvers: { dohFetch: async url => ({ ok: true, json: async () => ({ Status: 0,
        Answer: new URL(url).searchParams.get('type') === 'A' ? [{ type: 1, TTL: 1, data: '8.8.8.8' }] : [] }) }) } });
    store.enqueueNativeMcpEvent = runtime.emit;
    try {
      const subscription = await runtime.handler({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: { name: 'room.requested',
        arguments: { roomId: 'commons', memberId: principal.memberId }, delivery: { mode: 'webhook', url: 'https://callback.example/events', secret: 'whsec_' + Buffer.alloc(32, 9).toString('base64') } } }, { descriptor: mcpOAuthPrincipalDescriptor(principal) });
      if (!subscription.result?.id) throw Error(JSON.stringify(subscription));
      const post = id => store.command(sender, 'commons', { id, type: 'message.posted', data: { messageId: id, body: '@ReceiverAgent checkpoint complete' } });
      const room = store.room; let fullRoomReads = 0;
      store.room = function(...args) { fullRoomReads++; return room.apply(this, args); };
      let retryDuplicate;
      try { post('native-update'); await runtime.drain(); retryDuplicate = post('native-update').duplicate; }
      finally { store.room = room; }
      const delivered = store.db.prepare("SELECT state FROM mcp_event_outbox").get().state;
      post('corrupt-update');
      const original = store.db.prepare("SELECT body FROM messages WHERE room_id='commons' AND message_id='corrupt-update'").get().body;
      store.db.prepare("UPDATE messages SET body='Unproved' WHERE room_id='commons' AND message_id='corrupt-update'").run();
      await runtime.drain();
      const corruptionState = store.db.prepare("SELECT state FROM mcp_event_outbox ORDER BY rowid DESC LIMIT 1").get().state;
      store.db.prepare("UPDATE messages SET body=? WHERE room_id='commons' AND message_id='corrupt-update'").run(original);
      const cold = new RoomStore(null, { database: store.db, storagePlatform: durableStorage });
      return Response.json({ fullRoomReads, challenges, callbacks, delivered, corruptionState, retryDuplicate, coldMessageCount: cold.room('commons').state.messages.length });
    } finally { runtime.stop(); }
  }
}
export default { fetch(request, env) { return env.ROOM.getByName('native-mention-context').fetch(request); } };
