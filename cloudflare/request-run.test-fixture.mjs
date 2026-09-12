import assert from 'node:assert/strict';
import { RoomStore as OldStore } from 'old-runtime-store';
import { DurableDatabase as OldDatabase, durableStorage as oldPlatform } from 'old-runtime-storage';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class RequestRunExperiment {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch() {
    const old = new OldStore(null, { database: new OldDatabase(this.storage), storagePlatform: oldPlatform });
    old.initialize(initialRoom());
    const owner = old.issueAccessKey('commons', 'owner');
    old.command(owner, 'commons', { id: 'agent', type: 'member.added', data: { memberId: 'agent', displayName: 'Agent', kind: 'agent', permissions: [] } });
    const agent = old.issueAccessKey('commons', 'agent');
    const q = old.command(owner, 'commons', { id: 'q', type: 'message.posted', data: { messageId: 'q', requestKind: 'reply', toMemberId: 'agent', body: 'Question' } });
    const before = old.room('commons');
    const current = new RoomStore(null, { database: new DurableDatabase(this.storage), storagePlatform: durableStorage });
    assert.deepEqual(current.room('commons'), before);
    assert.equal(durableStorage.version(current.db), 32);
    assert.throws(() => old.command(owner, 'commons', { id: 'old-write', type: 'message.posted', data: { body: 'Must not write' } }));
    const claim = { id: 'claim', type: 'request_run.claimed', data: { requestMessageId: 'q', expectedRevision: 0, runId: 'run', contextEventId: q.event.id, instructionsRevision: 0, maxRuntimeMs: 10000, maxOutputBytes: 4096 } };
    current.command(agent, 'commons', claim);
    assert.equal(current.command(agent, 'commons', claim).duplicate, true);
    assert.throws(() => current.command(agent, 'commons', { ...claim, id: 'compete' }));
    assert.deepEqual(current.room('commons').state.workItems, {});
    return Response.json({ upgraded: true, oldWriterBlocked: true, claimed: true });
  }
}
export default { fetch(request, env) { return env.RUN.getByName('test').fetch(request); } };
