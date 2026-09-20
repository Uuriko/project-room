// LOCAL TEST ONLY: public Room entrypoint never exports this provisioning route.
import entry, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { emailContractFixture } from '../scripts/email-contract-fixture.mjs';
import { normalizeGraphEmail } from '../server/graph-email.mjs';
import { seedRecordedReply } from '../scripts/reply-review-fixture.mjs';
export class HttpTestRoom extends ProjectRoom {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test-provision') {
      this.store.initialize(initialRoom());
      const account = this.store.createAccount('worker-mail-owner'); this.store.bindHumanAccount('commons', 'owner', account.id);
      const accountKey = this.store.issueAccountAccessKey(account.id);
      const slot = this.store.createAccountSessionSlot(), session = this.store.loginAccountSession(slot.token, accountKey, 0);
      const raw = emailContractFixture(); raw.connection.accountId = account.id;
      this.store.email.apply(slot.token, { action: 'connection.configure', requestId: 'http-mail-configure', connectionId: raw.connection.id,
        expectedRevision: 0, profile: raw.connection }, session.sessionBinding);
      const envelope = normalizeGraphEmail(raw.connection, raw.message, raw.options);
      this.store.email.apply(slot.token, { action: 'page.apply', requestId: 'http-mail-import', connectionId: raw.connection.id,
        connectionRevision: 1, folderId: raw.message.parentFolderId, expectedRevision: 0, expectedCursor: null, cursor: 'fixture-complete',
        complete: true, reset: true, observations: [{ kind: 'message', expectedSourceRevision: 0, envelope }] }, session.sessionBinding);
      seedRecordedReply({ store: this.store, token: slot.token, binding: session.sessionBinding, sourceId: envelope.sourceId });
      return Response.json({ ownerKey: this.store.issueAccessKey('commons', 'owner'), accountKey, sourceId: envelope.sourceId });
    }
    if (url.pathname === '/__test-dm-consent' && request.method === 'POST') {
      // LOCAL TEST ONLY: approve a DM direction without the target's session.
      const { fromMemberId, toMemberId } = await request.json();
      this.store.dmConsents.request('commons', fromMemberId, toMemberId, 'test fixture');
      this.store.dmConsents.decide('commons', toMemberId, fromMemberId, 'approve');
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default entry;
