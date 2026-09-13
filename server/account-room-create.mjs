import { createHash } from 'node:crypto';
import { initialRoom } from './bootstrap.mjs';
import { ServiceError } from './store.mjs';

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export function createAccountRoom(store, token, binding, { requestId, title }) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)
    || typeof title !== 'string' || !title.trim() || title.length > 80 || /[\u0000-\u001f\u007f]/.test(title))
    fail(422, 'invalid_room_creation', 'Choose a room name of 1–80 characters.');
  return store.transaction(() => {
    const auth = store.authenticateAccountSession(token, null, binding);
    if (auth.account.id.startsWith('acct-legacy-')) fail(403, 'durable_account_required', 'Use a full account to create rooms.');
    const digest = createHash('sha256').update(JSON.stringify([auth.account.id, requestId])).digest('hex');
    const roomId = `private-${digest}`, creationId = `create-${digest}`;
    const prior = store.db.prepare('SELECT id,body FROM events WHERE room_id=? AND sequence=1').get(roomId);
    if (prior) {
      if (prior.id !== creationId || JSON.parse(prior.body).data.title !== title.trim())
        fail(409, 'room_creation_conflict', 'This room request already has a different name.');
      // A retry cannot restore revoked ownership or reveal another account's room.
      const current = store.authenticateAccountSession(token, roomId, binding);
      if (current.member.id !== store.room(roomId).state.room.ownerId) fail(403, 'owner_required', 'Room ownership changed.');
      return { roomId, duplicate: true };
    }
    const owned = store.db.prepare("SELECT count(*) AS n FROM member_accounts ma JOIN rooms r ON r.id=ma.room_id WHERE ma.account_id=? AND ma.member_id=json_extract(r.projection,'$.room.ownerId')").get(auth.account.id).n;
    if (owned >= 10 || store.db.prepare('SELECT count(*) AS n FROM rooms').get().n >= 1000)
      fail(409, 'pilot_limit', 'Room limit reached.');
    const events = initialRoom(roomId, 'owner');
    events[0].id = creationId;
    events[0].data.title = title.trim();
    events[0].data.purpose = 'A space for your people and agents.';
    events[1].data.displayName = 'Room owner';
    store.initialize(events);
    store.ensureHumanAccountBinding(roomId, 'owner', auth.account.id, 'self-service-room');
    return { roomId, duplicate: false };
  });
}
