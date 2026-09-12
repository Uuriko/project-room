// Local synthetic fixture only; never a deployment entrypoint.
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { RoomAttachments, attachmentSchema } from '../server/attachments.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class AttachmentStagingExperiment {
  constructor(ctx) {
    this.store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
  }
  async fetch() {
    const store = this.store;
    store.initialize(initialRoom('files'));
    store.transaction(() => store.db.exec(attachmentSchema));
    const token = store.issueAccessKey('files', 'owner'), files = new RoomAttachments(store);
    const whole = new Uint8Array([9, 0, 255, 8]);
    const input = { id: 'sliced', filename: 'notes.txt', mediaType: 'text/plain', bytes: whole.subarray(1, 3) };
    const receipt = files.stage(token, 'files', input);
    assert.deepEqual(files.stage(token, 'files', input), receipt);
    assert.deepEqual(files.readStaged(token, 'files', input.id).bytes, new Uint8Array([0, 255]));
    assert.throws(() => files.stage(token, 'files', { ...input, filename: 'different.txt' }), { status: 409 });
    assert.throws(() => store.transaction(() => {
      files.stage(token, 'files', { ...input, id: 'rollback' }); throw new Error('rollback');
    }), /rollback/);
    assert.throws(() => files.readStaged(token, 'files', 'rollback'), { status: 404 });
    const large = { ...input, id: 'large', bytes: new Uint8Array(1048576) };
    files.stage(token, 'files', large);
    assert.equal(files.readStaged(token, 'files', 'large').bytes.byteLength, 1048576);
    assert.equal(files.discard(token, 'files', 'large').state, 'discarded');
    assert.throws(() => files.stage(token, 'files', large), { status: 410 });
    return Response.json({ sharedAdapter: true, slice: true, retry: true, rollback: true, discard: true });
  }
}
export default { fetch(request, env) { return env.FILES.getByName('synthetic').fetch(request); } };
