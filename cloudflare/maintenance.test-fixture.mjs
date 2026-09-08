// Local test entrypoint only. The hostile storage accessor must never be read.
import assert from 'node:assert/strict';
import worker, { ProjectRoom } from './room.mjs';

export default { async fetch(request, env) {
  const direct = new URL(request.url).pathname === '/direct';
  const guarded = { get storage() { throw new Error('Maintenance must precede storage initialization'); } };
  if (new URL(request.url).pathname === '/configuration-checks') {
    assert.throws(() => new ProjectRoom(guarded, { ...env, ROOM_MAINTENANCE: 'true' }), /ROOM_MAINTENANCE must be 0 or 1/);
    assert.throws(() => new ProjectRoom(guarded, { ...env, ROOM_MAINTENANCE: '0' }), /Maintenance must precede storage initialization/);
    await assert.rejects(() => worker.fetch(request, { ...env, ROOM_MAINTENANCE: 'true' }), /ROOM_MAINTENANCE must be 0 or 1/);
    await assert.rejects(() => worker.fetch(request, { ...env, ROOM_ORIGIN: 'http://room.example.test' }), /Exact HTTPS Room origin required/);
    return Response.json({ invalidConfigurationRejected: true, normalStartupOpensStorage: true });
  }
  if (direct) {
    const object = new ProjectRoom(guarded, env);
    return object.fetch(new Request(env.ROOM_ORIGIN + '/api/rooms/commons'));
  }
  let called = false;
  const result = await worker.fetch(request, { ...env, ROOM: { getByName() { called = true; throw new Error('Maintenance must precede binding access'); } } });
  assert.equal(called, false);
  return result;
} };
