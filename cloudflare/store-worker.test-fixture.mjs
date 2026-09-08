// Local test fixture only. This exposes synthetic provisioning for tests and
// MUST NOT be deployed. The eventual public entrypoint must not include it.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { STORE_SCHEMA_VERSION } from '../server/writer-fence.mjs';

export class StoreTestRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = new DurableDatabase(ctx.storage);
    this.store = new RoomStore(null, { database: this.db, storagePlatform: durableStorage });
  }
  async fetch(request) {
    const store = this.store;
    const path = new URL(request.url).pathname;
    if (path === '/scenario') {
      store.initialize(initialRoom());
      const owner = store.issueAccessKey('commons', 'owner');
      const linkToken = randomBytes(32).toString('base64url');
      const link = store.shareLinks.create(owner, 'commons', { requestId: randomUUID(), linkToken,
        expiresAt: Date.now() + 3600000, maxJoins: 3, expectedMemberRevision: 0 }, null).link;
      const guests = ['Alice', 'Bob'].map(displayName => {
        const slot = store.createAccountSessionSlot();
        const redemptionId = randomUUID();
        const join = () => {
          const current = store.accountSessionSlot(slot.token);
          return store.shareLinks.join(slot.token, linkToken, { displayName, redemptionId,
            expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
        };
        const first = join(), second = join();
        assert.equal(second.duplicate, true);
        assert.equal(first.session.member.id, second.session.member.id);
        assert.deepEqual(first.session.member.permissions, []);
        return { token: slot.token, binding: first.session.sessionBinding, member: first.session.member.id };
      });
      assert.notEqual(guests[0].member, guests[1].member);
      assert.equal(store.shareLinks.list(owner, 'commons', null).links[0].joins, 2);
      const post = { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: 'A synthetic message from Alice' } };
      const receipt = store.command(guests[0].token, 'commons', post, guests[0].binding);
      const retry = store.command(guests[0].token, 'commons', post, guests[0].binding);
      assert.equal(retry.duplicate, true);
      assert.equal(receipt.event.actorId, guests[0].member);
      const bob = store.eventsAfter(guests[1].token, 'commons', 0, 100, guests[1].binding);
      assert.ok(bob.events.some(row => row.event?.id === receipt.event.id || row.id === receipt.event.id));
      const before = store.room('commons').sequence;
      const failedGuest = store.createAccountSessionSlot();
      const append = store.appendInvitationJournal;
      store.appendInvitationJournal = () => { throw new Error('synthetic unavailable storage'); };
      try {
        assert.throws(() => store.shareLinks.join(failedGuest.token, linkToken, { displayName: 'Rollback',
          redemptionId: randomUUID(), expectedSessionRevision: 0,
          expectedSessionBinding: failedGuest.session.sessionBinding }), /synthetic unavailable storage/);
      } finally { store.appendInvitationJournal = append; }
      assert.equal(store.accountSessionSlot(failedGuest.token).sessionRevision, 0);
      assert.equal(store.room('commons').sequence, before);
      assert.equal(store.shareLinks.list(owner, 'commons', null).links[0].joins, 2);
      assert.throws(() => this.db.exec('UPDATE membership_invitation_journal SET body=body'), /append-only/);
      assert.throws(() => this.db.exec('DELETE FROM membership_invitation_events'), /append-only/);
      assert.equal(store.verifyInvitationAudit().consistent, true);
      store.shareLinks.verify();
      store.shareLinks.cancel(owner, 'commons', link.id, null);
      assert.throws(() => store.shareLinks.preview(linkToken), { code: 'link_unavailable' });
      const send = (type, data) => store.command(owner, 'commons', { id: randomUUID(), type, data });
      const scope = { repository: 'test/repo', ref: 'draft', paths: ['src/**'], expiresAt: new Date(Date.now() + 60000).toISOString() };
      for (const workItemId of ['scope-first', 'scope-second']) {
        send(T.WORK_PROPOSED, { workItemId, title: workItemId, definitionOfDone: 'Synthetic handoff', accountableMemberId: 'owner', mode: 'write', independentVerificationRequired: false, ownerDecisionRequired: false });
        send(T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 });
      }
      send(T.CLAIM_ACQUIRED, { workItemId: 'scope-first', expectedRevision: 1, ...scope });
      const rejected = { id: randomUUID(), type: T.CLAIM_ACQUIRED, data: { workItemId: 'scope-second', expectedRevision: 1, ...scope } };
      const scopeBoundary = store.room('commons').sequence;
      assert.throws(() => store.command(owner, 'commons', rejected), { code: 'claim_conflict', status: 409 });
      assert.equal(store.room('commons').sequence, scopeBoundary);
      send(T.CLAIM_RELEASED, { workItemId: 'scope-first', expectedRevision: 2 });
      assert.equal(store.command(owner, 'commons', rejected).duplicate, false);
      const proposal = { id: randomUUID(), type: T.MESSAGE_POSTED, data: { workItemId: 'scope-first', body: 'Synthetic portable proposal; no external work performed.', packetId: 'test-packet', basisRevision: 0 } };
      const unchangedWork = store.room('commons').state.workItems;
      assert.throws(() => store.command(owner, 'commons', proposal), { status: 409 });
      proposal.data.allowOlderBasis = true;
      store.command(owner, 'commons', proposal);
      assert.equal(store.command(owner, 'commons', proposal).duplicate, true);
      assert.deepEqual(store.room('commons').state.workItems, unchangedWork);
      assert.equal(store.room('commons').state.messages.at(-1).proposal.attribution, 'manual-unverified');
      return Response.json({ guests, sequence: store.room('commons').sequence, eventId: receipt.event.id });
    }
    if (path === '/resume') {
      const { guests, sequence, eventId } = await request.json();
      for (const guest of guests) {
        assert.equal(store.authenticateAccountSession(guest.token, 'commons', guest.binding).member.id, guest.member);
        const events = store.eventsAfter(guest.token, 'commons', 0, 100, guest.binding);
        assert.ok(events.events.some(row => row.event?.id === eventId || row.id === eventId));
      }
      assert.equal(store.room('commons').sequence, sequence);
      assert.equal(store.room('commons').state.workItems['scope-first'].claim.status, 'released');
      assert.equal(store.room('commons').state.workItems['scope-second'].claim.status, 'active');
      assert.equal(store.room('commons').state.messages.at(-1).proposal.packetId, 'test-packet');
      assert.deepEqual(store.rebuildProjection('commons').state.messages, store.room('commons').state.messages);
      assert.equal(store.verifyInvitationAudit().consistent, true);
      store.shareLinks.verify();
      return Response.json({ recovered: true, guests: guests.length, sequence });
    }
    if (path === '/newer-version') {
      store.transaction(() => durableStorage.setVersion(this.db, STORE_SCHEMA_VERSION + 1));
      assert.throws(() => new RoomStore(null, { database: this.db, storagePlatform: durableStorage }), /newer than this service/);
      assert.throws(() => this.db.exec("INSERT INTO rooms VALUES('old-writer',0,'{}')"), /unsupported database writer|reconciliation/);
      return Response.json({ rejected: true });
    }
    return new Response('Not found', { status: 404 });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName('shared-store-proof').fetch(request); } };
