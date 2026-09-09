// Local test fixture only. This exposes synthetic provisioning for tests and
// MUST NOT be deployed. The eventual public entrypoint must not include it.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { STORE_SCHEMA_VERSION } from '../server/writer-fence.mjs';
import { textVersion } from '../server/text-results.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { emailContractFixture } from '../scripts/email-contract-fixture.mjs';
import { RecordedGraphMailbox, prepareGraphFixturePage, graphFixtureStart } from '../server/graph-fixture-sync.mjs';

function checkNarrowAuthentication(store, credentials) {
  const { state, sequence } = store.room('commons'), before = auditRecovery(store).dataSha256;
  assert.deepEqual(store.roomAuthority('commons'), { sequence, ownerId: state.room.ownerId, members: state.members });
  const room = store.room; store.room = () => assert.fail('Authentication must use the narrow storage read');
  try {
    for (const { token, member, binding = null } of credentials) {
      assert.deepEqual(store.authenticate(token, 'commons', binding).member, state.members[member]);
      if (binding) assert.throws(() => store.authenticate(token, 'commons', 'wrong'), { code: 'session_binding_changed' });
    }
  } finally { store.room = room; }
  assert.equal(auditRecovery(store).dataSha256, before);
}

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
      const session = store.createSession(owner), managedToken = randomBytes(32).toString('base64url');
      store.agentConnections.apply(session.token, 'commons', { action: 'create', requestId: randomUUID(), memberId: 'managed-reader',
        displayName: 'Managed reader', access: 'chat', keyHash: createHash('sha256').update(managedToken).digest('hex'),
        expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
      send(T.MEMBER_ADDED, { memberId: 'legacy-reader', displayName: 'Legacy reader', kind: 'agent', permissions: [], accountableHumanId: 'owner' });
      const credentials = [{ token: owner, member: 'owner' }, { token: session.token, member: 'owner', binding: session.session.sessionBinding },
        { token: managedToken, member: 'managed-reader' }, { token: store.issueAccessKey('commons', 'legacy-reader'), member: 'legacy-reader' }, ...guests];
      checkNarrowAuthentication(store, credentials);
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
      send(T.WORK_PROPOSED, { workItemId: 'native-text', title: 'Native text', definitionOfDone: 'Exact stored text', accountableMemberId: 'owner', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: 'owner' });
      send(T.WORK_ACCEPTED, { workItemId: 'native-text', expectedRevision: 0 });
      const nativeBody = 'Workers native text 🪷\r\n  unchanged  ', nativePost = send(T.MESSAGE_POSTED, { messageId: 'native-message', workItemId: 'native-text', body: nativeBody, packetId: 'native-packet', basisRevision: 1 });
      const nativeCommand = { id: 'native-completion', type: T.WORK_COMPLETED, data: { workItemId: 'native-text', expectedRevision: 1,
        evidenceKind: 'room_text', evidenceMessageId: 'native-message', evidenceMessageEventId: nativePost.event.id, evidenceVersion: textVersion(nativeBody),
        previousCompletionEventId: null, producerId: 'owner', summary: 'Native text', nextAction: 'Review' } };
      assert.throws(() => store.command(owner, 'commons', { ...nativeCommand, data: { ...nativeCommand.data, evidenceVersion: textVersion('wrong') } }), { code: 'command_rejected' });
      const nativeSaved = store.command(owner, 'commons', nativeCommand);
      assert.equal(store.workResult(owner, 'commons', 'native-text').result.text.body, nativeBody); auditRecovery(store);
      const mail = emailContractFixture(), mailSlot = store.createAccountSessionSlot();
      mail.connection.accountId = store.accountForMember('commons', 'owner').id;
      const mailSession = store.loginAccountSession(mailSlot.token, store.issueAccountAccessKey(mail.connection.accountId), 0);
      const mailToken = mailSlot.token, mailBinding = mailSession.sessionBinding;
      store.email.apply(mailToken, { action: 'connection.configure', requestId: 'mail-connection', connectionId: mail.connection.id,
        expectedRevision: 0, profile: mail.connection }, mailBinding);
      const mailPage = await prepareGraphFixturePage({ store, token: mailToken, binding: mailBinding, requestId: 'mail-first-page',
        connectionId: mail.connection.id, folderId: mail.message.parentFolderId, reader: new RecordedGraphMailbox({
          connection: mail.connection, pages: [{ cursor: null, response: { status: 200, body: { value: [{ id: mail.message.id }],
            '@odata.nextLink': graphFixtureStart(mail.connection, mail.message.parentFolderId) + '?$skiptoken=fixture-next' } } }],
          messages: [{ id: mail.message.id, response: { status: 200, message: mail.message, options: mail.options } }]
        }) });
      const envelope = mailPage.observations[0].envelope;
      store.email.apply(mailToken, mailPage, mailBinding);
      store.inbox.apply(mailToken, { action: 'draft.save', requestId: 'mail-private-draft', sourceId: envelope.sourceId,
        expectedRevision: 0, sourceRevision: 1, body: 'Recover this private email draft' }, mailBinding);
      const checkpoint = auditRecovery(store).dataSha256;
      store.db.exec("CREATE TRIGGER mail_test_failure BEFORE INSERT ON private_email_commands BEGIN SELECT RAISE(ABORT,'fixture mail failure'); END");
      assert.throws(() => store.email.apply(mailToken, { ...mailPage, requestId: 'mail-failed-page', expectedRevision: 1,
        expectedCursor: mailPage.cursor, cursor: 'fixture-final', complete: true, reset: false,
        observations: [{ kind: 'message', expectedSourceRevision: 1, envelope }] }, mailBinding), /fixture mail failure/);
      store.db.exec('DROP TRIGGER mail_test_failure');
      assert.equal(auditRecovery(store).dataSha256, checkpoint);
      return Response.json({ guests, credentials, sequence: store.room('commons').sequence, eventId: receipt.event.id, owner, nativeBody, nativeCommand, nativeSaved,
        email: { token: mailToken, binding: mailBinding, page: mailPage, sourceId: envelope.sourceId } });
    }
    if (path === '/resume') {
      const { guests, credentials, sequence, eventId, owner, nativeBody, nativeCommand, nativeSaved, email } = await request.json();
      checkNarrowAuthentication(store, credentials);
      for (const guest of guests) {
        assert.equal(store.authenticateAccountSession(guest.token, 'commons', guest.binding).member.id, guest.member);
        const events = store.eventsAfter(guest.token, 'commons', 0, 100, guest.binding);
        assert.ok(events.events.some(row => row.event?.id === eventId || row.id === eventId));
        assert.equal(store.workResult(guest.token, 'commons', 'native-text', { completionEventId: nativeSaved.event.id, expectedSessionBinding: guest.binding }).result.text.body, nativeBody);
      }
      assert.equal(store.room('commons').sequence, sequence);
      assert.equal(store.room('commons').state.workItems['scope-first'].claim.status, 'released');
      assert.equal(store.room('commons').state.workItems['scope-second'].claim.status, 'active');
      assert.equal(store.room('commons').state.messages.find(message => message.workItemId === 'scope-first').proposal.packetId, 'test-packet');
      assert.equal(store.command(owner, 'commons', nativeCommand).event.id, nativeSaved.event.id); auditRecovery(store);
      assert.deepEqual(store.rebuildProjection('commons').state.messages, store.room('commons').state.messages);
      assert.equal(store.verifyInvitationAudit().consistent, true);
      store.shareLinks.verify();
      assert.equal(store.email.apply(email.token, email.page, email.binding).duplicate, true);
      assert.equal(store.inbox.read(email.token, email.sourceId, email.binding).draft.body, 'Recover this private email draft');
      const mailState = store.email.state(email.token, email.page.connectionId, email.page.folderId, email.binding);
      assert.equal(mailState.folder.complete, false); assert.equal(mailState.expectedCursor, email.page.cursor);
      const finalPage = await prepareGraphFixturePage({ store, token: email.token, binding: email.binding,
        connectionId: email.page.connectionId, folderId: email.page.folderId, requestId: 'mail-final-page',
        reader: new RecordedGraphMailbox({ connection: mailState.connection.profile, messages: [],
          pages: [{ cursor: email.page.cursor, response: { status: 200, body: { value: [],
            '@odata.deltaLink': graphFixtureStart(mailState.connection.profile, email.page.folderId) + '?$deltatoken=fixture-final' } } }] }) });
      store.email.apply(email.token, finalPage, email.binding);
      assert.equal(store.email.verify().sources, 1); auditRecovery(store);
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
