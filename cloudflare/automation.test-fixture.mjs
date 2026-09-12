import assert from 'node:assert/strict';
import { RoomStore as OldStore } from 'old-runtime-store';
import { DurableDatabase as OldDatabase, durableStorage as oldPlatform } from 'old-runtime-storage';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { AgentConnections } from '../server/agent-connections.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class AutomationExperiment {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch() {
    const old = new OldStore(null, { database: new OldDatabase(this.storage), storagePlatform: oldPlatform });
    old.initialize(initialRoom());
    const owner = old.issueAccessKey('commons', 'owner');
    old.command(owner, 'commons', { id: 'agent', type: 'member.added', data: { memberId: 'agent', displayName: 'Agent', kind: 'agent', permissions: [] } });
    const agent = old.issueAccessKey('commons', 'agent');
    const create = { id: 'create', type: 'automation.created', data: { automationId: 'daily', expectedRevision: 0,
      definition: { title: 'Check in', prompt: 'What is next?', recipientId: 'agent', trigger: { kind: 'manual' }, maxRuns: 5, maxRuntimeMs: 10000, maxOutputBytes: 4096 } } };
    old.command(owner, 'commons', create);
    old.command(owner, 'commons', { id: 'enable', type: 'automation.enabled', data: { automationId: 'daily', expectedRevision: 1 } });
    old.command(agent, 'commons', { id: 'accept', type: 'automation.accepted', data: { automationId: 'daily', expectedRevision: 2 } });
    const before = old.room('commons');
    assert.equal(oldPlatform.version(old.db), 32);
    const verify = AgentConnections.prototype.verifyHistory;
    let failedVersion;
    AgentConnections.prototype.verifyHistory = function () { failedVersion = durableStorage.version(this.store.db); throw new Error('synthetic final failure'); };
    try {
      assert.throws(() => new RoomStore(null, { database: new DurableDatabase(this.storage), storagePlatform: durableStorage }));
    } finally { AgentConnections.prototype.verifyHistory = verify; }
    assert.equal(failedVersion, 33);
    assert.equal(oldPlatform.version(old.db), 32);
    assert.deepEqual(old.room('commons'), before);
    assert.equal(old.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'writer_v33_%'").get().n, 0);
    const current = new RoomStore(null, { database: new DurableDatabase(this.storage), storagePlatform: durableStorage });
    assert.deepEqual(current.room('commons'), before);
    assert.equal(durableStorage.version(current.db), 33);
    assert.throws(() => old.command(owner, 'commons', { id: 'old-write', type: 'message.posted', data: { body: 'Must not write' } }));
    const dispatch = { id: 'dispatch', type: 'message.posted', data: { messageId: 'q', automationId: 'daily', automationRevision: 3, automationSlot: 0 } };
    current.command(owner, 'commons', dispatch);
    assert.equal(current.command(owner, 'commons', dispatch).duplicate, true);
    assert.equal(current.command(owner, 'commons', create).duplicate, true);
    const reopened = new RoomStore(null, { database: new DurableDatabase(this.storage), storagePlatform: durableStorage });
    assert.deepEqual(reopened.room('commons'), current.room('commons'));
    reopened.command(agent, 'commons', { id: 'pause', type: 'automation.paused', data: { automationId: 'daily', expectedRevision: 4 } });
    assert.equal(reopened.room('commons').state.automations.daily.ownerEnabled, false);
    assert.deepEqual(reopened.room('commons').state.workItems, {});
    assert.equal(reopened.room('commons').state.messages.length, 1);
    assert.equal(reopened.room('commons').state.replyRequests.q.automation.maxRuntimeMs, 10000);
    assert.equal(reopened.room('commons').state.automations.daily.dispatchCount, 1);
    return Response.json({ upgraded: true, oldWriterBlocked: true, consentPersisted: true });
  }
}
export default { fetch(request, env) { return env.RUN.getByName('test').fetch(request); } };
