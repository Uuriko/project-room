// LOCAL TEST ONLY; this provisioning route is not exported by production.
import entry, { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

export class OrientationTestRoom extends HttpTestRoom {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/__test-orientation') return super.fetch(request);
    this.store.initialize(initialRoom());
    const owner = this.store.issueAccessKey('commons', 'owner');
    this.store.command(owner, 'commons', { id: 'orientation-member', type: 'member.added',
      data: { memberId: 'reader', displayName: 'Reader', kind: 'agent', permissions: [] } });
    this.store.command(owner, 'commons', { id: 'orientation-message', type: 'message.posted',
      data: { messageId: 'conversation-only', body: 'Conversation body must not enter orientation.' } });
    this.store.command(owner, 'commons', { id: 'orientation-work', type: 'work.proposed',
      data: { workItemId: 'inspect', title: 'Inspect storage', definitionOfDone: 'Prove bounded reads', mode: 'read', accountableMemberId: 'owner' } });
    return Response.json({ token: this.store.issueAccessKey('commons', 'reader') });
  }
}
export default entry;
